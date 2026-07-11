// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import { createCloudGraphService, graphHeadFromGraph, normalizeCloudGraphHead, removeEmptyAncestorDirectories, summarizeGraphContract, summarizeRequester, visibilityRequestFromOptions } from '../cloud/d1-graph-service.js'
import { defaultOpenHydrationMaxBytes, defaultOpenHydrationMaxFiles, defaultOpenHydrationSmallFileBytes, localCacheSchemaVersion, workspaceMode } from '../constants.js'
import { privacyZoneForPath, rawClientEncryptionKey } from '@hopit/core/crypto'
import { emit, readNdjson } from '../io.js'
import { cloudEntryEquals, countCloudScopes, countPathScopes, normalizeCloudFileEntry } from '../journal.js'
import { withCloudFetchRetry } from '../cloud-retry.js'
import { assertWorkspacePathSafe, cloudLocationFromOptions } from '../paths.js'
import { classifyJournalEntries, readJournalSafety, workspaceRootFromOptions } from '../status-state.js'
import { findIndexedCodebase, hydratedPathUnion, hydratedPathsAfterPrune, hydrationStateForHydratedPaths, latestIsoTimestamp, localCachePatchForPaths, materializationForHydrationState, parseNonNegativeIntegerOption, readWorkspaceIndex, selectedCloudPaths, upsertWorkspaceIndex, upsertWorkspaceIndexFromCloud, workspaceIndexEntryFromCloud, workspaceIndexEntryKey, workspaceIndexRoot, workspaceIndexSummary } from '../workspace-index.js'
import { manifestEntryChanged, readWorkspaceFiles, workspaceFilePath, workspaceLocalChanges } from '../workspace-manifest.js'
import { materializeCloudEntry, sortPathsDeepestFirst } from './sync.js'
import { assertAttachWorkspaceSafe, discoveredCloudCodebase, discoveredCloudCodebaseHead, workspaceFileMetadata, workspaceOptionsForCloudCodebase, writeWorkspaceMetadataManifest } from './workspace.js'
import { buildOpenHydrationPlan, selectedHydrationPathsForCommand } from './hydration-plan.js'
import { scopeForPath } from '@hopit/core/privacy-zone'
import { existsSync } from 'node:fs'

export async function hydrateWorkspace(options) {
  await assertWorkspacePathSafe(options)
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readVisibleGraph(visibilityRequestFromOptions(options))
  const requester = summarizeRequester(cloud.visibilityContext)
  await fs.mkdir(options.workspace, { recursive: true })

  const codebaseId = cloud.codebase?.id ?? options['codebase-id'] ?? 'hopit'
  // Cheap local verify pass: on a restart of an already-materialized workspace
  // most files are byte-identical to cloud. Reading the disk graph once (local
  // hash/size, no per-file cloud reads) lets us skip the slow path — fetch +
  // rewrite + `file.hydrated` — for every clean file, so a large clean workspace
  // reaches `workspace.ready` (and the watcher/remote-push start) in seconds
  // instead of re-downloading thousands of files. Files that are missing, stale,
  // or dirty on disk still take the slow path below. The content manifest is
  // rebuilt in full by the upsert at the end, so a stale manifest self-heals
  // regardless of what was skipped.
  const diskEntries = await readWorkspaceFiles(options.workspace, options)
  const workspaceIndex = await readWorkspaceIndex(options)
  const indexedCodebase = findIndexedCodebase(workspaceIndex, codebaseId, options.workspace)
  let materializedCount = 0
  let verifiedCount = 0

  for (const [relativePath, file] of Object.entries(cloud.files)) {
    const scope = scopeForPath(relativePath)
    const entry = normalizeCloudFileEntry(relativePath, file)
    const diskEntry = diskEntries[relativePath]
      ? normalizeCloudFileEntry(relativePath, diskEntries[relativePath])
      : null
    const manifestEntry = indexedCodebase?.contentManifest?.files?.[relativePath] ?? null
    // Byte-identical on disk (and consistent with the last acknowledged
    // manifest when one exists) means no cloud read or rewrite is needed.
    if (
      diskEntry &&
      cloudEntryEquals(diskEntry, entry) &&
      (!manifestEntry || manifestMatchesCloudEntry(manifestEntry, entry))
    ) {
      verifiedCount += 1
      continue
    }

    await materializeCloudEntry(options.workspace, relativePath, entry, cloudService, {
      codebaseId,
      fetchRetry: hydrateFetchRetry(options, relativePath),
    })
    await emit(options, 'file.hydrated', {
      path: relativePath,
      scope,
      privacyZone: entry.privacyZone ?? privacyZoneForPath(relativePath),
      kind: entry.kind,
      bytes: entry.size,
      revision: entry.revision,
    })
    materializedCount += 1
  }

  await emit(options, 'workspace.ready', {
    workspace: options.workspace,
    revision: cloud.revision,
    service: cloudService.type,
    contract: summarizeGraphContract(cloud),
    requester,
    adapter: workspaceMode.adapter,
    cacheMode: workspaceMode.cacheMode,
    scopeCounts: countCloudScopes(cloud),
    hiddenScopeCounts: cloud.visibilityContext?.hiddenScopeCounts ?? { shared: 0, private: 0 },
    materializedFileCount: materializedCount,
    verifiedFileCount: verifiedCount,
  })
  await upsertWorkspaceIndexFromCloud(options, cloud, {
    reason: 'hydrate',
    lastEvent: 'workspace.ready',
    hydrationState: 'materialized',
    hydratedPaths: Object.keys(cloud.files ?? {}),
  })
}

// Builds the per-entry retry wrapper used by hydration's cloud fetches. On a
// recovered transient fault it journals `cloud.fetch_recovered` so the flakiness
// is observable; exhaustion still throws and fails the command.
export function hydrateFetchRetry(options, relativePath, retryOptions = {}) {
  return (fn) =>
    withCloudFetchRetry(fn, {
      ...retryOptions,
      onRetrySuccess: async ({ attempt, failures, error }) => {
        await emit(options, 'cloud.fetch_recovered', {
          path: relativePath,
          attempts: attempt,
          failures,
          reason: error instanceof Error ? error.message : error != null ? String(error) : null,
          code: error?.code ?? error?.cause?.code ?? null,
        })
      },
    })
}

export async function hydrateWorkspaceFile(options) {
  await hydrateWorkspacePaths(options, {
    action: 'hydrate-file',
    reason: 'lazy-hydrate',
    event: 'file.lazy_hydrated',
    recursive: false,
    withSiblings: Boolean(options['with-siblings']),
  })
}

export async function hydrateWorkspacePath(options) {
  await hydrateWorkspacePaths(options, {
    action: 'hydrate-path',
    reason: 'hydrate-path',
    event: 'file.lazy_hydrated',
    recursive: Boolean(options.recursive),
  })
}

export async function hydrateWorkspacePaths(options, command) {
  const requestedPath = options.path ?? options.file
  if (!requestedPath) {
    throw new Error(`workspace ${command.action} requires --path <cloud-path>.`)
  }
  await assertWorkspacePathSafe(options)
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readVisibleGraph(visibilityRequestFromOptions(options))
  const selection = selectedHydrationPathsForCommand(cloud, requestedPath, options, command)
  const hydrationResult = await materializeHydrationPaths(options, cloud, cloudService, selection.paths, {
    reason: command.reason,
    lastEvent: command.event,
  })
  const hydratedFiles = hydrationResult.hydrated.map((file) => ({
    path: file.path,
    file: cloud.files[file.path],
    entry: file.entry,
  }))
  const hydratedPaths = hydrationResult.indexedHydratedPaths

  await emit(options, command.event, {
    path: hydratedFiles.length === 1 ? hydratedFiles[0].path : null,
    paths: hydratedFiles.map((file) => file.path),
    requestedPath,
    plannedPaths: selection.paths,
    recursive: command.recursive,
    withSiblings: Boolean(command.withSiblings),
    scope: hydratedFiles.length === 1 ? scopeForPath(hydratedFiles[0].path) : null,
    scopeCounts: countPathScopes(hydratedFiles.map((file) => file.path)),
    bytes: hydrationResult.bytesHydrated,
    workspace: options.workspace,
    service: cloudService.type,
    contract: summarizeGraphContract(cloud),
    hydratedPathCount: hydratedPaths.length,
    skipped: hydrationResult.skipped,
    blocked: hydrationResult.blocked,
  })
  const index = hydrationResult.index

  console.log(JSON.stringify({
    ok: true,
    action: command.action,
    path: hydratedFiles.length === 1 ? hydratedFiles[0].path : null,
    paths: hydratedFiles.map((file) => file.path),
    plannedPaths: selection.paths,
    recursive: command.recursive,
    withSiblings: Boolean(command.withSiblings),
    budgetReason: selection.budgetReason,
    hydrated: hydratedFiles.length,
    skipped: hydrationResult.skipped,
    blocked: hydrationResult.blocked,
    workspace: path.resolve(options.workspace),
    file: hydratedFiles.length === 1
      ? workspaceFileMetadata(options, hydratedFiles[0].path, hydratedFiles[0].file, {
        forceExists: true,
        indexedCodebase: findIndexedCodebase(index, cloud.codebase?.id ?? options['codebase-id'], options.workspace),
      })
      : null,
    files: hydratedFiles.map(({ path: relativePath, file }) =>
      workspaceFileMetadata(options, relativePath, file, {
        forceExists: true,
        indexedCodebase: findIndexedCodebase(index, cloud.codebase?.id ?? options['codebase-id'], options.workspace),
      }),
    ),
    index: workspaceIndexSummary(options, index),
    hydration: findIndexedCodebase(index, cloud.codebase?.id ?? options['codebase-id'], options.workspace)?.hydration ?? null,
  }, null, 2))
}

export async function openWorkspace(options) {
  await assertWorkspacePathSafe(options)
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readVisibleGraph(visibilityRequestFromOptions(options))
  const requester = summarizeRequester(cloud.visibilityContext)
  const workspaceIndex = await readWorkspaceIndex(options)
  const indexedCodebase = findIndexedCodebase(workspaceIndex, cloud.codebase?.id ?? options['codebase-id'], options.workspace)
  const maxFiles = parseNonNegativeIntegerOption(options['open-max-files'], defaultOpenHydrationMaxFiles)
  const maxBytes = parseNonNegativeIntegerOption(options['open-max-bytes'], defaultOpenHydrationMaxBytes)
  const smallFileBytes = parseNonNegativeIntegerOption(options['open-small-file-bytes'], defaultOpenHydrationSmallFileBytes)
  const started = {
    workspace: options.workspace,
    revision: cloud.revision,
    service: cloudService.type,
    contract: summarizeGraphContract(cloud),
    requester,
    adapter: workspaceMode.adapter,
    cacheMode: workspaceMode.cacheMode,
    budgets: {
      maxFiles,
      maxBytes,
      smallFileBytes,
    },
    scopeCounts: countCloudScopes(cloud),
    hiddenScopeCounts: cloud.visibilityContext?.hiddenScopeCounts ?? { shared: 0, private: 0 },
  }

  await emit(options, 'workspace.opened', started)

  const journalSafety = await readJournalSafety(options)
  if (!journalSafety.safe) {
    const result = openHydrationSkippedResult(started, 'journal_has_unresolved_entries', {
      journal: journalSafety.summary,
      pendingCount: journalSafety.pendingEntries.length,
      failedCount: journalSafety.failedEntries.length,
    })
    await persistOpenHydrationResult(options, cloud, indexedCodebase, result)
    await emit(options, 'workspace.open_hydration.skipped', result)
    console.log(JSON.stringify(result, null, 2))
    return
  }

  const localChanges = existsSync(options.workspace)
    ? await workspaceLocalChanges(options, indexedCodebase)
    : { safe: true, state: 'missing', reason: null }
  if (!localChanges.safe) {
    const result = openHydrationSkippedResult(started, 'workspace_has_unjournaled_changes', {
      localChanges,
    })
    await persistOpenHydrationResult(options, cloud, indexedCodebase, result)
    await emit(options, 'workspace.open_hydration.skipped', result)
    console.log(JSON.stringify(result, null, 2))
    return
  }

  const plan = buildOpenHydrationPlan(cloud, indexedCodebase, {
    maxFiles,
    maxBytes,
    smallFileBytes,
  })
  const hydrated = await materializeHydrationPaths(options, cloud, cloudService, plan.paths, {
    reason: 'workspace-open',
    lastEvent: 'workspace.open_hydration',
  })
  const state = plan.budgetReason || hydrated.blocked.length > 0 ? 'partial' : 'applied'
  const result = {
    ok: true,
    action: 'open',
    state,
    reason: null,
    workspace: path.resolve(options.workspace),
    revision: cloud.revision,
    service: cloudService.type,
    requester,
    budgets: started.budgets,
    plannedPathCount: plan.paths.length,
    plannedPaths: plan.paths,
    hydratedPathCount: hydrated.hydrated.length,
    hydratedPaths: hydrated.hydrated.map((entry) => entry.path),
    skippedPathCount: hydrated.skipped.length,
    skippedPaths: hydrated.skipped,
    blockedPathCount: hydrated.blocked.length,
    blockedPaths: hydrated.blocked,
    bytesHydrated: hydrated.bytesHydrated,
    budgetReason: plan.budgetReason,
    consideredPathCount: plan.consideredPathCount,
    hiddenScopeCounts: cloud.visibilityContext?.hiddenScopeCounts ?? { shared: 0, private: 0 },
    hydration: findIndexedCodebase(hydrated.index, cloud.codebase?.id ?? options['codebase-id'], options.workspace)?.hydration ?? null,
  }
  const eventName = state === 'partial' ? 'workspace.open_hydration.partial' : 'workspace.open_hydration.applied'
  const index = await persistOpenHydrationResult(options, cloud, indexedCodebase, result, hydrated.indexedHydratedPaths)
  result.index = workspaceIndexSummary(options, index)
  await emit(options, eventName, result)
  console.log(JSON.stringify(result, null, 2))
}

export async function materializeHydrationPaths(options, cloud, cloudService, paths, metadata = {}) {
  await fs.mkdir(options.workspace, { recursive: true })
  const now = new Date().toISOString()
  const codebaseId = cloud.codebase?.id ?? options['codebase-id'] ?? 'hopit'
  const workspaceIndex = await readWorkspaceIndex(options)
  const indexedCodebase = findIndexedCodebase(workspaceIndex, codebaseId, options.workspace)
  const diskEntries = await readWorkspaceFiles(options.workspace, options)
  const hydrated = []
  const skipped = []
  const blocked = []
  let bytesHydrated = 0

  for (const relativePath of uniqueHydrationPaths(paths)) {
    const file = cloud.files?.[relativePath]
    if (!file) {
      blocked.push({ path: relativePath, reason: 'not_visible_or_missing' })
      continue
    }

    const entry = normalizeCloudFileEntry(relativePath, file)
    const manifestEntry = indexedCodebase?.contentManifest?.files?.[relativePath] ?? null
    if (diskEntries[relativePath] && manifestMatchesCloudEntry(manifestEntry, entry)) {
      skipped.push({ path: relativePath, reason: 'already_hydrated_clean' })
      continue
    }

    if (entry.clientEncryption?.state === 'client-encrypted' && !rawClientEncryptionKey(options)) {
      blocked.push({ path: relativePath, reason: 'client_encryption_key_missing' })
      continue
    }

    try {
      await materializeCloudEntry(options.workspace, relativePath, entry, cloudService, {
        codebaseId,
      })
      await emit(options, 'file.hydrated', {
        path: relativePath,
        scope: scopeForPath(relativePath),
        privacyZone: entry.privacyZone ?? privacyZoneForPath(relativePath),
        kind: entry.kind,
        bytes: entry.size,
        revision: entry.revision,
      })
      hydrated.push({ path: relativePath, entry })
      bytesHydrated += entry.size ?? 0
    } catch (error) {
      blocked.push({
        path: relativePath,
        reason: error instanceof Error ? error.message : 'hydrate_failed',
      })
    }
  }

  const hydratedPaths = await hydratedPathUnion(options, codebaseId, hydrated.map((file) => file.path))
  const visiblePaths = Object.keys(cloud.files ?? {})
  const hydrationState = hydrationStateForHydratedPaths(hydratedPaths, visiblePaths)
  const localCache = localCachePatchForHydrationResult(cloud, {
    hydrated,
    blocked,
    now,
  })
  const index = await upsertWorkspaceIndexFromCloud(options, cloud, {
    reason: metadata.reason ?? 'hydrate-path',
    lastEvent: metadata.lastEvent ?? 'file.hydrated',
    hydrationState,
    hydratedPaths,
    materialization: materializationForHydrationState(hydrationState),
    localCache,
  })

  return {
    hydrated,
    skipped,
    blocked,
    bytesHydrated,
    indexedHydratedPaths: hydratedPaths,
    index,
  }
}

function openHydrationSkippedResult(started, reason, detail = {}) {
  return {
    ok: true,
    action: 'open',
    state: 'skipped',
    reason,
    workspace: path.resolve(started.workspace),
    revision: started.revision,
    service: started.service,
    requester: started.requester,
    budgets: started.budgets,
    plannedPathCount: 0,
    plannedPaths: [],
    hydratedPathCount: 0,
    hydratedPaths: [],
    skippedPathCount: 0,
    skippedPaths: [],
    blockedPathCount: 0,
    blockedPaths: [],
    bytesHydrated: 0,
    budgetReason: null,
    hiddenScopeCounts: started.hiddenScopeCounts,
    ...detail,
  }
}

async function persistOpenHydrationResult(options, cloud, indexedCodebase, result, hydratedPaths = null) {
  const existingHydratedPaths = hydratedPaths ?? indexedCodebase?.hydratedPaths ?? []
  const hydrationState = hydrationStateForHydratedPaths(existingHydratedPaths, Object.keys(cloud.files ?? {}))
  return upsertWorkspaceIndexFromCloud(options, cloud, {
    reason: 'workspace-open',
    lastEvent: result.state === 'skipped' ? 'workspace.open_hydration.skipped' : 'workspace.open_hydration',
    hydrationState,
    hydratedPaths: existingHydratedPaths,
    materialization: materializationForHydrationState(hydrationState),
    openHydration: {
      at: new Date().toISOString(),
      state: result.state,
      reason: result.reason,
      plannedPathCount: result.plannedPathCount,
      plannedPaths: result.plannedPaths,
      hydratedPathCount: result.hydratedPathCount,
      hydratedPaths: result.hydratedPaths,
      skippedPathCount: result.skippedPathCount,
      skippedPaths: result.skippedPaths,
      blockedPathCount: result.blockedPathCount,
      blockedPaths: result.blockedPaths,
      bytesHydrated: result.bytesHydrated,
      budgetReason: result.budgetReason,
      budgets: result.budgets,
    },
  })
}

function localCachePatchForHydrationResult(cloud, result) {
  const files = {}
  for (const { path: relativePath, entry } of result.hydrated) {
    files[relativePath] = {
      state: 'hydrated',
      lastHydratedAt: result.now,
      bytesOnDisk: entry.size ?? null,
    }
  }
  for (const blocked of result.blocked) {
    files[blocked.path] = {
      state: 'blocked',
      bytesOnDisk: null,
    }
  }
  return {
    schemaVersion: localCacheSchemaVersion,
    updatedAt: result.now,
    files,
  }
}

function uniqueHydrationPaths(paths) {
  return Array.from(new Set(paths.map((value) => String(value)))).sort()
}

function manifestMatchesCloudEntry(manifestEntry, cloudEntry) {
  if (!manifestEntry) return false
  return (
    manifestEntry.kind === cloudEntry.kind &&
    manifestEntry.hash === cloudEntry.hash &&
    manifestEntry.size === cloudEntry.size &&
    manifestEntry.scope === cloudEntry.scope &&
    (manifestEntry.privacyZone ?? null) === (cloudEntry.privacyZone ?? null) &&
    (manifestEntry.target ?? null) === (cloudEntry.target ?? null)
  )
}

export async function dehydrateWorkspace(options) {
  if (!options.force) {
    throw new Error('workspace dehydrate requires --force because it removes local cached file contents.')
  }
  await assertWorkspacePathSafe(options)
  const journalSafety = await readJournalSafety(options)
  if (!journalSafety.safe) {
    throw new Error('Cannot dehydrate while the local journal has pending or failed entries.')
  }

  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readVisibleGraph(visibilityRequestFromOptions(options))
  const removedPaths = []
  for (const relativePath of sortPathsDeepestFirst(Object.keys(cloud.files ?? {}))) {
    const absolutePath = workspaceFilePath(options.workspace, relativePath)
    if (!existsSync(absolutePath)) continue
    await fs.rm(absolutePath, { recursive: true, force: true })
    await removeEmptyAncestorDirectories(options.workspace, path.dirname(relativePath))
    removedPaths.push(relativePath)
  }

  await writeWorkspaceMetadataManifest(options, cloud, {
    materialization: 'metadata-only',
    removedPaths,
  })
  await emit(options, 'workspace.dehydrated', {
    workspace: options.workspace,
    removed: removedPaths.length,
    removedScopeCounts: countPathScopes(removedPaths),
    revision: cloud.revision,
    service: cloudService.type,
    contract: summarizeGraphContract(cloud),
  })
  const index = await upsertWorkspaceIndexFromCloud(options, cloud, {
    reason: 'dehydrate',
    lastEvent: 'workspace.dehydrated',
    hydrationState: 'metadata-only',
    hydratedPaths: [],
    materialization: 'metadata-only',
  })

  console.log(JSON.stringify({
    ok: true,
    action: 'dehydrate',
    removed: removedPaths.length,
    removedScopeCounts: countPathScopes(removedPaths),
    workspace: path.resolve(options.workspace),
    index: workspaceIndexSummary(options, index),
  }, null, 2))
}

export async function pruneWorkspaceCache(options) {
  await assertWorkspacePathSafe(options)
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readVisibleGraph(visibilityRequestFromOptions(options))
  const target = options.path ?? 'all'
  const targetPaths = selectedCloudPaths(cloud, target, { recursive: target === 'all' || Boolean(options.recursive) })
  const [workspaceIndex, diskEntries, journalEntries, eventEntries] = await Promise.all([
    readWorkspaceIndex(options),
    readWorkspaceFiles(options.workspace, options),
    readNdjson(options.journal),
    readNdjson(options.events),
  ])
  const journalState = classifyJournalEntries(journalEntries, eventEntries)
  const indexedCodebase = findIndexedCodebase(workspaceIndex, cloud.codebase?.id ?? options['codebase-id'], options.workspace)
  const inactiveMs = parseNonNegativeIntegerOption(options['inactive-ms'], 0)
  const now = new Date().toISOString()
  const nowMs = Date.now()
  const candidates = []
  const skipped = []

  for (const relativePath of targetPaths) {
    const diskEntry = diskEntries[relativePath]
    const cached = indexedCodebase?.localCache?.files?.[relativePath] ?? {}
    const manifestEntry = indexedCodebase?.contentManifest?.files?.[relativePath] ?? null
    const pathJournalEntries = journalState.entries.filter((entry) => entry.path === relativePath)
    const unresolved = pathJournalEntries.find((entry) => entry.recoveryStatus === 'pending' || entry.recoveryStatus === 'failed')

    if (!diskEntry) {
      skipped.push({ path: relativePath, reason: 'not_hydrated' })
      continue
    }
    if (cached.pinned) {
      skipped.push({ path: relativePath, reason: 'pinned' })
      continue
    }
    if (unresolved) {
      skipped.push({ path: relativePath, reason: `journal_${unresolved.recoveryStatus}` })
      continue
    }
    if (!manifestEntry) {
      skipped.push({ path: relativePath, reason: 'not_acknowledged_in_manifest' })
      continue
    }
    if (manifestEntryChanged(manifestEntry, normalizeCloudFileEntry(relativePath, diskEntry))) {
      skipped.push({ path: relativePath, reason: 'dirty' })
      continue
    }
    if (inactiveMs > 0) {
      const lastActiveAt = latestIsoTimestamp([
        cached.lastSyncedAt,
        cached.lastHydratedAt,
        cached.lastEditedAt,
      ])
      if (lastActiveAt && nowMs - new Date(lastActiveAt).getTime() < inactiveMs) {
        skipped.push({ path: relativePath, reason: 'recently_active', lastActiveAt })
        continue
      }
    }

    candidates.push({
      path: relativePath,
      size: Number.isInteger(diskEntry.size) ? diskEntry.size : manifestEntry.size ?? null,
      revision: manifestEntry.revision ?? null,
    })
  }

  const execute = Boolean(options.execute)
  const removedPaths = []
  if (execute) {
    for (const candidate of candidates) {
      await fs.rm(workspaceFilePath(options.workspace, candidate.path), { recursive: true, force: true })
      await removeEmptyAncestorDirectories(options.workspace, path.dirname(candidate.path))
      removedPaths.push(candidate.path)
    }
  }

  let index = workspaceIndex
  if (execute && removedPaths.length > 0) {
    const visiblePaths = Object.keys(cloud.files ?? {})
    const hydratedPaths = hydratedPathsAfterPrune(indexedCodebase, visiblePaths, removedPaths)
    const hydrationState = hydrationStateForHydratedPaths(hydratedPaths, visiblePaths)
    index = await upsertWorkspaceIndexFromCloud(options, cloud, {
      reason: 'prune',
      lastEvent: 'cache.evicted',
      hydrationState,
      hydratedPaths,
      materialization: materializationForHydrationState(hydrationState),
      prunedPaths: removedPaths,
      localCache: localCachePatchForPaths(cloud, removedPaths, {
        now,
        state: 'cloud-only',
        lastPrunedAt: now,
        bytesOnDisk: null,
      }),
    })
  }

  const result = {
    ok: true,
    action: 'prune',
    mode: execute ? 'execute' : 'dry-run',
    target,
    recursive: target === 'all' || Boolean(options.recursive),
    inactiveMs,
    workspace: path.resolve(options.workspace),
    candidates,
    candidateCount: candidates.length,
    candidateBytes: candidates.reduce((sum, candidate) => sum + (candidate.size ?? 0), 0),
    removed: removedPaths.length,
    removedPaths,
    skipped,
    skippedCount: skipped.length,
    index: workspaceIndexSummary(options, index),
    hydration: findIndexedCodebase(index, cloud.codebase?.id ?? options['codebase-id'], options.workspace)?.hydration ?? null,
  }
  await emit(options, execute ? 'cache.evicted' : 'cache.prune_planned', result)
  console.log(JSON.stringify(result, null, 2))
}

export async function setWorkspaceCachePin(options, pinned) {
  const requestedPath = options.path ?? options.file
  if (!requestedPath) {
    throw new Error(`workspace ${pinned ? 'pin' : 'unpin'} requires --path <cloud-path>.`)
  }

  await assertWorkspacePathSafe(options)
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readVisibleGraph(visibilityRequestFromOptions(options))
  const paths = selectedCloudPaths(cloud, requestedPath, { recursive: Boolean(options.recursive) })
  const now = new Date().toISOString()
  const workspaceIndex = await readWorkspaceIndex(options)
  const indexedCodebase =
    findIndexedCodebase(workspaceIndex, cloud.codebase?.id ?? options['codebase-id'], options.workspace) ??
    workspaceIndexEntryFromCloud(options, cloud, {
      reason: 'attach',
      lastEvent: null,
      hydrationState: 'metadata-only',
      hydratedPaths: [],
      materialization: 'metadata-only',
      now,
    })
  const files = {}
  for (const relativePath of paths) {
    const exists = existsSync(workspaceFilePath(options.workspace, relativePath))
    files[relativePath] = {
      pinned,
      state: pinned ? 'pinned' : exists ? 'hydrated' : 'cloud-only',
    }
  }
  const localCache = {
    schemaVersion: localCacheSchemaVersion,
    updatedAt: now,
    files,
  }
  const index = await upsertWorkspaceIndex(options, {
    ...indexedCodebase,
    localCache,
    updatedAt: now,
  })

  const result = {
    ok: true,
    action: pinned ? 'pin' : 'unpin',
    path: paths.length === 1 ? paths[0] : null,
    paths,
    recursive: Boolean(options.recursive),
    workspace: path.resolve(options.workspace),
    index: workspaceIndexSummary(options, index),
    cache: findIndexedCodebase(index, cloud.codebase?.id ?? options['codebase-id'], options.workspace)?.localCache?.summary ?? null,
  }
  await emit(options, pinned ? 'cache.pinned' : 'cache.unpinned', result)
  console.log(JSON.stringify(result, null, 2))
}

export async function discoverWorkspaces(options, discoverOptions = {}) {
  const action = discoverOptions.action ?? 'discover'
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readOptionalVisibleGraph(visibilityRequestFromOptions(options))
  const cloudDiscovery = await discoverCloudCodebases(options, cloudService, cloud)
  const index = await readWorkspaceIndex(options)
  const rootPath = path.resolve(workspaceRootFromOptions(options))
  const codebases = []

  if (cloudDiscovery.discovery.startsWith('configured-codebase') && cloud?.codebase) {
    codebases.push(discoveredCloudCodebase(options, cloud, index, cloudService))
  } else if (cloudDiscovery.codebases.length > 0) {
    for (const cloudCodebase of cloudDiscovery.codebases) {
      codebases.push(discoveredCloudCodebaseHead(options, cloudCodebase, index, cloudService))
    }
  } else if (cloud?.codebase) {
    codebases.push(discoveredCloudCodebase(options, cloud, index, cloudService))
  }

  const discoveredKeys = new Set(codebases.map((entry) => workspaceIndexEntryKey(entry)))
  for (const indexedCodebase of index?.codebases ?? []) {
    const key = workspaceIndexEntryKey(indexedCodebase)
    if (discoveredKeys.has(key)) continue
    codebases.push({
      ...indexedCodebase,
      source: 'workspace-index',
      attached: true,
      available: false,
    })
  }

  console.log(JSON.stringify({
    ok: true,
    action,
    root: {
      path: rootPath,
      exists: existsSync(rootPath),
      adapter: workspaceMode.adapter,
      cacheMode: workspaceMode.cacheMode,
      sourceOfTruth: workspaceMode.sourceOfTruth,
      virtualized: false,
      index: workspaceIndexSummary(options, index),
    },
    cloud: {
      service: cloudService.type,
      path: cloudService.location ?? cloudLocationFromOptions(options),
      exists: Boolean(cloud),
      discovery: cloudDiscovery.discovery,
      error: cloudDiscovery.error,
    },
    codebases,
  }, null, 2))
}

export async function discoverCloudCodebases(options, cloudService, configuredCloud) {
  if (typeof cloudService.listCodebases !== 'function') {
    return {
      discovery: 'configured-codebase',
      codebases: configuredCloud?.codebase ? [graphHeadFromGraph(configuredCloud)] : [],
      error: null,
    }
  }

  try {
    const codebases = (await cloudService.listCodebases(visibilityRequestFromOptions(options)))
      .map(normalizeCloudGraphHead)
      .filter((codebase) => codebase?.codebase?.id)
    return {
      discovery: codebases.length > 0 ? 'account-codebases' : 'account-codebases-empty',
      codebases,
      error: null,
    }
  } catch (error) {
    return {
      discovery: 'configured-codebase-fallback',
      codebases: configuredCloud?.codebase ? [graphHeadFromGraph(configuredCloud)] : [],
      error: error instanceof Error ? error.message : 'Account-wide codebase discovery failed.',
    }
  }
}

export async function attachWorkspace(options) {
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readVisibleGraph(visibilityRequestFromOptions(options))
  const attachOptions = workspaceOptionsForCloudCodebase(options, cloud)
  await assertWorkspacePathSafe(attachOptions)
  const index = await readWorkspaceIndex(attachOptions)
  const existing = findIndexedCodebase(
    index,
    cloud.codebase?.id ?? attachOptions['codebase-id'],
    attachOptions.workspace,
  )

  if (existing && existing.hydration?.state !== 'metadata-only' && !options.force) {
    const result = {
      ok: true,
      action: 'attach',
      alreadyAttached: true,
      root: workspaceIndexRoot(attachOptions),
      workspace: path.resolve(attachOptions.workspace),
      codebase: existing,
      files: {
        visible: existing.visibleFileCount ?? Object.keys(cloud.files ?? {}).length,
        hydrated: existing.hydration?.hydratedPathCount ?? null,
        materialization: existing.materialization ?? null,
      },
      index: workspaceIndexSummary(attachOptions, index),
      note: 'Existing attached workspace was left unchanged. Use hydrate-file, hydrate, or refresh for materialization changes.',
    }
    if (!options.quiet) console.log(JSON.stringify(result, null, 2))
    return result
  }

  await assertAttachWorkspaceSafe(attachOptions, cloud, index)

  await fs.mkdir(workspaceRootFromOptions(attachOptions), { recursive: true })
  await fs.mkdir(attachOptions.workspace, { recursive: true })
  await writeWorkspaceMetadataManifest(attachOptions, cloud, {
    materialization: 'metadata-only',
    attached: true,
  })

  await emit(attachOptions, 'workspace.attached', {
    workspace: attachOptions.workspace,
    codebaseId: cloud.codebase?.id ?? attachOptions['codebase-id'] ?? null,
    codebaseName: cloud.codebase?.name ?? null,
    revision: cloud.revision,
    service: cloudService.type,
    contract: summarizeGraphContract(cloud),
    requester: summarizeRequester(cloud.visibilityContext),
    adapter: workspaceMode.adapter,
    cacheMode: workspaceMode.cacheMode,
    materialization: 'metadata-only',
    visibleFileCount: Object.keys(cloud.files ?? {}).length,
    scopeCounts: countCloudScopes(cloud),
    hiddenScopeCounts: cloud.visibilityContext?.hiddenScopeCounts ?? { shared: 0, private: 0 },
  })

  const attachedIndex = await upsertWorkspaceIndexFromCloud(attachOptions, cloud, {
    reason: 'attach',
    lastEvent: 'workspace.attached',
    hydrationState: 'metadata-only',
    hydratedPaths: [],
    materialization: 'metadata-only',
  })
  const indexedCodebase = findIndexedCodebase(
    attachedIndex,
    cloud.codebase?.id ?? attachOptions['codebase-id'],
    attachOptions.workspace,
  )

  const result = {
    ok: true,
    action: 'attach',
    alreadyAttached: Boolean(existing),
    root: workspaceIndexRoot(attachOptions),
    workspace: path.resolve(attachOptions.workspace),
    codebase: indexedCodebase,
    files: {
      visible: Object.keys(cloud.files ?? {}).length,
      hydrated: 0,
      materialization: 'metadata-only',
    },
    index: workspaceIndexSummary(attachOptions, attachedIndex),
  }
  if (!options.quiet) console.log(JSON.stringify(result, null, 2))
  return result
}

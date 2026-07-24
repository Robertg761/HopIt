// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import { canRequesterSeePath, createCloudGraphService, filterVisibleGraphForRequester, removeEmptyAncestorDirectories, summarizeGraphContract, summarizeRequester, visibilityContextForGraph, visibilityRequestFromOptions } from '../cloud/d1-graph-service.js'
import { bulkJournalCommitChunkSize, bulkJournalCommitThreshold, ConflictError, defaultLargeFileThresholdBytes, entryKind, refreshMassDeleteFraction, refreshMassDeleteMinFiles, workspaceMode } from '../constants.js'
import { privacyZoneForPath } from '@hopit/core/crypto'
import { appendNdjson, emit, findLastEventOf, readNdjson } from '../io.js'
import { actorIdFromOptions, bufferFromCloudFileEntry, cloudEntryEquals, countCloudScopes, countEntryScopes, countPathScopes, ensureActiveChangeSet, journalContextForCloud, normalizeCloudFileEntry, recordChangeSetConflict } from '../journal.js'
import { assertWorkspacePathSafe } from '../paths.js'
import { partitionEntriesForReconnect } from '../reconnect.js'
import { classifyJournalEntries, hasUnresolvedSyncFailure, prepareRecovery, readJournalSafety, syncContextDetail, visibleRevisionFromEvent } from '../status-state.js'
import { deletableCloudPathsForWorkspace, findIndexedCodebase, hydratedPathsAfterSync, readWorkspaceIndex, upsertWorkspaceIndexFromCloud, workspaceIndexHydrationStateForSync } from '../workspace-index.js'
import { exoneratedLocalChanges, readWorkspaceFiles, withheldRefreshPaths, workspaceFilePath, workspaceLocalChanges } from '../workspace-manifest.js'
import { isScannableTextEntry, scanTextForSecrets } from '../secret-scan.js'
import { scopeForPath } from '@hopit/core/privacy-zone'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'

// GR-C1 (decisions §6): resolves the per-codebase derived-path add/remove
// overrides once per sync-triggering call (never per file) and layers them
// onto a shallow options copy for the workspace scan that follows. Best-effort:
// a codebase-settings read failure must never block sync, so it falls back to
// curated-only classification (no overrides) rather than throwing. Callers that
// already resolved overrides (e.g. tests injecting `options.derivedPathOverrides`
// directly) are passed through unchanged.
export async function withDerivedPathOverrides(options, cloudService) {
  if (options.derivedPathOverrides) return options
  try {
    const settings = await cloudService.readCodebaseSettings()
    return { ...options, derivedPathOverrides: settings?.derivedPathOverrides }
  } catch {
    return options
  }
}

export async function refreshWorkspace(options) {
  await assertWorkspacePathSafe(options)
  const cloudService = createCloudGraphService(options)
  const visibilityRequest = visibilityRequestFromOptions(options)
  const cloud = await cloudService.readVisibleGraph(visibilityRequest)
  const eventEntries = await readNdjson(options.events)
  const lastVisibleWorkspaceEvent = findLastEventOf(eventEntries, [
    'workspace.ready',
    'refresh.complete',
    'remote-update',
  ])
  const journalSafety = await readJournalSafety(options)
  const startedDetail = {
    workspace: options.workspace,
    revision: cloud.revision,
    service: cloudService.type,
    contract: summarizeGraphContract(cloud),
    requester: summarizeRequester(cloud.visibilityContext),
    adapter: workspaceMode.adapter,
    cacheMode: workspaceMode.cacheMode,
    scopeCounts: countCloudScopes(cloud),
    hiddenScopeCounts: cloud.visibilityContext?.hiddenScopeCounts ?? { shared: 0, private: 0 },
    journal: journalSafety.summary,
  }

  await emit(options, 'refresh.started', startedDetail)

  if (!journalSafety.safe) {
    const blockedDetail = {
      ...startedDetail,
      state: 'blocked',
      reason: 'journal_has_unresolved_entries',
      pendingCount: journalSafety.pendingEntries.length,
      failedCount: journalSafety.failedEntries.length,
      pendingScopeCounts: countEntryScopes(journalSafety.pendingEntries),
      failedScopeCounts: countEntryScopes(journalSafety.failedEntries),
    }
    await emit(options, 'refresh.blocked', blockedDetail)
    throw new Error('Refresh blocked because the local journal has pending or failed entries.')
  }

  const workspaceIndex = await readWorkspaceIndex(options)
  const indexedCodebase = findIndexedCodebase(workspaceIndex, cloud.codebase?.id ?? options['codebase-id'], options.workspace)
  const rawLocalChanges = existsSync(options.workspace)
    ? await workspaceLocalChanges(options, indexedCodebase, { includePaths: true })
    : { safe: true, state: 'missing', reason: null }

  // A stale content manifest can flag already-committed files as unjournaled
  // and deadlock refresh (the only thing that rebuilds the manifest). Exonerate
  // against the cloud graph we just read: if every reported change already
  // matches cloud, the refresh below rebuilds the manifest and self-heals.
  // The exonerated result is compact (counts + ≤10-path samples), so embedding
  // it in the refresh.blocked detail below stays bounded.
  let localChanges = rawLocalChanges
  let diskEntriesForWithhold = null
  if (!rawLocalChanges.safe) {
    diskEntriesForWithhold = await readWorkspaceFiles(options.workspace, options)
    localChanges = exoneratedLocalChanges(rawLocalChanges, cloud, diskEntriesForWithhold)
  }
  const manifestSelfHealed = Boolean(localChanges?.manifestStale)

  // GR-F1 (decisions §10): a whole-workspace block only remains for the outer
  // safety gates — a workspace that is missing entirely or whose content
  // manifest cannot be trusted. Genuine per-file drift (`dirty`) is relaxed:
  // those specific paths are withheld and flagged below instead of blocking
  // every other file's refresh.
  if (!localChanges.safe && localChanges.state !== 'dirty') {
    const blockedDetail = {
      ...startedDetail,
      state: 'blocked',
      reason: localChanges.reason,
      localChanges,
    }
    await emit(options, 'refresh.blocked', blockedDetail)
    throw new Error('Refresh blocked because the local workspace has unjournaled changes.')
  }

  const withheldPaths = !localChanges.safe
    ? withheldRefreshPaths(rawLocalChanges, cloud, diskEntriesForWithhold ?? {})
    : []

  const result = await materializeCloudToWorkspace(options, cloud, cloudService, { withheldPaths })
  if (result.written > 0 || result.deleted > 0) {
    await emit(options, 'remote-update', {
      workspace: options.workspace,
      service: cloudService.type,
      contract: summarizeGraphContract(cloud),
      requester: summarizeRequester(cloud.visibilityContext),
      selectedStateId: cloud.selectedState?.id ?? null,
      selectedStateType: cloud.selectedState?.type ?? null,
      fromRevision: visibleRevisionFromEvent(lastVisibleWorkspaceEvent),
      toRevision: cloud.revision,
      changedPaths: result.changedPaths,
      deletedPaths: result.deletedPaths,
      changedScopeCounts: countPathScopes(result.changedPaths),
      deletedScopeCounts: countPathScopes(result.deletedPaths),
      scopeCounts: countPathScopes([...result.changedPaths, ...result.deletedPaths]),
      hiddenScopeCounts: cloud.visibilityContext?.hiddenScopeCounts ?? { shared: 0, private: 0 },
    })
  }
  await emit(options, 'refresh.complete', {
    ...startedDetail,
    ...result,
    ...(manifestSelfHealed
      ? {
          manifestSelfHealed: true,
          manifestStaleSamplePaths: localChanges.exoneratedSamplePaths ?? [],
          manifestStalePathCount: localChanges.exoneratedCount ?? 0,
        }
      : {}),
    // GR-F1: withheld paths get their own compact reason distinct from the
    // whole-workspace `workspace_has_unjournaled_changes` block above, so
    // dashboard/menu-bar surfaces can tell "one file is flagged" apart from
    // "refresh is entirely blocked".
    ...(withheldPaths.length > 0
      ? {
          reason: 'file_withheld_local_edits',
          withheldCount: withheldPaths.length,
          withheldSamplePaths: withheldPaths.slice(0, 10),
        }
      : {}),
  })
  await upsertWorkspaceIndexFromCloud(options, cloud, {
    reason: 'refresh',
    lastEvent: 'refresh.complete',
    hydrationState: 'materialized',
    hydratedPaths: Object.keys(cloud.files ?? {}).filter((relativePath) => !withheldPaths.includes(relativePath)),
    // GR-F1: never advance the indexed revision past a withheld path — that
    // would make the cheap "already at head" reconciliation shortcut think
    // the withheld file's remote change was already applied, and stop
    // retrying once the local edit resolves.
    ...(withheldPaths.length > 0
      ? { materializedRevision: indexedCodebase?.hydration?.lastMaterializedRevision ?? null }
      : {}),
  })
  return { ...result, withheldPaths }
}

export async function materializeCloudToWorkspace(options, cloud, cloudService = null, refreshOptions = {}) {
  await fs.mkdir(options.workspace, { recursive: true })

  // GR-F1 (decisions §10): paths carrying genuine unjournaled local drift are
  // withheld from this materialize pass entirely — neither overwritten with
  // the cloud version nor deleted — so the user's local edit survives and the
  // caller can flag it ("Main changed under you") instead of blocking every
  // other file in the workspace.
  const withheldPaths = new Set(refreshOptions.withheldPaths ?? [])

  // cloudService is optional here (materializeCloudToWorkspace is also called
  // with an already-fetched `cloud` graph and no live service); only resolve
  // overrides when a service is actually available rather than forcing one.
  const scanOptions = cloudService ? await withDerivedPathOverrides(options, cloudService) : options
  const diskEntries = await readWorkspaceFiles(options.workspace, scanOptions)
  const cloudPaths = new Set(Object.keys(cloud.files ?? {}))
  const wouldDeletePaths = Object.keys(diskEntries).filter(
    (relativePath) => !cloudPaths.has(relativePath) && !withheldPaths.has(relativePath),
  )

  // Fail closed before any deletion when refresh would wipe an implausible share
  // of the workspace. A guest/zero-visibility read (session id without requester
  // id) reports zero visible files, which would otherwise delete every disk file.
  await assertRefreshDeletionSafe(options, cloud, cloudService, {
    diskFileCount: Object.keys(diskEntries).length,
    visibleFileCount: cloudPaths.size,
    wouldDeleteCount: wouldDeletePaths.length,
  })

  const changedPaths = []
  const deletedPaths = []
  let written = 0
  let deleted = 0
  let unchanged = 0

  for (const [relativePath, file] of Object.entries(cloud.files ?? {})) {
    if (withheldPaths.has(relativePath)) continue

    const entry = normalizeCloudFileEntry(relativePath, file)
    const diskEntry = diskEntries[relativePath] ? normalizeCloudFileEntry(relativePath, diskEntries[relativePath]) : null
    if (diskEntry && cloudEntryEquals(diskEntry, entry)) {
      unchanged += 1
      continue
    }

    await materializeCloudEntry(options.workspace, relativePath, entry, cloudService)
    changedPaths.push(relativePath)
    written += 1
  }

  for (const relativePath of sortPathsDeepestFirst(Object.keys(diskEntries))) {
    if (cloudPaths.has(relativePath)) continue
    if (withheldPaths.has(relativePath)) continue

    await fs.rm(workspaceFilePath(options.workspace, relativePath), { recursive: true, force: true })
    await removeEmptyAncestorDirectories(options.workspace, path.dirname(relativePath))
    deletedPaths.push(relativePath)
    deleted += 1
  }

  return {
    workspace: options.workspace,
    revision: cloud.revision,
    written,
    deleted,
    unchanged,
    changedPaths,
    deletedPaths,
    fileCount: cloudPaths.size,
    scopeCounts: countCloudScopes(cloud),
    hiddenScopeCounts: cloud.visibilityContext?.hiddenScopeCounts ?? { shared: 0, private: 0 },
    withheldCount: withheldPaths.size,
  }
}

export async function assertRefreshDeletionSafe(options, cloud, cloudService, counts) {
  const { diskFileCount, visibleFileCount, wouldDeleteCount } = counts

  // Nothing to delete, or the operator explicitly opted into a mass delete.
  if (wouldDeleteCount === 0) return
  if (options['allow-mass-delete']) return

  const requesterRole = cloud.visibilityContext?.role ?? null
  const hiddenFileCount = cloud.visibilityContext?.hiddenFileCount ?? 0
  const guestLike = requesterRole
    ? requesterRole === 'guest'
    : !cloud.visibilityContext?.isOwner && !cloud.visibilityContext?.isCollaborator

  const emptyGraphWipe = visibleFileCount === 0 && diskFileCount > 0
  const deleteFraction = diskFileCount > 0 ? wouldDeleteCount / diskFileCount : 0
  const massDelete = wouldDeleteCount > refreshMassDeleteMinFiles && deleteFraction > refreshMassDeleteFraction

  if (!emptyGraphWipe && !massDelete) return

  const reason = emptyGraphWipe ? 'visible_graph_empty_local_files_present' : 'refresh_would_mass_delete'
  await emit(options, 'refresh.blocked', {
    state: 'blocked',
    reason,
    workspace: options.workspace,
    revision: cloud.revision,
    service: cloudService?.type ?? null,
    contract: summarizeGraphContract(cloud),
    requester: summarizeRequester(cloud.visibilityContext),
    requesterRole,
    visibleFileCount,
    hiddenFileCount,
    diskFileCount,
    wouldDeleteCount,
    deleteFraction: Number(deleteFraction.toFixed(4)),
  })

  // When the read looks like a guest (or the visible graph is empty while files
  // are hidden), the most likely cause is a missing requester identity rather
  // than a genuine cloud-side deletion: surface that so the operator can fix it.
  const guestHint =
    guestLike || (emptyGraphWipe && hiddenFileCount > 0)
      ? ` This device is reading the cloud as ${requesterRole ?? 'a guest'} and likely has no requester identity configured; set HOPIT_REQUESTER_ID to the codebase owner id (or re-run connected setup) so visibility-filtered reads see the codebase.`
      : ''
  const overrideHint = ' Pass --allow-mass-delete to override if this deletion is intended.'

  if (emptyGraphWipe) {
    throw new Error(
      `Refresh blocked to prevent mass deletion: the visible cloud graph has 0 files but the workspace holds ${diskFileCount} file(s), so refresh would delete all of them (${hiddenFileCount} file(s) hidden from this requester).${guestHint}${overrideHint}`,
    )
  }
  throw new Error(
    `Refresh blocked to prevent mass deletion: refresh would delete ${wouldDeleteCount} of ${diskFileCount} workspace file(s) (${Math.round(deleteFraction * 100)}%).${guestHint}${overrideHint}`,
  )
}

// GR-G2: per-codebase override of the large-file warning threshold, falling
// back to the agent default (100 MB). Missing/misconfigured settings support
// (e.g. a minimal test stub) degrades to the default rather than failing sync.
export async function resolveLargeFileThresholdBytes(cloudService, cloud, options) {
  if (typeof cloudService.readCodebaseSettings !== 'function') return defaultLargeFileThresholdBytes
  try {
    const codebaseId = cloud.codebase?.id ?? options['codebase-id']
    const settings = await cloudService.readCodebaseSettings(codebaseId)
    return Number.isInteger(settings?.largeFileThresholdBytes) && settings.largeFileThresholdBytes > 0
      ? settings.largeFileThresholdBytes
      : defaultLargeFileThresholdBytes
  } catch {
    return defaultLargeFileThresholdBytes
  }
}

export async function materializeCloudEntry(root, relativePath, file, cloudService = null, context = {}) {
  const entry = normalizeCloudFileEntry(relativePath, file)
  const absolutePath = workspaceFilePath(root, relativePath)

  await fs.mkdir(path.dirname(absolutePath), { recursive: true })

  if (entry.kind === entryKind.directory) {
    await replacePathIfWrongType(absolutePath, 'directory')
    await fs.mkdir(absolutePath, { recursive: true })
    return
  }

  if (entry.kind === entryKind.symlink) {
    await fs.rm(absolutePath, { recursive: true, force: true })
    await fs.symlink(entry.target, absolutePath)
    return
  }

  await replacePathIfWrongType(absolutePath, 'file')
  const fetchBody = () => bufferFromCloudFileEntry(entry, cloudService, {
    ...context,
    relativePath,
  })
  // Only the cloud fetch is wrapped in retry-with-backoff (callers that hydrate
  // opt in via context.fetchRetry); the local fs writes below stay single-shot.
  const body = typeof context.fetchRetry === 'function'
    ? await context.fetchRetry(fetchBody, { relativePath })
    : await fetchBody()
  try {
    await fs.writeFile(absolutePath, body)
  } catch (error) {
    // Read-only targets (git stores object files as mode 444) are replaced,
    // not edited in place: the same way git itself rewrites them.
    if (error?.code !== 'EACCES' && error?.code !== 'EPERM') throw error
    await fs.rm(absolutePath, { force: true })
    await fs.writeFile(absolutePath, body)
  }
}

export async function replacePathIfWrongType(absolutePath, expectedType) {
  if (!existsSync(absolutePath)) return

  const stat = await fs.lstat(absolutePath)
  const matches =
    (expectedType === 'file' && stat.isFile()) ||
    (expectedType === 'directory' && stat.isDirectory() && !stat.isSymbolicLink())

  if (!matches) {
    await fs.rm(absolutePath, { recursive: true, force: true })
  }
}

export function sortPathsDeepestFirst(paths) {
  return [...paths].sort((a, b) => {
    const depth = b.split('/').length - a.split('/').length
    return depth || b.localeCompare(a)
  })
}

export async function syncOnce(options, context = {}) {
  const unresolvedFailure = await hasUnresolvedSyncFailure(options)
  const contextDetail = syncContextDetail(context)

  await emit(options, 'sync.started', contextDetail)

  try {
    const result = await performSyncOnce(options, contextDetail)
    if (unresolvedFailure) {
      await emit(options, 'sync.recovered', {
        ...contextDetail,
        lastFailedSync: unresolvedFailure,
        lastSuccessfulSync: result,
      })
    }
    return result
  } catch (error) {
    await emit(options, 'sync.failed', {
      ...contextDetail,
      reason: error.message,
    })
    throw error
  }
}

export async function performSyncOnce(options, contextDetail = {}) {
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()
  const scanOptions = await withDerivedPathOverrides(options, cloudService)
  const diskEntries = await readWorkspaceFiles(options.workspace, scanOptions)
  const visibilityContext = visibilityContextForGraph(cloud, visibilityRequestFromOptions(options))
  const visibleCloudPaths = Object.keys(cloud.files).filter((relativePath) =>
    canRequesterSeePath(visibilityContext, relativePath),
  )
  const workspaceIndex = await readWorkspaceIndex(options)
  const indexedCodebase = findIndexedCodebase(
    workspaceIndex,
    cloud.codebase?.id ?? options['codebase-id'],
    options.workspace,
  )
  const deleteCandidatePaths = deletableCloudPathsForWorkspace(indexedCodebase, visibleCloudPaths)
  const cloudPaths = new Set(
    Object.keys(cloud.files).filter((relativePath) => canRequesterSeePath(visibilityContext, relativePath)),
  )
  const writeEvents = []
  const now = new Date().toISOString()
  const plannedEntries = []
  const planningCloud = structuredClone(cloud)
  const largeFileThresholdBytes = await resolveLargeFileThresholdBytes(cloudService, cloud, options)

  // Lazy + cached: only resolve the per-project secret-scanning setting once,
  // and only if a candidate outbound text file actually turns up below. Never
  // lets a settings-read failure block the sync: fails open to "scan".
  let secretScanningEnabledPromise = null
  const secretScanningEnabled = () => {
    if (!secretScanningEnabledPromise) {
      secretScanningEnabledPromise = (async () => {
        if (typeof cloudService.readCodebaseSettings !== 'function') return true
        try {
          const settings = await cloudService.readCodebaseSettings(cloud.codebase?.id)
          return settings?.secretScanningEnabled !== false
        } catch {
          return true
        }
      })()
    }
    return secretScanningEnabledPromise
  }

  for (const [relativePath, rawEntry] of Object.entries(diskEntries)) {
    if (!canRequesterSeePath(visibilityContext, relativePath)) continue

    const entryPayload = normalizeCloudFileEntry(relativePath, rawEntry)
    const current = planningCloud.files[relativePath]
      ? normalizeCloudFileEntry(relativePath, planningCloud.files[relativePath])
      : null
    const scope = scopeForPath(relativePath)
    cloudPaths.delete(relativePath)

    if (current && cloudEntryEquals(current, entryPayload)) continue

    // GR-G2: large files sync exactly like everything else (no cap, no gate) --
    // this is a purely additive dashboard note, so it must never influence what
    // gets journaled or committed below.
    if (entryPayload.kind === entryKind.file && entryPayload.size > largeFileThresholdBytes) {
      await emit(options, 'file.large', {
        path: relativePath,
        bytes: entryPayload.size,
        thresholdBytes: largeFileThresholdBytes,
      })
    }

    const entry = {
      id: randomUUID(),
      type: current ? 'write' : 'create',
      path: relativePath,
      kind: entryPayload.kind,
      scope,
      privacyZone: privacyZoneForPath(relativePath),
      hash: entryPayload.hash,
      bytes: entryPayload.size,
      encoding: entryPayload.encoding,
      target: entryPayload.target ?? null,
      baseRevision: current?.revision ?? null,
      createdAt: now,
      status: 'pending',
      ...journalContextForCloud(planningCloud),
    }

    plannedEntries.push({ entry, payload: entryPayload })
    cloudService.applyJournalEntry(planningCloud, entry, { entry: entryPayload, now })

    // Scan before upload, warn-only: findings never block or delay the write
    // above. A scan or event-emit failure here must not fail the sync either.
    if (isScannableTextEntry(relativePath, entryPayload)) {
      try {
        if (await secretScanningEnabled()) {
          const findings = scanTextForSecrets(entryPayload.content)
          if (findings.length > 0) {
            await emit(options, 'secret.suspected', {
              path: relativePath,
              scope,
              entryType: entry.type,
              findingCount: findings.length,
              findings,
              ...journalContextForCloud(planningCloud),
            })
          }
        }
      } catch {
        // Never let scanning block or fail the upload.
      }
    }
  }

  for (const relativePath of cloudPaths) {
    if (!deleteCandidatePaths.has(relativePath)) continue

    const scope = scopeForPath(relativePath)
    const entry = {
      id: randomUUID(),
      type: 'delete',
      path: relativePath,
      kind: planningCloud.files[relativePath]?.kind ?? entryKind.file,
      scope,
      privacyZone: privacyZoneForPath(relativePath),
      baseRevision: planningCloud.files[relativePath]?.revision ?? null,
      createdAt: now,
      status: 'pending',
      ...journalContextForCloud(planningCloud),
    }

    plannedEntries.push({ entry, payload: null })
    cloudService.applyJournalEntry(planningCloud, entry, { now })
  }

  writeEvents.push(...await commitPlannedJournalEntries({
    options,
    cloudService,
    cloud,
    plannedEntries,
    now,
    summaryEvent: 'sync.bulk_commit',
  }))

  if (!cloudService.usesAtomicFileMutations) {
    await cloudService.writeGraph(cloud)
  }
  const result = {
    ...contextDetail,
    writes: writeEvents.length,
    revision: cloud.revision,
    service: cloudService.type,
    contract: summarizeGraphContract(cloud),
    scopeCounts: countCloudScopes(cloud),
    journaledScopeCounts: countEntryScopes(writeEvents),
  }
  await emit(options, 'sync.complete', result)
  const visibleCloud = filterVisibleGraphForRequester(cloud, visibilityRequestFromOptions(options))
  await upsertWorkspaceIndexFromCloud(options, visibleCloud, {
    reason: 'sync',
    lastEvent: 'sync.complete',
    hydrationState: workspaceIndexHydrationStateForSync(indexedCodebase),
    hydratedPaths: hydratedPathsAfterSync(indexedCodebase, Object.keys(diskEntries), Object.keys(visibleCloud.files ?? {})),
    syncedPaths: writeEvents.map((entry) => entry.path).filter(Boolean),
  })
  return result
}

export async function recoverJournal(options) {
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()

  const journalEntries = await readNdjson(options.journal)
  const eventEntries = await readNdjson(options.events)
  const journalState = classifyJournalEntries(journalEntries, eventEntries)
  const allCandidates = journalState.entries.filter((entry) => entry.recoveryStatus !== 'acknowledged')

  // Reconnect classification (decisions §1): before replaying anything,
  // sort pending paths into only-local (replay), auto-resolved (identical
  // content, no divergence), and diverged (both touched, content differs).
  // Diverged paths are never replayed and never clobber the local file; they
  // stay pending until resolved outside this command.
  const { replayable: candidates, diverged } = partitionEntriesForReconnect(cloud, allCandidates)
  const recoveredPaths = []
  const result = {
    totalJournalEntries: journalEntries.length,
    attempted: 0,
    acknowledged: 0,
    failed: 0,
    diverged: diverged.length,
    divergedPaths: diverged.map((classification) => classification.path),
    skipped: journalEntries.length - allCandidates.length,
  }

  for (const classification of diverged) {
    await emit(options, 'journal.reconnect_diverged', {
      id: classification.entry.id,
      type: classification.entry.type,
      path: classification.path,
      scope: classification.scope,
      reason: classification.reason,
      baseRevision: classification.baseRevision,
      cloudRevision: classification.cloudRevision,
      cloudHash: classification.cloudHash,
      localHash: classification.localHash,
    })
  }

  if (candidates.length > bulkJournalCommitThreshold && typeof cloudService.commitJournalEntries === 'function') {
    for (let offset = 0; offset < candidates.length; offset += bulkJournalCommitChunkSize) {
      const chunkEntries = candidates.slice(offset, offset + bulkJournalCommitChunkSize)
      const plannedEntries = []
      for (const entry of chunkEntries) {
        result.attempted += 1
        try {
          const recovery = await prepareRecovery(cloud, entry, options.workspace)
          plannedEntries.push({
            entry,
            payload: recovery.entry,
            recoveryReason: recovery.reason,
          })
        } catch (error) {
          result.failed += 1
          await emit(options, 'journal.recovery_failed', {
            id: entry.id,
            type: entry.type,
            path: entry.path,
            scope: entry.scope ?? scopeForPath(entry.path ?? ''),
            reason: error.message,
          })
        }
      }

      const committed = await commitPlannedJournalEntries({
        options,
        cloudService,
        cloud,
        plannedEntries,
        now: new Date().toISOString(),
        summaryEvent: 'sync.bulk_commit',
        journalAlreadyWritten: true,
        acknowledgementDetail: (plan) => ({
          recovered: true,
          recoveryReason: plan.recoveryReason,
        }),
      })
      result.acknowledged += committed.length
      recoveredPaths.push(...committed.map((entry) => entry.path).filter(Boolean))
    }

    await emit(options, 'journal.recovery_complete', {
      ...result,
      revision: cloud.revision,
      service: cloudService.type,
      contract: summarizeGraphContract(cloud),
      scopeCounts: countCloudScopes(cloud),
    })

    if (result.acknowledged > 0 && result.failed === 0) {
      const workspaceIndex = await readWorkspaceIndex(options)
      const indexedCodebase = findIndexedCodebase(
        workspaceIndex,
        cloud.codebase?.id ?? options['codebase-id'],
        options.workspace,
      )
      const scanOptions = await withDerivedPathOverrides(options, cloudService)
      const diskEntries = await readWorkspaceFiles(options.workspace, scanOptions)
      const hydrationState = workspaceIndexHydrationStateForSync(indexedCodebase)
      const visibleCloud = filterVisibleGraphForRequester(cloud, visibilityRequestFromOptions(options))
      await upsertWorkspaceIndexFromCloud(options, visibleCloud, {
        reason: 'recover',
        lastEvent: 'journal.recovery_complete',
        hydrationState,
        hydratedPaths: hydratedPathsAfterSync(indexedCodebase, Object.keys(diskEntries), Object.keys(visibleCloud.files ?? {})),
        materialization: hydrationState === 'materialized' ? 'managed-folder' : 'partial-managed-folder',
        syncedPaths: recoveredPaths,
      })
    }

    return result
  }

  for (const entry of candidates) {
    result.attempted += 1
    const now = new Date().toISOString()

    try {
      const recovery = await prepareRecovery(cloud, entry, options.workspace)
      const acknowledgement = await cloudService.commitJournalEntry(cloud, entry, {
        entry: recovery.entry,
        now,
      })
      await emit(options, 'cloud.acknowledged', {
        ...acknowledgement,
        recovered: true,
        recoveryReason: recovery.reason,
      })
      result.acknowledged += 1
      if (entry.path) recoveredPaths.push(entry.path)
    } catch (error) {
      result.failed += 1
      if (error instanceof ConflictError) {
        const conflict = recordChangeSetConflict(cloud, {
          ...error.detail,
          detectedAt: new Date().toISOString(),
        })
        await cloudService.writeGraph(cloud)
        await emit(options, 'change_set.conflict_detected', conflict)
      }
      await emit(options, 'journal.recovery_failed', {
        id: entry.id,
        type: entry.type,
        path: entry.path,
        scope: entry.scope ?? scopeForPath(entry.path ?? ''),
        reason: error.message,
      })
    }
  }

  await emit(options, 'journal.recovery_complete', {
    ...result,
    revision: cloud.revision,
    service: cloudService.type,
    contract: summarizeGraphContract(cloud),
    scopeCounts: countCloudScopes(cloud),
  })

  if (result.acknowledged > 0 && result.failed === 0) {
    const workspaceIndex = await readWorkspaceIndex(options)
    const indexedCodebase = findIndexedCodebase(
      workspaceIndex,
      cloud.codebase?.id ?? options['codebase-id'],
      options.workspace,
    )
    const scanOptions = await withDerivedPathOverrides(options, cloudService)
    const diskEntries = await readWorkspaceFiles(options.workspace, scanOptions)
    const hydrationState = workspaceIndexHydrationStateForSync(indexedCodebase)
    const visibleCloud = filterVisibleGraphForRequester(cloud, visibilityRequestFromOptions(options))
    await upsertWorkspaceIndexFromCloud(options, visibleCloud, {
      reason: 'recover',
      lastEvent: 'journal.recovery_complete',
      hydrationState,
      hydratedPaths: hydratedPathsAfterSync(indexedCodebase, Object.keys(diskEntries), Object.keys(visibleCloud.files ?? {})),
      materialization: hydrationState === 'materialized' ? 'managed-folder' : 'partial-managed-folder',
      syncedPaths: recoveredPaths,
    })
  }

  return result
}

async function commitPlannedJournalEntries({
  options,
  cloudService,
  cloud,
  plannedEntries,
  now = new Date().toISOString(),
  summaryEvent = 'sync.bulk_commit',
  acknowledgementDetail = null,
  journalAlreadyWritten = false,
}) {
  if (plannedEntries.length === 0) return []

  const useBulk =
    plannedEntries.length > bulkJournalCommitThreshold &&
    typeof cloudService.commitJournalEntries === 'function'

  if (!useBulk) {
    const committed = []
    for (const plan of plannedEntries) {
      if (!journalAlreadyWritten) {
        await appendNdjson(options.journal, plan.entry)
        await emit(options, 'write.journaled', plan.entry)
      }
      const acknowledgement = await cloudService.commitJournalEntry(cloud, plan.entry, {
        entry: plan.payload,
        now,
      })
      await emit(options, 'cloud.acknowledged', {
        ...acknowledgement,
        ...(typeof acknowledgementDetail === 'function' ? acknowledgementDetail(plan) : acknowledgementDetail),
      })
      committed.push(plan.entry)
    }
    return committed
  }

  for (const plan of plannedEntries) {
    if (!journalAlreadyWritten) {
      await appendNdjson(options.journal, plan.entry)
      await emit(options, 'write.journaled', plan.entry)
    }
  }

  const payloads = new Map()
  for (const plan of plannedEntries) {
    if (plan.payload) payloads.set(plan.entry.id, plan.payload)
  }

  const committed = []
  await cloudService.commitJournalEntries(cloud, plannedEntries.map((plan) => plan.entry), {
    entryPayloads: payloads,
    now,
    chunkSize: bulkJournalCommitChunkSize,
    onChunkCommitted: async (chunk) => {
      const scopeCounts = countEntryScopes(chunk.entries)
      await emit(options, summaryEvent, {
        storageMode: chunk.storageMode,
        chunkIndex: chunk.chunkIndex,
        chunkOffset: chunk.chunkOffset,
        count: chunk.count,
        fromRevision: chunk.fromRevision,
        toRevision: chunk.toRevision,
        paths: chunk.entries.map((entry) => entry.path).filter(Boolean),
        scopeCounts,
      })
      for (const acknowledgement of chunk.acknowledgements) {
        const matchingPlan = plannedEntries.find((plan) => plan.entry.id === acknowledgement.id)
        await emit(options, 'cloud.acknowledged', {
          ...acknowledgement,
          ...(typeof acknowledgementDetail === 'function'
            ? acknowledgementDetail(matchingPlan ?? { entry: acknowledgement })
            : acknowledgementDetail),
        })
      }
      committed.push(...chunk.entries)
    },
  })
  return committed
}

export async function openChangeSetReview(options) {
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()
  const now = new Date().toISOString()
  const actorId = actorIdFromOptions(options, cloud)

  ensureActiveChangeSet(cloud)

  if (cloud.selectedState.mergeState === 'merged') {
    throw new Error('Cannot open review because the selected change set is already merged.')
  }

  cloud.selectedState.reviewState = 'open'
  cloud.selectedState.review = {
    state: 'open',
    openedAt: cloud.selectedState.review?.openedAt ?? now,
    openedBy: cloud.selectedState.review?.openedBy ?? actorId,
  }

  await cloudService.writeGraph(cloud)
  await emit(options, 'change_set.review_opened', {
    selectedStateId: cloud.selectedState.id,
    selectedStateType: cloud.selectedState.type,
    selectedStateRevision: cloud.selectedState.revision,
    mainId: cloud.main.id,
    mainRevision: cloud.main.revision,
    reviewState: cloud.selectedState.reviewState,
    openedAt: cloud.selectedState.review.openedAt,
    openedBy: cloud.selectedState.review.openedBy,
  })
}

export async function mergeChangeSet(options) {
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()
  const now = new Date().toISOString()
  const actorId = actorIdFromOptions(options, cloud)

  ensureActiveChangeSet(cloud)

  if (cloud.selectedState.reviewState !== 'open') {
    throw new Error('Cannot merge because the selected change set is not open for review.')
  }

  if (cloud.selectedState.baseRevision !== cloud.main.revision) {
    const conflict = recordChangeSetConflict(cloud, {
      reason: 'main_revision_mismatch',
      expectedMainRevision: cloud.selectedState.baseRevision,
      actualMainRevision: cloud.main.revision,
      selectedStateId: cloud.selectedState.id,
      selectedStateRevision: cloud.selectedState.revision,
      detectedAt: now,
    })
    await cloudService.writeGraph(cloud)
    await emit(options, 'change_set.conflict_detected', conflict)
    throw new Error(
      `Cannot merge because Main moved from revision ${cloud.selectedState.baseRevision} to ${cloud.main.revision}.`,
    )
  }

  const previousMainRevision = cloud.main.revision
  cloud.main.revision = cloud.selectedState.revision
  cloud.main.mergedChangeSetId = cloud.selectedState.id
  cloud.main.updatedAt = now
  cloud.selectedState.reviewState = 'merged'
  cloud.selectedState.mergeState = 'merged'
  cloud.selectedState.merge = {
    state: 'merged',
    mergedAt: cloud.selectedState.merge?.mergedAt ?? now,
    mergedBy: cloud.selectedState.merge?.mergedBy ?? actorId,
    mainId: cloud.main.id,
    mainRevision: cloud.main.revision,
    previousMainRevision,
  }

  await cloudService.writeGraph(cloud)
  await emit(options, 'change_set.merged', {
    selectedStateId: cloud.selectedState.id,
    selectedStateType: cloud.selectedState.type,
    selectedStateRevision: cloud.selectedState.revision,
    mainId: cloud.main.id,
    mainRevision: cloud.main.revision,
    previousMainRevision,
    mergedAt: cloud.selectedState.merge.mergedAt,
    mergedBy: cloud.selectedState.merge.mergedBy,
    reviewState: cloud.selectedState.reviewState,
    mergeState: cloud.selectedState.mergeState,
  })
}

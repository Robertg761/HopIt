// @ts-check
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { canRequesterSeePath, createCloudGraphService, filterVisibleGraphForRequester, removeEmptyAncestorDirectories, summarizeGraphContract, summarizeRequester, visibilityContextForGraph, visibilityRequestFromOptions } from '../cloud/d1-graph-service.js'
import { bulkJournalCommitChunkSize, bulkJournalCommitThreshold, ConflictError, defaultLargeFileThresholdBytes, entryKind, refreshMassDeleteFraction, refreshMassDeleteMinFiles, workspaceMode } from '../constants.js'
import { privacyZoneForPath } from '@hopit/core/crypto'
import { appendNdjson, emit, findLastEventOf, readNdjson } from '../io.js'
import { actorIdFromOptions, bufferFromCloudFileEntry, bufferFromFileEntry, cloudEntryEquals, countCloudScopes, countEntryScopes, countPathScopes, ensureActiveChangeSet, journalContextForCloud, normalizeCloudFileEntry, recordChangeSetConflict } from '../journal.js'
import { assertWorkspacePathSafe } from '../paths.js'
import { buildDivergenceRecord, partitionEntriesForReconnect, reconnectBucket } from '../reconnect.js'
import { classifySaveAgainstRefresh, clearWriterLedgerPath, markLocalSaveWriter, markRefreshWriter, readWriterLedger, writeWriterLedger } from '../save-clobber.js'
import { isCloudUnreachableError, readCachedGraph, writeCachedGraph } from '../graph-cache.js'
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

  // GR-F2 (decisions §10): record which paths a remote refresh just
  // materialized new content into, so the next local save to any of them can
  // be checked for a stale-editor-buffer clobber before it overwrites Main's
  // version. Deletions clear any pending refresh (nothing left to clobber).
  if (result.changedPaths.length > 0 || result.deletedPaths.length > 0) {
    const writerLedger = await readWriterLedger(options)
    for (const relativePath of result.changedPaths) {
      const file = cloud.files?.[relativePath]
      if (!file) continue
      const normalized = normalizeCloudFileEntry(relativePath, file)
      markRefreshWriter(writerLedger, relativePath, { hash: normalized.hash, revision: normalized.revision ?? null })
    }
    for (const relativePath of result.deletedPaths) {
      clearWriterLedgerPath(writerLedger, relativePath)
    }
    await writeWriterLedger(options, writerLedger)
  }

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
  // Write-ahead journaling across an outage: a successful read snapshots the
  // graph, and an unreachable cloud falls back to that snapshot so the sync
  // can still plan and journal. Entries land `pending` and are committed by
  // `recoverJournal` at reconnect, which runs them through the normal GR-A1
  // classification -- planning against a stale revision is precisely what
  // that classifier exists to make safe. See `packages/agent/src/graph-cache.js`.
  let cloud
  let offlineJournaling = false
  try {
    cloud = await cloudService.readGraph()
    await writeCachedGraph(options, cloud)
  } catch (error) {
    // Only a transport failure falls back. An auth/quota/validation error
    // means the server answered and said no, and must keep failing loudly.
    if (!isCloudUnreachableError(error)) throw error
    cloud = await readCachedGraph(options)
    if (!cloud) throw error
    offlineJournaling = true
    await emit(options, 'sync.cloud_unreachable', {
      reason: error instanceof Error ? error.message : String(error),
      cachedRevision: cloud.revision ?? null,
      ...contextDetail,
    })
  }
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
  // GR-F2 (decisions §10): save-side clobber detection. Loaded once per sync
  // call; mutated in memory as saves are classified below and persisted once
  // at the end if anything changed.
  const writerLedger = await readWriterLedger(options)
  let writerLedgerChanged = false
  const clobberDiverged = []

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

    // GR-F2 (decisions §10): if a remote refresh materialized new content at
    // this path since this device's last known local save, the current disk
    // write is a *candidate* stale-editor-buffer clobber. Classify it against
    // the refreshed content before ever journaling it: a diverged save is
    // never committed (Main's version stays exactly as it is -- never a
    // silent revert of either side) and is surfaced instead.
    const ledgerRecord = writerLedger.paths[relativePath]
    if (ledgerRecord?.pendingRefresh) {
      const refreshedContent = current
        ? await bufferFromCloudFileEntry(current, cloudService, { relativePath })
        : null
      const classification = classifySaveAgainstRefresh({
        ledger: writerLedger,
        relativePath,
        kind: entryPayload.kind,
        newHash: entryPayload.hash,
        newContent: bufferFromFileEntry(entryPayload),
        refreshedContent,
      })
      if (classification.bucket === reconnectBucket.diverged) {
        clobberDiverged.push({
          path: relativePath,
          reason: classification.reason,
          refreshedHash: ledgerRecord.pendingRefresh.hash,
          refreshedRevision: ledgerRecord.pendingRefresh.revision,
          localHash: entryPayload.hash,
          scope,
        })
        continue
      }
    }

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
    offlineJournaling,
  }))

  // Roll the snapshot forward by the entries this offline sync just planned.
  // `planningCloud` has had each one applied to it, so it is the state the
  // cloud *will* be in once the backlog commits. Without this, every sync
  // during a single outage would re-plan against the same untouched snapshot
  // and stamp all of its entries with the same `targetStateRevision` -- the
  // first would commit at reconnect and the rest would fail
  // `selected_state_revision_mismatch` against the state their own
  // predecessor just advanced. Successive offline syncs have to read like one
  // continuous session, which is what this makes true.
  //
  // It does mean the snapshot is now a projected state rather than one the
  // server was observed in. That is safe: it is only ever used for offline
  // planning, any successful read overwrites it with real server state, and
  // if the projection turns out wrong (the cloud moved too), reconnect
  // classification opens a divergence rather than trusting it.
  if (offlineJournaling && plannedEntries.length > 0) {
    await writeCachedGraph(options, planningCloud)
  }

  if (!cloudService.usesAtomicFileMutations && !offlineJournaling) {
    await cloudService.writeGraph(cloud)
  }

  // GR-F2: every committed write/create resolves (or never had) a pending
  // refresh for its path -- record the revision it just committed at as the
  // new local-save baseline. Committed deletes drop any leftover ledger
  // record for the path (nothing left on disk to clobber).
  for (const committedEntry of writeEvents) {
    if (committedEntry.type === 'delete') {
      if (writerLedger.paths[committedEntry.path]) {
        clearWriterLedgerPath(writerLedger, committedEntry.path)
        writerLedgerChanged = true
      }
      continue
    }
    const committedRevision = cloud.files?.[committedEntry.path]?.revision ?? cloud.revision ?? null
    markLocalSaveWriter(writerLedger, committedEntry.path, { revision: committedRevision })
    writerLedgerChanged = true
  }

  for (const diverged of clobberDiverged) {
    await emit(options, 'sync.save_clobber_diverged', {
      ...diverged,
      ...journalContextForCloud(planningCloud),
    })
  }
  if (writerLedgerChanged) {
    await writeWriterLedger(options, writerLedger)
  }

  const result = {
    ...contextDetail,
    writes: writeEvents.length,
    revision: cloud.revision,
    service: cloudService.type,
    contract: summarizeGraphContract(cloud),
    scopeCounts: countCloudScopes(cloud),
    journaledScopeCounts: countEntryScopes(writeEvents),
    ...(clobberDiverged.length > 0
      ? {
          saveClobberDiverged: clobberDiverged.length,
          saveClobberDivergedPaths: clobberDiverged.map((entry) => entry.path),
        }
      : {}),
    ...(offlineJournaling
      ? {
          cloudReachable: false,
          writeAheadPending: plannedEntries.length,
        }
      : {}),
  }
  await emit(options, 'sync.complete', result)
  // Skipped while offline: the workspace index records hydration state from
  // the graph, and the graph in hand is a stale snapshot. Writing it would
  // claim the workspace matches a revision the cloud may have moved past.
  // The next successful sync rewrites it from the real graph.
  if (offlineJournaling) return result
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

// GR-A2 (decisions §1): persists every bucket-3 (diverged) classification as
// an open divergence record *before* anything about it is resolved. Nothing
// is silently dropped: the offline device's own version is captured in full
// (`localEntry`) here, independent of whatever happens to the journal entry
// afterwards, so it stays recoverable even if the local workspace file is
// later changed again or the divergence is resolved in the cloud's favor.
// The local workspace file itself is never touched by this function -- it
// stays exactly as the user left it until they explicitly resolve.
async function persistDivergences(options, cloudService, cloud, diverged) {
  const localDevice = options['device-name'] ?? os.hostname() ?? 'local-device'
  let fileVersions = null
  const records = []

  for (const classification of diverged) {
    let localEntry = null
    if (classification.localSide !== 'deleted') {
      try {
        const recovery = await prepareRecovery(cloud, classification.entry, options.workspace)
        localEntry = recovery.entry ?? null
      } catch (error) {
        await emit(options, 'journal.reconnect_diverged_local_content_unavailable', {
          path: classification.path,
          reason: error.message,
        })
      }
    }

    let cloudDevice = null
    if (classification.cloudRevision !== null && typeof cloudService.listFileVersions === 'function') {
      if (fileVersions === null) {
        fileVersions = await cloudService.listFileVersions(cloud.codebase?.id).catch(() => [])
      }
      const cloudVersion = [...fileVersions]
        .reverse()
        .find((row) => row.path === classification.path && row.newRevision === classification.cloudRevision)
      cloudDevice = cloudVersion?.deviceName ?? null
    }

    const divergence = buildDivergenceRecord(classification, { localEntry, localDevice, cloudDevice })
    const record = await cloudService.openDivergence(cloud.codebase?.id, divergence)
    if (record) records.push(record)
  }

  return records
}

// GR-A2 (decisions §1): resolves an open divergence. `keep: 'local'` writes
// the offline device's captured content as a normal journaled step (exactly
// like any other write -- it goes through the same `commitJournalEntry` path,
// so it gets its own `file_versions` row); `keep: 'cloud'` writes nothing new
// because the cloud's current file already *is* the winning content. Either
// way the divergence record is only ever closed, never deleted, so both the
// content that lost (still in `record.localEntry` / still reachable at its
// old cloud revision through `file_versions`) and the content that won
// remain fetchable by revision forever. Combining the two sides into a new,
// user-edited file is exposed by GR-A3's CLI/dashboard surface as a
// `keep: 'local'` resolution against a locally-edited merge, so it needs no
// separate branch here.
export async function resolveDivergence(options, { divergenceId: id, keep } = {}) {
  if (!id) throw new Error('resolveDivergence requires a divergenceId')
  if (keep !== 'local' && keep !== 'cloud') {
    throw new Error(`resolveDivergence: unsupported keep value ${JSON.stringify(keep)} (expected "local" or "cloud")`)
  }

  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()
  const record = await cloudService.getDivergence(cloud.codebase?.id, id)
  if (!record) throw new Error(`divergence not found: ${id}`)
  if (record.state === 'resolved') return { record, applied: false }

  let resolvedRevision = record.cloudRevision
  if (keep === 'local' && record.localSide === 'deleted') {
    // delete_vs_edit (decisions §1 sub-cases): keeping "local" means keeping
    // the offline device's delete, journaled as a normal delete step.
    const now = new Date().toISOString()
    const entry = {
      id: randomUUID(),
      type: 'delete',
      path: record.path,
      scope: record.scope ?? scopeForPath(record.path),
      baseRevision: cloud.files?.[record.path]?.revision ?? null,
      createdAt: now,
      status: 'pending',
    }
    const acknowledgement = await cloudService.commitJournalEntry(cloud, entry, { now })
    resolvedRevision = acknowledgement?.revision ?? cloud.revision
  } else if (keep === 'local') {
    if (!record.localEntry) {
      throw new Error(`divergence ${id} has no recoverable local content to keep (path: ${record.path})`)
    }
    const now = new Date().toISOString()
    const entry = {
      id: randomUUID(),
      type: 'write',
      path: record.path,
      scope: record.scope ?? scopeForPath(record.path),
      kind: record.localEntry.kind ?? entryKind.file,
      hash: record.localEntry.hash,
      baseRevision: cloud.files?.[record.path]?.revision ?? null,
      createdAt: now,
      status: 'pending',
    }
    const acknowledgement = await cloudService.commitJournalEntry(cloud, entry, { entry: record.localEntry, now })
    resolvedRevision = acknowledgement?.revision ?? cloud.revision
  }

  const resolved = await cloudService.resolveDivergence(cloud.codebase?.id, id, { keep, resolvedRevision })
  await emit(options, 'journal.reconnect_diverged_resolved', {
    divergenceId: id,
    path: record.path,
    keep,
    resolvedRevision,
  })
  return { record: resolved, applied: true }
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
    divergences: [],
    skipped: journalEntries.length - allCandidates.length,
  }

  // Persists every diverged path as an open divergence record (GR-A2,
  // decisions §1). Deliberately run last, immediately before the
  // recovery-complete summary, in each branch below: earlier commit paths
  // (bulk-chunked and single-entry) both do their own read-modify-write
  // cycles against the cloud graph, and if divergence persistence ran before
  // them its writes would be clobbered by a subsequent read that predates
  // them. Running last means nothing after it can overwrite the record.
  async function finalizeDivergences() {
    if (diverged.length === 0 || typeof cloudService.openDivergence !== 'function') return
    const records = await persistDivergences(options, cloudService, cloud, diverged)
    result.divergences = records.map((record) => ({
      divergenceId: record.divergenceId,
      path: record.path,
      reason: record.reason,
    }))
  }

  // GR-A3 (decisions §1): device labels for the divergence surfaces (`hop
  // conflicts`, status API `divergences`, dashboard side-by-side view). Best
  // effort only -- neither side's device identity is durably tracked yet
  // (that level of attribution is GR-A2 territory), so this labels the
  // reconnecting device from its own `--device-name`/hostname and the cloud
  // side from the session name recorded when this codebase was initialized.
  const localDeviceName = options['device-name'] ?? os.hostname() ?? null
  const cloudDeviceName = cloud.session?.deviceName ?? null
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
      localDeviceName,
      cloudDeviceName,
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

    await finalizeDivergences()

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

  await finalizeDivergences()

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
  offlineJournaling = false,
}) {
  if (plannedEntries.length === 0) return []

  // Cloud unreachable: write the journal and stop there. The entries stay
  // `pending`, which is the same state an interrupted sync leaves behind, so
  // `recoverJournal` picks them up at reconnect with no special casing. No
  // `cloud.acknowledged` is emitted because nothing was acknowledged, and
  // none of these count as committed writes to the caller.
  if (offlineJournaling) {
    for (const plan of plannedEntries) {
      if (journalAlreadyWritten) continue
      // The selected-state revision this entry will commit at is not
      // knowable while the cloud is unreachable, and the guard it feeds
      // (`assertEntrySelectedStateRevision`) encodes a strict *global*
      // sequence. Replay orders entries by per-path causality, which does
      // not preserve that global sequence, so a write-ahead batch would fail
      // on whichever entry happened to be applied out of order.
      //
      // `baseRevision` is deliberately kept: it is per-path, it survives
      // reordering, it is what GR-A1 classification reads, and it is the
      // guard that actually stops a stale write from clobbering a newer
      // cloud version. Dropping the global one loses no protection that was
      // meaningful for an entry planned offline in the first place.
      delete plan.entry.targetStateRevision
      await appendNdjson(options.journal, plan.entry)
      await emit(options, 'write.journaled', plan.entry)
    }
    await emit(options, 'journal.write_ahead_pending', {
      count: plannedEntries.length,
      paths: plannedEntries.map((plan) => plan.entry.path).filter(Boolean),
      cachedRevision: cloud?.revision ?? null,
    })
    return []
  }

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
  cloud.selectedState.reviewState = 'merged'
  cloud.selectedState.mergeState = 'merged'
  cloud.selectedState.merge = {
    state: 'merged',
    mergedAt: cloud.selectedState.merge?.mergedAt ?? now,
    mergedBy: cloud.selectedState.merge?.mergedBy ?? actorId,
    mainId: cloud.main.id,
    mainRevision: cloud.selectedState.revision,
    previousMainRevision,
  }

  // GR-B2 (decisions §2: "Main has exactly one door"): the actual Main
  // advance -- mutate cloud.main, write the graph, best-effort mirror
  // enqueue -- is the same primitive the merge queue uses to land a
  // proposal (`landOneProposal` in commands/propose.js). This plain,
  // proposal-less merge keeps its own pre-conditions/bookkeeping above
  // unchanged; only the Main-advancing mechanics are shared.
  await advanceMainToRevision(options, cloudService, cloud, {
    revision: cloud.selectedState.revision,
    mergedChangeSetId: cloud.selectedState.id,
    actorId,
    now,
  })

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

// GR-B2 (decisions §2, design doc "Merge queue serialization"): the single
// shared "advance Main" primitive. Mutates `cloud.main` in place, persists
// it, and fires the same best-effort mirror-on-merge automation (GR-E2) --
// used by both the plain `mergeChangeSet` above and the proposal merge
// queue (`packages/agent/src/commands/propose.js`), so there is exactly one
// code path that ever writes `cloud.main.revision`.
export async function advanceMainToRevision(options, cloudService, cloud, { revision, mergedChangeSetId, actorId, now = new Date().toISOString(), beforeWrite = null }) {
  cloud.main.revision = revision
  cloud.main.mergedChangeSetId = mergedChangeSetId
  cloud.main.updatedAt = now

  // Optional hook for callers that need to mutate the graph further (e.g.
  // GR-B2's change-set rotation) using the *already-advanced* `cloud.main`,
  // in the same write as the Main advance rather than a second round-trip.
  if (typeof beforeWrite === 'function') beforeWrite(cloud)

  await cloudService.writeGraph(cloud)

  // GR-E2 (decisions §8): if this codebase has a mirror remote configured,
  // enqueue a mirror-push action_job for a hosted runner to pick up. This is
  // best-effort automation on top of an already-committed merge -- a
  // read/enqueue failure must never surface as a merge failure, so it is
  // swallowed and only journaled.
  await enqueueMirrorSyncOnMerge(options, cloudService, cloud, actorId)
}

async function enqueueMirrorSyncOnMerge(options, cloudService, cloud, actorId) {
  try {
    const settings = await cloudService.readCodebaseSettings(cloud.codebase.id)
    if (!settings?.mirrorRemoteUrl) return
    const job = await cloudService.enqueueMirrorSyncJob({
      codebaseId: cloud.codebase.id,
      actor: { userId: actorId },
    })
    if (job) await emit(options, 'mirror.job_enqueued', { jobId: job.jobId, codebaseId: cloud.codebase.id })
  } catch (error) {
    await emit(options, 'mirror.enqueue_failed', {
      codebaseId: cloud.codebase.id,
      reason: error instanceof Error ? error.message : 'mirror enqueue failed',
    })
  }
}

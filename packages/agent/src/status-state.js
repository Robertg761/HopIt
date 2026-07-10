// @ts-check
import path from 'node:path'
import { createCloudGraphService, summarizeRequester, visibilityRequestFromOptions } from './cloud/d1-graph-service.js'
import { ConflictError, entryEncoding, entryKind, workspaceMode } from './constants.js'
import { privacyZoneForPath } from '@hopit/core/crypto'
import { findLastEvent, findLastEventOf, readNdjson } from './io.js'
import { cloudEntryEquals, countCloudScopes, countEntryScopes, normalizeCloudFileEntry, toCloudPath } from './journal.js'
import { remotePullEnabled, remotePushEnabled, remotePushUrl, remoteRefreshIntervalMs } from './paths.js'
import { isTimestampAtOrAfter } from './service.js'
import { findIndexedCodebase, localCacheSnapshotForCloud, readWorkspaceIndex, workspaceIndexSummary } from './workspace-index.js'
import { buildRemoteCursor, buildWorkspaceHydration, contentManifestSummary, readSingleWorkspaceEntry, workspaceFilePath, workspaceLocalChanges } from './workspace-manifest.js'
import { scopeForPath } from '@hopit/core/privacy-zone'
import { existsSync, watch } from 'node:fs'

export async function readAgentState(options) {
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readOptionalVisibleGraph(visibilityRequestFromOptions(options))
  const journalEntries = await readNdjson(options.journal)
  const eventEntries = await readNdjson(options.events)
  const journalState = classifyJournalEntries(journalEntries, eventEntries)
  const recentEvents = eventEntries.slice(-20)
  const lastAcknowledgement = findLastEvent(eventEntries, 'cloud.acknowledged')
  const lastSync = findLastEvent(eventEntries, 'sync.complete')
  const lastStartedSync = findLastEvent(eventEntries, 'sync.started')
  const lastFailedSync = findLastEvent(eventEntries, 'sync.failed')
  const lastRecoveredSync = findLastEvent(eventEntries, 'sync.recovered')
  const latestSyncEvent = findLastEventOf(eventEntries, [
    'sync.started',
    'sync.complete',
    'sync.failed',
    'sync.recovered',
  ])
  const syncHealth = buildSyncHealth({
    lastStartedSync,
    lastSuccessfulSync: lastSync,
    lastFailedSync,
    lastRecoveredSync,
    latestSyncEvent,
  })
  const lastRefreshStarted = findLastEvent(eventEntries, 'refresh.started')
  const lastRefreshBlocked = findLastEvent(eventEntries, 'refresh.blocked')
  const lastRefreshComplete = findLastEvent(eventEntries, 'refresh.complete')
  const lastWorkspaceReady = findLastEvent(eventEntries, 'workspace.ready')
  const lastWorkspaceOpened = findLastEvent(eventEntries, 'workspace.opened')
  const lastWorkspaceOpenHydration = findLastEventOf(eventEntries, [
    'workspace.open_hydration.applied',
    'workspace.open_hydration.partial',
    'workspace.open_hydration.skipped',
  ])
  const lastRemoteUpdate = findLastEvent(eventEntries, 'remote-update')
  const lastRemotePullStarted = findLastEvent(eventEntries, 'remote-pull.started')
  const lastRemotePullSkipped = findLastEvent(eventEntries, 'remote-pull.skipped')
  const lastRemotePullFailed = findLastEvent(eventEntries, 'remote-pull.failed')
  const latestRemotePullEvent = findLastEventOf(eventEntries, [
    'remote-pull.started',
    'remote-pull.applied',
    'remote-pull.skipped',
    'remote-pull.failed',
  ])
  const lastRemotePullApplied = findLastEvent(eventEntries, 'remote-pull.applied')
  const remotePullHealth = buildRemotePullHealth(options, {
    lastRemotePullStarted,
    lastRemotePullApplied,
    lastRemotePullSkipped,
    lastRemotePullFailed,
    latestRemotePullEvent,
  })
  const lastRemotePushStarted = findLastEvent(eventEntries, 'remote-push.started')
  const lastRemotePushConnected = findLastEvent(eventEntries, 'remote-push.connected')
  const lastRemotePushDisconnected = findLastEvent(eventEntries, 'remote-push.disconnected')
  const lastRemotePushFallbackPolling = findLastEvent(eventEntries, 'remote-push.fallback_polling')
  const lastRemotePushApplied = findLastEvent(eventEntries, 'remote-push.applied')
  const lastRemotePushSkipped = findLastEvent(eventEntries, 'remote-push.skipped')
  const lastRemotePushFailed = findLastEvent(eventEntries, 'remote-push.failed')
  const latestRemotePushEvent = findLastEventOf(eventEntries, [
    'remote-push.started',
    'remote-push.connected',
    'remote-push.disconnected',
    'remote-push.fallback_polling',
    'remote-push.applied',
    'remote-push.skipped',
    'remote-push.failed',
  ])
  const remotePushHealth = buildRemotePushHealth(options, {
    lastRemotePushStarted,
    lastRemotePushConnected,
    lastRemotePushDisconnected,
    lastRemotePushFallbackPolling,
    lastRemotePushApplied,
    lastRemotePushSkipped,
    lastRemotePushFailed,
    latestRemotePushEvent,
    lastRemotePullApplied,
    lastRemotePullSkipped,
    lastRemotePullFailed,
  })
  const latestRefreshEvent = findLastEventOf(eventEntries, [
    'refresh.started',
    'refresh.blocked',
    'refresh.complete',
  ])
  const refreshHealth = buildRefreshHealth({
    lastRefreshStarted,
    lastRefreshBlocked,
    lastRefreshComplete,
    latestRefreshEvent,
  })
  const lastRecovery = findLastEvent(eventEntries, 'journal.recovery_complete')
  const lastWatchStarted = findLastEvent(eventEntries, 'watch.started')
  const lastWatchDegraded = findLastEvent(eventEntries, 'watch.degraded')
  const lastWatchRecoveryBlocked = findLastEvent(eventEntries, 'watch.recovery_blocked')
  const latestWatchEvent = findLastEventOf(eventEntries, [
    'watch.started',
    'watch.degraded',
    'watch.recovery_blocked',
  ])
  const watchHealth = buildWatchHealth({
    lastWatchStarted,
    lastWatchDegraded,
    lastWatchRecoveryBlocked,
    latestWatchEvent,
  })
  const cloudFiles = cloud?.files ? Object.keys(cloud.files) : []
  const scopeCounts = countCloudScopes(cloud)
  const pendingJournalEntries = journalState.entries.filter((entry) => entry.recoveryStatus === 'pending')
  const failedJournalEntries = journalState.entries.filter((entry) => entry.recoveryStatus === 'failed')
  const acknowledgedJournalEntries = journalState.entries.filter(
    (entry) => entry.recoveryStatus === 'acknowledged',
  )
  const workspaceExists = existsSync(options.workspace)
  const workspaceIndex = await readWorkspaceIndex(options)
  const indexedCodebase = findIndexedCodebase(
    workspaceIndex,
    cloud?.codebase?.id ?? options['codebase-id'],
    options.workspace,
  )

  const cloudSummary = {
    path: cloudService.location ?? path.resolve(options.cloud),
    service: cloudService.type,
    exists: Boolean(cloud),
    schemaVersion: cloud?.schemaVersion ?? null,
    codebase: cloud?.codebase
      ? {
          id: cloud.codebase.id ?? null,
          name: cloud.codebase.name ?? null,
          ownerId: cloud.codebase.ownerId ?? null,
        }
      : null,
    main: cloud?.main
      ? {
          id: cloud.main.id ?? null,
          revision: cloud.main.revision ?? null,
        }
      : null,
    selectedState: cloud?.selectedState
      ? {
          type: cloud.selectedState.type ?? null,
          id: cloud.selectedState.id ?? null,
          ownerId: cloud.selectedState.ownerId ?? null,
          baseMainId: cloud.selectedState.baseMainId ?? null,
          baseRevision: cloud.selectedState.baseRevision ?? null,
          revision: cloud.selectedState.revision ?? null,
          visibility: cloud.selectedState.visibility ?? null,
          effectiveVisibility: cloud.selectedState.effectiveVisibility ?? null,
          reviewState: cloud.selectedState.reviewState ?? null,
          mergeState: cloud.selectedState.mergeState ?? null,
          conflictState: cloud.selectedState.conflictState ?? null,
          conflict: cloud.selectedState.conflict ?? null,
          review: cloud.selectedState.review ?? null,
          merge: cloud.selectedState.merge ?? null,
        }
      : null,
    owner: cloud?.owner
      ? {
          id: cloud.owner.id ?? null,
        }
      : null,
    session: cloud?.session
      ? {
          id: cloud.session.id ?? null,
          deviceName: cloud.session.deviceName ?? null,
        }
      : null,
    requester: cloud?.visibilityContext ? summarizeRequester(cloud.visibilityContext) : null,
    hiddenFileCount: cloud?.visibilityContext?.hiddenFileCount ?? null,
    hiddenScopeCounts: cloud?.visibilityContext?.hiddenScopeCounts ?? null,
    visibility: cloud?.visibility
      ? {
          productDefault: cloud.visibility.productDefault ?? null,
          globalUserDefault: cloud.visibility.globalUserDefault ?? null,
          codebaseOverride: cloud.visibility.codebaseOverride ?? null,
          changeSetOverride: cloud.visibility.changeSetOverride ?? null,
          effective: cloud.visibility.effective ?? null,
        }
      : null,
    revision: cloud?.revision ?? null,
    fileCount: cloudFiles.length,
    scopeCounts,
  }

  const journalSummary = {
    path: path.resolve(options.journal),
    exists: existsSync(options.journal),
    totalEntries: journalEntries.length,
    pendingCount: pendingJournalEntries.length,
    failedCount: failedJournalEntries.length,
    acknowledgedCount: acknowledgedJournalEntries.length,
    scopeCounts: countEntryScopes(journalEntries),
    pendingScopeCounts: countEntryScopes(pendingJournalEntries),
    failedScopeCounts: countEntryScopes(failedJournalEntries),
    acknowledgedScopeCounts: countEntryScopes(acknowledgedJournalEntries),
    pendingEntries: pendingJournalEntries,
    failedEntries: failedJournalEntries,
    acknowledgedEntries: acknowledgedJournalEntries,
    entries: journalState.entries,
  }

  const eventsSummary = {
    path: path.resolve(options.events),
    exists: existsSync(options.events),
    totalEntries: eventEntries.length,
    recent: recentEvents,
    lastAcknowledgement,
    lastSync,
    lastStartedSync,
    lastFailedSync,
    lastRecoveredSync,
    latestSyncEvent,
    lastWorkspaceReady,
    lastWorkspaceOpened,
    lastWorkspaceOpenHydration,
    lastRefreshStarted,
    lastRefreshBlocked,
    lastRefreshComplete,
    lastRemoteUpdate,
    lastRemotePullStarted,
    lastRemotePullApplied,
    lastRemotePullSkipped,
    lastRemotePullFailed,
    latestRemotePullEvent,
    lastRemotePushStarted,
    lastRemotePushConnected,
    lastRemotePushDisconnected,
    lastRemotePushFallbackPolling,
    lastRemotePushApplied,
    lastRemotePushSkipped,
    lastRemotePushFailed,
    latestRemotePushEvent,
    lastReviewOpened: findLastEvent(eventEntries, 'change_set.review_opened'),
    lastChangeSetMerged: findLastEvent(eventEntries, 'change_set.merged'),
    lastConflictDetected: findLastEvent(eventEntries, 'change_set.conflict_detected'),
    latestRefreshEvent,
    lastRecovery,
    lastWatchStarted,
    lastWatchDegraded,
    lastWatchRecoveryBlocked,
    latestWatchEvent,
  }
  const hydration = buildWorkspaceHydration({
    cloudSummary,
    workspaceExists,
    lastWorkspaceReady,
    lastRefreshComplete,
    indexedCodebase,
  })
  const localChanges = await workspaceLocalChanges(options, indexedCodebase)
  const localCache = localCacheSnapshotForCloud(options, cloud, indexedCodebase)
  remotePullHealth.cursor = buildRemoteCursor({
    cloudSummary,
    eventsSummary,
    hydration,
  })
  const initialized = Boolean(cloud) && (hydration.state === 'materialized' || hydration.state === 'partial')
  const attached = Boolean(cloud) && hydration.state === 'metadata-only'
  const usable = initialized || attached

  return {
    status: {
      ok:
        usable &&
        localChanges.safe &&
        failedJournalEntries.length === 0 &&
        syncHealth.state !== 'failed' &&
        refreshHealth.state !== 'blocked' &&
        watchHealth.state !== 'unavailable-degraded' &&
        watchHealth.state !== 'degraded' &&
        watchHealth.state !== 'blocked',
      generatedAt: new Date().toISOString(),
      readiness: initialized ? 'ready' : attached ? 'attached' : 'not_initialized',
      mode: workspaceMode,
      codebaseId: cloudSummary.codebase?.id ?? null,
      codebaseName: cloudSummary.codebase?.name ?? null,
      selectedStateType: cloudSummary.selectedState?.type ?? null,
      activeChangeSetId:
        cloudSummary.selectedState?.type === 'active-change-set' ? cloudSummary.selectedState.id : null,
      mainId: cloudSummary.main?.id ?? null,
      ownerId: cloudSummary.owner?.id ?? cloudSummary.codebase?.ownerId ?? null,
      sessionId: cloudSummary.session?.id ?? null,
      requesterId: cloudSummary.requester?.id ?? null,
      requesterSessionId: cloudSummary.requester?.sessionId ?? null,
      requesterRole: cloudSummary.requester?.role ?? null,
      visibleFileCount: cloudSummary.fileCount,
      hiddenFileCount: cloudSummary.hiddenFileCount,
      hiddenScopeCounts: cloudSummary.hiddenScopeCounts,
      effectiveChangeSetVisibility:
        cloudSummary.selectedState?.effectiveVisibility ?? cloudSummary.visibility?.effective ?? null,
      review: {
        state: cloudSummary.selectedState?.reviewState ?? 'not-open',
        detail: cloudSummary.selectedState?.review ?? null,
      },
      merge: {
        state: cloudSummary.selectedState?.mergeState ?? 'unmerged',
        detail: cloudSummary.selectedState?.merge ?? null,
        mainRevision: cloudSummary.main?.revision ?? null,
      },
      conflict: {
        state: cloudSummary.selectedState?.conflictState ?? 'none',
        detail: cloudSummary.selectedState?.conflict ?? null,
      },
      workspace: {
        root: path.resolve(workspaceRootFromOptions(options)),
        path: path.resolve(options.workspace),
        exists: workspaceExists,
        adapter: workspaceMode.adapter,
        cacheMode: workspaceMode.cacheMode,
        materializationPolicy: workspaceMode.materializationPolicy,
        hydrationPolicy: workspaceMode.hydrationPolicy,
        remoteUpdatePolicy: workspaceMode.remoteUpdatePolicy,
        hydration,
        localChanges,
        contentManifest: contentManifestSummary(indexedCodebase?.contentManifest),
        cache: localCache.summary,
        openHydration: indexedCodebase?.openHydration ?? null,
        files: localCache.files,
        index: workspaceIndexSummary(options, workspaceIndex),
        virtualized: false,
      },
      cloud: cloudSummary,
      journal: {
        path: journalSummary.path,
        exists: journalSummary.exists,
        totalEntries: journalSummary.totalEntries,
        pendingCount: journalSummary.pendingCount,
        failedCount: journalSummary.failedCount,
        acknowledgedCount: journalSummary.acknowledgedCount,
        scopeCounts: journalSummary.scopeCounts,
        pendingScopeCounts: journalSummary.pendingScopeCounts,
        failedScopeCounts: journalSummary.failedScopeCounts,
        acknowledgedScopeCounts: journalSummary.acknowledgedScopeCounts,
      },
      sync: syncHealth,
      refresh: refreshHealth,
      remoteUpdate: {
        state: lastRemoteUpdate ? 'updated' : 'idle',
        lastUpdate: lastRemoteUpdate,
      },
      remotePull: remotePullHealth,
      remotePush: remotePushHealth,
      watch: watchHealth,
      events: {
        path: eventsSummary.path,
        exists: eventsSummary.exists,
        totalEntries: eventsSummary.totalEntries,
        recent: eventsSummary.recent,
        lastAcknowledgement,
        lastSync,
        lastStartedSync,
        lastFailedSync,
        lastRecoveredSync,
        latestSyncEvent,
        lastWorkspaceReady,
        lastWorkspaceOpened,
        lastWorkspaceOpenHydration,
        lastRefreshStarted,
        lastRefreshBlocked,
        lastRefreshComplete,
        lastRemoteUpdate,
        lastRemotePullStarted,
        lastRemotePullApplied,
        lastRemotePullSkipped,
        lastRemotePullFailed,
        latestRemotePullEvent,
        lastRemotePushStarted,
        lastRemotePushConnected,
        lastRemotePushDisconnected,
        lastRemotePushFallbackPolling,
        lastRemotePushApplied,
        lastRemotePushSkipped,
        lastRemotePushFailed,
        latestRemotePushEvent,
        lastReviewOpened: eventsSummary.lastReviewOpened,
        lastChangeSetMerged: eventsSummary.lastChangeSetMerged,
        lastConflictDetected: eventsSummary.lastConflictDetected,
        latestRefreshEvent,
        lastRecovery,
        lastWatchStarted,
        lastWatchDegraded,
        lastWatchRecoveryBlocked,
        latestWatchEvent,
      },
    },
    cloud: {
      ...cloudSummary,
      graph: cloud,
    },
    journal: journalSummary,
    events: eventsSummary,
  }
}

export async function prepareRecovery(cloud, entry, workspace) {
  if (!entry.id) throw new Error('journal entry is missing id')
  if (!entry.path) throw new Error('journal entry is missing path')

  const scope = entry.scope ?? scopeForPath(entry.path)
  const cloudFile = cloud.files?.[entry.path]
    ? normalizeCloudFileEntry(entry.path, cloud.files[entry.path])
    : null

  if (entry.type === 'delete') {
    if (!cloudFile) return { reason: 'cloud_already_deleted' }
    return { reason: 'cloud_delete_replayed' }
  }

  if (entry.type !== 'create' && entry.type !== 'write') {
    throw new Error(`unsupported journal entry type: ${entry.type}`)
  }

  if (cloudFile?.hash === entry.hash && cloudFile.scope === scope && (entry.kind ?? cloudFile.kind) === cloudFile.kind) {
    return { entry: cloudFile, reason: 'cloud_already_matches' }
  }

  if (!existsSync(workspace)) {
    throw new Error('workspace_missing')
  }

  const absolutePath = workspaceFilePath(workspace, entry.path)
  if (!existsSync(absolutePath)) {
    throw new Error('workspace_file_missing')
  }

  const diskEntry = normalizeCloudFileEntry(entry.path, await readSingleWorkspaceEntry(workspace, entry.path))
  if (diskEntry.hash !== entry.hash || diskEntry.kind !== (entry.kind ?? diskEntry.kind)) {
    throw new Error(`workspace_hash_mismatch: expected ${entry.hash}, got ${diskEntry.hash}`)
  }

  return { entry: diskEntry, reason: 'workspace_replayed' }
}

export function applyJournalEntryToCloud(cloud, entry, options = {}) {
  const scope = entry.scope ?? scopeForPath(entry.path)
  const now = options.now ?? new Date().toISOString()

  if (!cloud.files) cloud.files = {}
  if (!Number.isInteger(cloud.revision)) cloud.revision = 0
  if (cloud.selectedState && !Number.isInteger(cloud.selectedState.revision)) {
    cloud.selectedState.revision = cloud.revision
  }

  assertEntrySelectedStateRevision(cloud, entry)
  assertEntryBaseRevision(cloud, entry)

  if (entry.type === 'delete') {
    const current = cloud.files[entry.path]
    if (current) {
      cloud.revision += 1
      if (cloud.selectedState) cloud.selectedState.revision = cloud.revision
      delete cloud.files[entry.path]
    }

    return {
      id: entry.id,
      type: entry.type,
      path: entry.path,
      kind: entry.kind ?? entryKind.file,
      scope,
      privacyZone: privacyZoneForPath(entry.path),
      revision: cloud.revision,
      selectedStateType: cloud.selectedState?.type ?? null,
      selectedStateId: cloud.selectedState?.id ?? null,
      selectedStateRevision: cloud.selectedState?.revision ?? null,
    }
  }

  const payload = options.entry
    ? normalizeCloudFileEntry(entry.path, options.entry)
    : normalizeCloudFileEntry(entry.path, {
        kind: entry.kind ?? entryKind.file,
        content: options.content ?? '',
        encoding: entry.encoding ?? entryEncoding.utf8,
        target: entry.target ?? null,
      })

  if (entry.hash && payload.hash !== entry.hash) {
    throw new Error(`content_hash_mismatch: expected ${entry.hash}, got ${payload.hash}`)
  }

  const current = cloud.files[entry.path]
  const currentEntry = current ? normalizeCloudFileEntry(entry.path, current) : null
  if (!currentEntry || !cloudEntryEquals(currentEntry, payload)) {
    cloud.revision += 1
    cloud.files[entry.path] = {
      kind: payload.kind,
      content: payload.content ?? '',
      encoding: payload.encoding ?? entryEncoding.utf8,
      target: payload.target ?? null,
      hash: payload.hash,
      size: payload.size,
      scope,
      privacyZone: privacyZoneForPath(entry.path),
      revision: cloud.revision,
      updatedAt: now,
    }
    if (payload.kind === entryKind.file && payload.contentStorage) {
      cloud.files[entry.path].contentStorage = payload.contentStorage
    }
    if (payload.kind === entryKind.file && payload.blobProvider) {
      cloud.files[entry.path].blobProvider = payload.blobProvider
    }
    if (payload.kind === entryKind.file && payload.blobKey) {
      cloud.files[entry.path].blobKey = payload.blobKey
    }
    if (payload.kind === entryKind.file && payload.blobHash) {
      cloud.files[entry.path].blobHash = payload.blobHash
    }
    if (payload.kind === entryKind.file && Number.isInteger(payload.blobSize)) {
      cloud.files[entry.path].blobSize = payload.blobSize
    }
    if (payload.kind === entryKind.file && payload.clientEncryption) {
      cloud.files[entry.path].clientEncryption = payload.clientEncryption
    }
    if (cloud.selectedState) cloud.selectedState.revision = cloud.revision
  }

  return {
    id: entry.id,
    type: entry.type,
    path: entry.path,
    kind: payload.kind,
    scope,
    privacyZone: privacyZoneForPath(entry.path),
    revision: cloud.revision,
    selectedStateType: cloud.selectedState?.type ?? null,
    selectedStateId: cloud.selectedState?.id ?? null,
    selectedStateRevision: cloud.selectedState?.revision ?? null,
  }
}

export function assertEntrySelectedStateRevision(cloud, entry) {
  if (!Object.hasOwn(entry, 'targetStateRevision') || entry.targetStateRevision === undefined) return

  const actualRevision = cloud.selectedState?.revision ?? null
  if (entry.targetStateRevision === actualRevision) return

  throw new ConflictError(
    `selected_state_revision_mismatch: expected ${entry.targetStateRevision}, got ${actualRevision}`,
    {
      reason: 'selected_state_revision_mismatch',
      id: entry.id,
      type: entry.type,
      path: entry.path,
      scope: entry.scope ?? scopeForPath(entry.path ?? ''),
      expectedRevision: entry.targetStateRevision,
      actualRevision,
      selectedStateId: cloud.selectedState?.id ?? null,
      selectedStateRevision: actualRevision,
    },
  )
}

export function assertEntryBaseRevision(cloud, entry) {
  if (!Object.hasOwn(entry, 'baseRevision') || entry.baseRevision === undefined) return

  const current = cloud.files?.[entry.path]
  const actualRevision = current?.revision ?? null
  if (entry.baseRevision === actualRevision) return

  throw new ConflictError(
    `base_revision_mismatch: expected ${entry.baseRevision}, got ${actualRevision}`,
    {
      reason: 'base_revision_mismatch',
      id: entry.id,
      type: entry.type,
      path: entry.path,
      scope: entry.scope ?? scopeForPath(entry.path ?? ''),
      expectedRevision: entry.baseRevision,
      actualRevision,
      selectedStateId: cloud.selectedState?.id ?? null,
      selectedStateRevision: cloud.selectedState?.revision ?? null,
    },
  )
}

export function classifyJournalEntries(journalEntries, eventEntries) {
  const outcomesById = new Map()

  for (const event of eventEntries) {
    const id = event.detail?.id
    if (!id) continue

    if (event.event === 'cloud.acknowledged') {
      outcomesById.set(id, {
        recoveryStatus: 'acknowledged',
        event,
      })
      continue
    }

    if (event.event === 'journal.recovery_failed') {
      const current = outcomesById.get(id)
      if (current?.recoveryStatus !== 'acknowledged') {
        outcomesById.set(id, {
          recoveryStatus: 'failed',
          event,
        })
      }
    }
  }

  const entries = journalEntries.map((entry) => {
    const outcome = outcomesById.get(entry.id)
    return {
      ...entry,
      recoveryStatus: outcome?.recoveryStatus ?? 'pending',
      recoveryEvent: outcome?.event ?? null,
    }
  })

  return { entries }
}

export async function readJournalSafety(options) {
  const journalEntries = await readNdjson(options.journal)
  const eventEntries = await readNdjson(options.events)
  const journalState = classifyJournalEntries(journalEntries, eventEntries)
  const pendingEntries = journalState.entries.filter((entry) => entry.recoveryStatus === 'pending')
  const failedEntries = journalState.entries.filter((entry) => entry.recoveryStatus === 'failed')

  return {
    safe: pendingEntries.length === 0 && failedEntries.length === 0,
    pendingEntries,
    failedEntries,
    summary: {
      totalEntries: journalEntries.length,
      pendingCount: pendingEntries.length,
      failedCount: failedEntries.length,
      pendingScopeCounts: countEntryScopes(pendingEntries),
      failedScopeCounts: countEntryScopes(failedEntries),
    },
  }
}

export async function hasUnresolvedSyncFailure(options) {
  const events = await readNdjson(options.events)
  const lastSyncOutcome = findLastEventOf(events, ['sync.complete', 'sync.failed', 'sync.recovered'])
  if (lastSyncOutcome?.event !== 'sync.failed') return null

  return {
    at: lastSyncOutcome.at,
    reason: lastSyncOutcome.detail?.reason ?? null,
  }
}

export function syncContextDetail(context) {
  const detail = {
    trigger: context.trigger ?? 'manual',
  }

  if (Number.isInteger(context.coalescedEvents)) detail.coalescedEvents = context.coalescedEvents
  if (context.eventType) detail.eventType = context.eventType
  if (context.path) detail.path = context.path

  return detail
}

export function normalizeWatchFilename(filename) {
  if (typeof filename === 'string') return toCloudPath(filename)
  if (Buffer.isBuffer(filename)) return toCloudPath(filename.toString('utf8'))
  return null
}

export function buildSyncHealth(syncEvents) {
  const { lastStartedSync, lastSuccessfulSync, lastFailedSync, lastRecoveredSync, latestSyncEvent } = syncEvents
  let state = 'idle'

  if (latestSyncEvent?.event === 'sync.failed') {
    state = 'failed'
  } else if (latestSyncEvent?.event === 'sync.started') {
    state = 'syncing'
  } else if (latestSyncEvent?.event === 'sync.complete' || latestSyncEvent?.event === 'sync.recovered') {
    state = 'healthy'
  }

  return {
    state,
    lastStartedSync,
    lastSuccessfulSync,
    lastFailedSync,
    lastRecoveredSync,
    lastError: lastFailedSync?.detail?.reason ?? null,
  }
}

export function buildRefreshHealth(refreshEvents) {
  const { lastRefreshStarted, lastRefreshBlocked, lastRefreshComplete, latestRefreshEvent } = refreshEvents
  let state = 'idle'

  if (latestRefreshEvent?.event === 'refresh.blocked') {
    state = 'blocked'
  } else if (latestRefreshEvent?.event === 'refresh.started') {
    state = 'refreshing'
  } else if (latestRefreshEvent?.event === 'refresh.complete') {
    state = 'healthy'
  }

  return {
    state,
    lastStarted: lastRefreshStarted,
    lastBlocked: lastRefreshBlocked,
    lastComplete: lastRefreshComplete,
    lastError: state === 'blocked' ? (lastRefreshBlocked?.detail?.reason ?? null) : null,
  }
}

export function buildWatchHealth(watchEvents) {
  const { lastWatchStarted, lastWatchDegraded, lastWatchRecoveryBlocked, latestWatchEvent } = watchEvents
  const latestProblem = latestEvent([lastWatchDegraded, lastWatchRecoveryBlocked])
  let state = 'unknown'

  if (latestWatchEvent?.event === 'watch.recovery_blocked') {
    state = 'blocked'
  } else if (latestWatchEvent?.event === 'watch.degraded') {
    if (lastWatchDegraded.detail?.state === 'unavailable') {
      state = 'unavailable-degraded'
    } else if (lastWatchDegraded.detail?.state === 'polling') {
      state = 'polling-degraded'
    } else {
      state = 'degraded'
    }
  } else if (latestWatchEvent?.event === 'watch.started') {
    state = 'watching'
  }

  return {
    state,
    lastStarted: lastWatchStarted,
    lastDegraded: lastWatchDegraded,
    lastRecoveryBlocked: lastWatchRecoveryBlocked,
    lastError: latestProblem?.detail?.reason ?? null,
  }
}

export function buildRemotePullHealth(options, remotePullEvents) {
  const activityTriggersEnabled = remotePullEnabled(options)
  const pushReconciliationEnabled = remotePushEnabled(options)
  const enabled = activityTriggersEnabled || pushReconciliationEnabled
  const currentWatchStartedAt = remotePullEvents.lastWatchStarted?.at ?? null
  const lastRemotePullStarted = eventAtOrAfter(remotePullEvents.lastRemotePullStarted, currentWatchStartedAt)
  const lastRemotePullApplied = eventAtOrAfter(remotePullEvents.lastRemotePullApplied, currentWatchStartedAt)
  const lastRemotePullSkipped = eventAtOrAfter(remotePullEvents.lastRemotePullSkipped, currentWatchStartedAt)
  const lastRemotePullFailed = eventAtOrAfter(remotePullEvents.lastRemotePullFailed, currentWatchStartedAt)
  const latestRemotePullEvent = eventAtOrAfter(remotePullEvents.latestRemotePullEvent, currentWatchStartedAt)
  const latestProblem = latestEvent([
    lastRemotePullSkipped,
    lastRemotePullFailed,
  ])
  const latestProblemIsCurrent = latestProblem && latestProblem === latestRemotePullEvent
  let state = enabled ? 'enabled' : 'disabled'

  if (enabled && latestRemotePullEvent?.event === 'remote-pull.failed') {
    state = 'failed'
  } else if (enabled && latestRemotePullEvent?.event === 'remote-pull.skipped') {
    state = 'skipped'
  }

  return {
    enabled,
    state,
    intervalMs: enabled ? remoteRefreshIntervalMs(options) : null,
    reconciliationIntervalMs: enabled ? remoteRefreshIntervalMs(options) : null,
    activityTriggersEnabled,
    pushReconciliationEnabled,
    safeRefreshOnly: enabled,
    lastStarted: lastRemotePullStarted,
    lastApplied: lastRemotePullApplied,
    lastSkipped: lastRemotePullSkipped,
    lastFailed: lastRemotePullFailed,
    latestEvent: latestRemotePullEvent,
    lastError: latestProblemIsCurrent ? (latestProblem.detail?.reason ?? null) : null,
  }
}

export function buildRemotePushHealth(options, remotePushEvents) {
  const enabled = remotePushEnabled(options)
  const lastApplied = latestEvent([
    remotePushEvents.lastRemotePushApplied,
    enabled ? remotePushEvents.lastRemotePullApplied : null,
  ])
  const lastSkipped = latestEvent([
    remotePushEvents.lastRemotePushSkipped,
    enabled ? remotePushEvents.lastRemotePullSkipped : null,
  ])
  const lastFailed = latestEvent([
    remotePushEvents.lastRemotePushFailed,
    enabled ? remotePushEvents.lastRemotePullFailed : null,
  ])
  const latestRemotePushEvent = latestEvent([
    remotePushEvents.latestRemotePushEvent,
    enabled ? remotePushEvents.lastRemotePullApplied : null,
    enabled ? remotePushEvents.lastRemotePullSkipped : null,
    enabled ? remotePushEvents.lastRemotePullFailed : null,
  ])
  const latestConnectionEvent = latestEvent([
    remotePushEvents.lastRemotePushStarted,
    remotePushEvents.lastRemotePushConnected,
    remotePushEvents.lastRemotePushDisconnected,
  ])
  const latestProblem = latestEvent([
    lastSkipped,
    lastFailed,
    remotePushEvents.lastRemotePushDisconnected,
  ])
  const latestProblemIsCurrent = latestProblem && latestProblem === latestRemotePushEvent
  const latestPushedRevisionEvent = latestEvent([
    remotePushEvents.lastRemotePushConnected,
    remotePushEvents.lastRemotePushDisconnected,
    remotePushEvents.lastRemotePushFallbackPolling,
    remotePushEvents.lastRemotePushApplied,
    remotePushEvents.lastRemotePushSkipped,
    remotePushEvents.lastRemotePushFailed,
  ].filter((event) => Number.isInteger(
    event?.detail?.pushedRevision ?? event?.detail?.lastPushedRevision,
  )))
  let state = enabled ? 'push-disconnected' : 'disabled'
  let connectionState = enabled ? 'disconnected' : 'disabled'
  let fallbackState = enabled ? 'standby' : 'disabled'

  if (enabled && latestConnectionEvent?.event === 'remote-push.connected') {
    connectionState = 'connected'
  }
  if (enabled && latestRemotePushEvent?.event === 'remote-push.fallback_polling') {
    fallbackState = 'checking'
  } else if (enabled && remotePushEvents.lastRemotePushFallbackPolling) {
    fallbackState = 'available'
  }

  if (enabled && latestRemotePushEvent?.event === 'remote-push.connected') {
    state = 'push-connected'
  } else if (enabled && latestRemotePushEvent?.event === 'remote-push.disconnected') {
    state = 'push-disconnected'
  } else if (enabled && latestRemotePushEvent?.event === 'remote-push.fallback_polling') {
    state = 'push-fallback-polling'
  } else if (enabled && (latestRemotePushEvent?.event === 'remote-push.skipped' || latestRemotePushEvent?.event === 'remote-pull.skipped')) {
    state = 'push-skipped'
  } else if (enabled && (latestRemotePushEvent?.event === 'remote-push.applied' || latestRemotePushEvent?.event === 'remote-pull.applied')) {
    state = 'push-applied'
  } else if (enabled && (latestRemotePushEvent?.event === 'remote-push.failed' || latestRemotePushEvent?.event === 'remote-pull.failed')) {
    state = 'push-disconnected'
  }

  return {
    enabled,
    state,
    connectionState,
    fallbackState,
    hubUrl: enabled ? remotePushUrl(options) : null,
    reconciliationIntervalMs: enabled ? remoteRefreshIntervalMs(options) : null,
    safeRefreshOnly: enabled,
    lastStarted: remotePushEvents.lastRemotePushStarted ?? null,
    lastConnected: remotePushEvents.lastRemotePushConnected ?? null,
    lastDisconnected: remotePushEvents.lastRemotePushDisconnected ?? null,
    lastFallbackPolling: remotePushEvents.lastRemotePushFallbackPolling ?? null,
    lastApplied,
    lastSkipped,
    lastFailed,
    latestEvent: latestRemotePushEvent,
    lastEventId: latestRemotePushEvent?.detail?.eventId ??
      remotePushEvents.lastRemotePushApplied?.detail?.eventId ??
      null,
    lastPushedRevision: latestPushedRevisionEvent?.detail?.pushedRevision ??
      latestPushedRevisionEvent?.detail?.lastPushedRevision ??
      null,
    lastAppliedRevision: lastApplied?.detail?.toRevision ?? null,
    lastSkippedReason: lastSkipped?.detail?.reason ?? null,
    lastError: latestProblemIsCurrent ? (latestProblem.detail?.reason ?? null) : null,
  }
}

export function eventAtOrAfter(event, reference) {
  if (!event || !reference) return event ?? null
  return isTimestampAtOrAfter(event.at, reference) ? event : null
}

export function latestEvent(events) {
  return events.filter(Boolean).reduce((latest, event) => {
    if (!latest || isEventAfter(event, latest)) return event
    return latest
  }, null)
}

export function isEventAfter(event, reference) {
  if (!event) return false
  if (!reference) return true

  const eventAt = Date.parse(event.at)
  const referenceAt = Date.parse(reference.at)
  if (Number.isNaN(eventAt) || Number.isNaN(referenceAt)) return false

  return eventAt >= referenceAt
}

export function visibleRevisionFromEvent(event) {
  if (!event) return null
  if (Number.isInteger(event.detail?.toRevision)) return event.detail.toRevision
  if (Number.isInteger(event.detail?.revision)) return event.detail.revision
  return null
}

export function workspaceRootFromOptions(options) {
  return options['workspace-root'] ?? path.dirname(path.resolve(options.workspace))
}

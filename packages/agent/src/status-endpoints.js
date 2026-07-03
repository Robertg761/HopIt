// @ts-check
import path from 'node:path'
import { createCloudGraphService, summarizeRequester, visibilityRequestFromOptions } from './cloud/d1-graph-service.js'
import { workspaceMode } from './constants.js'
import { findLastEvent, findLastEventOf, readNdjson } from './io.js'
import { countCloudScopes, countEntryScopes } from './journal.js'
import { cloudLocationFromOptions } from './paths.js'
import { buildRefreshHealth, buildRemotePullHealth, buildSyncHealth, buildWatchHealth, classifyJournalEntries, workspaceRootFromOptions } from './status-state.js'
import { findIndexedCodebase, localCacheSnapshotForCloud, readWorkspaceIndex, workspaceIndexSummary } from './workspace-index.js'
import { buildRemoteCursor, buildWorkspaceHydration, contentManifestSummary } from './workspace-manifest.js'
import { existsSync, watch } from 'node:fs'

export async function readAgentStatusEndpoint(options) {
  const cloudService = createCloudGraphService(options)
  const [journalEntries, eventEntries, workspaceIndex] = await Promise.all([
    readNdjson(options.journal),
    readNdjson(options.events),
    readWorkspaceIndex(options),
  ])
  const journalState = classifyJournalEntries(journalEntries, eventEntries)
  const eventsSummary = {
    ...summarizeAgentEvents(eventEntries),
    path: path.resolve(options.events),
    exists: existsSync(options.events),
  }
  const journalSummary = {
    ...summarizeAgentJournal(journalEntries, journalState),
    path: path.resolve(options.journal),
    exists: existsSync(options.journal),
  }
  const indexedCodebase = findIndexedCodebase(workspaceIndex, options['codebase-id'], options.workspace)
  const cloudSummary = fastCloudSummaryFromIndex(options, cloudService, indexedCodebase)
  const workspaceExists = existsSync(options.workspace)
  const hydration = buildWorkspaceHydration({
    cloudSummary,
    workspaceExists,
    lastWorkspaceReady: eventsSummary.lastWorkspaceReady,
    lastRefreshComplete: eventsSummary.lastRefreshComplete,
    indexedCodebase,
  })
  const syncHealth = buildSyncHealth(eventsSummary)
  const refreshHealth = buildRefreshHealth(eventsSummary)
  const watchHealth = buildWatchHealth(eventsSummary)
  const remotePullHealth = buildRemotePullHealth(options, eventsSummary)
  remotePullHealth.cursor = buildRemoteCursor({
    cloudSummary,
    eventsSummary,
    hydration,
  })
  const initialized = cloudSummary.exists && (hydration.state === 'materialized' || hydration.state === 'partial')
  const attached = cloudSummary.exists && hydration.state === 'metadata-only'
  const readiness = initialized || watchHealth.state === 'watching' ? 'ready' : attached ? 'attached' : 'not_initialized'
  const localCache = localCacheSnapshotForCloud(options, null, indexedCodebase)

  return {
    ok:
      (readiness === 'ready' || readiness === 'attached') &&
      journalSummary.failedCount === 0 &&
      syncHealth.state !== 'failed' &&
      refreshHealth.state !== 'blocked' &&
      !watchHealth.state.endsWith('degraded') &&
      watchHealth.state !== 'blocked',
    generatedAt: new Date().toISOString(),
    readiness,
    mode: workspaceMode,
    codebaseId: cloudSummary.codebase?.id ?? options['codebase-id'] ?? null,
    codebaseName: cloudSummary.codebase?.name ?? null,
    selectedStateType: cloudSummary.selectedState?.type ?? null,
    activeChangeSetId:
      cloudSummary.selectedState?.type === 'active-change-set' ? cloudSummary.selectedState.id : indexedCodebase?.activeChangeSetId ?? null,
    mainId: cloudSummary.main?.id ?? indexedCodebase?.mainId ?? null,
    ownerId: cloudSummary.owner?.id ?? cloudSummary.codebase?.ownerId ?? null,
    sessionId: cloudSummary.session?.id ?? null,
    requesterId: null,
    requesterSessionId: cloudSummary.session?.id ?? null,
    requesterRole: null,
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
      hydration,
      localChanges: {
        safe: true,
        state: 'not_scanned',
        reason: 'status_endpoint_avoids_workspace_scan',
        addedCount: null,
        modifiedCount: null,
        deletedCount: null,
        samplePaths: [],
      },
      contentManifest: contentManifestSummary(indexedCodebase?.contentManifest),
      cache: localCache.summary,
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
      state: eventsSummary.lastRemoteUpdate ? 'updated' : 'idle',
      lastUpdate: eventsSummary.lastRemoteUpdate,
    },
    remotePull: remotePullHealth,
    watch: watchHealth,
    events: eventsSummary,
  }
}

export async function readAgentEventsEndpoint(options) {
  return {
    ...summarizeAgentEvents(await readNdjson(options.events)),
    path: path.resolve(options.events),
    exists: existsSync(options.events),
  }
}

export async function readAgentJournalEndpoint(options) {
  const [journalEntries, eventEntries] = await Promise.all([
    readNdjson(options.journal),
    readNdjson(options.events),
  ])
  return {
    ...summarizeAgentJournal(journalEntries, classifyJournalEntries(journalEntries, eventEntries)),
    path: path.resolve(options.journal),
    exists: existsSync(options.journal),
  }
}

export async function readAgentCloudEndpoint(options) {
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readOptionalVisibleGraph(visibilityRequestFromOptions(options))
  const cloudFiles = cloud?.files ? Object.keys(cloud.files) : []
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
    access: cloud?.visibilityContext ? summarizeRequester(cloud.visibilityContext) : null,
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
    scopeCounts: countCloudScopes(cloud),
  }

  return {
    ...cloudSummary,
    graph: cloud,
  }
}

export function summarizeAgentEvents(eventEntries) {
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
  const lastRefreshStarted = findLastEvent(eventEntries, 'refresh.started')
  const lastRefreshBlocked = findLastEvent(eventEntries, 'refresh.blocked')
  const lastRefreshComplete = findLastEvent(eventEntries, 'refresh.complete')
  const lastWorkspaceReady = findLastEvent(eventEntries, 'workspace.ready')
  const lastRemoteUpdate = findLastEvent(eventEntries, 'remote-update')
  const lastRemotePullStarted = findLastEvent(eventEntries, 'remote-pull.started')
  const lastRemotePullSkipped = findLastEvent(eventEntries, 'remote-pull.skipped')
  const lastRemotePullFailed = findLastEvent(eventEntries, 'remote-pull.failed')
  const lastRemotePullApplied = findLastEvent(eventEntries, 'remote-pull.applied')
  const latestRemotePullEvent = findLastEventOf(eventEntries, [
    'remote-pull.started',
    'remote-pull.applied',
    'remote-pull.skipped',
    'remote-pull.failed',
  ])
  const latestRefreshEvent = findLastEventOf(eventEntries, [
    'refresh.started',
    'refresh.blocked',
    'refresh.complete',
  ])
  const lastRecovery = findLastEvent(eventEntries, 'journal.recovery_complete')
  const lastWatchStarted = findLastEvent(eventEntries, 'watch.started')
  const lastWatchDegraded = findLastEvent(eventEntries, 'watch.degraded')
  const lastWatchRecoveryBlocked = findLastEvent(eventEntries, 'watch.recovery_blocked')
  const latestWatchEvent = findLastEventOf(eventEntries, [
    'watch.started',
    'watch.degraded',
    'watch.recovery_blocked',
  ])

  return {
    path: null,
    exists: eventEntries.length > 0,
    totalEntries: eventEntries.length,
    recent: eventEntries.slice(-20),
    lastAcknowledgement,
    lastSync,
    lastStartedSync,
    lastFailedSync,
    lastRecoveredSync,
    latestSyncEvent,
    lastWorkspaceReady,
    lastRefreshStarted,
    lastRefreshBlocked,
    lastRefreshComplete,
    lastRemoteUpdate,
    lastRemotePullStarted,
    lastRemotePullApplied,
    lastRemotePullSkipped,
    lastRemotePullFailed,
    latestRemotePullEvent,
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
}

export function summarizeAgentJournal(journalEntries, journalState) {
  const pendingJournalEntries = journalState.entries.filter((entry) => entry.recoveryStatus === 'pending')
  const failedJournalEntries = journalState.entries.filter((entry) => entry.recoveryStatus === 'failed')
  const acknowledgedJournalEntries = journalState.entries.filter(
    (entry) => entry.recoveryStatus === 'acknowledged',
  )

  return {
    path: null,
    exists: journalEntries.length > 0,
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
}

export function fastCloudSummaryFromIndex(options, cloudService, indexedCodebase) {
  const codebaseId = indexedCodebase?.id ?? options['codebase-id'] ?? null
  const selectedStateType = indexedCodebase?.activeChangeSetId ? 'active-change-set' : null
  const revision = indexedCodebase?.remoteCursor?.graphRevision ?? indexedCodebase?.hydration?.lastMaterializedRevision ?? null
  const selectedStateRevision = indexedCodebase?.remoteCursor?.selectedStateRevision ?? null

  return {
    path: cloudService.location ?? cloudLocationFromOptions(options, codebaseId),
    service: cloudService.type,
    exists: Boolean(indexedCodebase?.cloud?.exists ?? indexedCodebase),
    schemaVersion: null,
    codebase: codebaseId
      ? {
          id: codebaseId,
          name: indexedCodebase?.name ?? codebaseId,
          ownerId: null,
        }
      : null,
    main: indexedCodebase?.mainId
      ? {
          id: indexedCodebase.mainId,
          revision,
        }
      : null,
    selectedState: selectedStateType
      ? {
          type: selectedStateType,
          id: indexedCodebase.activeChangeSetId,
          ownerId: null,
          baseMainId: indexedCodebase.mainId ?? null,
          baseRevision: null,
          revision: selectedStateRevision,
          visibility: null,
          effectiveVisibility: null,
          reviewState: 'not-open',
          mergeState: 'unmerged',
          conflictState: 'none',
          conflict: null,
          review: null,
          merge: null,
        }
      : null,
    owner: null,
    session: {
      id: options['session-id'] ?? null,
      deviceName: options['device-name'] ?? null,
    },
    requester: null,
    hiddenFileCount: indexedCodebase?.hiddenFileCount ?? null,
    hiddenScopeCounts: indexedCodebase?.hiddenScopeCounts ?? null,
    visibility: null,
    revision,
    fileCount: indexedCodebase?.visibleFileCount ?? indexedCodebase?.hydration?.hydratedPathCount ?? 0,
    scopeCounts: indexedCodebase?.scopeCounts ?? null,
  }
}


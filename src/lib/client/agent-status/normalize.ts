import type { AgentPanelState, AgentStatusSnapshot } from '@hopit/core'

import { offlineAgentStatus } from './defaults'
import { formatEventTime, formatRevision, remotePullCadenceLabel, remotePullModeLabel } from './formatters'
import {
  backendName,
  mapCloudFiles,
  mapGraphMembers,
  mapRecentEvents,
  mapRequester,
  numberOrNull,
  stringOrNull,
} from './mappers'

export type {
  AgentCodebaseRole,
  AgentEvent,
  AgentEventTone,
  AgentFile,
  AgentFileLocal,
  AgentFileLocalState,
  AgentMember,
  AgentPanelState,
  AgentRequester,
  AgentStatusSnapshot,
} from '@hopit/core'

export type RawAgentResponse = {
  status?: RawAgentStatus | null
  cloud?: RawCloudResponse | null
  events?: RawEventsResponse | null
  capabilities?: {
    backend?: string
    hosted?: boolean
    commands?: boolean
  }
  error?: {
    code?: string
    message?: string
    agentBaseUrl?: string
  }
}

export type RawCloudResponse = {
  graph?: {
    codebase?: {
      id?: string | null
      ownerId?: string | null
    } | null
    owner?: RawGraphMember | null
    collaborators?: RawGraphMember[]
    visibilityContext?: RawAccessContext | null
    files?: Record<string, RawCloudFile>
  } | null
  access?: RawAccessContext | null
}

export type RawGraphMember = {
  id?: string | null
  userId?: string | null
  name?: string | null
  displayName?: string | null
  email?: string | null
  primaryEmail?: string | null
  avatarUrl?: string | null
  role?: string | null
  status?: string | null
  source?: string | null
  joinedAt?: string | null
  createdAt?: string | null
}

export type RawAccessContext = {
  id?: string | null
  sessionId?: string | null
  role?: string | null
  isOwner?: boolean
  isCollaborator?: boolean
  membershipSource?: string | null
  permissions?: unknown[]
  visibleFileCount?: number | null
  hiddenFileCount?: number | null
}

export type RawCloudFile = {
  kind?: string
  encoding?: string
  target?: string | null
  scope?: string
  revision?: number
  size?: number
  hash?: string
  contentStorage?: string | null
  blobProvider?: string | null
  blobKey?: string | null
  blobHash?: string | null
  content?: string
}

export type RawEventsResponse = {
  recent?: RawAgentEvent[]
  lastAcknowledgement?: RawAgentEvent | null
  lastSync?: RawAgentEvent | null
  lastStartedSync?: RawAgentEvent | null
  lastFailedSync?: RawAgentEvent | null
  lastRecoveredSync?: RawAgentEvent | null
  latestSyncEvent?: RawAgentEvent | null
  lastRefreshStarted?: RawAgentEvent | null
  lastRefreshBlocked?: RawAgentEvent | null
  lastRefreshComplete?: RawAgentEvent | null
  latestRefreshEvent?: RawAgentEvent | null
  lastRemoteUpdate?: RawAgentEvent | null
}

export type RawAgentStatus = {
  ok?: boolean
  generatedAt?: string
  readiness?: string
  codebaseId?: string | null
  codebaseName?: string | null
  activeChangeSetId?: string | null
  mainId?: string | null
  ownerId?: string | null
  requesterId?: string | null
  requesterSessionId?: string | null
  requesterRole?: string | null
  visibleFileCount?: number | null
  hiddenFileCount?: number | null
  effectiveChangeSetVisibility?: string | null
  access?: RawAccessContext | null
  workspace?: {
    path?: string | null
    cacheMode?: string | null
    hydration?: {
      state?: string
      lastMaterializedRevision?: number | null
      graphRevision?: number | null
    } | null
    index?: {
      path?: string | null
      exists?: boolean
    } | null
    cache?: {
      hydratedFiles?: number
      pinnedFiles?: number
      prunableFiles?: number
      bytesOnDisk?: number
    } | null
    files?: Record<string, RawLocalFileState>
  }
  cloud?: {
    revision?: number | null
    main?: {
      revision?: number | null
    } | null
    scopeCounts?: {
      private?: number
    }
  }
  journal?: {
    pendingCount?: number
    failedCount?: number
    acknowledgedCount?: number
  }
  sync?: {
    state?: string
    lastSuccessfulAt?: string | null
    lastAcknowledgementAt?: string | null
  }
  refresh?: {
    state?: string
  }
  remoteUpdate?: {
    state?: string
  }
  remotePull?: {
    enabled?: boolean
    state?: string
    intervalMs?: number | null
    lastStarted?: {
      detail?: {
        state?: string
        mode?: string
        cooldownMs?: number | null
      } | null
    } | null
    cursor?: {
      materializedRevision?: number | null
      graphRevision?: number | null
      behindByRevisions?: number | null
    } | null
  }
  review?: {
    state?: string
  }
  merge?: {
    state?: string
  }
  conflict?: {
    state?: string
  }
  events?: RawEventsResponse
}

export type RawAgentEvent = {
  id?: string
  type?: string
  event?: string
  timestamp?: string
  at?: string
  payload?: Record<string, unknown>
  detail?: Record<string, unknown>
}

export type RawLocalFileState = {
  path?: string | null
  exists?: boolean
  hydrated?: boolean
  state?: string
  pinned?: boolean
  dirty?: boolean
  pending?: boolean
  blocked?: boolean
  prunable?: boolean
  bytesOnDisk?: number | null
  lastHydratedAt?: string | null
  lastEditedAt?: string | null
  lastSyncedAt?: string | null
  lastPrunedAt?: string | null
}

export function mapAgentStatusResponse(response: unknown): AgentStatusSnapshot {
  const wrappedResponse = isRawAgentResponse(response) ? response : null
  const rawStatus = wrappedResponse?.status ?? (isRawAgentStatus(response) ? response : null)

  if (!rawStatus) {
    const offline = offlineAgentStatus(wrappedResponse?.error?.message ?? 'Agent status endpoint is unavailable.')
    offline.backend = backendName(wrappedResponse?.capabilities?.backend)
    offline.commandsAvailable = Boolean(wrappedResponse?.capabilities?.commands)
    return offline
  }

  const status = rawStatus
  const pendingWrites = status.journal?.pendingCount ?? 0
  const failedWrites = status.journal?.failedCount ?? 0
  const syncState = status.sync?.state ?? 'idle'
  const refreshState = status.refresh?.state ?? 'idle'
  const conflictState = status.conflict?.state ?? 'none'
  const isBlocked =
    syncState === 'failed' ||
    failedWrites > 0 ||
    refreshState === 'blocked' ||
    conflictState === 'conflicted'
  const isSyncing = syncState === 'syncing' || refreshState === 'refreshing' || pendingWrites > 0
  const state: AgentPanelState = isBlocked ? 'blocked' : isSyncing ? 'syncing' : 'online'
  const privateFiles = status.cloud?.scopeCounts?.private ?? 0
  const events = wrappedResponse?.events ?? status.events
  const recentEvents = events?.recent ?? []
  const remoteUpdateState = status.remoteUpdate?.state ?? (events?.lastRemoteUpdate ? 'updated' : 'idle')
  const remotePullState = status.remotePull?.state ?? 'disabled'
  const remotePullEnabled = Boolean(status.remotePull?.enabled)
  const remotePullMode = remotePullModeLabel(status.remotePull)
  const remotePullCadence = remotePullCadenceLabel(status.remotePull)
  const workspaceHydration = status.workspace?.hydration
  const remoteCursor = status.remotePull?.cursor
  const backend = backendName(wrappedResponse?.capabilities?.backend)
  const access = status.access ?? wrappedResponse?.cloud?.access ?? wrappedResponse?.cloud?.graph?.visibilityContext ?? null
  const codebaseId = stringOrNull(status.codebaseId) ?? stringOrNull(wrappedResponse?.cloud?.graph?.codebase?.id)

  return {
    id: status.codebaseName ? `${status.codebaseName}-agent` : 'local-hopit-agent',
    state,
    healthLabel: status.ok === false ? 'Needs attention' : state === 'syncing' ? 'Syncing' : 'Online',
    codebaseId,
    managedWorkspacePath: status.workspace?.path ?? 'Workspace unavailable',
    codebaseName: status.codebaseName ?? 'Unknown codebase',
    activeChangeSetId: status.activeChangeSetId ?? 'None',
    mainId: status.mainId ?? 'None',
    cloudRevision: formatRevision('cloud-rev', status.cloud?.revision),
    mainRevision: formatRevision('main-rev', status.cloud?.main?.revision),
    fileCount: status.visibleFileCount ?? 0,
    hiddenFileCount: status.hiddenFileCount ?? 0,
    pendingWrites,
    failedWrites,
    acknowledgedWrites: status.journal?.acknowledgedCount ?? 0,
    lastSync: formatEventTime(events?.lastSync?.at ?? events?.lastSync?.timestamp ?? status.sync?.lastSuccessfulAt),
    lastAck: formatEventTime(
      events?.lastAcknowledgement?.at ??
        events?.lastAcknowledgement?.timestamp ??
        status.sync?.lastAcknowledgementAt,
    ),
    cacheState: isBlocked ? 'blocked' : isSyncing ? 'syncing' : 'ready',
    privateScope: privateFiles > 0 ? 'scoped' : 'none',
    privateScopePath: `${status.workspace?.path ?? 'workspace'}/.private/`,
    visibility: status.effectiveChangeSetVisibility ?? 'Unknown',
    reviewState: status.review?.state ?? 'not-open',
    mergeState: status.merge?.state ?? 'unmerged',
    conflictState,
    remoteUpdateState,
    remotePullState,
    remotePullEnabled,
    remotePullMode,
    remotePullCadence,
    workspaceHydrationState: workspaceHydration?.state ?? status.readiness ?? 'unknown',
    workspaceMaterializedRevision:
      numberOrNull(workspaceHydration?.lastMaterializedRevision) ??
      numberOrNull(remoteCursor?.materializedRevision),
    workspaceIndexPath: stringOrNull(status.workspace?.index?.path),
    remoteBehindByRevisions: numberOrNull(remoteCursor?.behindByRevisions),
    commandsAvailable: Boolean(wrappedResponse?.capabilities?.commands),
    backend,
    requester: mapRequester(status, access),
    members: mapGraphMembers(wrappedResponse?.cloud?.graph, access, status),
    files: mapCloudFiles(wrappedResponse?.cloud, status.workspace?.files),
    events: mapRecentEvents(recentEvents),
    rawUpdatedAt: status.generatedAt ?? null,
  }
}

function isRawAgentResponse(response: unknown): response is RawAgentResponse {
  return typeof response === 'object' && response !== null && ('status' in response || 'error' in response)
}

function isRawAgentStatus(response: unknown): response is RawAgentStatus {
  return (
    typeof response === 'object' &&
    response !== null &&
    ('ok' in response || 'generatedAt' in response || 'codebaseName' in response)
  )
}


export type AgentEventTone = 'ready' | 'syncing' | 'queued' | 'observed' | 'blocked'

export type AgentPanelState = 'online' | 'syncing' | 'offline' | 'blocked'

export type AgentCodebaseRole = 'owner' | 'maintainer' | 'member' | 'viewer' | 'guest'

export type AgentEvent = {
  id: string
  label: string
  detail: string
  when: string
  tone: AgentEventTone
}

export type AgentRequester = {
  id: string | null
  sessionId: string | null
  role: AgentCodebaseRole
  isOwner: boolean
  isCollaborator: boolean
  membershipSource: string
  permissions: string[]
  visibleFileCount: number | null
  hiddenFileCount: number | null
}

export type AgentMember = {
  id: string
  name: string
  email: string | null
  role: Exclude<AgentCodebaseRole, 'guest'>
  status: 'active' | 'suspended' | 'unknown'
  source: string
  isOwner: boolean
  joinedAt: string | null
  avatarUrl: string | null
}

export type AgentStatusSnapshot = {
  id: string
  state: AgentPanelState
  healthLabel: string
  codebaseId: string | null
  managedWorkspacePath: string
  codebaseName: string
  activeChangeSetId: string
  mainId: string
  cloudRevision: string
  mainRevision: string
  fileCount: number
  hiddenFileCount: number
  pendingWrites: number
  failedWrites: number
  acknowledgedWrites: number
  lastSync: string
  lastAck: string
  cacheState: 'ready' | 'syncing' | 'offline' | 'blocked'
  privateScope: 'scoped' | 'none'
  privateScopePath: string
  visibility: string
  reviewState: string
  mergeState: string
  conflictState: string
  remoteUpdateState: string
  remotePullState: string
  remotePullEnabled: boolean
  workspaceHydrationState: string
  workspaceMaterializedRevision: number | null
  workspaceIndexPath: string | null
  remoteBehindByRevisions: number | null
  commandsAvailable: boolean
  backend: 'local-agent' | 'convex' | 'unknown'
  requester: AgentRequester
  members: AgentMember[]
  files: AgentFile[]
  events: AgentEvent[]
  rawUpdatedAt: string | null
  unavailableReason?: string
}

export type AgentFile = {
  path: string
  name: string
  directory: string
  kind: 'file' | 'symlink' | 'directory'
  encoding: 'utf8' | 'base64' | null
  target: string | null
  scope: 'shared' | 'owner-private'
  revision: number | null
  size: number | null
  hash: string | null
  contentStorage: string | null
  blobProvider: string | null
  blobKey: string | null
  blobHash: string | null
  contentPreview: string | null
  contentPreviewTruncated: boolean
}

type RawAgentResponse = {
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

type RawCloudResponse = {
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

type RawGraphMember = {
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

type RawAccessContext = {
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

type RawCloudFile = {
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

type RawEventsResponse = {
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

type RawAgentStatus = {
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

type RawAgentEvent = {
  id?: string
  type?: string
  event?: string
  timestamp?: string
  at?: string
  payload?: Record<string, unknown>
  detail?: Record<string, unknown>
}

export function offlineAgentStatus(reason = 'Start the local HopIt agent status server.'): AgentStatusSnapshot {
  return {
    id: 'local-hopit-agent',
    state: 'offline',
    healthLabel: 'Offline',
    codebaseId: null,
    managedWorkspacePath: 'Agent not connected',
    codebaseName: 'No codebase',
    activeChangeSetId: 'No active change set',
    mainId: 'No Main state',
    cloudRevision: 'Unavailable',
    mainRevision: 'Unavailable',
    fileCount: 0,
    hiddenFileCount: 0,
    pendingWrites: 0,
    failedWrites: 0,
    acknowledgedWrites: 0,
    lastSync: 'Unavailable',
    lastAck: 'Unavailable',
    cacheState: 'offline',
    privateScope: 'none',
    privateScopePath: '.private/',
    visibility: 'Unavailable',
    reviewState: 'Unavailable',
    mergeState: 'Unavailable',
    conflictState: 'Unavailable',
    remoteUpdateState: 'Unavailable',
    remotePullState: 'Unavailable',
    remotePullEnabled: false,
    workspaceHydrationState: 'Unavailable',
    workspaceMaterializedRevision: null,
    workspaceIndexPath: null,
    remoteBehindByRevisions: null,
    commandsAvailable: false,
    backend: 'unknown',
    requester: offlineRequester(),
    members: [],
    files: [],
    events: [
      {
        id: 'agent-offline',
        label: 'agent:offline',
        detail: reason,
        when: 'now',
        tone: 'blocked',
      },
    ],
    rawUpdatedAt: null,
    unavailableReason: reason,
  }
}

export function mapAgentStatusResponse(response: unknown): AgentStatusSnapshot {
  const wrappedResponse = isRawAgentResponse(response) ? response : null
  const rawStatus = wrappedResponse?.status ?? (isRawAgentStatus(response) ? response : null)

  if (!rawStatus) {
    return offlineAgentStatus(wrappedResponse?.error?.message ?? 'Agent status endpoint is unavailable.')
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
    files: mapCloudFiles(wrappedResponse?.cloud),
    events: mapRecentEvents(recentEvents),
    rawUpdatedAt: status.generatedAt ?? null,
  }
}

function mapRequester(status: RawAgentStatus, access: RawAccessContext | null): AgentRequester {
  const role = roleName(access?.role ?? status.requesterRole)

  return {
    id: stringOrNull(access?.id) ?? stringOrNull(status.requesterId),
    sessionId: stringOrNull(access?.sessionId) ?? stringOrNull(status.requesterSessionId),
    role,
    isOwner: Boolean(access?.isOwner) || role === 'owner',
    isCollaborator: Boolean(access?.isCollaborator),
    membershipSource: stringOrNull(access?.membershipSource) ?? (role === 'guest' ? 'none' : 'unknown'),
    permissions: permissionsFromAccess(access, role),
    visibleFileCount: numberOrNull(access?.visibleFileCount) ?? numberOrNull(status.visibleFileCount),
    hiddenFileCount: numberOrNull(access?.hiddenFileCount) ?? numberOrNull(status.hiddenFileCount),
  }
}

function offlineRequester(): AgentRequester {
  return {
    id: null,
    sessionId: null,
    role: 'guest',
    isOwner: false,
    isCollaborator: false,
    membershipSource: 'none',
    permissions: [],
    visibleFileCount: null,
    hiddenFileCount: null,
  }
}

function permissionsFromAccess(access: RawAccessContext | null, role: AgentCodebaseRole) {
  const rawPermissions = access?.permissions?.filter((permission): permission is string => typeof permission === 'string')
  if (rawPermissions && rawPermissions.length > 0) return Array.from(new Set(rawPermissions))

  if (role === 'owner') return ['read', 'write', 'invite', 'manage_members', 'review', 'merge', 'release']
  if (role === 'maintainer') return ['read', 'write', 'invite', 'review', 'merge', 'release']
  if (role === 'member') return ['read', 'write', 'review']
  if (role === 'viewer') return ['read']
  return []
}

function mapGraphMembers(
  graph: RawCloudResponse['graph'] | null | undefined,
  access: RawAccessContext | null,
  status: RawAgentStatus,
): AgentMember[] {
  if (!graph) return []

  const ownerId = stringOrNull(graph.owner?.id) ?? stringOrNull(graph.codebase?.ownerId) ?? stringOrNull(status.ownerId)
  const members = new Map<string, AgentMember>()

  if (ownerId) {
    members.set(ownerId, {
      id: ownerId,
      name: memberDisplayName(graph.owner, ownerId),
      email: stringOrNull(graph.owner?.email) ?? stringOrNull(graph.owner?.primaryEmail),
      role: 'owner',
      status: memberStatus(graph.owner?.status),
      source: stringOrNull(graph.owner?.source) ?? 'owner',
      isOwner: true,
      joinedAt: stringOrNull(graph.owner?.joinedAt) ?? stringOrNull(graph.owner?.createdAt),
      avatarUrl: stringOrNull(graph.owner?.avatarUrl),
    })
  }

  for (const collaborator of graph.collaborators ?? []) {
    const id = stringOrNull(collaborator.id) ?? stringOrNull(collaborator.userId)
    if (!id || members.has(id)) continue

    members.set(id, {
      id,
      name: memberDisplayName(collaborator, id),
      email: stringOrNull(collaborator.email) ?? stringOrNull(collaborator.primaryEmail),
      role: memberRole(collaborator.role),
      status: memberStatus(collaborator.status),
      source: stringOrNull(collaborator.source) ?? 'graph',
      isOwner: false,
      joinedAt: stringOrNull(collaborator.joinedAt) ?? stringOrNull(collaborator.createdAt),
      avatarUrl: stringOrNull(collaborator.avatarUrl),
    })
  }

  const requesterId = stringOrNull(access?.id) ?? stringOrNull(status.requesterId)
  const requesterRole = roleName(access?.role ?? status.requesterRole)
  if (requesterId && requesterRole !== 'guest' && !members.has(requesterId)) {
    members.set(requesterId, {
      id: requesterId,
      name: requesterId,
      email: null,
      role: memberRole(requesterRole),
      status: 'active',
      source: stringOrNull(access?.membershipSource) ?? 'requester',
      isOwner: requesterRole === 'owner',
      joinedAt: null,
      avatarUrl: null,
    })
  }

  return Array.from(members.values()).sort((a, b) => {
    if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function memberDisplayName(member: RawGraphMember | null | undefined, fallback: string) {
  return (
    stringOrNull(member?.displayName) ??
    stringOrNull(member?.name) ??
    stringOrNull(member?.email) ??
    stringOrNull(member?.primaryEmail) ??
    fallback
  )
}

function roleName(value: unknown): AgentCodebaseRole {
  if (
    value === 'owner' ||
    value === 'maintainer' ||
    value === 'member' ||
    value === 'viewer' ||
    value === 'guest'
  ) {
    return value
  }
  return 'guest'
}

function memberRole(value: unknown): Exclude<AgentCodebaseRole, 'guest'> {
  const role = roleName(value)
  return role === 'guest' ? 'member' : role
}

function memberStatus(value: unknown): AgentMember['status'] {
  if (value === 'active' || value === 'suspended') return value
  return 'active'
}

function mapCloudFiles(cloud: RawCloudResponse | null | undefined): AgentFile[] {
  const files = cloud?.graph?.files ?? {}

  return Object.entries(files)
    .map(([filePath, file]) => {
      const preview = contentPreview(file)

      return {
        path: filePath,
        name: pathName(filePath),
        directory: pathDirectory(filePath),
        kind: fileKind(file.kind),
        encoding: fileEncoding(file.encoding, file.kind),
        target: typeof file.target === 'string' ? file.target : null,
        scope: fileScope(file.scope),
        revision: typeof file.revision === 'number' ? file.revision : null,
        size: typeof file.size === 'number' ? file.size : contentSize(file.content),
        hash: typeof file.hash === 'string' ? file.hash : null,
        contentStorage: typeof file.contentStorage === 'string' ? file.contentStorage : null,
        blobProvider: typeof file.blobProvider === 'string' ? file.blobProvider : null,
        blobKey: typeof file.blobKey === 'string' ? file.blobKey : null,
        blobHash: typeof file.blobHash === 'string' ? file.blobHash : null,
        contentPreview: preview.content,
        contentPreviewTruncated: preview.truncated,
      }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
}

function backendName(value: string | undefined): AgentStatusSnapshot['backend'] {
  if (value === 'local-agent' || value === 'convex') return value
  return 'unknown'
}

function fileScope(scope: string | undefined): AgentFile['scope'] {
  return scope === 'owner-private' ? 'owner-private' : 'shared'
}

function fileKind(kind: string | undefined): AgentFile['kind'] {
  if (kind === 'symlink' || kind === 'directory') return kind
  return 'file'
}

function fileEncoding(encoding: string | undefined, kind: string | undefined): AgentFile['encoding'] {
  if (fileKind(kind) !== 'file') return null
  return encoding === 'base64' ? 'base64' : 'utf8'
}

function pathName(filePath: string) {
  return filePath.split('/').pop() ?? filePath
}

function pathDirectory(filePath: string) {
  const parts = filePath.split('/')
  parts.pop()
  return parts.join('/') || '/'
}

function contentSize(content: string | undefined) {
  return typeof content === 'string' ? new TextEncoder().encode(content).length : null
}

function contentPreview(file: RawCloudFile) {
  const maxPreviewCharacters = 2400

  if (
    fileScope(file.scope) === 'owner-private' ||
    fileKind(file.kind) !== 'file' ||
    file.contentStorage === 'object-blob' ||
    fileEncoding(file.encoding, file.kind) !== 'utf8' ||
    typeof file.content !== 'string'
  ) {
    return { content: null, truncated: false }
  }

  const normalizedContent = file.content.replace(/\r\n/g, '\n')

  return {
    content:
      normalizedContent.length > maxPreviewCharacters
        ? normalizedContent.slice(0, maxPreviewCharacters)
        : normalizedContent,
    truncated: normalizedContent.length > maxPreviewCharacters,
  }
}

function stringOrNull(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberOrNull(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
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

function mapRecentEvents(events: RawAgentEvent[]): AgentEvent[] {
  if (events.length === 0) {
    return [
      {
        id: 'agent-ready-empty',
        label: 'agent:ready',
        detail: 'Status endpoint is reachable and waiting for local activity.',
        when: 'now',
        tone: 'ready',
      },
    ]
  }

  return events
    .slice(-5)
    .reverse()
    .map((event, index) => {
      const label = event.event ?? event.type ?? 'agent.event'
      const timestamp = event.at ?? event.timestamp
      return {
        id: event.id ?? `${label}-${timestamp ?? index}`,
        label,
        detail: describeEvent(event),
        when: formatEventTime(timestamp),
        tone: toneForEvent(label),
      }
    })
}

function describeEvent(event: RawAgentEvent) {
  const payload = event.detail ?? event.payload ?? {}
  const label = event.event ?? event.type ?? ''
  const path = typeof payload.path === 'string' ? payload.path : null
  const trigger = typeof payload.trigger === 'string' ? payload.trigger : null
  const revision = typeof payload.revision === 'number' ? payload.revision : null
  const baseRevision = typeof payload.baseRevision === 'number' ? payload.baseRevision : null
  const headRevision = typeof payload.headRevision === 'number' ? payload.headRevision : null
  const mainRevision = typeof payload.mainRevision === 'number' ? payload.mainRevision : null
  const changeSetId = typeof payload.changeSetId === 'string' ? payload.changeSetId : null
  const hiddenCount = typeof payload.hiddenFileCount === 'number' ? payload.hiddenFileCount : null
  const changedPaths = Array.isArray(payload.changedPaths)
    ? payload.changedPaths.filter((value): value is string => typeof value === 'string')
    : []
  const writes = typeof payload.writes === 'number' ? payload.writes : null

  if (label.includes('review') && changeSetId) {
    return `Review opened for ${changeSetId}${headRevision === null ? '' : ` at revision ${headRevision}`}`
  }
  if (label.includes('merge') && changeSetId) {
    return `Merged ${changeSetId}${mainRevision === null ? '' : ` into Main revision ${mainRevision}`}`
  }
  if (label.includes('conflict') && changeSetId) {
    return `Conflict recorded on ${changeSetId}${baseRevision === null ? '' : ` from base revision ${baseRevision}`}`
  }
  if (label.includes('remote') && changedPaths.length > 0) {
    return `${changedPaths.length} remote path${changedPaths.length === 1 ? '' : 's'} updated`
  }
  if (path && revision !== null) return `${path} acknowledged at revision ${revision}`
  if (path) return path
  if (writes !== null) return `${writes} write${writes === 1 ? '' : 's'} processed`
  if (hiddenCount !== null) return `${hiddenCount} private path${hiddenCount === 1 ? '' : 's'} hidden`
  if (trigger) return `Triggered by ${trigger}`

  return 'Local agent state changed'
}

function toneForEvent(label: string): AgentEventTone {
  if (label.includes('failed') || label.includes('blocked') || label.includes('conflict')) return 'blocked'
  if (label.includes('started') || label.includes('sync') || label.includes('refresh')) return 'syncing'
  if (label.includes('journaled') || label.includes('pending')) return 'queued'
  if (label.includes('ready') || label.includes('acknowledged') || label.includes('complete')) return 'ready'
  return 'observed'
}

function formatRevision(prefix: string, revision: number | null | undefined) {
  return typeof revision === 'number' ? `${prefix} ${revision}` : 'Unavailable'
}

function formatEventTime(timestamp: string | null | undefined) {
  if (!timestamp) return 'Unavailable'

  const time = new Date(timestamp).getTime()
  if (Number.isNaN(time)) return 'Unavailable'

  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000))
  if (seconds < 5) return 'now'
  if (seconds < 60) return `${seconds} sec ago`

  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`

  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hr ago`

  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

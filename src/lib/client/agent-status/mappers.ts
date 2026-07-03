import type {
  AgentCodebaseRole,
  AgentEvent,
  AgentEventTone,
  AgentFile,
  AgentFileLocal,
  AgentFileLocalState,
  AgentMember,
  AgentRequester,
  AgentStatusSnapshot,
} from '@hopit/core'

import { formatEventTime } from './formatters'
import type {
  RawAccessContext,
  RawAgentEvent,
  RawAgentStatus,
  RawCloudFile,
  RawCloudResponse,
  RawGraphMember,
  RawLocalFileState,
} from './normalize'

export function mapRequester(status: RawAgentStatus, access: RawAccessContext | null): AgentRequester {
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

export function offlineRequester(): AgentRequester {
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

export function mapGraphMembers(
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

export function mapCloudFiles(
  cloud: RawCloudResponse | null | undefined,
  localFiles: Record<string, RawLocalFileState> | undefined,
): AgentFile[] {
  const files = cloud?.graph?.files ?? {}

  return Object.entries(files)
    .map(([filePath, file]) => {
      const preview = contentPreview(file)
      const local = mapLocalFileState(filePath, localFiles?.[filePath])

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
        local,
      }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
}

function mapLocalFileState(filePath: string, local: RawLocalFileState | undefined): AgentFileLocal {
  const state = localFileState(local?.state)
  const hydrated = Boolean(local?.hydrated) || state !== 'cloud-only'
  const dirty = Boolean(local?.dirty) || state === 'dirty'
  const pending = Boolean(local?.pending) || state === 'pending-upload'
  const blocked = Boolean(local?.blocked) || state === 'blocked'
  const pinned = Boolean(local?.pinned) || state === 'pinned'
  const prunable = Boolean(local?.prunable) || state === 'prunable'

  return {
    path: stringOrNull(local?.path),
    exists: Boolean(local?.exists) || hydrated,
    hydrated,
    state,
    pinned,
    dirty,
    pending,
    blocked,
    prunable,
    bytesOnDisk: numberOrNull(local?.bytesOnDisk),
    lastHydratedAt: stringOrNull(local?.lastHydratedAt),
    lastEditedAt: stringOrNull(local?.lastEditedAt),
    lastSyncedAt: stringOrNull(local?.lastSyncedAt),
    lastPrunedAt: stringOrNull(local?.lastPrunedAt),
  }
}

function localFileState(value: string | undefined): AgentFileLocalState {
  if (
    value === 'cloud-only' ||
    value === 'hydrated' ||
    value === 'dirty' ||
    value === 'pending-upload' ||
    value === 'uploaded' ||
    value === 'prunable' ||
    value === 'pinned' ||
    value === 'blocked'
  ) {
    return value
  }
  return 'cloud-only'
}

export function backendName(value: string | undefined): AgentStatusSnapshot['backend'] {
  if (value === 'd1' || value === 'cloudflare-d1-graph') return 'd1'
  if (value === 'local-agent') return value
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

export function stringOrNull(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function numberOrNull(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}


export function mapRecentEvents(events: RawAgentEvent[]): AgentEvent[] {
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


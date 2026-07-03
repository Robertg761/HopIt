import { scopeForPath } from '@hopit/core/privacy-zone'
import { normalizeGraph } from './graph.js'
import { countPathScopes, integerOrNull, normalizeRole, stringOrNull } from './base.js'

export const visibleRoles = new Set(['owner', 'maintainer', 'member', 'viewer'])
export const writeRoles = new Set(['owner', 'maintainer'])
export const inviteRoles = new Set(['owner', 'maintainer'])
export const adminRoles = new Set(['owner'])

export function hasCapability(access, capability) {
  return Array.isArray(access?.permissions) && access.permissions.includes(capability)
}

export function visibilityContextForGraph(graph, request = {}) {
  if (!request.requesterId && !request.sessionId && graph.visibilityContext) return graph.visibilityContext
  const ownerId = graph.owner?.id ?? graph.codebase?.ownerId ?? null
  const requesterId = request.requesterId ?? ownerId
  const membership = request.membership ?? null
  const collaborator = (graph.collaborators ?? []).find((entry) => (entry.id ?? entry.userId) === requesterId) ?? null
  const isOwner = Boolean(requesterId && requesterId === ownerId)
  const activeMembership = membership?.status === 'active' ? membership : null
  const role = isOwner
    ? 'owner'
    : activeMembership
      ? normalizeRole(activeMembership.role)
      : collaborator
        ? normalizeRole(collaborator?.role)
        : 'guest'
  const context = {
    id: requesterId ?? null,
    sessionId: request.sessionId ?? null,
    role,
    isOwner,
    isCollaborator: role !== 'guest' && !isOwner,
    membershipSource: isOwner
      ? 'owner'
      : activeMembership
        ? 'membership'
        : membership
          ? stringOrNull(membership.source) ?? 'membership'
          : collaborator
            ? 'graph-collaborator'
            : 'none',
    permissions: permissionsForRole(role),
    visibleFileCount: null,
    hiddenFileCount: null,
    hiddenScopeCounts: { shared: 0, private: 0 },
  }
  return context
}

export function filterVisibleGraphForRequester(graph, request = {}) {
  const next = normalizeGraph(graph)
  const context = visibilityContextForGraph(next, request)
  return filterVisibleGraphForAccess(next, context)
}

export function filterVisibleGraphForAccess(graph, context) {
  const next = normalizeGraph(graph)
  const files = {}
  const hiddenPaths = []
  for (const [filePath, file] of Object.entries(next.files ?? {})) {
    if (!canRequesterSeePath(context, filePath)) {
      hiddenPaths.push(filePath)
      continue
    }
    files[filePath] = file
  }
  next.files = files
  next.visibilityContext = {
    ...context,
    visibleFileCount: Object.keys(files).length,
    hiddenFileCount: hiddenPaths.length,
    hiddenScopeCounts: countPathScopes(hiddenPaths),
  }
  return next
}

export function canRequesterSeePath(context, filePath) {
  if (scopeForPath(filePath) !== 'owner-private') return visibleRoles.has(context.role)
  return context.isOwner
}

export function canRead(context) {
  return visibleRoles.has(context.role)
}

export function canWrite(context) {
  return writeRoles.has(context.role)
}

export function permissionsForRole(role) {
  if (role === 'owner') return ['read', 'write', 'invite', 'admin', 'manage_members', 'review', 'merge', 'release']
  if (role === 'maintainer') return ['read', 'write', 'invite', 'review', 'merge', 'release']
  if (role === 'member') return ['read', 'write', 'review']
  if (role === 'viewer') return ['read']
  return []
}

export function accessContextForCodebaseHead(codebase, context) {
  if (!context) return null

  const fileCount = integerOrNull(codebase.fileCount) ?? 0
  const privateFileCount = integerOrNull(codebase.privateFileCount) ?? 0
  const sharedFileCount = Math.max(0, fileCount - privateFileCount)
  const effectiveVisibility =
    stringOrNull(codebase.selectedState?.effectiveVisibility) ??
    stringOrNull(codebase.visibility?.effective) ??
    'private'
  const visibleFileCount = context.isOwner
    ? fileCount
    : context.role === 'guest' || effectiveVisibility === 'private'
      ? 0
      : sharedFileCount
  const hiddenFileCount = Math.max(0, fileCount - visibleFileCount)

  return {
    ...context,
    visibleFileCount,
    hiddenFileCount,
    hiddenScopeCounts: {
      shared: Math.max(0, sharedFileCount - visibleFileCount),
      private: context.isOwner ? 0 : privateFileCount,
    },
  }
}

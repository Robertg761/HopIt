import { createHash } from 'node:crypto'
import { scopeForPath } from '@hopit/core/privacy-zone'

export function summarizeAccessContext(context) {
  if (!context) return null
  return {
    id: context.id ?? null,
    sessionId: context.sessionId ?? null,
    role: context.role ?? 'guest',
    isOwner: Boolean(context.isOwner),
    isCollaborator: Boolean(context.isCollaborator),
    membershipSource: context.membershipSource ?? 'fallback',
    permissions: Array.isArray(context.permissions) ? context.permissions : [],
    visibleFileCount: context.visibleFileCount ?? null,
    hiddenFileCount: context.hiddenFileCount ?? null,
    hiddenScopeCounts: context.hiddenScopeCounts ?? { shared: 0, private: 0 },
  }
}

export function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : ''
}

export function normalizeCodebaseName(value) {
  const name = stringOrNull(value)
  if (!name) throw new Error('Codebase name is required.')
  if (name.length > 120) throw new Error('Codebase name must be 120 characters or fewer.')
  return name
}

export function normalizeNewCodebaseId(value) {
  const codebaseId = stringOrNull(value)
  if (!codebaseId) throw new Error('Codebase id is required.')
  if (!/^[a-z0-9][a-z0-9._-]{1,80}$/.test(codebaseId)) {
    throw new Error('Codebase id must be 2-81 lowercase letters, numbers, dots, underscores, or dashes.')
  }
  return codebaseId
}

export function slugifyCodebaseId(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'codebase'
}

export function backendErrorMessage(error, fallback) {
  return error instanceof Error ? error.message : fallback
}

export function normalizeFutureTimestamp(value, label) {
  const text = stringOrNull(value)
  if (!text) return null
  const time = Date.parse(text)
  if (!Number.isFinite(time)) throw new Error(`${label} must be a valid timestamp.`)
  if (time <= Date.now()) throw new Error(`${label} must be in the future.`)
  return new Date(time).toISOString()
}

export function normalizePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`)
  return value
}

export function nullablePositiveInteger(value, label) {
  if (value === undefined || value === null || value === '') return null
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`)
  return value
}

export function nullableNonNegativeInteger(value, label) {
  if (value === undefined || value === null || value === '') return null
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`)
  return value
}

export function actorAuditId(actor, override, label) {
  const actorId = stringOrNull(actor?.userId)
  return requireTextValue(actorId === 'service:hopit-agent' ? override ?? actorId : actorId, label)
}

export function requireTextValue(value, label) {
  const text = stringOrNull(value)
  if (!text) throw new Error(`${label} is required.`)
  return text
}

export function uniqueStrings(values) {
  return Array.isArray(values)
    ? Array.from(new Set(values.map((value) => typeof value === 'string' ? value.trim() : '').filter(Boolean))).sort()
    : []
}

export function parseStringArray(value) {
  const parsed = parseJson(value, [])
  return uniqueStrings(parsed)
}

export function normalizeRole(value) {
  if (value === 'owner' || value === 'maintainer' || value === 'member' || value === 'viewer') return value
  return 'guest'
}

export function graphMemberCount(graph) {
  return 1 + (Array.isArray(graph.collaborators) ? graph.collaborators.length : 0)
}

export function countPathScopes(paths) {
  const counts = { shared: 0, private: 0 }
  for (const filePath of paths) {
    if (scopeForPath(filePath) === 'owner-private') counts.private += 1
    else counts.shared += 1
  }
  return counts
}

export function assertSafeGraphPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.startsWith('/') || filePath.includes('\\')) {
    throw new Error(`Invalid HopIt graph path: ${filePath}`)
  }
  const parts = filePath.split('/')
  if (parts.includes('..') || parts.includes('')) throw new Error(`Invalid HopIt graph path: ${filePath}`)
}

export function hashText(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function byteLength(value) {
  return Buffer.byteLength(value, 'utf8')
}

export function parseJson(value, fallback) {
  if (typeof value !== 'string' || value.length === 0) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

export function stringifyJson(value) {
  return JSON.stringify(value ?? null)
}

export function stringOrNull(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function integerOrNull(value) {
  return Number.isInteger(value) ? value : null
}

export function integerValue(value, fallback) {
  return Number.isInteger(value) ? value : fallback
}

export function boundedLimit(value, max) {
  return Math.max(1, Math.min(max, Number.isInteger(value) ? value : max))
}

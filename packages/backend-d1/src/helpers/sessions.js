import { createHash, randomBytes } from 'node:crypto'
import { parseJson, stringOrNull, uniqueStrings } from './base.js'

export function createAgentSessionId() {
  return `as_${randomBytes(12).toString('base64url')}`
}

export function createAgentSessionToken() {
  const token = `hst_${randomBytes(32).toString('base64url')}`
  return {
    token,
    tokenHash: hashAgentSessionToken(token),
    tokenPrefix: token.slice(0, 12),
  }
}

export function hashAgentSessionToken(token) {
  const normalized = stringOrNull(token)
  if (!normalized) throw new Error('Agent session token is required.')
  if (!normalized.startsWith('hst_')) throw new Error('Agent session token has an invalid format.')
  return `sha256:${createHash('sha256').update(`hopit.agent-session.v1:${normalized}`).digest('hex')}`
}

export function normalizeAgentSessionId(value) {
  const sessionId = stringOrNull(value)
  if (!sessionId) throw new Error('Agent session id is required.')
  if (!/^[A-Za-z0-9_.:-]{3,160}$/.test(sessionId)) {
    throw new Error('Agent session id may only contain letters, numbers, dots, underscores, colons, and dashes.')
  }
  return sessionId
}

export function assertReusableAgentSession(existing, registration) {
  if (existing.user_id !== registration.userId) {
    throw new Error(`Agent session ${existing.session_id} belongs to a different user.`)
  }
  if (existing.codebase_id !== registration.codebaseId) {
    throw new Error(`Agent session ${existing.session_id} is scoped to a different codebase.`)
  }
}

export function normalizeAgentSessionCapabilities(capabilities) {
  const values = Array.isArray(capabilities) && capabilities.length > 0
    ? capabilities
    : ['read', 'write', 'sync', 'watch']
  return uniqueStrings(values)
}

export function agentSessionStatusOrNull(value) {
  if (value === 'active' || value === 'revoked') return value
  return null
}

export function agentSessionHasCapability(session, capability) {
  const capabilities = parseJson(session.capabilities_json, [])
  return capabilities.includes('admin') || capabilities.includes(capability)
}

export function codebaseCapabilityForAgentCapability(capability) {
  if (capability === 'sync' || capability === 'watch') return 'read'
  if (capability === 'admin') return 'manage_members'
  if (
    capability === 'read' ||
    capability === 'write' ||
    capability === 'invite' ||
    capability === 'review' ||
    capability === 'merge' ||
    capability === 'release'
  ) {
    return capability
  }
  return null
}

export function agentCapabilityForCodebaseCapability(capability) {
  if (capability === 'manage_members') return 'admin'
  return capability
}

export function isExpiredTimestamp(value) {
  const time = Date.parse(value)
  return !Number.isFinite(time) || time <= Date.now()
}

export function summarizeAgentSession(row) {
  if (!row) return null
  return {
    userId: row.user_id,
    sessionId: row.session_id,
    codebaseId: row.codebase_id ?? null,
    deviceName: row.device_name ?? null,
    tokenPrefix: row.token_prefix ?? null,
    capabilities: parseJson(row.capabilities_json, []),
    expiresAt: row.expires_at ?? null,
    status: row.status,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at ?? null,
    revokedByUserId: row.revoked_by_user_id ?? null,
    revokedAt: row.revoked_at ?? null,
  }
}

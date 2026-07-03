import { createHash } from 'node:crypto'
import { integerValue, normalizeEmail, normalizeRole, stringOrNull } from './base.js'

export function memberSelectSql(whereClause) {
  return `select
    m.codebase_id,
    m.user_id,
    m.role,
    m.status,
    m.source,
    m.invited_by_user_id,
    m.joined_at,
    m.created_at,
    m.updated_at,
    u.primary_email as profile_primary_email,
    u.display_name as profile_display_name,
    u.avatar_url as profile_avatar_url
  from codebase_members m
  left join users u on u.user_id = m.user_id
  ${whereClause}
  order by
    case m.role
      when 'owner' then 0
      when 'maintainer' then 1
      when 'member' then 2
      when 'viewer' then 3
      else 4
    end,
    m.user_id asc`
}

export function mapD1Member(row) {
  const userId = stringOrNull(row.user_id) ?? ''
  const id = `${row.codebase_id}:${userId}`
  return {
    _id: id,
    id,
    codebaseId: row.codebase_id,
    userId,
    role: normalizeRole(row.role),
    status: row.status === 'suspended' ? 'suspended' : 'active',
    source: stringOrNull(row.source) ?? 'membership',
    invitedByUserId: stringOrNull(row.invited_by_user_id),
    joinedAt: stringOrNull(row.joined_at),
    createdAt: stringOrNull(row.created_at),
    updatedAt: stringOrNull(row.updated_at),
    profile: {
      userId,
      primaryEmail: stringOrNull(row.profile_primary_email),
      displayName: stringOrNull(row.profile_display_name),
      avatarUrl: stringOrNull(row.profile_avatar_url),
    },
  }
}

export function mapD1Invitation(row) {
  if (!row) return null
  return {
    _id: row.invitation_id,
    id: row.invitation_id,
    invitationId: row.invitation_id,
    codebaseId: row.codebase_id,
    normalizedEmail: row.normalized_email,
    email: row.normalized_email,
    role: invitationRole(row.role),
    status: invitationStatusForRead(row),
    invitedByUserId: row.invited_by_user_id,
    acceptedByUserId: stringOrNull(row.accepted_by_user_id),
    revokedByUserId: stringOrNull(row.revoked_by_user_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: stringOrNull(row.expires_at),
    acceptedAt: stringOrNull(row.accepted_at),
    revokedAt: stringOrNull(row.revoked_at),
  }
}

export function invitationRole(value) {
  if (value === 'maintainer' || value === 'viewer') return value
  return 'member'
}

export function invitationStatusOrNull(value) {
  if (value === 'pending' || value === 'accepted' || value === 'revoked' || value === 'expired') return value
  return null
}

export function isInvitationExpired(invitation) {
  if (invitation?.status !== 'pending') return false
  const expiresAt = stringOrNull(invitation.expires_at ?? invitation.expiresAt)
  if (!expiresAt) return false
  const time = Date.parse(expiresAt)
  return !Number.isFinite(time) || time <= Date.now()
}

export function invitationStatusForRead(invitation) {
  return isInvitationExpired(invitation) ? 'expired' : invitation.status
}

export function hashInvitationToken(token) {
  const normalized = stringOrNull(token)
  if (!normalized) throw new Error('Invitation token is required.')
  return `sha256:${createHash('sha256').update(`hopit.invite.v1:${normalized}`).digest('hex')}`
}

import { normalizeEmail, stringOrNull } from './base.js'

export function requireAuthenticatedActor(actor = {}, message = 'Product auth is required.') {
  const userId = stringOrNull(actor.userId)
  if (!userId) throw new Error(message)
  return {
    ...actor,
    userId,
    primaryEmail: stringOrNull(actor.primaryEmail),
    displayName: stringOrNull(actor.displayName),
    avatarUrl: stringOrNull(actor.avatarUrl),
    currentAuthEmailVerified: actor.currentAuthEmailVerified === true || actor.emailVerified === true,
  }
}

export function requireVerifiedEmailActor(actor = {}, message = 'A verified account email is required.') {
  const authenticated = requireAuthenticatedActor(actor, message)
  if (!normalizeEmail(authenticated.primaryEmail) || authenticated.currentAuthEmailVerified !== true) {
    throw new Error(message)
  }
  return authenticated
}

export function requireOwnerClaimActor(actor = {}) {
  const ownerActor = requireVerifiedEmailActor(actor, 'A verified account email is required to claim codebase ownership.')
  const expectedEmail = normalizeEmail(process.env.HOPIT_OWNER_EMAIL)
  if (!expectedEmail) {
    throw new Error('HOPIT_OWNER_EMAIL must be configured before a codebase owner can be claimed.')
  }
  if (normalizeEmail(ownerActor.primaryEmail) !== expectedEmail) {
    throw new Error('Authenticated account email is not allowed to claim codebase ownership.')
  }
  return ownerActor
}

export function isBootstrapOwnerMember(member, graph) {
  if (member.user_id === 'local-owner') return true
  return member.source === 'graph-owner' && member.user_id === graph.codebase.ownerId
}

export function claimedOwnerValue(existingOwner, actor) {
  const owner = existingOwner && typeof existingOwner === 'object' && !Array.isArray(existingOwner)
    ? { ...existingOwner }
    : {}
  owner.id = actor.userId
  owner.userId = actor.userId
  if (stringOrNull(actor.displayName)) {
    owner.name = actor.displayName
    owner.displayName = actor.displayName
  }
  if (stringOrNull(actor.primaryEmail)) {
    owner.email = actor.primaryEmail
    owner.primaryEmail = actor.primaryEmail
  }
  owner.role = 'owner'
  owner.status = 'active'
  owner.source = 'owner-claim'
  owner.joinedAt = owner.joinedAt ?? new Date().toISOString()
  return owner
}

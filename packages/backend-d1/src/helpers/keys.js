import { randomBytes } from 'node:crypto'
import { integerValue, parseJson, stringOrNull } from './base.js'

export function normalizeKeyEntityId(value, label) {
  const id = stringOrNull(value)
  if (!id) throw new Error(`${label} is required.`)
  if (!/^[A-Za-z0-9_.:-]{3,180}$/.test(id)) {
    throw new Error(`${label} may only contain letters, numbers, dots, underscores, colons, and dashes.`)
  }
  return id
}

export function assertDevicePublicKeyDescriptor(value) {
  if (value.encryptionPublicKeyAlgorithm !== 'x25519') {
    throw new Error('Device encryption public key algorithm must be x25519.')
  }
  if (value.encryptionPublicKeyEncoding !== 'spki-pem') {
    throw new Error('Device encryption public key encoding must be spki-pem.')
  }
  if (!looksLikePem(value.encryptionPublicKey, 'PUBLIC KEY')) {
    throw new Error('Device encryption public key must be a PEM public key.')
  }
  if (value.signingPublicKey !== undefined && value.signingPublicKey !== null) {
    if (value.signingPublicKeyAlgorithm !== 'ed25519') {
      throw new Error('Device signing public key algorithm must be ed25519.')
    }
    if (value.signingPublicKeyEncoding !== 'spki-pem') {
      throw new Error('Device signing public key encoding must be spki-pem.')
    }
    if (!looksLikePem(value.signingPublicKey, 'PUBLIC KEY')) {
      throw new Error('Device signing public key must be a PEM public key.')
    }
  }
}

export function looksLikePem(value, block) {
  const text = stringOrNull(value)
  return Boolean(text && text.includes(`-----BEGIN ${block}-----`) && text.includes(`-----END ${block}-----`))
}

export function assertSameDevicePublicKeys(existing, next) {
  const checks = [
    ['encryption_public_key', next.encryptionPublicKey],
    ['encryption_public_key_algorithm', next.encryptionPublicKeyAlgorithm],
    ['encryption_public_key_encoding', next.encryptionPublicKeyEncoding],
    ['signing_public_key', stringOrNull(next.signingPublicKey)],
    ['signing_public_key_algorithm', stringOrNull(next.signingPublicKeyAlgorithm)],
    ['signing_public_key_encoding', stringOrNull(next.signingPublicKeyEncoding)],
  ]
  for (const [field, value] of checks) {
    if ((existing[field] ?? null) !== (value ?? null)) {
      throw new Error(`Device key ${existing.device_id} already exists with different public key material.`)
    }
  }
}

export function assertSameCodebaseKeyring(existing, next) {
  const checks = [
    ['repo_content_key_id', next.repoContentKeyId],
    ['owner_private_key_id', next.ownerPrivateKeyId],
    ['git_internals_key_id', next.gitInternalsKeyId],
    ['default_secret_key_id', next.defaultSecretKeyId],
  ]
  for (const [field, value] of checks) {
    if (existing[field] !== value) {
      throw new Error('Codebase keyring already exists with different key ids. Use a rotation flow instead.')
    }
  }
}

export function wrappedKeyType(value) {
  if (value === 'repo-content' || value === 'owner-private' || value === 'secret-group' || value === 'file-dek' || value === 'user-vault') {
    return value
  }
  throw new Error('Wrapped key type is not supported.')
}

export function wrappedKeyRecipientType(value) {
  if (value === 'user' || value === 'device' || value === 'member-group') return value
  throw new Error('Wrapped key recipient type is not supported.')
}

export function capabilityForWrappedKey(args) {
  if (args.wrappedKeyType === 'user-vault') return 'read'
  if (args.wrappedKeyType === 'repo-content') return 'write'
  if (args.wrappedKeyType === 'file-dek' && isPrivateZoneId(stringOrNull(args.zoneId))) return 'manage_members'
  if (args.wrappedKeyType === 'file-dek') return 'write'
  return 'manage_members'
}

export function isPrivateZoneId(zoneId) {
  if (!zoneId) return false
  return (
    zoneId.endsWith(':owner-private') ||
    zoneId.endsWith(':secrets') ||
    zoneId.endsWith(':git-internals') ||
    zoneId.includes('owner-private') ||
    zoneId.includes('secrets') ||
    zoneId.includes('git-internals')
  )
}

export function assertWrappedKeyEnvelope(args) {
  if (args.algorithm !== 'x25519-aes-256-gcm' && args.algorithm !== 'pbkdf2-sha256-aes-256-gcm') {
    throw new Error('Wrapped key algorithm is not supported.')
  }
  const ciphertext = stringOrNull(args.ciphertext)
  if (!ciphertext || ciphertext.length > 256_000) {
    throw new Error('Wrapped key ciphertext must be a non-empty bounded string.')
  }
  let envelope = null
  try {
    envelope = JSON.parse(ciphertext)
  } catch {
    throw new Error('Wrapped key ciphertext must be a serialized JSON envelope.')
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('Wrapped key envelope must be an object.')
  }
  if (envelope.algorithm !== args.algorithm) {
    throw new Error('Wrapped key envelope algorithm must match the stored algorithm.')
  }
  if (typeof envelope.context === 'string') {
    if (!envelope.context.includes(args.wrappedKeyId) || !envelope.context.includes(args.recipientId)) {
      throw new Error('Wrapped key envelope context must bind the wrapped key and recipient.')
    }
  }
}

export function assertSameWrappedKey(existing, next) {
  if (effectiveWrappedKeyStatus(existing, Date.now()) !== 'active') {
    throw new Error(`Wrapped key ${existing.wrap_id} is not active and cannot be reused.`)
  }
  const checks = [
    ['wrapped_key_id', next.wrappedKeyId],
    ['wrapped_key_type', next.wrappedKeyType],
    ['key_version', next.keyVersion],
    ['recipient_type', next.recipientType],
    ['recipient_id', next.recipientId],
    ['codebase_id', next.codebaseId],
    ['zone_id', next.zoneId],
    ['wrapping_key_id', next.wrappingKeyId],
    ['wrapping_public_key_id', next.wrappingPublicKeyId],
    ['algorithm', next.algorithm],
    ['ciphertext', next.ciphertext],
  ]
  for (const [field, value] of checks) {
    const actual = field === 'key_version' ? integerValue(existing[field], null) : (existing[field] ?? null)
    if (actual !== (value ?? null)) {
      throw new Error(`Wrapped key ${existing.wrap_id} already exists with different metadata.`)
    }
  }
}

export function effectiveWrappedKeyStatus(row, now) {
  const status = row.status ?? 'active'
  if (status !== 'active') return status
  const expiresAt = stringOrNull(row.expires_at ?? row.expiresAt)
  if (expiresAt && Date.parse(expiresAt) <= now) return 'expired'
  return 'active'
}

export function canActorReadWrappedKey(row, actor, actorDeviceIds) {
  if (actor.kind === 'service') return true
  if (row.created_by_user_id === actor.userId) return true
  if (row.recipient_type === 'user' && row.recipient_id === actor.userId) return true
  if (row.recipient_type === 'device' && actorDeviceIds.has(row.recipient_id)) return true
  return false
}

export function createWrappedKeyId() {
  return `wrap_${randomBytes(18).toString('base64url')}`
}

export function summarizeDeviceKey(row) {
  if (!row) return null
  return {
    deviceId: row.device_id,
    userId: row.user_id,
    displayName: row.display_name ?? null,
    platform: row.platform ?? null,
    encryptionPublicKeyAlgorithm: row.encryption_public_key_algorithm,
    encryptionPublicKeyEncoding: row.encryption_public_key_encoding,
    signingPublicKeyAlgorithm: row.signing_public_key_algorithm ?? null,
    signingPublicKeyEncoding: row.signing_public_key_encoding ?? null,
    status: row.status,
    createdAt: row.created_at,
    trustedAt: row.trusted_at ?? null,
    revokedAt: row.revoked_at ?? null,
    lastSeenAt: row.last_seen_at ?? null,
  }
}

export function summarizeUserKeyring(row) {
  if (!row) return null
  return {
    userId: row.user_id,
    vaultKeyId: row.vault_key_id,
    currentVersion: integerValue(row.current_version, 1),
    status: row.status,
    recoveryConfigured: row.recovery_configured === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function summarizeCodebaseKeyring(row) {
  if (!row) return null
  return {
    codebaseId: row.codebase_id,
    repoContentKeyId: row.repo_content_key_id,
    ownerPrivateKeyId: row.owner_private_key_id,
    gitInternalsKeyId: row.git_internals_key_id,
    defaultSecretKeyId: row.default_secret_key_id,
    rotationState: row.rotation_state ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function summarizeWrappedKey(row) {
  if (!row) return null
  return {
    wrapId: row.wrap_id,
    wrappedKeyId: row.wrapped_key_id,
    wrappedKeyType: row.wrapped_key_type,
    keyVersion: integerValue(row.key_version, 1),
    recipientType: row.recipient_type,
    recipientId: row.recipient_id,
    codebaseId: row.codebase_id ?? null,
    zoneId: row.zone_id ?? null,
    wrappingKeyId: row.wrapping_key_id ?? null,
    wrappingPublicKeyId: row.wrapping_public_key_id ?? null,
    algorithm: row.algorithm,
    ciphertext: row.ciphertext,
    createdByUserId: row.created_by_user_id ?? null,
    createdByDeviceId: row.created_by_device_id ?? null,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? null,
    revokedAt: row.revoked_at ?? null,
    status: row.status,
  }
}

export function deviceKeyStatusOrNull(value) {
  if (value === 'trusted' || value === 'revoked' || value === 'lost') return value
  return null
}

export function keyRotationState(value) {
  if (value === 'planned' || value === 'rotating' || value === 'wrapped' || value === 'stable' || value === 'blocked') {
    return value
  }
  throw new Error('Key rotation state must be planned, rotating, wrapped, stable, or blocked.')
}

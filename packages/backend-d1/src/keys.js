import { randomBytes, randomUUID } from 'node:crypto'
import { privacyZoneForPath, privacyZoneIdForPath, scopeForPath } from '@hopit/core/privacy-zone'
import { defineBackendMethods } from './method-support.js'
import { d1CloudServiceType, d1AuthorizationToken, schemaCacheKey, usesCloudflareD1Api, usesScopedD1SessionAuth } from './config.js'
import { d1SchemaStatements } from './schema.js'
import { summarizeAccessContext, normalizeEmail, backendErrorMessage, normalizeFutureTimestamp, normalizePositiveInteger, nullablePositiveInteger, nullableNonNegativeInteger, actorAuditId, requireTextValue, uniqueStrings, parseStringArray, normalizeRole, graphMemberCount, countPathScopes, assertSafeGraphPath, hashText, byteLength, parseJson, stringifyJson, stringOrNull, integerOrNull, integerValue, boundedLimit, requireAuthenticatedActor, requireVerifiedEmailActor, requireOwnerClaimActor, isBootstrapOwnerMember, claimedOwnerValue, graphFromRows, codebaseRowToRecord, codebaseRecordFromGraph, fileRowToEntry, normalizeGraph, normalizeFileEntry, normalizeVisibilityContract, normalizeOptionalVisibility, normalizeVisibilityValue, summarizeCodebaseHead, summarizeCodebaseRemoteUpdate, buildStatus, buildSyncHealth, buildRefreshHealth, mapD1AgentEvent, latestEventOf, applyJournalEntryToCloud, hasCapability, visibilityContextForGraph, filterVisibleGraphForRequester, filterVisibleGraphForAccess, canRequesterSeePath, canRead, canWrite, permissionsForRole, accessContextForCodebaseHead, memberSelectSql, mapD1Member, mapD1Invitation, invitationRole, invitationStatusOrNull, isInvitationExpired, invitationStatusForRead, hashInvitationToken, createAgentSessionId, createAgentSessionToken, hashAgentSessionToken, normalizeAgentSessionId, assertReusableAgentSession, normalizeAgentSessionCapabilities, agentSessionStatusOrNull, agentSessionHasCapability, codebaseCapabilityForAgentCapability, agentCapabilityForCodebaseCapability, isExpiredTimestamp, summarizeAgentSession, normalizeKeyEntityId, assertDevicePublicKeyDescriptor, looksLikePem, assertSameDevicePublicKeys, assertSameCodebaseKeyring, wrappedKeyType, wrappedKeyRecipientType, capabilityForWrappedKey, isPrivateZoneId, assertWrappedKeyEnvelope, assertSameWrappedKey, effectiveWrappedKeyStatus, canActorReadWrappedKey, createWrappedKeyId, summarizeDeviceKey, summarizeUserKeyring, summarizeCodebaseKeyring, summarizeWrappedKey, deviceKeyStatusOrNull, keyRotationState, mapD1ReviewThread, mapD1ReviewThreadComment, mapD1ReviewDecision, mapD1Notification, reviewDecision, notificationKind, reviewDecisionTitle, reviewDecisionBody, reviewHref, actionCommandForKind, summarizeActionJob, actionSummary, capOutput } from './helpers/index.js'

/** @typedef {import('@hopit/core').CloudGraph} CloudGraph */
/** @typedef {import('@hopit/core').AgentSession} AgentSession */

export function attachKeyMethods(Backend) {
  defineBackendMethods(Backend, {
  async registerDeviceKey(options = {}) {
    await this.ensureSchema()
    const codebaseId = stringOrNull(options.codebaseId) ?? this.codebaseId
    const actor = await this.resolveKeyActor(codebaseId, options, 'read')
    const now = new Date().toISOString()
    const deviceId = normalizeKeyEntityId(options.deviceId, 'Device id')
    assertDevicePublicKeyDescriptor(options)
    const existing = await this.first(
      `select * from device_keys where user_id = ? and device_id = ? limit 1`,
      [actor.userId, deviceId],
    )
    if (existing) {
      if (existing.user_id !== actor.userId) {
        throw new Error(`Device key ${deviceId} already belongs to another user.`)
      }
      if (existing.status === 'revoked' || existing.status === 'lost') {
        throw new Error(`Device key ${deviceId} is ${existing.status} and cannot be reused.`)
      }
      assertSameDevicePublicKeys(existing, options)
      await this.query(
        `update device_keys set display_name = ?, platform = ?, status = 'trusted',
          trusted_at = coalesce(trusted_at, ?), last_seen_at = ?
         where user_id = ? and device_id = ?`,
        [
          stringOrNull(options.displayName) ?? existing.display_name,
          stringOrNull(options.platform) ?? existing.platform,
          now,
          now,
          actor.userId,
          deviceId,
        ],
      )
      return summarizeDeviceKey(await this.first(
        `select * from device_keys where user_id = ? and device_id = ?`,
        [actor.userId, deviceId],
      ))
    }

    await this.query(
      `insert into device_keys (
        device_id, user_id, display_name, platform, encryption_public_key,
        encryption_public_key_algorithm, encryption_public_key_encoding,
        signing_public_key, signing_public_key_algorithm, signing_public_key_encoding,
        status, created_at, trusted_at, last_seen_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'trusted', ?, ?, ?)`,
      [
        deviceId,
        actor.userId,
        stringOrNull(options.displayName),
        stringOrNull(options.platform),
        options.encryptionPublicKey,
        options.encryptionPublicKeyAlgorithm,
        options.encryptionPublicKeyEncoding,
        stringOrNull(options.signingPublicKey),
        stringOrNull(options.signingPublicKeyAlgorithm),
        stringOrNull(options.signingPublicKeyEncoding),
        now,
        now,
        now,
      ],
    )
    await this.appendKeyAuditEvent({
      codebaseId,
      actorUserId: actor.userId,
      actorDeviceId: actor.deviceId,
      eventType: 'device_key.trusted',
      targetUserId: actor.userId,
      targetDeviceId: deviceId,
    })
    return summarizeDeviceKey(await this.first(
      `select * from device_keys where user_id = ? and device_id = ?`,
      [actor.userId, deviceId],
    ))
  },

  async listDeviceKeys(options = {}) {
    const codebaseId = stringOrNull(options.codebaseId) ?? this.codebaseId
    const actor = await this.resolveKeyActor(codebaseId, options, 'read')
    const targetUserId = stringOrNull(options.userId) ?? actor.userId
    if (targetUserId !== actor.userId && actor.kind !== 'service') {
      await this.requireKeyActorCapability(codebaseId, actor, 'manage_members')
    }
    const status = deviceKeyStatusOrNull(options.status)
    const rows = status
      ? await this.query(
          `select * from device_keys where user_id = ? and status = ? order by coalesce(last_seen_at, created_at) desc`,
          [targetUserId, status],
        )
      : await this.query(
          `select * from device_keys where user_id = ? order by coalesce(last_seen_at, created_at) desc`,
          [targetUserId],
        )
    return rows.map(summarizeDeviceKey)
  },

  async ensureUserKeyring(options = {}) {
    await this.ensureSchema()
    const codebaseId = stringOrNull(options.codebaseId) ?? this.codebaseId
    const actor = await this.resolveKeyActor(codebaseId, options, 'read')
    const now = new Date().toISOString()
    const vaultKeyId = normalizeKeyEntityId(options.vaultKeyId, 'User vault key id')
    const currentVersion = normalizePositiveInteger(options.currentVersion ?? 1, 'User vault key version')
    const existing = await this.first(`select * from user_keyrings where user_id = ? limit 1`, [actor.userId])
    if (existing) {
      if (existing.vault_key_id !== vaultKeyId) {
        throw new Error(`User ${actor.userId} already has a different vault key.`)
      }
      await this.query(
        `update user_keyrings set current_version = ?, recovery_configured = ?, status = 'active', updated_at = ?
         where user_id = ?`,
        [
          Math.max(integerValue(existing.current_version, 1), currentVersion),
          existing.recovery_configured === 1 || options.recoveryConfigured === true ? 1 : 0,
          now,
          actor.userId,
        ],
      )
      return summarizeUserKeyring(await this.first(`select * from user_keyrings where user_id = ?`, [actor.userId]))
    }

    await this.query(
      `insert into user_keyrings (
        user_id, vault_key_id, current_version, status, recovery_configured, created_at, updated_at
      ) values (?, ?, ?, 'active', ?, ?, ?)`,
      [actor.userId, vaultKeyId, currentVersion, options.recoveryConfigured === true ? 1 : 0, now, now],
    )
    await this.appendKeyAuditEvent({
      codebaseId,
      actorUserId: actor.userId,
      actorDeviceId: actor.deviceId,
      eventType: 'user_keyring.created',
      targetUserId: actor.userId,
      keyId: vaultKeyId,
    })
    return summarizeUserKeyring(await this.first(`select * from user_keyrings where user_id = ?`, [actor.userId]))
  },

  async ensureCodebaseKeyring(options = {}) {
    await this.ensureSchema()
    const codebaseId = stringOrNull(options.codebaseId) ?? this.codebaseId
    const actor = await this.resolveKeyActor(codebaseId, options, 'manage_members')
    const now = new Date().toISOString()
    const next = {
      repoContentKeyId: normalizeKeyEntityId(options.repoContentKeyId, 'Repo content key id'),
      ownerPrivateKeyId: normalizeKeyEntityId(options.ownerPrivateKeyId, 'Owner private key id'),
      gitInternalsKeyId: normalizeKeyEntityId(options.gitInternalsKeyId, 'Git internals key id'),
      defaultSecretKeyId: normalizeKeyEntityId(options.defaultSecretKeyId, 'Default secret key id'),
    }
    const existing = await this.first(`select * from codebase_keyrings where codebase_id = ? limit 1`, [codebaseId])
    if (existing) {
      assertSameCodebaseKeyring(existing, next)
      await this.query(`update codebase_keyrings set updated_at = ? where codebase_id = ?`, [now, codebaseId])
      return summarizeCodebaseKeyring(await this.first(`select * from codebase_keyrings where codebase_id = ?`, [codebaseId]))
    }
    await this.query(
      `insert into codebase_keyrings (
        codebase_id, repo_content_key_id, owner_private_key_id, git_internals_key_id,
        default_secret_key_id, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?)`,
      [
        codebaseId,
        next.repoContentKeyId,
        next.ownerPrivateKeyId,
        next.gitInternalsKeyId,
        next.defaultSecretKeyId,
        now,
        now,
      ],
    )
    await this.appendKeyAuditEvent({
      codebaseId,
      actorUserId: actor.userId,
      actorDeviceId: actor.deviceId,
      eventType: 'codebase_keyring.created',
    })
    return summarizeCodebaseKeyring(await this.first(`select * from codebase_keyrings where codebase_id = ?`, [codebaseId]))
  },

  async createWrappedKey(options = {}) {
    await this.ensureSchema()
    const codebaseId = stringOrNull(options.codebaseId) ?? this.codebaseId
    const actor = await this.resolveKeyActor(codebaseId, options, capabilityForWrappedKey(options))
    const now = new Date().toISOString()
    const wrapId = normalizeKeyEntityId(options.wrapId ?? createWrappedKeyId(), 'Wrapped key id')
    const wrappedKeyId = normalizeKeyEntityId(options.wrappedKeyId, 'Wrapped key id')
    const keyVersion = normalizePositiveInteger(options.keyVersion, 'Wrapped key version')
    const recipientType = wrappedKeyRecipientType(options.recipientType)
    const recipientId = normalizeKeyEntityId(options.recipientId, 'Wrapped key recipient id')
    const expiresAt = normalizeFutureTimestamp(options.expiresAt, 'Wrapped key expiry')
    assertWrappedKeyEnvelope({ ...options, wrappedKeyId, recipientId })
    const recipientDevice = await this.requireTrustedRecipientDevice({
      recipientType,
      recipientId,
      userId: options.wrappedKeyType === 'user-vault' ? actor.userId : null,
    })
    if (options.wrappedKeyType === 'user-vault' && recipientDevice?.user_id !== actor.userId) {
      throw new Error("User vault keys can only be wrapped to the owner's trusted devices.")
    }
    if (recipientDevice && recipientDevice.user_id !== actor.userId && actor.kind !== 'service') {
      await this.requireKeyActorCapability(codebaseId, actor, 'manage_members')
    }

    const existing = await this.first(
      `select * from wrapped_keys where codebase_id = ? and wrap_id = ? limit 1`,
      [codebaseId, wrapId],
    )
    const value = {
      wrapId,
      wrappedKeyId,
      wrappedKeyType: wrappedKeyType(options.wrappedKeyType),
      keyVersion,
      recipientType,
      recipientId,
      codebaseId,
      zoneId: stringOrNull(options.zoneId),
      wrappingKeyId: stringOrNull(options.wrappingKeyId),
      wrappingPublicKeyId: stringOrNull(options.wrappingPublicKeyId),
      algorithm: requireTextValue(options.algorithm, 'Wrapped key algorithm'),
      ciphertext: requireTextValue(options.ciphertext, 'Wrapped key ciphertext'),
      createdByUserId: actor.userId,
      createdByDeviceId: stringOrNull(options.createdByDeviceId) ?? actor.deviceId ?? null,
      createdAt: now,
      expiresAt,
      status: 'active',
    }
    if (existing) {
      assertSameWrappedKey(existing, value)
      return summarizeWrappedKey(existing)
    }
    await this.assertNoDuplicateActiveWrappedKey(value)
    await this.query(
      `insert into wrapped_keys (
        wrap_id, wrapped_key_id, wrapped_key_type, key_version, recipient_type, recipient_id,
        codebase_id, zone_id, wrapping_key_id, wrapping_public_key_id, algorithm, ciphertext,
        created_by_user_id, created_by_device_id, created_at, expires_at, status
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [
        value.wrapId,
        value.wrappedKeyId,
        value.wrappedKeyType,
        value.keyVersion,
        value.recipientType,
        value.recipientId,
        value.codebaseId,
        value.zoneId,
        value.wrappingKeyId,
        value.wrappingPublicKeyId,
        value.algorithm,
        value.ciphertext,
        value.createdByUserId,
        value.createdByDeviceId,
        value.createdAt,
        value.expiresAt,
      ],
    )
    await this.appendKeyAuditEvent({
      codebaseId,
      actorUserId: actor.userId,
      actorDeviceId: actor.deviceId,
      eventType: 'wrapped_key.created',
      targetUserId: recipientDevice?.user_id,
      targetDeviceId: recipientDevice?.device_id,
      zoneId: value.zoneId,
      keyId: wrappedKeyId,
      wrapId,
    })
    return summarizeWrappedKey(await this.first(
      `select * from wrapped_keys where codebase_id = ? and wrap_id = ?`,
      [codebaseId, wrapId],
    ))
  },

  async listWrappedKeys(options = {}) {
    const codebaseId = stringOrNull(options.codebaseId) ?? this.codebaseId
    const actor = await this.resolveKeyActor(codebaseId, options, 'read')
    const actorDevices = actor.kind === 'service'
      ? new Set()
      : new Set((await this.query(`select device_id from device_keys where user_id = ?`, [actor.userId])).map((row) => row.device_id))
    const rows = await this.query(
      `select * from wrapped_keys where codebase_id = ? order by created_at desc`,
      [codebaseId],
    )
    const now = Date.now()
    return rows
      .filter((row) => !options.recipientType || row.recipient_type === options.recipientType)
      .filter((row) => !options.recipientId || row.recipient_id === options.recipientId)
      .filter((row) => !options.wrappedKeyId || row.wrapped_key_id === options.wrappedKeyId)
      .filter((row) => !options.zoneId || row.zone_id === options.zoneId)
      .map((row) => ({ ...row, status: effectiveWrappedKeyStatus(row, now) }))
      .filter((row) => !options.status || row.status === options.status)
      .filter((row) => options.includeExpired || row.status !== 'expired')
      .filter((row) => canActorReadWrappedKey(row, actor, actorDevices))
      .map(summarizeWrappedKey)
  },

  async readKeyGrantStatus({ codebaseId = this.codebaseId, actor = {} } = {}) {
    await this.requireGraphCapability(codebaseId, actor, 'manage_members')
    const [codebaseKeyring, members, wraps] = await Promise.all([
      this.first(`select * from codebase_keyrings where codebase_id = ? limit 1`, [codebaseId]),
      this.query(`select user_id, role, status from codebase_members where codebase_id = ? order by joined_at asc`, [codebaseId]),
      this.query(`select * from wrapped_keys where codebase_id = ? order by created_at desc`, [codebaseId]),
    ])
    const userIds = uniqueStrings(members.map((member) => member.user_id))
    const [devices, userKeyrings] = userIds.length > 0
      ? await Promise.all([
          this.query(
            `select * from device_keys where user_id in (${userIds.map(() => '?').join(', ')}) order by coalesce(last_seen_at, created_at) desc`,
            userIds,
          ),
          this.query(
            `select * from user_keyrings where user_id in (${userIds.map(() => '?').join(', ')}) order by updated_at desc`,
            userIds,
          ),
        ])
      : [[], []]
    const now = Date.now()

    return {
      codebaseId,
      codebaseKeyring: summarizeCodebaseKeyring(codebaseKeyring),
      members: members.map((member) => ({
        userId: member.user_id,
        role: member.role,
        status: member.status,
      })),
      devices: devices.map(summarizeDeviceKey),
      userKeyrings: userKeyrings.map(summarizeUserKeyring),
      wrappedKeys: wraps.map((row) => {
        const { ciphertext: _ciphertext, ...summary } = summarizeWrappedKey({ ...row, status: effectiveWrappedKeyStatus(row, now) })
        return summary
      }),
    }
  },

  async updateCodebaseKeyringRotationState({ codebaseId = this.codebaseId, rotationState, actor = {} } = {}) {
    const authenticatedActor = requireAuthenticatedActor(actor, 'Updating key rotation state requires product auth.')
    await this.requireGraphCapability(codebaseId, authenticatedActor, 'manage_members')
    const nextState = keyRotationState(rotationState)
    const existing = await this.first(`select * from codebase_keyrings where codebase_id = ? limit 1`, [codebaseId])
    if (!existing) throw new Error('Codebase keyring is not configured.')
    const now = new Date().toISOString()
    await this.query(
      `update codebase_keyrings set rotation_state = ?, updated_at = ? where codebase_id = ?`,
      [nextState, now, codebaseId],
    )
    await this.appendKeyAuditEvent({
      codebaseId,
      actorUserId: authenticatedActor.userId,
      actorDeviceId: authenticatedActor.deviceId,
      eventType: `codebase_keyring.rotation_${nextState}`,
      keyId: existing.repo_content_key_id,
    })
    return summarizeCodebaseKeyring(await this.first(`select * from codebase_keyrings where codebase_id = ?`, [codebaseId]))
  },

  async revokeWrappedKey(options = {}) {
    const codebaseId = stringOrNull(options.codebaseId) ?? this.codebaseId
    const actor = await this.resolveKeyActor(codebaseId, options, 'manage_members')
    const wrapId = normalizeKeyEntityId(options.wrapId, 'Wrapped key id')
    const existing = await this.first(`select * from wrapped_keys where wrap_id = ? limit 1`, [wrapId])
    if (!existing || existing.codebase_id !== codebaseId) {
      throw new Error(`Wrapped key ${wrapId} was not found.`)
    }
    const now = new Date().toISOString()
    await this.query(
      `update wrapped_keys set status = 'revoked', revoked_at = ? where wrap_id = ?`,
      [now, wrapId],
    )
    await this.appendKeyAuditEvent({
      codebaseId,
      actorUserId: actor.userId,
      actorDeviceId: actor.deviceId,
      eventType: 'wrapped_key.revoked',
      targetDeviceId: existing.recipient_type === 'device' ? existing.recipient_id : undefined,
      zoneId: existing.zone_id,
      keyId: existing.wrapped_key_id,
      wrapId,
    })
    return summarizeWrappedKey(await this.first(`select * from wrapped_keys where wrap_id = ?`, [wrapId]))
  },

  async resolveKeyActor(codebaseId, options = {}, capability = 'read') {
    const actorId = stringOrNull(options.actor?.userId)
    if (actorId) {
      const { access } = await this.requireGraphCapability(codebaseId, options.actor, capability)
      return {
        kind: 'browser',
        userId: actorId,
        deviceId: stringOrNull(options.actor?.deviceId),
        access,
      }
    }
    const sessionToken = stringOrNull(options.sessionToken) ?? this.config.agentSessionToken
    if (sessionToken) {
      const access = await this.requireD1AgentAccess(
        codebaseId,
        { sessionToken },
        agentCapabilityForCodebaseCapability(capability),
        { touch: true },
      )
      return {
        kind: 'agent-session',
        userId: access.userId,
        deviceId: access.session?.session_id ?? null,
        sessionToken,
      }
    }
    const graph = await this.readGraph(codebaseId)
    return {
      kind: 'service',
      userId: stringOrNull(graph.codebase?.ownerId) ?? 'service:hopit-agent',
      deviceId: null,
    }
  },

  async requireKeyActorCapability(codebaseId, actor, capability) {
    if (actor.kind === 'agent-session') {
      await this.requireD1AgentAccess(
        codebaseId,
        { sessionToken: actor.sessionToken },
        agentCapabilityForCodebaseCapability(capability),
        { touch: true },
      )
      return
    }
    const { access } = await this.requireGraphCapability(codebaseId, { userId: actor.userId }, capability)
    return access
  },

  async requireTrustedRecipientDevice({ recipientType, recipientId, userId = null }) {
    if (recipientType !== 'device') return null
    const device = userId
      ? await this.first(
        `select * from device_keys where user_id = ? and device_id = ? limit 1`,
        [userId, recipientId],
      )
      : await this.first(`select * from device_keys where device_id = ? limit 1`, [recipientId])
    if (!device) throw new Error(`Recipient device ${recipientId} was not found.`)
    if (device.status !== 'trusted') throw new Error(`Recipient device ${recipientId} is not trusted.`)
    return device
  },

  async assertNoDuplicateActiveWrappedKey(value) {
    const rows = await this.query(
      `select * from wrapped_keys where codebase_id = ? and wrapped_key_id = ?`,
      [value.codebaseId, value.wrappedKeyId],
    )
    const duplicate = rows.find((row) => (
      row.codebase_id === value.codebaseId &&
      row.wrapped_key_type === value.wrappedKeyType &&
      integerValue(row.key_version, 1) === value.keyVersion &&
      row.recipient_type === value.recipientType &&
      row.recipient_id === value.recipientId &&
      effectiveWrappedKeyStatus(row, Date.now()) === 'active'
    ))
    if (duplicate) {
      throw new Error(`An active wrapped key already exists for ${value.wrappedKeyId} and recipient ${value.recipientId}.`)
    }
  },

  async appendKeyAuditEvent(event) {
    await this.ensureSchema()
    await this.query(
      `insert into key_audit_events (
        event_id, codebase_id, actor_user_id, actor_device_id, event_type,
        target_user_id, target_device_id, zone_id, key_id, wrap_id, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `kae_${randomBytes(12).toString('base64url')}`,
        stringOrNull(event.codebaseId),
        stringOrNull(event.actorUserId),
        stringOrNull(event.actorDeviceId),
        requireTextValue(event.eventType, 'Key audit event type'),
        stringOrNull(event.targetUserId),
        stringOrNull(event.targetDeviceId),
        stringOrNull(event.zoneId),
        stringOrNull(event.keyId),
        stringOrNull(event.wrapId),
        new Date().toISOString(),
      ],
    )
  },
  })
}

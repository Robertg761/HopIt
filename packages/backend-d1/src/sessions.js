import { randomBytes, randomUUID } from 'node:crypto'
import { privacyZoneForPath, privacyZoneIdForPath, scopeForPath } from '@hopit/core/privacy-zone'
import { defineBackendMethods } from './method-support.js'
import { d1CloudServiceType, d1AuthorizationToken, schemaCacheKey, usesCloudflareD1Api, usesScopedD1SessionAuth } from './config.js'
import { d1SchemaStatements } from './schema.js'
import { summarizeAccessContext, normalizeEmail, backendErrorMessage, normalizeFutureTimestamp, normalizePositiveInteger, nullablePositiveInteger, nullableNonNegativeInteger, actorAuditId, requireTextValue, uniqueStrings, parseStringArray, normalizeRole, graphMemberCount, countPathScopes, assertSafeGraphPath, hashText, byteLength, parseJson, stringifyJson, stringOrNull, integerOrNull, integerValue, boundedLimit, requireAuthenticatedActor, requireVerifiedEmailActor, requireOwnerClaimActor, isBootstrapOwnerMember, claimedOwnerValue, graphFromRows, codebaseRowToRecord, codebaseRecordFromGraph, fileRowToEntry, normalizeGraph, normalizeFileEntry, normalizeVisibilityContract, normalizeOptionalVisibility, normalizeVisibilityValue, summarizeCodebaseHead, summarizeCodebaseRemoteUpdate, buildStatus, buildSyncHealth, buildRefreshHealth, mapD1AgentEvent, latestEventOf, applyJournalEntryToCloud, hasCapability, visibilityContextForGraph, filterVisibleGraphForRequester, filterVisibleGraphForAccess, canRequesterSeePath, canRead, canWrite, permissionsForRole, accessContextForCodebaseHead, memberSelectSql, mapD1Member, mapD1Invitation, invitationRole, invitationStatusOrNull, isInvitationExpired, invitationStatusForRead, hashInvitationToken, createAgentSessionId, createAgentSessionToken, hashAgentSessionToken, normalizeAgentSessionId, assertReusableAgentSession, normalizeAgentSessionCapabilities, agentSessionStatusOrNull, agentSessionHasCapability, codebaseCapabilityForAgentCapability, agentCapabilityForCodebaseCapability, isExpiredTimestamp, summarizeAgentSession, normalizeKeyEntityId, assertDevicePublicKeyDescriptor, looksLikePem, assertSameDevicePublicKeys, assertSameCodebaseKeyring, wrappedKeyType, wrappedKeyRecipientType, capabilityForWrappedKey, isPrivateZoneId, assertWrappedKeyEnvelope, assertSameWrappedKey, effectiveWrappedKeyStatus, canActorReadWrappedKey, createWrappedKeyId, summarizeDeviceKey, summarizeUserKeyring, summarizeCodebaseKeyring, summarizeWrappedKey, deviceKeyStatusOrNull, keyRotationState, mapD1Issue, mapD1IssueComment, mapD1Discussion, mapD1DiscussionComment, mapD1Release, mapD1ReleaseAsset, mapD1ReviewThread, mapD1ReviewThreadComment, mapD1ReviewDecision, mapD1Notification, mapD1Project, mapD1ProjectItem, issuePriorityOrNull, issueStatus, discussionCategory, discussionStatus, releaseStatus, releaseAssetKind, reviewDecision, notificationKind, reviewDecisionTitle, reviewDecisionBody, reviewHref, workItemHref, projectStatus, normalizeProjectColumns, normalizeProjectColumnId, normalizeProjectPosition, projectItemType, normalizeReleaseTarget, collaborationScope, actionCommandForKind, summarizeActionJob, actionSummary, capOutput } from './helpers/index.js'

/** @typedef {import('@hopit/core').CloudGraph} CloudGraph */
/** @typedef {import('@hopit/core').AgentSession} AgentSession */

export function attachSessionMethods(Backend) {
  defineBackendMethods(Backend, {
  async registerAgentSession(options = {}) {
    await this.ensureSchema()
    const codebaseId = stringOrNull(options.codebaseId) ?? this.codebaseId
    const userId = await this.resolveAgentSessionRegistrationUser(codebaseId, options)
    const sessionId = normalizeAgentSessionId(options.sessionId ?? createAgentSessionId())
    const existing = await this.first(
      `select * from agent_sessions where session_id = ? limit 1`,
      [sessionId],
    )
    if (existing?.status === 'revoked') {
      throw new Error(`Agent session ${sessionId} is revoked and cannot be reused.`)
    }
    if (existing) assertReusableAgentSession(existing, { codebaseId, userId })

    const now = new Date().toISOString()
    const sessionToken = createAgentSessionToken()
    const capabilities = normalizeAgentSessionCapabilities(options.capabilities)
    const expiresAt = normalizeFutureTimestamp(options.expiresAt, 'Agent session expiry')
    if (existing) {
      await this.query(
        `update agent_sessions set
          user_id = ?, codebase_id = ?, device_name = ?, token_hash = ?, token_prefix = ?,
          capabilities_json = ?, expires_at = ?, status = 'active', last_seen_at = ?, updated_at = ?
         where session_id = ?`,
        [
          userId,
          codebaseId,
          stringOrNull(options.deviceName),
          sessionToken.tokenHash,
          sessionToken.tokenPrefix,
          stringifyJson(capabilities),
          expiresAt,
          now,
          now,
          sessionId,
        ],
      )
    } else {
      await this.query(
        `insert into agent_sessions (
          session_id, user_id, codebase_id, device_name, token_hash, token_prefix,
          capabilities_json, expires_at, status, created_at, last_seen_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        [
          sessionId,
          userId,
          codebaseId,
          stringOrNull(options.deviceName),
          sessionToken.tokenHash,
          sessionToken.tokenPrefix,
          stringifyJson(capabilities),
          expiresAt,
          now,
          now,
          now,
        ],
      )
    }

    const session = await this.first(`select * from agent_sessions where session_id = ?`, [sessionId])
    return {
      session: summarizeAgentSession(session),
      sessionToken: sessionToken.token,
    }
  },

  async listAgentSessions(options = {}) {
    await this.ensureSchema()
    const codebaseId = stringOrNull(options.codebaseId) ?? this.codebaseId
    await this.requireD1AgentAccess(codebaseId, options, 'admin')
    const normalizedStatus = agentSessionStatusOrNull(options.status)
    const rows = normalizedStatus
      ? await this.query(
          `select * from agent_sessions where codebase_id = ? and status = ? order by last_seen_at desc, created_at desc`,
          [codebaseId, normalizedStatus],
        )
      : await this.query(
          `select * from agent_sessions where codebase_id = ? order by last_seen_at desc, created_at desc`,
          [codebaseId],
        )
    return rows.map(summarizeAgentSession)
  },

  async touchAgentSession(options = {}) {
    const sessionId = normalizeAgentSessionId(options.sessionId)
    const session = await this.requireMutableAgentSession(sessionId, options)
    if (session.status !== 'active') throw new Error('Only active agent sessions can be touched.')
    const now = new Date().toISOString()
    await this.query(
      `update agent_sessions set last_seen_at = ?, updated_at = ? where session_id = ?`,
      [now, now, sessionId],
    )
    return summarizeAgentSession(await this.first(`select * from agent_sessions where session_id = ?`, [sessionId]))
  },

  async revokeAgentSession(options = {}) {
    const sessionId = normalizeAgentSessionId(options.sessionId)
    const session = await this.requireMutableAgentSession(sessionId, options)
    const now = new Date().toISOString()
    const revokedBy = await this.revokedByUserId(session, options)
    await this.query(
      `update agent_sessions set status = 'revoked', revoked_by_user_id = ?, revoked_at = ?, updated_at = ?
       where session_id = ?`,
      [revokedBy, now, now, sessionId],
    )
    return summarizeAgentSession(await this.first(`select * from agent_sessions where session_id = ?`, [sessionId]))
  },

  async resolveAgentSessionRegistrationUser(codebaseId, options = {}) {
    const actorId = stringOrNull(options.actor?.userId)
    if (actorId) {
      await this.requireGraphCapability(codebaseId, options.actor, 'read')
      return actorId
    }
    const sessionToken = stringOrNull(options.sessionToken) ?? this.config.agentSessionToken
    if (sessionToken) {
      const access = await this.requireD1AgentAccess(codebaseId, { sessionToken }, 'admin', { touch: true })
      return access.userId
    }
    const graph = await this.readGraph(codebaseId)
    return stringOrNull(graph.codebase?.ownerId) ?? stringOrNull(graph.owner?.id) ?? 'local-owner'
  },

  async requireD1AgentAccess(codebaseId, options = {}, capability = 'read', behavior = {}) {
    const sessionToken = stringOrNull(options.sessionToken) ?? this.config.agentSessionToken
    if (!sessionToken) {
      const graph = await this.readGraph(codebaseId)
      return {
        kind: 'service',
        userId: stringOrNull(graph.codebase?.ownerId) ?? 'service:hopit-agent',
      }
    }
    const session = await this.requireActiveAgentSessionByToken(sessionToken, codebaseId, capability)
    const graph = await this.readGraph(codebaseId)
    const access = await this.readAccessContext(graph, {
      userId: session.user_id,
      sessionId: session.session_id,
    })
    const requiredCapability = codebaseCapabilityForAgentCapability(capability)
    if (requiredCapability && !hasCapability(access, requiredCapability)) {
      throw new Error(`Agent session user ${session.user_id} does not have ${requiredCapability} access to ${codebaseId}.`)
    }
    if (behavior.touch && !usesScopedD1SessionAuth(this.config)) {
      const now = new Date().toISOString()
      await this.query(
        `update agent_sessions set last_seen_at = ?, updated_at = ? where session_id = ?`,
        [now, now, session.session_id],
      )
    }
    return {
      kind: 'agent-session',
      userId: session.user_id,
      session,
      access,
    }
  },

  async requireActiveAgentSessionByToken(sessionToken, codebaseId, capability) {
    const tokenHash = hashAgentSessionToken(sessionToken)
    const session = codebaseId
      ? await this.first(
          `select * from agent_sessions where codebase_id = ? and token_hash = ? limit 1`,
          [codebaseId, tokenHash],
        )
      : await this.first(`select * from agent_sessions where token_hash = ? limit 1`, [tokenHash])
    if (!session) throw new Error('Agent session token was not found.')
    if (session.status !== 'active') throw new Error('Agent session is not active.')
    if (session.expires_at && isExpiredTimestamp(session.expires_at)) {
      throw new Error('Agent session token has expired.')
    }
    if (codebaseId && session.codebase_id !== codebaseId) {
      throw new Error(`Agent session is not scoped to codebase ${codebaseId}.`)
    }
    if (!agentSessionHasCapability(session, capability)) {
      throw new Error(`Agent session does not have ${capability} capability.`)
    }
    return session
  },

  async requireMutableAgentSession(sessionId, options = {}) {
    const session = await this.first(`select * from agent_sessions where session_id = ? limit 1`, [sessionId])
    if (!session) throw new Error(`Agent session ${sessionId} was not found.`)
    const sessionToken = stringOrNull(options.sessionToken) ?? this.config.agentSessionToken
    if (sessionToken) {
      const tokenSession = await this.requireActiveAgentSessionByToken(sessionToken, session.codebase_id, 'read')
      if (tokenSession.session_id === session.session_id) return session
      if (!agentSessionHasCapability(tokenSession, 'admin')) {
        throw new Error('Agent session token can only modify itself unless it has admin capability.')
      }
      await this.requireD1AgentAccess(session.codebase_id, { sessionToken }, 'admin')
    }
    return session
  },

  async revokedByUserId(session, options = {}) {
    const sessionToken = stringOrNull(options.sessionToken) ?? this.config.agentSessionToken
    if (sessionToken) {
      const tokenSession = await this.requireActiveAgentSessionByToken(sessionToken, session.codebase_id, 'read')
      return tokenSession.user_id
    }
    const graph = await this.readGraph(session.codebase_id)
    return stringOrNull(graph.codebase?.ownerId) ?? 'service:hopit-agent'
  },
  })
}

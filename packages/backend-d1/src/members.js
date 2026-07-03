import { randomBytes, randomUUID } from 'node:crypto'
import { privacyZoneForPath, privacyZoneIdForPath, scopeForPath } from '@hopit/core/privacy-zone'
import { defineBackendMethods } from './method-support.js'
import { d1CloudServiceType, d1AuthorizationToken, schemaCacheKey, usesCloudflareD1Api, usesScopedD1SessionAuth } from './config.js'
import { d1SchemaStatements } from './schema.js'
import { summarizeAccessContext, normalizeEmail, backendErrorMessage, normalizeFutureTimestamp, normalizePositiveInteger, nullablePositiveInteger, nullableNonNegativeInteger, actorAuditId, requireTextValue, uniqueStrings, parseStringArray, normalizeRole, graphMemberCount, countPathScopes, assertSafeGraphPath, hashText, byteLength, parseJson, stringifyJson, stringOrNull, integerOrNull, integerValue, boundedLimit, requireAuthenticatedActor, requireVerifiedEmailActor, requireOwnerClaimActor, isBootstrapOwnerMember, claimedOwnerValue, graphFromRows, codebaseRowToRecord, codebaseRecordFromGraph, fileRowToEntry, normalizeGraph, normalizeFileEntry, normalizeVisibilityContract, normalizeOptionalVisibility, normalizeVisibilityValue, summarizeCodebaseHead, summarizeCodebaseRemoteUpdate, buildStatus, buildSyncHealth, buildRefreshHealth, mapD1AgentEvent, latestEventOf, applyJournalEntryToCloud, hasCapability, visibilityContextForGraph, filterVisibleGraphForRequester, filterVisibleGraphForAccess, canRequesterSeePath, canRead, canWrite, permissionsForRole, accessContextForCodebaseHead, memberSelectSql, mapD1Member, mapD1Invitation, invitationRole, invitationStatusOrNull, isInvitationExpired, invitationStatusForRead, hashInvitationToken, createAgentSessionId, createAgentSessionToken, hashAgentSessionToken, normalizeAgentSessionId, assertReusableAgentSession, normalizeAgentSessionCapabilities, agentSessionStatusOrNull, agentSessionHasCapability, codebaseCapabilityForAgentCapability, agentCapabilityForCodebaseCapability, isExpiredTimestamp, summarizeAgentSession, normalizeKeyEntityId, assertDevicePublicKeyDescriptor, looksLikePem, assertSameDevicePublicKeys, assertSameCodebaseKeyring, wrappedKeyType, wrappedKeyRecipientType, capabilityForWrappedKey, isPrivateZoneId, assertWrappedKeyEnvelope, assertSameWrappedKey, effectiveWrappedKeyStatus, canActorReadWrappedKey, createWrappedKeyId, summarizeDeviceKey, summarizeUserKeyring, summarizeCodebaseKeyring, summarizeWrappedKey, deviceKeyStatusOrNull, keyRotationState, mapD1Issue, mapD1IssueComment, mapD1Discussion, mapD1DiscussionComment, mapD1Release, mapD1ReleaseAsset, mapD1ReviewThread, mapD1ReviewThreadComment, mapD1ReviewDecision, mapD1Notification, mapD1Project, mapD1ProjectItem, issuePriorityOrNull, issueStatus, discussionCategory, discussionStatus, releaseStatus, releaseAssetKind, reviewDecision, notificationKind, reviewDecisionTitle, reviewDecisionBody, reviewHref, workItemHref, projectStatus, normalizeProjectColumns, normalizeProjectColumnId, normalizeProjectPosition, projectItemType, normalizeReleaseTarget, collaborationScope, actionCommandForKind, summarizeActionJob, actionSummary, capOutput } from './helpers/index.js'

/** @typedef {import('@hopit/core').CloudGraph} CloudGraph */
/** @typedef {import('@hopit/core').AgentSession} AgentSession */

export function attachMemberMethods(Backend) {
  defineBackendMethods(Backend, {
  async listMembers({ codebaseId, status, actor = {} }) {
    const { graph, access } = await this.requireGraphCapability(codebaseId, actor, 'read')
    const normalizedStatus = status === 'active' || status === 'suspended' ? status : null
    const rows = normalizedStatus
      ? await this.query(memberSelectSql(`where m.codebase_id = ? and m.status = ?`), [codebaseId, normalizedStatus])
      : await this.query(memberSelectSql(`where m.codebase_id = ?`), [codebaseId])
    return rows.map((row) => mapD1Member(row, graph, access))
  },

  async claimCodebaseOwner({ codebaseId, actor = {} }) {
    const ownerActor = requireOwnerClaimActor(actor)
    await this.upsertUser({
      userId: ownerActor.userId,
      primaryEmail: ownerActor.primaryEmail,
      displayName: ownerActor.displayName,
      avatarUrl: ownerActor.avatarUrl,
      emailVerified: ownerActor.currentAuthEmailVerified,
    })
    const graph = await this.readGraph(codebaseId)
    await this.ensureGraphMembers(graph)
    const members = await this.query(`select * from codebase_members where codebase_id = ?`, [codebaseId])
    const conflictingOwner = members.find((member) =>
      member.role === 'owner' &&
      member.status === 'active' &&
      member.user_id !== ownerActor.userId &&
      !isBootstrapOwnerMember(member, graph),
    )
    if (conflictingOwner) {
      throw new Error(`Codebase ${codebaseId} already has an active owner.`)
    }

    const now = new Date().toISOString()
    for (const member of members) {
      if (member.role === 'owner' && member.status === 'active' && member.user_id !== ownerActor.userId) {
        await this.query(
          `update codebase_members set status = 'suspended', updated_at = ? where codebase_id = ? and user_id = ?`,
          [now, codebaseId, member.user_id],
        )
      }
    }

    await this.upsertMember({
      codebaseId,
      userId: ownerActor.userId,
      role: 'owner',
      status: 'active',
      source: 'owner-claim',
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    })

    graph.codebase.ownerId = ownerActor.userId
    graph.owner = claimedOwnerValue(graph.owner, ownerActor)
    graph.collaborators = (graph.collaborators ?? []).filter((entry) => {
      const userId = stringOrNull(entry?.id) ?? stringOrNull(entry?.userId)
      return userId && userId !== ownerActor.userId
    })
    graph.revision += 1
    graph.main.revision = graph.revision
    graph.main.updatedAt = now
    await this.writeGraph(graph)
    await this.refreshCodebaseMemberCount(codebaseId, now)
    await this.appendEvent({
      codebaseId,
      event: 'codebase.owner_claimed',
      detail: { ownerId: ownerActor.userId },
      at: now,
      source: 'browser',
    })

    return { ok: true, codebaseId, ownerId: ownerActor.userId }
  },

  async bootstrapAccount(actor = {}) {
    const ownerActor = requireOwnerClaimActor(actor)
    await this.ensureSchema()
    await this.upsertUser({
      userId: ownerActor.userId,
      primaryEmail: ownerActor.primaryEmail,
      displayName: ownerActor.displayName,
      avatarUrl: ownerActor.avatarUrl,
      emailVerified: ownerActor.currentAuthEmailVerified,
    })

    const rows = await this.query(
      `select distinct c.codebase_id
       from codebases c
       left join codebase_members m on m.codebase_id = c.codebase_id
       where c.owner_id = ?
          or (
            m.role = 'owner'
            and m.status = 'active'
            and (
              m.user_id = ?
              or m.source = 'graph-owner'
            )
          )
       order by c.updated_at desc`,
      ['local-owner', 'local-owner'],
    )
    const results = []

    for (const row of rows) {
      const codebaseId = stringOrNull(row.codebase_id)
      if (!codebaseId) continue

      try {
        const claim = await this.claimCodebaseOwner({ codebaseId, actor: ownerActor })
        results.push({
          codebaseId,
          status: 'claimed',
          ownerId: claim.ownerId,
        })
      } catch (error) {
        results.push({
          codebaseId,
          status: 'failed',
          error: backendErrorMessage(error, 'Codebase owner bootstrap failed.'),
        })
      }
    }

    return {
      ok: results.every((result) => result.status !== 'failed'),
      ownerId: ownerActor.userId,
      codebases: results,
      claimed: results.filter((result) => result.status === 'claimed'),
      failed: results.filter((result) => result.status === 'failed'),
    }
  },

  async suspendMember({ codebaseId, userId, actor = {} }) {
    return this.mutateMemberStatus({ codebaseId, userId, actor, action: 'suspend' })
  },

  async removeMember({ codebaseId, userId, actor = {} }) {
    return this.mutateMemberStatus({ codebaseId, userId, actor, action: 'remove' })
  },

  async mutateMemberStatus({ codebaseId, userId, actor, action }) {
    requireAuthenticatedActor(actor, 'Managing members requires product auth.')
    const { graph } = await this.requireGraphCapability(codebaseId, actor, 'manage_members')
    const member = await this.first(
      `select * from codebase_members where codebase_id = ? and user_id = ? limit 1`,
      [codebaseId, userId],
    )
    if (!member) throw new Error(`Member ${userId} was not found for ${codebaseId}.`)
    if (member.role === 'owner' || member.user_id === graph.codebase.ownerId) {
      throw new Error(`Codebase owners cannot be ${action}d through member management.`)
    }
    const now = new Date().toISOString()
    const source = action === 'remove' ? 'removed' : member.source
    await this.query(
      `update codebase_members set status = 'suspended', source = ?, updated_at = ? where codebase_id = ? and user_id = ?`,
      [source ?? null, now, codebaseId, userId],
    )
    await this.refreshCodebaseMemberCount(codebaseId, now)
    await this.appendEvent({
      codebaseId,
      event: action === 'remove' ? 'member.removed' : 'member.suspended',
      detail: { userId, updatedBy: actor.userId },
      at: now,
      source: 'browser',
    })
    const updated = await this.first(memberSelectSql(`where m.codebase_id = ? and m.user_id = ?`), [codebaseId, userId])
    return updated ? mapD1Member(updated, graph) : { ok: true, codebaseId, userId }
  },

  async listInvitations({ codebaseId, status = 'pending', actor = {} }) {
    await this.requireGraphCapability(codebaseId, actor, 'invite')
    await this.expireInvitationsForCodebase(codebaseId)
    const normalizedStatus = invitationStatusOrNull(status)
    const rows = normalizedStatus
      ? await this.query(
          `select * from codebase_invitations where codebase_id = ? and status = ? order by created_at desc`,
          [codebaseId, normalizedStatus],
        )
      : await this.query(
          `select * from codebase_invitations where codebase_id = ? order by created_at desc`,
          [codebaseId],
        )
    return rows.map(mapD1Invitation)
  },

  async createInvitation({ codebaseId, email, role, expiresAt, actor = {} }) {
    const inviteActor = requireAuthenticatedActor(actor, 'Creating invitations requires product auth.')
    await this.requireGraphCapability(codebaseId, inviteActor, 'invite')
    const normalizedEmail = normalizeEmail(email)
    if (!normalizedEmail) throw new Error('Invitation email is required.')
    const existingMember = await this.readActiveMemberByEmail(codebaseId, normalizedEmail)
    if (existingMember) {
      throw new Error(`${normalizedEmail} already has active access to ${codebaseId}.`)
    }

    await this.expireInvitationsForCodebase(codebaseId, normalizedEmail)
    const pending = await this.first(
      `select * from codebase_invitations where codebase_id = ? and normalized_email = ? and status = 'pending' limit 1`,
      [codebaseId, normalizedEmail],
    )
    if (pending) throw new Error(`A pending invitation already exists for ${normalizedEmail}.`)

    const now = new Date().toISOString()
    const token = await this.createUniqueInvitationToken()
    const invitationId = `inv_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    await this.query(
      `insert into codebase_invitations (
        invitation_id, codebase_id, normalized_email, role, token_hash, status,
        invited_by_user_id, expires_at, created_at, updated_at
      ) values (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      [
        invitationId,
        codebaseId,
        normalizedEmail,
        invitationRole(role),
        token.tokenHash,
        inviteActor.userId,
        normalizeFutureTimestamp(expiresAt, 'Invitation expiry'),
        now,
        now,
      ],
    )
    await this.appendEvent({
      codebaseId,
      event: 'invitation.created',
      detail: { invitationId, email: normalizedEmail, role: invitationRole(role), invitedBy: inviteActor.userId },
      at: now,
      source: 'browser',
    })
    return {
      invitationId,
      codebaseId,
      normalizedEmail,
      role: invitationRole(role),
      status: 'pending',
      token: token.token,
    }
  },

  async acceptInvitation({ token, actor = {} }) {
    const acceptingActor = requireVerifiedEmailActor(actor, 'A verified account email is required to accept an invitation.')
    await this.upsertUser({
      userId: acceptingActor.userId,
      primaryEmail: acceptingActor.primaryEmail,
      displayName: acceptingActor.displayName,
      avatarUrl: acceptingActor.avatarUrl,
      emailVerified: acceptingActor.currentAuthEmailVerified,
    })
    const tokenHash = hashInvitationToken(token)
    const invitation = await this.first(
      `select * from codebase_invitations where token_hash = ? limit 1`,
      [tokenHash],
    )
    if (!invitation) throw new Error('Invitation not found.')
    if (invitation.status !== 'pending') throw new Error('Invitation is no longer pending.')
    if (isInvitationExpired(invitation)) {
      const now = new Date().toISOString()
      await this.query(
        `update codebase_invitations set status = 'expired', updated_at = ? where invitation_id = ?`,
        [now, invitation.invitation_id],
      )
      throw new Error('Invitation has expired.')
    }
    if (normalizeEmail(acceptingActor.primaryEmail) !== invitation.normalized_email) {
      throw new Error('Authenticated account email does not match this invitation.')
    }

    const now = new Date().toISOString()
    await this.upsertMember({
      codebaseId: invitation.codebase_id,
      userId: acceptingActor.userId,
      role: invitationRole(invitation.role),
      status: 'active',
      source: 'invitation',
      invitedByUserId: invitation.invited_by_user_id,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    await this.query(
      `update codebase_invitations set
        status = 'accepted', accepted_by_user_id = ?, accepted_at = ?, updated_at = ?
       where invitation_id = ?`,
      [acceptingActor.userId, now, now, invitation.invitation_id],
    )
    await this.refreshCodebaseMemberCount(invitation.codebase_id, now)
    await this.appendEvent({
      codebaseId: invitation.codebase_id,
      event: 'invitation.accepted',
      detail: { invitationId: invitation.invitation_id, acceptedBy: acceptingActor.userId },
      at: now,
      source: 'browser',
    })
    return {
      codebaseId: invitation.codebase_id,
      userId: acceptingActor.userId,
      role: invitationRole(invitation.role),
      status: 'accepted',
    }
  },

  async revokeInvitation({ codebaseId, invitationId, actor = {} }) {
    const revokeActor = requireAuthenticatedActor(actor, 'Revoking invitations requires product auth.')
    const invitation = await this.first(
      `select * from codebase_invitations where invitation_id = ? limit 1`,
      [invitationId],
    )
    if (!invitation) throw new Error('Invitation not found.')
    await this.requireGraphCapability(invitation.codebase_id, revokeActor, 'invite')
    if (invitation.status !== 'pending') throw new Error('Only pending invitations can be revoked.')
    if (codebaseId && codebaseId !== invitation.codebase_id) {
      throw new Error(`Invitation ${invitationId} does not belong to ${codebaseId}.`)
    }
    const now = new Date().toISOString()
    await this.query(
      `update codebase_invitations set
        status = 'revoked', revoked_by_user_id = ?, revoked_at = ?, updated_at = ?
       where invitation_id = ?`,
      [revokeActor.userId, now, now, invitationId],
    )
    const updated = await this.first(`select * from codebase_invitations where invitation_id = ?`, [invitationId])
    await this.appendEvent({
      codebaseId: invitation.codebase_id,
      event: 'invitation.revoked',
      detail: { invitationId, revokedBy: revokeActor.userId },
      at: now,
      source: 'browser',
    })
    return mapD1Invitation(updated)
  },

  async refreshCodebaseMemberCount(codebaseId, now = new Date().toISOString()) {
    const row = await this.first(
      `select count(*) as count from codebase_members where codebase_id = ? and status = 'active'`,
      [codebaseId],
    )
    await this.query(
      `update codebases set member_count = ?, updated_at = ? where codebase_id = ?`,
      [integerValue(row?.count, 0), now, codebaseId],
    )
  },

  async readActiveMemberByEmail(codebaseId, normalizedEmail) {
    const user = await this.first(`select user_id from users where primary_email = ? limit 1`, [normalizedEmail])
    if (!user) return null
    return await this.first(
      `select * from codebase_members where codebase_id = ? and user_id = ? and status = 'active' limit 1`,
      [codebaseId, user.user_id],
    )
  },

  async expireInvitationsForCodebase(codebaseId, normalizedEmail = null) {
    const now = new Date().toISOString()
    const rows = normalizedEmail
      ? await this.query(
          `select * from codebase_invitations where codebase_id = ? and normalized_email = ? and status = 'pending'`,
          [codebaseId, normalizedEmail],
        )
      : await this.query(
          `select * from codebase_invitations where codebase_id = ? and status = 'pending'`,
          [codebaseId],
        )
    for (const invitation of rows) {
      if (!isInvitationExpired(invitation)) continue
      await this.query(
        `update codebase_invitations set status = 'expired', updated_at = ? where invitation_id = ?`,
        [now, invitation.invitation_id],
      )
    }
  },

  async createUniqueInvitationToken() {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const token = randomBytes(32).toString('base64url')
      const tokenHash = hashInvitationToken(token)
      const existing = await this.first(
        `select invitation_id from codebase_invitations where token_hash = ? limit 1`,
        [tokenHash],
      )
      if (!existing) return { token, tokenHash }
    }
    throw new Error('Could not allocate a unique invitation token.')
  },

  async upsertMember(member) {
    await this.ensureSchema()
    await this.query(
      `insert into codebase_members (
        codebase_id, user_id, role, status, source, invited_by_user_id, joined_at, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(codebase_id, user_id) do update set
        role = excluded.role,
        status = excluded.status,
        source = excluded.source,
        invited_by_user_id = excluded.invited_by_user_id,
        joined_at = excluded.joined_at,
        updated_at = excluded.updated_at`,
      [
        member.codebaseId,
        member.userId,
        member.role,
        member.status,
        member.source ?? null,
        member.invitedByUserId ?? null,
        member.joinedAt ?? null,
        member.createdAt ?? new Date().toISOString(),
        member.updatedAt ?? new Date().toISOString(),
      ],
    )
  },
  })
}

import { randomBytes, randomUUID } from 'node:crypto'
import { privacyZoneForPath, privacyZoneIdForPath, scopeForPath } from '@hopit/core/privacy-zone'
import { defineBackendMethods } from './method-support.js'
import { d1CloudServiceType, d1AuthorizationToken, schemaCacheKey, usesCloudflareD1Api, usesScopedD1SessionAuth } from './config.js'
import { d1SchemaStatements } from './schema.js'
import { summarizeAccessContext, normalizeEmail, backendErrorMessage, normalizeFutureTimestamp, normalizePositiveInteger, nullablePositiveInteger, nullableNonNegativeInteger, actorAuditId, requireTextValue, uniqueStrings, parseStringArray, normalizeRole, graphMemberCount, countPathScopes, assertSafeGraphPath, hashText, byteLength, parseJson, stringifyJson, stringOrNull, integerOrNull, integerValue, boundedLimit, requireAuthenticatedActor, requireVerifiedEmailActor, requireOwnerClaimActor, isBootstrapOwnerMember, claimedOwnerValue, graphFromRows, codebaseRowToRecord, codebaseRecordFromGraph, fileRowToEntry, normalizeGraph, normalizeFileEntry, normalizeVisibilityContract, normalizeOptionalVisibility, normalizeVisibilityValue, summarizeCodebaseHead, summarizeCodebaseRemoteUpdate, buildStatus, buildSyncHealth, buildRefreshHealth, mapD1AgentEvent, latestEventOf, applyJournalEntryToCloud, hasCapability, visibilityContextForGraph, filterVisibleGraphForRequester, filterVisibleGraphForAccess, canRequesterSeePath, canRead, canWrite, permissionsForRole, accessContextForCodebaseHead, memberSelectSql, mapD1Member, mapD1Invitation, invitationRole, invitationStatusOrNull, isInvitationExpired, invitationStatusForRead, hashInvitationToken, createAgentSessionId, createAgentSessionToken, hashAgentSessionToken, normalizeAgentSessionId, assertReusableAgentSession, normalizeAgentSessionCapabilities, agentSessionStatusOrNull, agentSessionHasCapability, codebaseCapabilityForAgentCapability, agentCapabilityForCodebaseCapability, isExpiredTimestamp, summarizeAgentSession, normalizeKeyEntityId, assertDevicePublicKeyDescriptor, looksLikePem, assertSameDevicePublicKeys, assertSameCodebaseKeyring, wrappedKeyType, wrappedKeyRecipientType, capabilityForWrappedKey, isPrivateZoneId, assertWrappedKeyEnvelope, assertSameWrappedKey, effectiveWrappedKeyStatus, canActorReadWrappedKey, createWrappedKeyId, summarizeDeviceKey, summarizeUserKeyring, summarizeCodebaseKeyring, summarizeWrappedKey, deviceKeyStatusOrNull, keyRotationState, mapD1ReviewThread, mapD1ReviewThreadComment, mapD1ReviewDecision, mapD1Notification, reviewDecision, notificationKind, reviewDecisionTitle, reviewDecisionBody, reviewHref, actionCommandForKind, summarizeActionJob, actionSummary, capOutput } from './helpers/index.js'

/** @typedef {import('@hopit/core').CloudGraph} CloudGraph */
/** @typedef {import('@hopit/core').AgentSession} AgentSession */

export function attachCollaborationMethods(Backend) {
  defineBackendMethods(Backend, {
  async listReviewThreads({ codebaseId, changeSetId = null, actor = {} }) {
    await this.requireGraphCapability(codebaseId, actor, 'read')
    const normalizedChangeSetId = stringOrNull(changeSetId)
    const threads = normalizedChangeSetId
      ? await this.query(
          `select * from review_threads where codebase_id = ? and change_set_id = ? order by updated_at desc, created_at desc`,
          [codebaseId, normalizedChangeSetId],
        )
      : await this.query(
          `select * from review_threads where codebase_id = ? order by updated_at desc, created_at desc limit 100`,
          [codebaseId],
        )
    if (threads.length === 0) return []
    const threadIds = threads.map((thread) => thread.thread_id)
    const comments = await this.query(
      `select * from review_thread_comments where codebase_id = ? and thread_id in (${threadIds.map(() => '?').join(', ')}) order by created_at asc`,
      [codebaseId, ...threadIds],
    )
    const commentsByThreadId = new Map()
    for (const comment of comments) {
      const list = commentsByThreadId.get(comment.thread_id) ?? []
      list.push(mapD1ReviewThreadComment(comment))
      commentsByThreadId.set(comment.thread_id, list)
    }
    return threads.map((thread) => mapD1ReviewThread(thread, commentsByThreadId.get(thread.thread_id) ?? []))
  },

  async createReviewThread({
    codebaseId,
    changeSetId,
    filePath,
    lineNumber,
    baseRevision,
    headRevision,
    lineFingerprint,
    body,
    createdBy,
    actor,
  }) {
    await this.requireGraphCapability(codebaseId, actor, 'write')
    const normalizedPath = requireTextValue(filePath, 'Review file path')
    const file = await this.first(`select path from files where codebase_id = ? and path = ? limit 1`, [codebaseId, normalizedPath])
    if (!file) throw new Error(`Review file ${normalizedPath} was not found in ${codebaseId}.`)
    const now = new Date().toISOString()
    const threadId = `rthr_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    const commentId = `rcom_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    const author = actorAuditId(actor, createdBy, 'Review thread creator')
    await this.query(
      `insert into review_threads (
        thread_id, codebase_id, change_set_id, file_path, line_number, base_revision,
        head_revision, line_fingerprint, status, created_by, updated_by, created_at, updated_at, resolved_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, null)`,
      [
        threadId,
        codebaseId,
        requireTextValue(changeSetId, 'Review change set id'),
        normalizedPath,
        nullablePositiveInteger(lineNumber, 'Review line number'),
        stringOrNull(baseRevision),
        stringOrNull(headRevision),
        stringOrNull(lineFingerprint),
        author,
        author,
        now,
        now,
      ],
    )
    await this.query(
      `insert into review_thread_comments (
        comment_id, codebase_id, thread_id, body, created_by, updated_by, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [commentId, codebaseId, threadId, requireTextValue(body, 'Review comment body'), author, author, now, now],
    )
    await this.appendEvent({
      codebaseId,
      event: 'review.thread_opened',
      detail: { threadId, changeSetId, path: normalizedPath, lineNumber: nullablePositiveInteger(lineNumber, 'Review line number') },
      source: 'browser',
    })
    await this.createNotification({
      codebaseId,
      kind: 'review.thread_opened',
      title: 'Review thread opened',
      body: `${author} opened a review thread on ${normalizedPath}.`,
      href: reviewHref(codebaseId, changeSetId),
      createdAt: now,
    })
    return mapD1ReviewThread(
      await this.first(`select * from review_threads where codebase_id = ? and thread_id = ?`, [codebaseId, threadId]),
      [mapD1ReviewThreadComment(await this.first(`select * from review_thread_comments where codebase_id = ? and comment_id = ?`, [codebaseId, commentId]))],
    )
  },

  async createReviewThreadComment({ codebaseId, threadId, body, createdBy, actor }) {
    const normalizedCodebaseId = stringOrNull(codebaseId)
    const thread = normalizedCodebaseId
      ? await this.first(`select * from review_threads where codebase_id = ? and thread_id = ? limit 1`, [normalizedCodebaseId, threadId])
      : await this.first(`select * from review_threads where thread_id = ? limit 1`, [threadId])
    if (!thread) throw new Error('Review thread not found.')
    await this.requireGraphCapability(thread.codebase_id, actor, 'write')
    if (thread.status !== 'open') throw new Error('Resolved review threads cannot accept new comments.')
    const now = new Date().toISOString()
    const commentId = `rcom_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    const author = actorAuditId(actor, createdBy, 'Review comment creator')
    await this.query(
      `insert into review_thread_comments (
        comment_id, codebase_id, thread_id, body, created_by, updated_by, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [commentId, thread.codebase_id, threadId, requireTextValue(body, 'Review comment body'), author, author, now, now],
    )
    await this.query(
      `update review_threads set updated_by = ?, updated_at = ? where codebase_id = ? and thread_id = ?`,
      [author, now, thread.codebase_id, threadId],
    )
    await this.createNotification({
      codebaseId: thread.codebase_id,
      kind: 'review.comment_added',
      title: 'Review comment added',
      body: `${author} replied to ${thread.file_path}.`,
      href: reviewHref(thread.codebase_id, thread.change_set_id),
      createdAt: now,
    })
    return mapD1ReviewThreadComment(await this.first(`select * from review_thread_comments where codebase_id = ? and comment_id = ?`, [thread.codebase_id, commentId]))
  },

  async resolveReviewThread({ codebaseId, threadId, updatedBy, actor }) {
    const normalizedCodebaseId = stringOrNull(codebaseId)
    const thread = normalizedCodebaseId
      ? await this.first(`select * from review_threads where codebase_id = ? and thread_id = ? limit 1`, [normalizedCodebaseId, threadId])
      : await this.first(`select * from review_threads where thread_id = ? limit 1`, [threadId])
    if (!thread) throw new Error('Review thread not found.')
    await this.requireGraphCapability(thread.codebase_id, actor, 'write')
    const now = new Date().toISOString()
    await this.query(
      `update review_threads set status = 'resolved', updated_by = ?, updated_at = ?, resolved_at = ? where codebase_id = ? and thread_id = ?`,
      [actorAuditId(actor, updatedBy, 'Review thread resolver'), now, now, thread.codebase_id, threadId],
    )
    const resolver = actorAuditId(actor, updatedBy, 'Review thread resolver')
    await this.appendEvent({
      codebaseId: thread.codebase_id,
      event: 'review.thread_resolved',
      detail: { threadId, changeSetId: thread.change_set_id, path: thread.file_path, lineNumber: thread.line_number ?? null },
      source: 'browser',
    })
    await this.createNotification({
      codebaseId: thread.codebase_id,
      kind: 'review.thread_resolved',
      title: 'Review thread resolved',
      body: `${resolver} resolved a review thread on ${thread.file_path}.`,
      href: reviewHref(thread.codebase_id, thread.change_set_id),
      createdAt: now,
    })
    const comments = await this.query(
      `select * from review_thread_comments where codebase_id = ? and thread_id = ? order by created_at asc`,
      [thread.codebase_id, threadId],
    )
    return mapD1ReviewThread(
      await this.first(`select * from review_threads where codebase_id = ? and thread_id = ?`, [thread.codebase_id, threadId]),
      comments.map(mapD1ReviewThreadComment),
    )
  },

  async listReviewDecisions({ codebaseId, changeSetId = null, actor = {} }) {
    await this.requireGraphCapability(codebaseId, actor, 'read')
    const normalizedChangeSetId = stringOrNull(changeSetId)
    const rows = normalizedChangeSetId
      ? await this.query(
          `select * from review_decisions where codebase_id = ? and change_set_id = ? order by created_at desc`,
          [codebaseId, normalizedChangeSetId],
        )
      : await this.query(
          `select * from review_decisions where codebase_id = ? order by created_at desc limit 100`,
          [codebaseId],
        )
    return rows.map(mapD1ReviewDecision).filter(Boolean)
  },

  async createReviewDecision({ codebaseId, changeSetId, decision, summary, createdBy, actor = {} }) {
    await this.requireGraphCapability(codebaseId, actor, 'review')
    const normalizedChangeSetId = requireTextValue(changeSetId, 'Review change set id')
    const nextDecision = reviewDecision(decision)
    const now = new Date().toISOString()
    const decisionId = `rdec_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    const reviewer = actorAuditId(actor, createdBy, 'Review decision creator')
    await this.query(
      `insert into review_decisions (
        decision_id, codebase_id, change_set_id, decision, summary, created_by, created_at
      ) values (?, ?, ?, ?, ?, ?, ?)`,
      [
        decisionId,
        codebaseId,
        normalizedChangeSetId,
        nextDecision,
        stringOrNull(summary),
        reviewer,
        now,
      ],
    )
    await this.appendEvent({
      codebaseId,
      event: 'review.decision_recorded',
      detail: { decisionId, changeSetId: normalizedChangeSetId, decision: nextDecision },
      at: now,
      source: 'browser',
    })
    await this.createNotification({
      codebaseId,
      kind: `review.${nextDecision}`,
      title: reviewDecisionTitle(nextDecision),
      body: reviewDecisionBody(nextDecision, reviewer, summary),
      href: reviewHref(codebaseId, normalizedChangeSetId),
      createdAt: now,
    })
    return mapD1ReviewDecision(await this.first(`select * from review_decisions where codebase_id = ? and decision_id = ?`, [codebaseId, decisionId]))
  },

  async listNotifications({ codebaseId, actor = {}, limit = 20, unreadOnly = false }) {
    await this.requireGraphCapability(codebaseId, actor, 'read')
    const userId = stringOrNull(actor.userId)
    const maxRows = boundedLimit(limit, 50)
    const unreadSql = unreadOnly ? ` and read_at is null` : ''
    const rows = userId
      ? await this.query(
          `select * from notifications
           where codebase_id = ? and (recipient_user_id is null or recipient_user_id = ?)${unreadSql}
           order by created_at desc, notification_id desc limit ?`,
          [codebaseId, userId, maxRows],
        )
      : await this.query(
          `select * from notifications
           where codebase_id = ? and recipient_user_id is null${unreadSql}
           order by created_at desc, notification_id desc limit ?`,
          [codebaseId, maxRows],
        )
    return rows.map(mapD1Notification).filter(Boolean)
  },

  async createNotification({ codebaseId, recipientUserId = null, kind, title, body, href = null, createdAt = new Date().toISOString() }) {
    if (!codebaseId) return null
    await this.ensureSchema()
    const notificationId = `notif_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    await this.query(
      `insert into notifications (
        notification_id, codebase_id, recipient_user_id, kind, title, body, href, read_at, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, null, ?)`,
      [
        notificationId,
        codebaseId,
        stringOrNull(recipientUserId),
        notificationKind(kind),
        requireTextValue(title, 'Notification title'),
        requireTextValue(body, 'Notification body'),
        stringOrNull(href),
        createdAt,
      ],
    )
    return mapD1Notification(await this.first(`select * from notifications where codebase_id = ? and notification_id = ?`, [codebaseId, notificationId]))
  },

  async markNotificationRead({ codebaseId, notificationId, actor = {} }) {
    await this.requireGraphCapability(codebaseId, actor, 'read')
    const userId = requireTextValue(actor?.userId, 'Notification reader')
    const now = new Date().toISOString()
    await this.query(
      `update notifications
       set read_at = ?
       where codebase_id = ? and notification_id = ? and (recipient_user_id is null or recipient_user_id = ?)`,
      [now, codebaseId, requireTextValue(notificationId, 'Notification id'), userId],
    )
    return mapD1Notification(await this.first(`select * from notifications where codebase_id = ? and notification_id = ?`, [codebaseId, notificationId]))
  },

  })
}

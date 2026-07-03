import { randomBytes, randomUUID } from 'node:crypto'
import { privacyZoneForPath, privacyZoneIdForPath, scopeForPath } from '@hopit/core/privacy-zone'
import { defineBackendMethods } from './method-support.js'
import { d1CloudServiceType, d1AuthorizationToken, schemaCacheKey, usesCloudflareD1Api, usesScopedD1SessionAuth } from './config.js'
import { d1SchemaStatements } from './schema.js'
import { summarizeAccessContext, normalizeEmail, backendErrorMessage, normalizeFutureTimestamp, normalizePositiveInteger, nullablePositiveInteger, nullableNonNegativeInteger, actorAuditId, requireTextValue, uniqueStrings, parseStringArray, normalizeRole, graphMemberCount, countPathScopes, assertSafeGraphPath, hashText, byteLength, parseJson, stringifyJson, stringOrNull, integerOrNull, integerValue, boundedLimit, requireAuthenticatedActor, requireVerifiedEmailActor, requireOwnerClaimActor, isBootstrapOwnerMember, claimedOwnerValue, graphFromRows, codebaseRowToRecord, codebaseRecordFromGraph, fileRowToEntry, normalizeGraph, normalizeFileEntry, normalizeVisibilityContract, normalizeOptionalVisibility, normalizeVisibilityValue, summarizeCodebaseHead, summarizeCodebaseRemoteUpdate, buildStatus, buildSyncHealth, buildRefreshHealth, mapD1AgentEvent, latestEventOf, applyJournalEntryToCloud, hasCapability, visibilityContextForGraph, filterVisibleGraphForRequester, filterVisibleGraphForAccess, canRequesterSeePath, canRead, canWrite, permissionsForRole, accessContextForCodebaseHead, memberSelectSql, mapD1Member, mapD1Invitation, invitationRole, invitationStatusOrNull, isInvitationExpired, invitationStatusForRead, hashInvitationToken, createAgentSessionId, createAgentSessionToken, hashAgentSessionToken, normalizeAgentSessionId, assertReusableAgentSession, normalizeAgentSessionCapabilities, agentSessionStatusOrNull, agentSessionHasCapability, codebaseCapabilityForAgentCapability, agentCapabilityForCodebaseCapability, isExpiredTimestamp, summarizeAgentSession, normalizeKeyEntityId, assertDevicePublicKeyDescriptor, looksLikePem, assertSameDevicePublicKeys, assertSameCodebaseKeyring, wrappedKeyType, wrappedKeyRecipientType, capabilityForWrappedKey, isPrivateZoneId, assertWrappedKeyEnvelope, assertSameWrappedKey, effectiveWrappedKeyStatus, canActorReadWrappedKey, createWrappedKeyId, summarizeDeviceKey, summarizeUserKeyring, summarizeCodebaseKeyring, summarizeWrappedKey, deviceKeyStatusOrNull, keyRotationState, mapD1Issue, mapD1IssueComment, mapD1Discussion, mapD1DiscussionComment, mapD1Release, mapD1ReleaseAsset, mapD1ReviewThread, mapD1ReviewThreadComment, mapD1ReviewDecision, mapD1Notification, mapD1Project, mapD1ProjectItem, issuePriorityOrNull, issueStatus, discussionCategory, discussionStatus, releaseStatus, releaseAssetKind, reviewDecision, notificationKind, reviewDecisionTitle, reviewDecisionBody, reviewHref, workItemHref, projectStatus, normalizeProjectColumns, normalizeProjectColumnId, normalizeProjectPosition, projectItemType, normalizeReleaseTarget, collaborationScope, actionCommandForKind, summarizeActionJob, actionSummary, capOutput } from './helpers/index.js'

/** @typedef {import('@hopit/core').CloudGraph} CloudGraph */
/** @typedef {import('@hopit/core').AgentSession} AgentSession */

export function attachActionMethods(Backend) {
  defineBackendMethods(Backend, {
  async listActionJobs({ codebaseId, limit = 20, actor = {} }) {
    const graph = await this.readGraph(codebaseId)
    const access = await this.readAccessContext(graph, actor)
    if (!canRead(access)) throw new Error(`User cannot read ${codebaseId}.`)
    const rows = await this.query(
      `select * from action_jobs where codebase_id = ? order by created_at desc limit ?`,
      [codebaseId, boundedLimit(limit, 30)],
    )
    return rows.map(summarizeActionJob)
  },

  async createActionJob({ codebaseId, kind, actor = {} }) {
    const graph = await this.readGraph(codebaseId)
    const access = await this.readAccessContext(graph, actor)
    if (!access.isOwner) throw new Error('Hosted actions are owner-only until sandboxed runners are available.')
    const command = actionCommandForKind(kind)
    const now = new Date().toISOString()
    const job = {
      jobId: `job_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
      codebaseId,
      kind,
      command: command.command,
      args: command.args,
      status: 'queued',
      requestedByUserId: actor.userId,
      createdAt: now,
      updatedAt: now,
    }
    await this.query(
      `insert into action_jobs (
        job_id, codebase_id, kind, command, args_json, status, requested_by_user_id,
        created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        job.jobId,
        job.codebaseId,
        job.kind,
        job.command,
        stringifyJson(job.args),
        job.status,
        job.requestedByUserId,
        job.createdAt,
        job.updatedAt,
      ],
    )
    await this.appendEvent({
      codebaseId,
      event: 'action.queued',
      detail: { jobId: job.jobId, kind, requestedBy: actor.userId },
      at: now,
      source: 'browser',
    })
    return summarizeActionJob(job)
  },

  async claimNextActionJob({ runnerId }) {
    await this.ensureSchema()
    const job = await this.first(
      `select * from action_jobs where status = 'queued' order by created_at asc limit 1`,
    )
    if (!job) return null
    const now = new Date().toISOString()
    await this.query(
      `update action_jobs set status = 'running', runner_id = ?, claimed_at = ?, started_at = ?, updated_at = ?
       where job_id = ? and status = 'queued'`,
      [runnerId, now, now, now, job.job_id],
    )
    const claimed = await this.first(`select * from action_jobs where job_id = ?`, [job.job_id])
    await this.appendEvent({
      codebaseId: job.codebase_id,
      event: 'action.started',
      detail: { jobId: job.job_id, kind: job.kind, runnerId },
      at: now,
      source: 'hosted-runner',
    })
    return claimed ? summarizeActionJob(claimed) : null
  },

  async completeActionJob({ jobId, runnerId, status, exitCode = null, stdout, stderr, summary }) {
    await this.ensureSchema()
    const job = await this.first(`select * from action_jobs where job_id = ?`, [jobId])
    if (!job) throw new Error(`Action job ${jobId} was not found.`)
    if (job.status !== 'running') throw new Error(`Action job ${jobId} is not running.`)
    if (job.runner_id && job.runner_id !== runnerId) throw new Error(`Action job ${jobId} is claimed by another runner.`)
    const now = new Date().toISOString()
    await this.query(
      `update action_jobs set
        status = ?, runner_id = ?, exit_code = ?, stdout = ?, stderr = ?, summary = ?,
        finished_at = ?, updated_at = ?
       where job_id = ?`,
      [
        status,
        runnerId,
        exitCode,
        capOutput(stdout),
        capOutput(stderr),
        stringOrNull(summary) ?? actionSummary(status, exitCode),
        now,
        now,
        jobId,
      ],
    )
    await this.appendEvent({
      codebaseId: job.codebase_id,
      event: status === 'succeeded' ? 'action.succeeded' : 'action.failed',
      detail: { jobId, kind: job.kind, runnerId, exitCode },
      at: now,
      source: 'hosted-runner',
    })
    const updated = await this.first(`select * from action_jobs where job_id = ?`, [jobId])
    return summarizeActionJob(updated)
  },
  })
}

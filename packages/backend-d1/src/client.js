import { randomBytes, randomUUID } from 'node:crypto'
import { privacyZoneForPath, privacyZoneIdForPath, scopeForPath } from '@hopit/core/privacy-zone'
import { defineBackendMethods } from './method-support.js'
import { d1CloudServiceType, d1AuthorizationToken, schemaCacheKey, usesCloudflareD1Api, usesScopedD1SessionAuth } from './config.js'
import { d1SchemaStatements } from './schema.js'
import { summarizeAccessContext, normalizeEmail, backendErrorMessage, normalizeFutureTimestamp, normalizePositiveInteger, nullablePositiveInteger, nullableNonNegativeInteger, actorAuditId, requireTextValue, uniqueStrings, parseStringArray, normalizeRole, graphMemberCount, countPathScopes, assertSafeGraphPath, hashText, byteLength, parseJson, stringifyJson, stringOrNull, integerOrNull, integerValue, boundedLimit, requireAuthenticatedActor, requireVerifiedEmailActor, requireOwnerClaimActor, isBootstrapOwnerMember, claimedOwnerValue, graphFromRows, codebaseRowToRecord, codebaseRecordFromGraph, fileRowToEntry, normalizeGraph, normalizeFileEntry, normalizeVisibilityContract, normalizeOptionalVisibility, normalizeVisibilityValue, summarizeCodebaseHead, summarizeCodebaseRemoteUpdate, buildStatus, buildSyncHealth, buildRefreshHealth, mapD1AgentEvent, latestEventOf, applyJournalEntryToCloud, hasCapability, visibilityContextForGraph, filterVisibleGraphForRequester, filterVisibleGraphForAccess, canRequesterSeePath, canRead, canWrite, permissionsForRole, accessContextForCodebaseHead, memberSelectSql, mapD1Member, mapD1Invitation, invitationRole, invitationStatusOrNull, isInvitationExpired, invitationStatusForRead, hashInvitationToken, createAgentSessionId, createAgentSessionToken, hashAgentSessionToken, normalizeAgentSessionId, assertReusableAgentSession, normalizeAgentSessionCapabilities, agentSessionStatusOrNull, agentSessionHasCapability, codebaseCapabilityForAgentCapability, agentCapabilityForCodebaseCapability, isExpiredTimestamp, summarizeAgentSession, normalizeKeyEntityId, assertDevicePublicKeyDescriptor, looksLikePem, assertSameDevicePublicKeys, assertSameCodebaseKeyring, wrappedKeyType, wrappedKeyRecipientType, capabilityForWrappedKey, isPrivateZoneId, assertWrappedKeyEnvelope, assertSameWrappedKey, effectiveWrappedKeyStatus, canActorReadWrappedKey, createWrappedKeyId, summarizeDeviceKey, summarizeUserKeyring, summarizeCodebaseKeyring, summarizeWrappedKey, deviceKeyStatusOrNull, keyRotationState, mapD1Issue, mapD1IssueComment, mapD1Discussion, mapD1DiscussionComment, mapD1Release, mapD1ReleaseAsset, mapD1ReviewThread, mapD1ReviewThreadComment, mapD1ReviewDecision, mapD1Notification, mapD1Project, mapD1ProjectItem, issuePriorityOrNull, issueStatus, discussionCategory, discussionStatus, releaseStatus, releaseAssetKind, reviewDecision, notificationKind, reviewDecisionTitle, reviewDecisionBody, reviewHref, workItemHref, projectStatus, normalizeProjectColumns, normalizeProjectColumnId, normalizeProjectPosition, projectItemType, normalizeReleaseTarget, collaborationScope, actionCommandForKind, summarizeActionJob, actionSummary, capOutput } from './helpers/index.js'

/** @typedef {import('@hopit/core').CloudGraph} CloudGraph */
/** @typedef {import('@hopit/core').AgentSession} AgentSession */

export function attachClientMethods(Backend) {
  defineBackendMethods(Backend, {
  async query(sql, params = []) {
    this.assertConfigured()
    const authToken = d1AuthorizationToken(this.config)
    const response = await fetch(this.queryUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        'X-HopIt-Codebase-Id': this.codebaseId ?? this.config.codebaseId ?? '',
      },
      body: JSON.stringify({ sql, params }),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok || body?.success === false) {
      const reason = body?.errors?.map((error) => error.message).join('; ') || response.statusText
      throw new Error(`D1 query failed: ${reason}`)
    }
    const result = Array.isArray(body?.result) ? body.result[0] : body?.result
    if (result?.success === false) {
      const reason = result?.error ?? result?.meta?.error ?? 'statement failed'
      throw new Error(`D1 statement failed: ${reason}`)
    }
    return Array.isArray(result?.results) ? result.results : []
  },

  async first(sql, params = []) {
    const rows = await this.query(sql, params)
    return rows[0] ?? null
  },

  queryUrl() {
    const base = this.config.apiBaseUrl.replace(/\/+$/, '')
    if (!usesCloudflareD1Api(this.config) && (!this.config.accountId || !this.config.databaseId)) {
      return `${base}/query`
    }
    return `${base}/accounts/${encodeURIComponent(this.config.accountId)}/d1/database/${encodeURIComponent(this.config.databaseId)}/query`
  },

  assertConfigured() {
    const missing = []
    if (usesCloudflareD1Api(this.config)) {
      if (!this.config.accountId) missing.push('HOPIT_D1_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID')
      if (!this.config.databaseId) missing.push('HOPIT_D1_DATABASE_ID')
      if (!this.config.apiToken) missing.push('HOPIT_D1_API_TOKEN or CLOUDFLARE_API_TOKEN')
    } else if (!d1AuthorizationToken(this.config)) {
      missing.push('HOPIT_D1_API_TOKEN, CLOUDFLARE_API_TOKEN, or HOPIT_AGENT_SESSION_TOKEN')
    }
    if (missing.length > 0) {
      throw new Error(`Cloudflare D1 is not configured. Missing: ${missing.join(', ')}.`)
    }
  },
  })
}

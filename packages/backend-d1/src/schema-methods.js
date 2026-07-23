import { randomBytes, randomUUID } from 'node:crypto'
import { privacyZoneForPath, privacyZoneIdForPath, scopeForPath } from '@hopit/core/privacy-zone'
import { defineBackendMethods } from './method-support.js'
import { d1CloudServiceType, d1AuthorizationToken, schemaCacheKey, usesCloudflareD1Api, usesScopedD1SessionAuth } from './config.js'
import { d1SchemaStatements } from './schema.js'
import { summarizeAccessContext, normalizeEmail, backendErrorMessage, normalizeFutureTimestamp, normalizePositiveInteger, nullablePositiveInteger, nullableNonNegativeInteger, actorAuditId, requireTextValue, uniqueStrings, parseStringArray, normalizeRole, graphMemberCount, countPathScopes, assertSafeGraphPath, hashText, byteLength, parseJson, stringifyJson, stringOrNull, integerOrNull, integerValue, boundedLimit, requireAuthenticatedActor, requireVerifiedEmailActor, requireOwnerClaimActor, isBootstrapOwnerMember, claimedOwnerValue, graphFromRows, codebaseRowToRecord, codebaseRecordFromGraph, fileRowToEntry, normalizeGraph, normalizeFileEntry, normalizeVisibilityContract, normalizeOptionalVisibility, normalizeVisibilityValue, summarizeCodebaseHead, summarizeCodebaseRemoteUpdate, buildStatus, buildSyncHealth, buildRefreshHealth, mapD1AgentEvent, latestEventOf, applyJournalEntryToCloud, hasCapability, visibilityContextForGraph, filterVisibleGraphForRequester, filterVisibleGraphForAccess, canRequesterSeePath, canRead, canWrite, permissionsForRole, accessContextForCodebaseHead, memberSelectSql, mapD1Member, mapD1Invitation, invitationRole, invitationStatusOrNull, isInvitationExpired, invitationStatusForRead, hashInvitationToken, createAgentSessionId, createAgentSessionToken, hashAgentSessionToken, normalizeAgentSessionId, assertReusableAgentSession, normalizeAgentSessionCapabilities, agentSessionStatusOrNull, agentSessionHasCapability, codebaseCapabilityForAgentCapability, agentCapabilityForCodebaseCapability, isExpiredTimestamp, summarizeAgentSession, normalizeKeyEntityId, assertDevicePublicKeyDescriptor, looksLikePem, assertSameDevicePublicKeys, assertSameCodebaseKeyring, wrappedKeyType, wrappedKeyRecipientType, capabilityForWrappedKey, isPrivateZoneId, assertWrappedKeyEnvelope, assertSameWrappedKey, effectiveWrappedKeyStatus, canActorReadWrappedKey, createWrappedKeyId, summarizeDeviceKey, summarizeUserKeyring, summarizeCodebaseKeyring, summarizeWrappedKey, deviceKeyStatusOrNull, keyRotationState, mapD1ReviewThread, mapD1ReviewThreadComment, mapD1ReviewDecision, mapD1Notification, reviewDecision, notificationKind, reviewDecisionTitle, reviewDecisionBody, reviewHref, actionCommandForKind, summarizeActionJob, actionSummary, capOutput } from './helpers/index.js'

/** @typedef {import('@hopit/core').CloudGraph} CloudGraph */
/** @typedef {import('@hopit/core').AgentSession} AgentSession */

const ensuredSchemaKeys = new Set()

export function attachSchemaMethods(Backend) {
  defineBackendMethods(Backend, {
  async ensureSchema() {
    if (this.schemaEnsured) return
    if (this.config.assumeSchema) {
      this.schemaEnsured = true
      return
    }
    if (usesScopedD1SessionAuth(this.config)) {
      this.schemaEnsured = true
      return
    }
    const cacheKey = schemaCacheKey(this.config)
    if (ensuredSchemaKeys.has(cacheKey)) {
      this.schemaEnsured = true
      return
    }
    for (const sql of d1SchemaStatements) {
      try {
        await this.query(sql)
      } catch (error) {
        // Idempotent `alter table ... add column` migrations throw once the
        // column already exists (or on a fresh table that already declares it).
        if (/duplicate column name/i.test(error?.message ?? '')) continue
        throw error
      }
    }
    ensuredSchemaKeys.add(cacheKey)
    this.schemaEnsured = true
  },
  })
}

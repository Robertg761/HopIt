import { randomBytes, randomUUID } from 'node:crypto'
import { privacyZoneForPath, privacyZoneIdForPath, scopeForPath } from '@hopit/core/privacy-zone'
import { defineBackendMethods } from './method-support.js'
import { d1CloudServiceType, d1AuthorizationToken, schemaCacheKey, usesCloudflareD1Api, usesScopedD1SessionAuth } from './config.js'
import { d1SchemaStatements } from './schema.js'
import { QuotaExceededError, assertSeatAvailable, assertSubscriptionActive, computeUsageStatus, normalizePlan, resolveCodebaseLimit, resolvePlanLimits, utcDay, warnRatioFromEnv } from './quota.js'
import { attachTextDiff, buildFileVersionRowForEntry, buildFileVersionRows, compareVersionRows, createCompareBlobReader, retainedBlobKeysForVersions } from './history.js'
import { summarizeAccessContext, normalizeEmail, normalizeCodebaseName, normalizeNewCodebaseId, backendErrorMessage, normalizeFutureTimestamp, normalizePositiveInteger, nullablePositiveInteger, nullableNonNegativeInteger, actorAuditId, requireTextValue, uniqueStrings, parseStringArray, normalizeRole, graphMemberCount, countPathScopes, assertSafeGraphPath, hashText, byteLength, parseJson, stringifyJson, stringOrNull, integerOrNull, integerValue, boundedLimit, requireAuthenticatedActor, requireVerifiedEmailActor, requireOwnerClaimActor, isBootstrapOwnerMember, claimedOwnerValue, graphFromRows, codebaseRowToRecord, codebaseRecordFromGraph, fileRowToEntry, normalizeGraph, normalizeFileEntry, normalizeVisibilityContract, normalizeOptionalVisibility, normalizeVisibilityValue, summarizeCodebaseHead, summarizeCodebaseRemoteUpdate, buildStatus, buildSyncHealth, buildRefreshHealth, mapD1AgentEvent, latestEventOf, applyJournalEntryToCloud, slugifyCodebaseId, hasCapability, visibilityContextForGraph, filterVisibleGraphForRequester, filterVisibleGraphForAccess, canRequesterSeePath, canRead, canWrite, permissionsForRole, accessContextForCodebaseHead, memberSelectSql, mapD1Member, mapD1Invitation, invitationRole, invitationStatusOrNull, isInvitationExpired, invitationStatusForRead, hashInvitationToken, createAgentSessionId, createAgentSessionToken, hashAgentSessionToken, normalizeAgentSessionId, assertReusableAgentSession, normalizeAgentSessionCapabilities, agentSessionStatusOrNull, agentSessionHasCapability, codebaseCapabilityForAgentCapability, agentCapabilityForCodebaseCapability, isExpiredTimestamp, summarizeAgentSession, normalizeKeyEntityId, assertDevicePublicKeyDescriptor, looksLikePem, assertSameDevicePublicKeys, assertSameCodebaseKeyring, wrappedKeyType, wrappedKeyRecipientType, capabilityForWrappedKey, isPrivateZoneId, assertWrappedKeyEnvelope, assertSameWrappedKey, effectiveWrappedKeyStatus, canActorReadWrappedKey, createWrappedKeyId, summarizeDeviceKey, summarizeUserKeyring, summarizeCodebaseKeyring, summarizeWrappedKey, deviceKeyStatusOrNull, keyRotationState, mapD1Issue, mapD1IssueComment, mapD1Discussion, mapD1DiscussionComment, mapD1Release, mapD1ReleaseAsset, mapD1ReviewThread, mapD1ReviewThreadComment, mapD1ReviewDecision, mapD1Notification, mapD1Project, mapD1ProjectItem, issuePriorityOrNull, issueStatus, discussionCategory, discussionStatus, releaseStatus, releaseAssetKind, reviewDecision, notificationKind, reviewDecisionTitle, reviewDecisionBody, reviewHref, workItemHref, projectStatus, normalizeProjectColumns, normalizeProjectColumnId, normalizeProjectPosition, projectItemType, normalizeReleaseTarget, collaborationScope, actionCommandForKind, summarizeActionJob, actionSummary, capOutput } from './helpers/index.js'

/** @typedef {import('@hopit/core').CloudGraph} CloudGraph */
/** @typedef {import('@hopit/core').AgentSession} AgentSession */

// Cloudflare D1 rejects statements with more than 100 bound variables
// (SQLITE_MAX_VARIABLE_NUMBER=100), unlike stock SQLite's 999.
const maxNotInBoundPaths = 90
const defaultJournalCommitChunkSize = 40

function allocateCodebaseId(name) {
  // Codebase ids are global D1 tenant keys. Keep the human-readable name while
  // adding a full UUID so two accounts can safely choose the same common name.
  const slug = slugifyCodebaseId(name).slice(0, 44)
  return normalizeNewCodebaseId(`${slug}-${randomUUID()}`)
}

export function attachGraphMethods(Backend) {
  defineBackendMethods(Backend, {
  async exists(codebaseId = this.codebaseId) {
    return Boolean(await this.readGraphHead(codebaseId))
  },

  async initialize(graph) {
    await this.ensureSchema()
    const normalized = normalizeGraph(graph)
    this.codebaseId = normalized.codebase.id
    this.location = `d1:${this.config.databaseId}:${this.codebaseId}`
    await this.writeGraph(normalized)
    return normalized
  },

  async readGraphHead(codebaseId = this.codebaseId) {
    if (!codebaseId) return null
    await this.ensureSchema()
    const row = await this.first(
      `select * from codebases where codebase_id = ? limit 1`,
      [codebaseId],
    )
    if (!row) return null
    return summarizeCodebaseHead(codebaseRowToRecord(row))
  },

  async readGraph(codebaseId = this.codebaseId) {
    const graph = await this.readOptionalGraph(codebaseId)
    if (!graph) throw new Error(`D1 graph not found for codebase ${codebaseId ?? '(unset)'}.`)
    return graph
  },

  async readOptionalGraph(codebaseId = this.codebaseId) {
    if (!codebaseId) return null
    await this.ensureSchema()
    const codebaseRow = await this.first(
      `select * from codebases where codebase_id = ? limit 1`,
      [codebaseId],
    )
    if (!codebaseRow) return null

    const fileRows = await this.query(
      `select * from files where codebase_id = ? order by path asc`,
      [codebaseId],
    )
    return normalizeGraph(graphFromRows(codebaseRow, fileRows))
  },

  async writeGraph(graph, options = {}) {
    await this.ensureSchema()
    const normalized = normalizeGraph(graph)
    const codebaseId = normalized.codebase.id
    const beforeGraph = await this.readOptionalGraph(codebaseId)
    this.codebaseId = codebaseId
    this.location = `d1:${this.config.databaseId}:${codebaseId}`
    const now = options.now ?? new Date().toISOString()
    const files = Object.entries(normalized.files ?? {})
    const fileCount = files.length
    const privateFileCount = files.filter(([filePath]) => scopeForPath(filePath) === 'owner-private').length

    await this.query(
      `insert into codebases (
        codebase_id, name, owner_id, schema_version, revision, main_json,
        selected_state_json, owner_json, collaborators_json, session_json,
        visibility_json, file_count, private_file_count, member_count, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(codebase_id) do update set
        name = excluded.name,
        owner_id = excluded.owner_id,
        schema_version = excluded.schema_version,
        revision = excluded.revision,
        main_json = excluded.main_json,
        selected_state_json = excluded.selected_state_json,
        owner_json = excluded.owner_json,
        collaborators_json = excluded.collaborators_json,
        session_json = excluded.session_json,
        visibility_json = excluded.visibility_json,
        file_count = excluded.file_count,
        private_file_count = excluded.private_file_count,
        member_count = excluded.member_count,
        updated_at = excluded.updated_at`,
      [
        codebaseId,
        normalized.codebase.name,
        normalized.codebase.ownerId,
        normalized.schemaVersion,
        normalized.revision,
        stringifyJson(normalized.main),
        stringifyJson(normalized.selectedState),
        stringifyJson(normalized.owner),
        stringifyJson(normalized.collaborators),
        stringifyJson(normalized.session),
        stringifyJson(normalized.visibility),
        fileCount,
        privateFileCount,
        graphMemberCount(normalized),
        now,
      ],
    )
    await this.ensureGraphMembers(normalized, now)

    const seenPaths = []
    for (const [filePath, file] of files) {
      seenPaths.push(filePath)
      await this.upsertFile(codebaseId, filePath, file, normalized.revision, now)
    }

    if (seenPaths.length === 0) {
      await this.query(`delete from files where codebase_id = ?`, [codebaseId])
    } else if (seenPaths.length <= maxNotInBoundPaths) {
      await this.query(
        `delete from files where codebase_id = ? and path not in (${seenPaths.map(() => '?').join(', ')})`,
        [codebaseId, ...seenPaths],
      )
    } else {
      // Chunking a NOT IN list would delete paths carried by the other chunks,
      // so larger graphs diff against the existing rows and delete only stale paths.
      const existingRows = await this.query(`select path from files where codebase_id = ?`, [codebaseId])
      const incoming = new Set(seenPaths)
      for (const row of existingRows) {
        if (!incoming.has(row.path)) {
          await this.query(`delete from files where codebase_id = ? and path = ?`, [codebaseId, row.path])
        }
      }
    }

    const versionRows = buildFileVersionRows({
      beforeGraph,
      afterGraph: normalized,
      createdAt: now,
      actor: options.actor ?? {},
    })
    for (const row of versionRows) {
      await this.insertFileVersion(row)
    }

    return { ok: true, codebaseId, revision: normalized.revision, fileCount }
  },

  async insertFileVersion(row) {
    await this.query(...insertFileVersionStatement(row))
  },

  async listFileVersions(codebaseId = this.codebaseId) {
    if (!codebaseId) return []
    await this.ensureSchema()
    const rows = await this.query(
      `select * from file_versions where codebase_id = ? order by graph_revision asc, version_id asc`,
      [codebaseId],
    )
    return rows.map(mapD1FileVersion)
  },

  async retainedBlobKeysForFileVersions(codebaseId = this.codebaseId) {
    return retainedBlobKeysForVersions(await this.listFileVersions(codebaseId))
  },

  async compareRevisions(leftRevision, rightRevision, requester = {}) {
    const codebaseId = requester.codebaseId ?? this.codebaseId
    const graph = await this.readGraph(codebaseId)
    const access = await this.readAccessContext(graph, {
      userId: requester.requesterId ?? requester.userId,
      sessionId: requester.sessionId,
    })
    if (!canRead(access)) throw new Error(`User cannot read ${codebaseId}.`)
    const versions = await this.listFileVersions(codebaseId)
    const result = compareVersionRows(versions, leftRevision, rightRevision, {
      canSeePath: (filePath) => canRequesterSeePath(access, filePath),
    })
    if (!result.ok) return result

    const diffPath = requester.path ?? requester.filePath ?? requester.diffPath ?? null
    if (diffPath) {
      const blobReader = createCompareBlobReader({
        readBlob: typeof this.readBlob === 'function' ? (file) => this.readBlob(file, requester) : null,
        readInlineBlob: (file) => this.readFileBlob(codebaseId, file),
      })
      await attachTextDiff(result, diffPath, blobReader.readFileBody)
      result.bodyFetches = blobReader.stats.fetches
      result.blobCacheHits = blobReader.stats.cacheHits
    }
    return result
  },

  async readFileBlob(codebaseId, file) {
    const hash = stringOrNull(file?.blobHash) ?? stringOrNull(file?.hash)
    if (!hash) return null
    const row = await this.first(
      `select content, encoding, size from file_blobs where codebase_id = ? and hash = ? limit 1`,
      [codebaseId, hash],
    )
    return row ? { content: row.content ?? '', encoding: row.encoding ?? 'utf8', size: row.size ?? null } : null
  },

  async ensureGraphMembers(graph, now = new Date().toISOString()) {
    const codebaseId = graph.codebase.id
    const ownerId = stringOrNull(graph.owner?.id) ?? stringOrNull(graph.codebase?.ownerId)
    if (ownerId) {
      await this.insertMemberIfMissing({
        codebaseId,
        userId: ownerId,
        role: 'owner',
        status: 'active',
        source: 'graph-owner',
        joinedAt: stringOrNull(graph.owner?.joinedAt) ?? now,
        createdAt: now,
        updatedAt: now,
      })
    }
    for (const collaborator of graph.collaborators ?? []) {
      const userId = stringOrNull(collaborator?.id) ?? stringOrNull(collaborator?.userId)
      if (!userId) continue
      await this.insertMemberIfMissing({
        codebaseId,
        userId,
        role: normalizeRole(collaborator?.role),
        status: collaborator?.status === 'suspended' ? 'suspended' : 'active',
        source: 'graph-collaborator',
        joinedAt: stringOrNull(collaborator?.joinedAt) ?? now,
        createdAt: now,
        updatedAt: now,
      })
    }
  },

  async insertMemberIfMissing(member) {
    const existing = await this.first(
      `select user_id from codebase_members where codebase_id = ? and user_id = ? limit 1`,
      [member.codebaseId, member.userId],
    )
    if (existing) return
    await this.upsertMember(member)
  },

  applyJournalEntry(cloud, entry, options = {}) {
    assertWritableSelectedState(cloud, entry)
    const main = cloud.main ? structuredClone(cloud.main) : null
    const acknowledgement = applyJournalEntryToCloud(cloud, entry, options)

    // Journaled writes belong to the selected active change set. Main is an
    // accepted snapshot and must only move through the explicit merge flow.
    if (main) cloud.main = main

    return {
      id: entry.id,
      ...acknowledgement,
      selectedStateType: cloud.selectedState?.type ?? null,
      selectedStateId: cloud.selectedState?.id ?? null,
      selectedStateRevision: cloud.selectedState?.revision ?? null,
    }
  },

  async commitJournalEntry(cloud, entry, options = {}) {
    await this.ensureSchema()
    const previousRevision = integerOrNull(cloud?.revision) ?? 0
    const previousSelectedState = structuredClone(cloud?.selectedState ?? {})
    const previousMain = structuredClone(cloud?.main ?? {})
    const previousFile = cloneFileEntry(cloud?.files?.[entry.path] ?? null)
    // A failed compare-and-swap must not leak its speculative mutation back to
    // recovery code. Recovery records conflicts on the caller's graph and may
    // persist that graph, so only publish the working copy after D1 confirms
    // the guarded batch committed.
    const workingCloud = structuredClone(cloud)
    const acknowledgement = this.applyJournalEntry(workingCloud, entry, options)
    const normalized = normalizeGraph(workingCloud)
    const codebaseId = normalized.codebase.id
    const now = options.now ?? new Date().toISOString()
    const nextRevision = integerOrNull(normalized.revision) ?? previousRevision
    const files = Object.entries(normalized.files ?? {})
    const fileCount = files.length
    const privateFileCount = files.filter(([filePath]) => scopeForPath(filePath) === 'owner-private').length
    this.codebaseId = codebaseId
    this.location = `d1:${this.config.databaseId}:${codebaseId}`

    const guard = { codebaseId, revision: nextRevision, updatedAt: mutationGuardTimestamp(now) }
    const headStatement = [
      `update codebases set
        revision = ?,
        selected_state_json = ?,
        main_json = ?,
        file_count = ?,
        private_file_count = ?,
        updated_at = ?
      where codebase_id = ? and revision = ?
        and selected_state_json = ? and main_json = ?`,
      [
        nextRevision,
        stringifyJson(normalized.selectedState),
        stringifyJson(normalized.main),
        fileCount,
        privateFileCount,
        guard.updatedAt,
        codebaseId,
        previousRevision,
        stringifyJson(previousSelectedState),
        stringifyJson(previousMain),
      ],
    ]

    const actor = journalActor(entry, normalized)
    const versionRow = buildFileVersionRowForEntry({
      afterGraph: normalized,
      entry,
      beforeFile: previousFile,
      afterFile: normalized.files?.[entry.path] ?? null,
      createdAt: now,
      actor,
    })
    const statements = [
      headStatement,
      entry.type === 'delete'
        ? guardedDeleteFileStatement(codebaseId, entry.path, guard)
        : upsertFileStatement(codebaseId, entry.path, normalized.files[entry.path], nextRevision, now, guard),
    ]
    if (versionRow) statements.push(insertFileVersionStatement(versionRow, guard))
    if (options.event) {
      statements.push(guardedAgentEventStatement({
        codebaseId,
        event: options.event.event,
        detail: {
          ...(options.event.detail ?? {}),
          revision: acknowledgement.revision,
          selectedStateId: acknowledgement.selectedStateId,
          selectedStateRevision: acknowledgement.selectedStateRevision,
        },
        at: options.event.at ?? now,
        source: options.event.source ?? 'local-agent',
      }, guard))
    }
    const results = await this.queryBatch(statements.map(([sql, params]) => ({ sql, params })))
    const changedRows = changedRowCount(results[0])
    if (changedRows === 0) {
      const currentHead = await this.readGraphHead(codebaseId).catch(() => null)
      throw createSelectedStateRevisionConflict(options.ConflictError, {
        entry,
        cloud: currentHead ?? cloud,
        expectedRevision: previousRevision,
      })
    }
    if (!Number.isInteger(changedRows)) {
      throw new Error('D1 guarded journal commit did not report changed rows.')
    }

    replaceGraphContents(cloud, normalized)

    return {
      ...acknowledgement,
      storageMode: 'd1-file-mutation',
    }
  },

  async commitJournalEntries(cloud, entries, options = {}) {
    await this.ensureSchema()
    const pendingEntries = Array.isArray(entries) ? entries : []
    if (pendingEntries.length === 0) return []

    const chunkSize = journalCommitChunkSize(options.chunkSize)
    const acknowledgements = []
    for (let offset = 0; offset < pendingEntries.length; offset += chunkSize) {
      const chunkEntries = pendingEntries.slice(offset, offset + chunkSize)
      const chunk = await commitJournalEntryChunk(this, cloud, chunkEntries, {
        ...options,
        chunkIndex: Math.floor(offset / chunkSize),
        chunkOffset: offset,
      })
      acknowledgements.push(...chunk.acknowledgements)
      if (typeof options.onChunkCommitted === 'function') {
        await options.onChunkCommitted(chunk)
      }
    }
    return acknowledgements
  },

  async appendEvent({ codebaseId = this.codebaseId, event, detail, at = new Date().toISOString(), source = 'local-agent' }) {
    if (!codebaseId || !event) return
    await this.ensureSchema()
    await this.query(
      `insert into agent_events (codebase_id, event, detail_json, at, source) values (?, ?, ?, ?, ?)`,
      [codebaseId, event, stringifyJson(detail ?? {}), at, source],
    )
  },

  async readDashboard({ codebaseId = this.codebaseId, requesterUserId = null, requesterSessionId = null } = {}) {
    const graph = await this.readOptionalGraph(codebaseId)
    if (!graph) {
      return {
        status: null,
        events: { recent: [], lastAcknowledgement: null, lastSync: null },
        cloud: { graph: null },
        error: {
          code: 'd1_graph_not_found',
          message: `No HopIt codebase graph exists in D1 for ${codebaseId}.`,
        },
      }
    }

    const access = await this.readAccessContext(graph, {
      userId: requesterUserId,
      sessionId: requesterSessionId,
    })
    const visibleGraph = filterVisibleGraphForAccess(graph, access)
    const visibleAccess = visibleGraph.visibilityContext
    const recentRows = await this.query(
      `select id, event, detail_json, at, source from agent_events where codebase_id = ? order by at desc, id desc limit 20`,
      [codebaseId],
    )
    const recent = recentRows.reverse().map(mapD1AgentEvent)
    const eventNames = [
      'cloud.acknowledged',
      'sync.complete',
      'sync.started',
      'sync.failed',
      'sync.recovered',
      'refresh.started',
      'refresh.blocked',
      'refresh.complete',
      'remote-update',
    ]
    const latest = {}
    for (const eventName of eventNames) {
      latest[eventName] = await this.readLatestEvent(codebaseId, eventName)
    }
    const events = {
      recent,
      lastAcknowledgement: latest['cloud.acknowledged'],
      lastSync: latest['sync.complete'],
      lastStartedSync: latest['sync.started'],
      lastFailedSync: latest['sync.failed'],
      lastRecoveredSync: latest['sync.recovered'],
      latestSyncEvent: latestEventOf([
        latest['sync.started'],
        latest['sync.complete'],
        latest['sync.failed'],
        latest['sync.recovered'],
      ]),
      lastRefreshStarted: latest['refresh.started'],
      lastRefreshBlocked: latest['refresh.blocked'],
      lastRefreshComplete: latest['refresh.complete'],
      latestRefreshEvent: latestEventOf([
        latest['refresh.started'],
        latest['refresh.blocked'],
        latest['refresh.complete'],
      ]),
      lastRemoteUpdate: latest['remote-update'],
      totalEntries: recentRows.length,
    }

    return {
      status: buildStatus(visibleGraph, events, access, {
        service: d1CloudServiceType,
        path: `d1:${codebaseId}`,
        sourceOfTruth: 'd1',
      }),
      events,
      cloud: {
        path: `d1:${codebaseId}`,
        service: d1CloudServiceType,
        exists: true,
        graph: visibleGraph,
        access: summarizeAccessContext(visibleAccess),
      },
    }
  },

  async readLatestEvent(codebaseId, eventName) {
    const row = await this.first(
      `select id, event, detail_json, at, source from agent_events
       where codebase_id = ? and event = ?
       order by at desc, id desc limit 1`,
      [codebaseId, eventName],
    )
    return row ? mapD1AgentEvent(row) : null
  },

  async listCodebases(actor = {}) {
    await this.ensureSchema()
    if (usesScopedD1SessionAuth(this.config)) return await this.listConfiguredCodebase(actor)

    const actorId = stringOrNull(actor.userId)
    const rows = actorId
      ? await this.query(
          `select distinct c.* from codebases c
           left join codebase_members m on m.codebase_id = c.codebase_id
           where c.owner_id = ? or (m.user_id = ? and m.status = 'active')
           order by c.updated_at desc`,
          [actorId, actorId],
        )
      : await this.query(`select * from codebases order by updated_at desc`)

    const summaries = []
    for (const row of rows) {
      const record = codebaseRowToRecord(row)
      summaries.push(summarizeCodebaseHead(record, await this.readCodebaseHeadAccess(record, actor)))
    }
    return summaries
  },

  async listConfiguredCodebase(actor = {}) {
    const codebaseId = this.codebaseId ?? this.config.codebaseId
    if (!codebaseId) return []

    let requester = actor
    if (!stringOrNull(requester.userId) && this.config.agentSessionToken) {
      const sessionAccess = await this.requireD1AgentAccess(codebaseId, {}, 'read')
      requester = {
        userId: sessionAccess.userId,
        sessionId: sessionAccess.session?.session_id,
      }
    }

    const graph = await this.readVisibleGraph({
      userId: stringOrNull(requester.userId),
      sessionId: stringOrNull(requester.sessionId),
    }, codebaseId)
    return [summarizeCodebaseHead(codebaseRecordFromGraph(graph, null), graph.visibilityContext)]
  },

  async readCodebaseHeadAccess(record, actor = {}) {
    const actorId = stringOrNull(actor.userId)
    const membership = actorId
      ? await this.first(
          `select * from codebase_members where codebase_id = ? and user_id = ? limit 1`,
          [record.codebaseId, actorId],
        )
      : null
    const context = visibilityContextForGraph({
      codebase: {
        id: record.codebaseId,
        ownerId: record.ownerId,
      },
      owner: record.owner ?? (record.ownerId ? { id: record.ownerId } : null),
      collaborators: record.collaborators ?? [],
      visibility: record.visibility,
      selectedState: record.selectedState,
      files: {},
    }, {
      requesterId: actorId,
      sessionId: stringOrNull(actor.sessionId),
      membership,
    })
    return accessContextForCodebaseHead(record, context)
  },

  async upsertUser(user) {
    await this.ensureSchema()
    const now = new Date().toISOString()
    const userId = stringOrNull(user.userId)
    if (!userId) throw new Error('User id is required.')
    await this.query(
      `insert into users (
        user_id, primary_email, display_name, avatar_url, email_verified, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?)
      on conflict(user_id) do update set
        primary_email = excluded.primary_email,
        display_name = excluded.display_name,
        avatar_url = excluded.avatar_url,
        email_verified = excluded.email_verified,
        updated_at = excluded.updated_at`,
      [
        userId,
        stringOrNull(user.primaryEmail),
        stringOrNull(user.displayName),
        stringOrNull(user.avatarUrl),
        user.emailVerified ? 1 : 0,
        now,
        now,
      ],
    )
    const row = await this.first(`select * from users where user_id = ?`, [userId])
    return {
      userId: row.user_id,
      primaryEmail: row.primary_email ?? null,
      displayName: row.display_name ?? null,
      avatarUrl: row.avatar_url ?? null,
      currentAuthEmailVerified: row.email_verified === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  },

  // Resolve the tenant's plan (v1 tenant == owner user). A single indexed read;
  // absence of a row means the free plan (the no-card default).
  async readTenantPlan(tenantId) {
    if (!stringOrNull(tenantId)) return 'free'
    const row = await this.first('select plan from tenant_usage where tenant_id = ? limit 1', [tenantId])
    return normalizePlan(row?.plan)
  },

  async countCodebasesForOwner(ownerId) {
    if (!stringOrNull(ownerId)) return 0
    const row = await this.first('select count(*) as n from codebases where owner_id = ? limit 1', [ownerId])
    return Number(row?.n ?? 0)
  },

  async assertCodebaseCreationWithinQuota(ownerId) {
    // Flag off, or the single-operator local-owner sentinel => no gate (byte-for-
    // byte legacy behavior). Only real, authenticated tenants are metered.
    if (!this.config.multiTenant || !stringOrNull(ownerId) || ownerId === 'local-owner') return
    const env = typeof process !== 'undefined' && process.env ? process.env : {}
    const plan = await this.readTenantPlan(ownerId)
    // Subscription/seat gates are always-allow stubs for this stage.
    assertSubscriptionActive({ plan })
    assertSeatAvailable({ plan })
    const limit = resolveCodebaseLimit(env, plan)
    if (!(limit > 0)) return
    const count = await this.countCodebasesForOwner(ownerId)
    if (count >= limit) {
      throw new QuotaExceededError(
        `Codebase limit reached for the ${plan} plan (${count}/${limit}). Upgrade to add more codebases.`,
        { code: 'quota_exceeded_codebases', kind: 'codebases', limit, used: count, plan },
      )
    }
  },

  // Per-tenant usage + limits + warn/block state for the dashboard status surface
  // (Plane A). Read-only; display-only. The Worker is the authoritative
  // enforcement point. Returns the free-tier shape even before a meter row exists.
  async readTenantUsage({ tenantId, actor = {} } = {}) {
    await this.ensureSchema()
    const resolvedTenantId = stringOrNull(tenantId) ?? stringOrNull(actor.userId)
    if (!resolvedTenantId) return null
    const env = typeof process !== 'undefined' && process.env ? process.env : {}
    const usage = await this.first(
      'select tenant_id, plan, storage_bytes, write_day, rows_written_today from tenant_usage where tenant_id = ? limit 1',
      [resolvedTenantId],
    )
    const limits = resolvePlanLimits(env, usage?.plan ?? 'free')
    const codebaseCount = await this.countCodebasesForOwner(resolvedTenantId)
    return computeUsageStatus({
      usage,
      limits,
      warnRatio: warnRatioFromEnv(env),
      day: utcDay(),
      codebaseCount,
    })
  },

  async createCodebase({ name, codebaseId, description, actor = {} }) {
    await this.ensureSchema()
    const now = new Date().toISOString()
    const normalizedName = normalizeCodebaseName(name)
    const id = codebaseId === undefined || codebaseId === null
      ? allocateCodebaseId(normalizedName)
      : normalizeNewCodebaseId(codebaseId)
    if (await this.readOptionalGraph(id)) throw new Error(`Codebase ${id} already exists.`)
    const ownerId = stringOrNull(actor.userId) ?? 'local-owner'
    // Plane-A quota gate (Phase 3 Stage 3): with multi-tenancy on, enforce the
    // plan's codebase-count cap (free = 1) at create time. Codebase count is
    // computed on read here (a cold path), not maintained. Seat/subscription
    // gates are stubbed to always-allow until billing lands (Stage 5) but are
    // structured so that stage fills them in without touching this call site.
    // Reads/exports are never routed through this gate.
    await this.assertCodebaseCreationWithinQuota(ownerId)
    const ownerEmail = stringOrNull(actor.primaryEmail)
    const ownerName = stringOrNull(actor.displayName) ?? ownerEmail ?? ownerId
    const graph = normalizeGraph({
      schemaVersion: 2,
      codebase: {
        id,
        name: normalizedName,
        ownerId,
        description: stringOrNull(description),
      },
      main: {
        id: 'main',
        revision: 0,
        updatedAt: now,
        mergedChangeSetId: null,
      },
      selectedState: {
        type: 'active-change-set',
        id: `cs_${id}_main`,
        ownerId,
        baseMainId: 'main',
        baseRevision: 0,
        revision: 0,
        visibility: 'private',
        effectiveVisibility: 'private',
        reviewState: 'not-open',
        mergeState: 'unmerged',
        conflictState: 'none',
        conflict: null,
        review: null,
        merge: null,
      },
      owner: {
        id: ownerId,
        userId: ownerId,
        name: ownerName,
        displayName: ownerName,
        email: ownerEmail,
        primaryEmail: ownerEmail,
        role: 'owner',
        status: 'active',
        source: 'owner',
        joinedAt: now,
      },
      collaborators: [],
      session: {
        id: `session_${id}_browser`,
        deviceName: 'Hosted dashboard',
      },
      visibility: {
        productDefault: 'private',
        globalUserDefault: null,
        codebaseOverride: null,
        changeSetOverride: null,
        effective: 'private',
      },
      revision: 0,
      files: {},
    })
    await this.writeGraph(graph, { actor })
    await this.upsertMember({
      codebaseId: id,
      userId: ownerId,
      role: 'owner',
      status: 'active',
      source: 'owner',
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    await this.appendEvent({
      codebaseId: id,
      event: 'codebase.created',
      detail: { name: normalizedName, createdBy: ownerId },
      at: now,
      source: 'browser',
    })
    return summarizeCodebaseHead(codebaseRecordFromGraph(graph, now), visibilityContextForGraph(graph, { requesterId: ownerId }))
  },

  async updateCodebase({ codebaseId, name, visibility, actor = {} }) {
    const graph = await this.readGraph(codebaseId)
    const access = await this.readAccessContext(graph, actor)
    if (!canWrite(access)) throw new Error(`User cannot update ${codebaseId}.`)
    if (name !== undefined) graph.codebase.name = normalizeCodebaseName(name)
    if (visibility !== undefined) {
      const nextVisibility = normalizeVisibilityValue(visibility)
      graph.visibility = {
        ...(graph.visibility ?? {}),
        effective: nextVisibility,
      }
      graph.selectedState = {
        ...(graph.selectedState ?? {}),
        visibility: nextVisibility,
        effectiveVisibility: nextVisibility,
      }
    }
    graph.revision += 1
    graph.main.revision = graph.revision
    await this.writeGraph(graph, { actor })
    await this.appendEvent({
      codebaseId,
      event: 'codebase.updated',
      detail: { updatedBy: actor.userId ?? null, name: graph.codebase.name, visibility: visibility ?? null },
      source: 'browser',
    })
    return summarizeCodebaseHead(codebaseRecordFromGraph(graph, new Date().toISOString()), access)
  },

  async deleteCodebase({ codebaseId, actor = {} }) {
    const graph = await this.readGraph(codebaseId)
    const access = await this.readAccessContext(graph, actor)
    if (!access.isOwner) throw new Error('Only the codebase owner can delete a codebase.')
    await this.query(`delete from files where codebase_id = ?`, [codebaseId])
    await this.query(`delete from file_versions where codebase_id = ?`, [codebaseId])
    await this.query(`delete from file_blobs where codebase_id = ?`, [codebaseId])
    await this.query(`delete from agent_events where codebase_id = ?`, [codebaseId])
    await this.query(`delete from codebase_members where codebase_id = ?`, [codebaseId])
    await this.query(`delete from codebase_invitations where codebase_id = ?`, [codebaseId])
    await this.query(`delete from action_jobs where codebase_id = ?`, [codebaseId])
    await this.query(`delete from collaboration_counters where codebase_id = ?`, [codebaseId])
    await this.query(`delete from issues where codebase_id = ?`, [codebaseId])
    await this.query(`delete from issue_comments where codebase_id = ?`, [codebaseId])
    await this.query(`delete from discussions where codebase_id = ?`, [codebaseId])
    await this.query(`delete from discussion_comments where codebase_id = ?`, [codebaseId])
    await this.query(`delete from releases where codebase_id = ?`, [codebaseId])
    await this.query(`delete from release_assets where codebase_id = ?`, [codebaseId])
    await this.query(`delete from review_thread_comments where codebase_id = ?`, [codebaseId])
    await this.query(`delete from review_threads where codebase_id = ?`, [codebaseId])
    await this.query(`delete from review_decisions where codebase_id = ?`, [codebaseId])
    await this.query(`delete from notifications where codebase_id = ?`, [codebaseId])
    await this.query(`delete from projects where codebase_id = ?`, [codebaseId])
    await this.query(`delete from project_items where codebase_id = ?`, [codebaseId])
    await this.query(`delete from agent_sessions where codebase_id = ?`, [codebaseId])
    await this.query(`delete from codebase_keyrings where codebase_id = ?`, [codebaseId])
    await this.query(`delete from wrapped_keys where codebase_id = ?`, [codebaseId])
    await this.query(`delete from key_audit_events where codebase_id = ?`, [codebaseId])
    await this.query(`delete from codebases where codebase_id = ?`, [codebaseId])
    return { ok: true, codebaseId, deletedBy: actor.userId ?? null }
  },

  async readTextFile({ codebaseId, path, actor = {} }) {
    assertSafeGraphPath(path)
    const graph = await this.readVisibleGraph({ requesterId: actor.userId }, codebaseId)
    const file = graph.files[path]
    if (!file) throw new Error(`File ${path} was not found or is not visible.`)
    if ((file.kind ?? 'file') !== 'file') throw new Error(`File ${path} is not a text file.`)
    if ((file.encoding ?? 'utf8') !== 'utf8') throw new Error(`File ${path} is not UTF-8 text.`)
    if (file.contentStorage === 'object-blob') throw new Error(`File ${path} is object-backed and must be hydrated through the agent.`)
    return {
      path,
      content: file.content ?? '',
      revision: file.revision ?? null,
      hash: file.hash ?? null,
      size: file.size ?? byteLength(file.content ?? ''),
      scope: file.scope ?? scopeForPath(path),
      updatedAt: file.updatedAt ?? null,
      selectedStateId: graph.selectedState?.id ?? null,
      selectedStateRevision: graph.selectedState?.revision ?? null,
    }
  },

  async mutateTextFile({ codebaseId, path, content, baseRevision, selectedStateId, actor = {} }) {
    assertSafeGraphPath(path)
    let expectedFileRevision = baseRevision

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const graph = await this.readGraph(codebaseId)
      const access = await this.readAccessContext(graph, actor)
      if (!canWrite(access)) throw new Error(`User cannot edit ${codebaseId}.`)
      if (!canRequesterSeePath(access, path)) throw new Error(`File ${path} is not visible.`)
      assertWritableSelectedState(graph)
      if (selectedStateId !== undefined && selectedStateId !== graph.selectedState.id) {
        throw new D1FileMutationError(
          'selected_state_id_mismatch',
          `selected_state_id_mismatch: expected ${selectedStateId}, got ${graph.selectedState.id}`,
          {
            expectedId: selectedStateId,
            actualId: graph.selectedState.id,
            selectedStateRevision: graph.selectedState.revision ?? null,
          },
        )
      }

      const existing = graph.files[path] ?? null
      const actualRevision = existing?.revision ?? null
      if (expectedFileRevision === undefined) expectedFileRevision = actualRevision
      if (expectedFileRevision !== actualRevision) {
        throw new D1FileMutationError(
          'base_revision_mismatch',
          `base_revision_mismatch: expected ${expectedFileRevision}, got ${actualRevision}`,
          {
            path,
            expectedRevision: expectedFileRevision,
            actualRevision,
            selectedStateId: graph.selectedState?.id ?? null,
            selectedStateRevision: graph.selectedState?.revision ?? null,
          },
        )
      }
      if (existing?.contentStorage === 'object-blob') {
        throw new D1FileMutationError(
          'object_blob_upload_required',
          `object_blob_upload_required: Browser editing cannot replace object-backed file ${path} until the server can upload its new blob first. Edit it through the HopIt agent instead.`,
          {
            path,
            contentStorage: existing.contentStorage,
            blobProvider: existing.blobProvider ?? null,
            blobKey: existing.blobKey ?? null,
          },
        )
      }

      const now = new Date().toISOString()
      const hash = hashText(content)
      const entry = {
        id: randomUUID(),
        type: existing ? 'write' : 'create',
        path,
        kind: 'file',
        scope: scopeForPath(path),
        privacyZone: privacyZoneForPath(path),
        hash,
        bytes: byteLength(content),
        encoding: 'utf8',
        baseRevision: expectedFileRevision,
        targetStateType: graph.selectedState.type,
        targetStateId: selectedStateId ?? graph.selectedState.id,
        targetStateRevision: graph.selectedState.revision,
        actorUserId: actor.userId ?? null,
        sessionId: actor.sessionId ?? null,
        createdAt: now,
        status: 'pending',
      }

      try {
        const acknowledgement = await this.commitJournalEntry(graph, entry, {
          entry: {
            kind: 'file',
            content,
            encoding: 'utf8',
            contentStorage: 'inline',
            hash,
            size: byteLength(content),
          },
          now,
          event: {
            event: 'file.mutated',
            detail: {
              path,
              updatedBy: actor.userId ?? null,
            },
            at: now,
            source: 'browser',
          },
        })
        return {
          ok: true,
          codebaseId,
          path,
          revision: acknowledgement.revision,
          selectedStateId: acknowledgement.selectedStateId,
          selectedStateRevision: acknowledgement.selectedStateRevision,
          file: graph.files[path],
        }
      } catch (error) {
        if (attempt < 2 && isSelectedStateHeadConflict(error)) continue
        throw error
      }
    }

    throw new Error(`Could not edit ${path} because the selected change set kept moving.`)
  },

  async upsertFile(codebaseId, filePath, file, graphRevision, now = new Date().toISOString()) {
    await this.query(...upsertFileStatement(codebaseId, filePath, file, graphRevision, now))
  },
  })
}

function upsertFileStatement(codebaseId, filePath, file, graphRevision, now = new Date().toISOString(), guard = null) {
  const normalized = normalizeFileEntry(filePath, file, graphRevision, now, codebaseId)
  const params = [
    codebaseId,
    filePath,
    normalized.kind,
    normalized.content,
    normalized.encoding,
    normalized.target ?? null,
    normalized.blobHash ?? normalized.hash ?? null,
    normalized.blobProvider ?? null,
    normalized.blobKey ?? null,
    normalized.blobSize ?? null,
    normalized.clientEncryption ? stringifyJson(normalized.clientEncryption) : null,
    normalized.encryption ? stringifyJson(normalized.encryption) : null,
    normalized.privacyZone ?? privacyZoneForPath(filePath),
    normalized.zoneId ?? privacyZoneIdForPath(codebaseId, filePath),
    normalized.contentStorage ?? 'inline',
    normalized.hash ?? null,
    normalized.size ?? byteLength(normalized.content ?? ''),
    normalized.scope ?? scopeForPath(filePath),
    normalized.revision ?? graphRevision,
    normalized.updatedAt ?? now,
  ]
  return [
    `insert into files (
      codebase_id, path, kind, content, encoding, target, blob_hash, blob_provider,
      blob_key, blob_size, client_encryption_json, encryption_json, privacy_zone,
      zone_id, content_storage, hash, size, scope, revision, updated_at
    ) ${guardedValuesSql(params.length, guard)}
    on conflict(codebase_id, path) do update set
      kind = excluded.kind,
      content = excluded.content,
      encoding = excluded.encoding,
      target = excluded.target,
      blob_hash = excluded.blob_hash,
      blob_provider = excluded.blob_provider,
      blob_key = excluded.blob_key,
      blob_size = excluded.blob_size,
      client_encryption_json = excluded.client_encryption_json,
      encryption_json = excluded.encryption_json,
      privacy_zone = excluded.privacy_zone,
      zone_id = excluded.zone_id,
      content_storage = excluded.content_storage,
      hash = excluded.hash,
      size = excluded.size,
      scope = excluded.scope,
      revision = excluded.revision,
      updated_at = excluded.updated_at`,
    guardedParams(params, guard),
  ]
}

async function commitJournalEntryChunk(backend, cloud, entries, options = {}) {
  const previousRevision = integerOrNull(cloud?.revision) ?? 0
  const previousSelectedState = structuredClone(cloud?.selectedState ?? {})
  const previousMain = structuredClone(cloud?.main ?? {})
  const workingCloud = structuredClone(cloud)
  const now = options.now ?? new Date().toISOString()
  const acknowledgements = []
  const fileStatements = []
  const versionStatements = []

  for (const entry of entries) {
    const previousFile = cloneFileEntry(workingCloud?.files?.[entry.path] ?? null)
    const payload = entryPayloadFor(options, entry)
    const acknowledgement = backend.applyJournalEntry(workingCloud, entry, {
      ...options,
      entry: payload ?? options.entry,
      now,
    })
    const normalizedEntryGraph = normalizeGraph(workingCloud)
    const codebaseId = normalizedEntryGraph.codebase.id
    const actor = journalActor(entry, normalizedEntryGraph)
    const afterFile = cloneFileEntry(normalizedEntryGraph.files?.[entry.path] ?? null)
    const versionRow = buildFileVersionRowForEntry({
      afterGraph: normalizedEntryGraph,
      entry,
      beforeFile: previousFile,
      afterFile,
      createdAt: now,
      actor,
    })

    fileStatements.push(entry.type === 'delete'
      ? { entry, statement: guardedDeleteFileStatement }
      : { entry, file: afterFile, graphRevision: integerOrNull(afterFile?.revision) ?? integerOrNull(normalizedEntryGraph.revision) ?? previousRevision })
    if (versionRow) versionStatements.push(versionRow)
    acknowledgements.push(acknowledgement)
  }

  const normalized = normalizeGraph(workingCloud)
  const codebaseId = normalized.codebase.id
  const nextRevision = integerOrNull(normalized.revision) ?? previousRevision
  const files = Object.entries(normalized.files ?? {})
  const fileCount = files.length
  const privateFileCount = files.filter(([filePath]) => scopeForPath(filePath) === 'owner-private').length
  backend.codebaseId = codebaseId
  backend.location = `d1:${backend.config.databaseId}:${codebaseId}`

  const guard = { codebaseId, revision: nextRevision, updatedAt: mutationGuardTimestamp(now) }
  const headStatement = [
    `update codebases set
      revision = ?,
      selected_state_json = ?,
      main_json = ?,
      file_count = ?,
      private_file_count = ?,
      updated_at = ?
    where codebase_id = ? and revision = ?
      and selected_state_json = ? and main_json = ?`,
    [
      nextRevision,
      stringifyJson(normalized.selectedState),
      stringifyJson(normalized.main),
      fileCount,
      privateFileCount,
      guard.updatedAt,
      codebaseId,
      previousRevision,
      stringifyJson(previousSelectedState),
      stringifyJson(previousMain),
    ],
  ]

  const statements = [headStatement]
  for (const item of fileStatements) {
    statements.push(item.entry.type === 'delete'
      ? guardedDeleteFileStatement(codebaseId, item.entry.path, guard)
      : upsertFileStatement(codebaseId, item.entry.path, item.file, item.graphRevision, now, guard))
  }
  for (const row of versionStatements) {
    statements.push(insertFileVersionStatement(row, guard))
  }

  const results = await backend.queryBatch(statements.map(([sql, params]) => ({ sql, params })))
  const changedRows = changedRowCount(results[0])
  if (changedRows === 0) {
    throw createSelectedStateRevisionConflict(options.ConflictError, {
      entry: entries[0],
      cloud: normalized,
      expectedRevision: previousRevision,
    })
  }
  if (!Number.isInteger(changedRows)) {
    throw new Error('D1 guarded journal commit did not report changed rows.')
  }

  replaceGraphContents(cloud, normalized)
  return {
    acknowledgements: acknowledgements.map((acknowledgement) => ({
      ...acknowledgement,
      storageMode: 'd1-bulk-mutation',
    })),
    entries,
    chunkIndex: options.chunkIndex ?? 0,
    chunkOffset: options.chunkOffset ?? 0,
    fromRevision: previousRevision,
    toRevision: nextRevision,
    count: entries.length,
    storageMode: 'd1-bulk-mutation',
  }
}

function journalCommitChunkSize(value) {
  const normalized = Number(value)
  if (!Number.isInteger(normalized) || normalized <= 0) return defaultJournalCommitChunkSize
  return Math.min(normalized, defaultJournalCommitChunkSize)
}

function entryPayloadFor(options, entry) {
  const payloads = options.entryPayloads
  if (!payloads) return null
  if (payloads instanceof Map) {
    return payloads.get(entry.id) ?? payloads.get(entry.path) ?? null
  }
  if (typeof payloads === 'object') {
    return payloads[entry.id] ?? payloads[entry.path] ?? null
  }
  return null
}

function replaceGraphContents(target, source) {
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(target, structuredClone(source))
}

function guardedDeleteFileStatement(codebaseId, filePath, guard) {
  return [
    `delete from files
      where codebase_id = ? and path = ?
        and exists (
          select 1 from codebases
          where codebase_id = ? and revision = ? and updated_at = ?
        )`,
    [codebaseId, filePath, guard.codebaseId, guard.revision, guard.updatedAt],
  ]
}

function insertFileVersionStatement(row, guard = null) {
  const params = [
    row.codebaseId,
    row.selectedStateType,
    row.selectedStateId,
    row.mainStateId,
    row.graphRevision,
    row.path,
    row.operation,
    row.kind,
    row.oldRevision,
    row.newRevision,
    row.oldFile ? stringifyJson(row.oldFile) : null,
    row.newFile ? stringifyJson(row.newFile) : null,
    row.scope,
    row.privacyZone,
    row.zoneId,
    row.contentStorage,
    row.blobProvider,
    row.blobKey,
    row.blobHash,
    row.encoding,
    row.target,
    row.size,
    row.actorUserId,
    row.sessionId,
    row.deviceName,
    row.createdAt,
  ]
  return [
    `insert into file_versions (
      codebase_id, selected_state_type, selected_state_id, main_state_id,
      graph_revision, path, operation, kind, old_revision, new_revision,
      old_file_json, new_file_json, scope, privacy_zone, zone_id,
      content_storage, blob_provider, blob_key, blob_hash, encoding,
      target, size, actor_user_id, session_id, device_name, created_at
    ) ${guardedValuesSql(params.length, guard)}`,
    guardedParams(params, guard),
  ]
}

function guardedAgentEventStatement(event, guard) {
  const params = [
    event.codebaseId,
    event.event,
    stringifyJson(event.detail ?? {}),
    event.at,
    event.source,
  ]
  return [
    `insert into agent_events (codebase_id, event, detail_json, at, source)
      ${guardedValuesSql(params.length, guard)}`,
    guardedParams(params, guard),
  ]
}

function guardedValuesSql(valueCount, guard) {
  const placeholders = Array.from({ length: valueCount }, () => '?').join(', ')
  if (!guard) return `values (${placeholders})`
  return `select ${placeholders}
    where exists (
      select 1 from codebases
      where codebase_id = ? and revision = ? and updated_at = ?
    )`
}

function guardedParams(params, guard) {
  return guard ? [...params, guard.codebaseId, guard.revision, guard.updatedAt] : params
}

function changedRowCount(result) {
  const meta = result?.meta ?? {}
  for (const key of ['changes', 'changedRows', 'rowsAffected', 'rowsWritten', 'rows_written']) {
    const value = meta[key]
    if (Number.isInteger(value)) return value
  }
  return null
}

function createSelectedStateRevisionConflict(ConflictErrorClass, { entry, cloud, expectedRevision }) {
  const actualRevision = cloud?.selectedState?.revision ?? cloud?.revision ?? null
  const Conflict = typeof ConflictErrorClass === 'function' ? ConflictErrorClass : D1ConflictError
  return new Conflict(
    `selected_state_revision_mismatch: expected ${expectedRevision}, got ${actualRevision}`,
    {
      reason: 'selected_state_revision_mismatch',
      id: entry.id,
      type: entry.type,
      path: entry.path,
      scope: entry.scope ?? scopeForPath(entry.path ?? ''),
      expectedRevision,
      actualRevision,
      selectedStateId: cloud?.selectedState?.id ?? null,
      selectedStateRevision: actualRevision,
    },
  )
}

function journalActor(entry, cloud) {
  return {
    actorUserId: entry.actorUserId ?? entry.ownerId ?? entry.userId ?? entry.requesterId ?? null,
    sessionId: entry.sessionId ?? cloud.session?.id ?? null,
    deviceName: entry.deviceName ?? cloud.session?.deviceName ?? null,
  }
}

function cloneFileEntry(file) {
  return file ? structuredClone(file) : null
}

function assertWritableSelectedState(cloud, entry = {}) {
  const selectedState = cloud?.selectedState
  if (selectedState?.type !== 'active-change-set' || !selectedState.id) {
    throw new D1FileMutationError(
      'selected_state_not_writable',
      'selected_state_not_writable: File mutations require a selected active change set.',
      {
        selectedStateType: selectedState?.type ?? null,
        selectedStateId: selectedState?.id ?? null,
      },
    )
  }
  if (selectedState.mergeState === 'merged') {
    throw new D1FileMutationError(
      'selected_state_already_merged',
      `selected_state_already_merged: Change set ${selectedState.id} is already merged and cannot accept file mutations.`,
      {
        selectedStateType: selectedState.type,
        selectedStateId: selectedState.id,
        selectedStateRevision: selectedState.revision ?? null,
      },
    )
  }
  if (entry.targetStateType !== undefined && entry.targetStateType !== selectedState.type) {
    throw new D1FileMutationError(
      'selected_state_type_mismatch',
      `selected_state_type_mismatch: expected ${entry.targetStateType}, got ${selectedState.type}`,
      {
        expectedType: entry.targetStateType,
        actualType: selectedState.type,
        selectedStateId: selectedState.id,
        selectedStateRevision: selectedState.revision ?? null,
      },
    )
  }
  if (entry.targetStateId !== undefined && entry.targetStateId !== selectedState.id) {
    throw new D1FileMutationError(
      'selected_state_id_mismatch',
      `selected_state_id_mismatch: expected ${entry.targetStateId}, got ${selectedState.id}`,
      {
        expectedId: entry.targetStateId,
        actualId: selectedState.id,
        selectedStateRevision: selectedState.revision ?? null,
      },
    )
  }
}

function isSelectedStateHeadConflict(error) {
  return error?.detail?.reason === 'selected_state_revision_mismatch' ||
    /^selected_state_revision_mismatch:/.test(error instanceof Error ? error.message : '')
}

function mutationGuardTimestamp(now) {
  const match = /^(.+?)(?:\.(\d+))?Z$/.exec(String(now ?? ''))
  const base = match?.[1] ?? new Date(now).toISOString().replace(/\.\d{3}Z$/, '')
  const milliseconds = (match?.[2] ?? '000').padEnd(3, '0').slice(0, 3)
  const entropy = (BigInt(`0x${randomBytes(8).toString('hex')}`) % 1_000_000_000_000n)
    .toString()
    .padStart(12, '0')
  return `${base}.${milliseconds}${entropy}Z`
}

class D1FileMutationError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'FileMutationError'
    this.code = code
    this.detail = { reason: code, ...detail }
  }
}

class D1ConflictError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'ConflictError'
    this.detail = detail
  }
}

function mapD1FileVersion(row) {
  return {
    versionId: integerOrNull(row.version_id) ?? 0,
    codebaseId: row.codebase_id,
    selectedStateType: row.selected_state_type ?? null,
    selectedStateId: row.selected_state_id ?? null,
    mainStateId: row.main_state_id ?? null,
    graphRevision: integerValue(row.graph_revision, 0),
    path: row.path,
    operation: row.operation ?? 'modify',
    kind: row.kind ?? 'file',
    oldRevision: integerOrNull(row.old_revision),
    newRevision: integerOrNull(row.new_revision),
    oldFile: parseJson(row.old_file_json, null),
    newFile: parseJson(row.new_file_json, null),
    scope: row.scope ?? scopeForPath(row.path),
    privacyZone: row.privacy_zone ?? privacyZoneForPath(row.path),
    zoneId: row.zone_id ?? privacyZoneIdForPath(row.codebase_id, row.path),
    contentStorage: row.content_storage ?? 'inline',
    blobProvider: row.blob_provider ?? null,
    blobKey: row.blob_key ?? null,
    blobHash: row.blob_hash ?? null,
    encoding: row.encoding ?? 'utf8',
    target: row.target ?? null,
    size: integerOrNull(row.size),
    actorUserId: row.actor_user_id ?? null,
    sessionId: row.session_id ?? null,
    deviceName: row.device_name ?? null,
    createdAt: row.created_at,
  }
}

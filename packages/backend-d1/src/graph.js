import { randomBytes, randomUUID } from 'node:crypto'
import { privacyZoneForPath, privacyZoneIdForPath, scopeForPath } from '@hopit/core/privacy-zone'
import { defineBackendMethods } from './method-support.js'
import { d1CloudServiceType, d1AuthorizationToken, schemaCacheKey, usesCloudflareD1Api, usesScopedD1SessionAuth } from './config.js'
import { d1SchemaStatements } from './schema.js'
import { summarizeAccessContext, normalizeEmail, normalizeCodebaseName, normalizeNewCodebaseId, backendErrorMessage, normalizeFutureTimestamp, normalizePositiveInteger, nullablePositiveInteger, nullableNonNegativeInteger, actorAuditId, requireTextValue, uniqueStrings, parseStringArray, normalizeRole, graphMemberCount, countPathScopes, assertSafeGraphPath, hashText, byteLength, parseJson, stringifyJson, stringOrNull, integerOrNull, integerValue, boundedLimit, requireAuthenticatedActor, requireVerifiedEmailActor, requireOwnerClaimActor, isBootstrapOwnerMember, claimedOwnerValue, graphFromRows, codebaseRowToRecord, codebaseRecordFromGraph, fileRowToEntry, normalizeGraph, normalizeFileEntry, normalizeVisibilityContract, normalizeOptionalVisibility, normalizeVisibilityValue, summarizeCodebaseHead, summarizeCodebaseRemoteUpdate, buildStatus, buildSyncHealth, buildRefreshHealth, mapD1AgentEvent, latestEventOf, applyJournalEntryToCloud, slugifyCodebaseId, hasCapability, visibilityContextForGraph, filterVisibleGraphForRequester, filterVisibleGraphForAccess, canRequesterSeePath, canRead, canWrite, permissionsForRole, accessContextForCodebaseHead, memberSelectSql, mapD1Member, mapD1Invitation, invitationRole, invitationStatusOrNull, isInvitationExpired, invitationStatusForRead, hashInvitationToken, createAgentSessionId, createAgentSessionToken, hashAgentSessionToken, normalizeAgentSessionId, assertReusableAgentSession, normalizeAgentSessionCapabilities, agentSessionStatusOrNull, agentSessionHasCapability, codebaseCapabilityForAgentCapability, agentCapabilityForCodebaseCapability, isExpiredTimestamp, summarizeAgentSession, normalizeKeyEntityId, assertDevicePublicKeyDescriptor, looksLikePem, assertSameDevicePublicKeys, assertSameCodebaseKeyring, wrappedKeyType, wrappedKeyRecipientType, capabilityForWrappedKey, isPrivateZoneId, assertWrappedKeyEnvelope, assertSameWrappedKey, effectiveWrappedKeyStatus, canActorReadWrappedKey, createWrappedKeyId, summarizeDeviceKey, summarizeUserKeyring, summarizeCodebaseKeyring, summarizeWrappedKey, deviceKeyStatusOrNull, keyRotationState, mapD1Issue, mapD1IssueComment, mapD1Discussion, mapD1DiscussionComment, mapD1Release, mapD1ReleaseAsset, mapD1ReviewThread, mapD1ReviewThreadComment, mapD1ReviewDecision, mapD1Notification, mapD1Project, mapD1ProjectItem, issuePriorityOrNull, issueStatus, discussionCategory, discussionStatus, releaseStatus, releaseAssetKind, reviewDecision, notificationKind, reviewDecisionTitle, reviewDecisionBody, reviewHref, workItemHref, projectStatus, normalizeProjectColumns, normalizeProjectColumnId, normalizeProjectPosition, projectItemType, normalizeReleaseTarget, collaborationScope, actionCommandForKind, summarizeActionJob, actionSummary, capOutput } from './helpers/index.js'

/** @typedef {import('@hopit/core').CloudGraph} CloudGraph */
/** @typedef {import('@hopit/core').AgentSession} AgentSession */

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

  async writeGraph(graph) {
    await this.ensureSchema()
    const normalized = normalizeGraph(graph)
    const codebaseId = normalized.codebase.id
    this.codebaseId = codebaseId
    this.location = `d1:${this.config.databaseId}:${codebaseId}`
    const now = new Date().toISOString()
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
    } else if (seenPaths.length <= 900) {
      await this.query(
        `delete from files where codebase_id = ? and path not in (${seenPaths.map(() => '?').join(', ')})`,
        [codebaseId, ...seenPaths],
      )
    } else {
      const existingRows = await this.query(`select path from files where codebase_id = ?`, [codebaseId])
      const incoming = new Set(seenPaths)
      for (const row of existingRows) {
        if (!incoming.has(row.path)) {
          await this.query(`delete from files where codebase_id = ? and path = ?`, [codebaseId, row.path])
        }
      }
    }

    return { ok: true, codebaseId, revision: normalized.revision, fileCount }
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
    return applyJournalEntryToCloud(cloud, entry, options)
  },

  async commitJournalEntry(cloud, entry, options = {}) {
    const acknowledgement = this.applyJournalEntry(cloud, entry, options)
    await this.writeGraph(cloud)
    return {
      ...acknowledgement,
      storageMode: 'd1-graph-save',
    }
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

  async createCodebase({ name, codebaseId, description, actor = {} }) {
    await this.ensureSchema()
    const now = new Date().toISOString()
    const normalizedName = normalizeCodebaseName(name)
    const id = normalizeNewCodebaseId(codebaseId ?? slugifyCodebaseId(normalizedName))
    if (await this.readOptionalGraph(id)) throw new Error(`Codebase ${id} already exists.`)
    const ownerId = stringOrNull(actor.userId) ?? 'local-owner'
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
    await this.writeGraph(graph)
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
    await this.writeGraph(graph)
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
    }
  },

  async mutateTextFile({ codebaseId, path, content, baseRevision, actor = {} }) {
    assertSafeGraphPath(path)
    const graph = await this.readGraph(codebaseId)
    const access = await this.readAccessContext(graph, actor)
    if (!canWrite(access)) throw new Error(`User cannot edit ${codebaseId}.`)
    if (!canRequesterSeePath(access, path)) throw new Error(`File ${path} is not visible.`)
    const existing = graph.files[path] ?? null
    const actualRevision = existing?.revision ?? null
    if (baseRevision !== undefined && baseRevision !== actualRevision) {
      throw new Error(`base_revision_mismatch: expected ${baseRevision}, got ${actualRevision}`)
    }
    const now = new Date().toISOString()
    graph.revision += 1
    graph.main.revision = graph.revision
    graph.files[path] = normalizeFileEntry(path, {
      kind: 'file',
      content,
      encoding: 'utf8',
      contentStorage: 'inline',
      hash: hashText(content),
      size: byteLength(content),
      revision: graph.revision,
      updatedAt: now,
    }, graph.revision, now)
    await this.writeGraph(graph)
    await this.appendEvent({
      codebaseId,
      event: 'file.mutated',
      detail: { path, revision: graph.revision, updatedBy: actor.userId ?? null },
      at: now,
      source: 'browser',
    })
    return {
      ok: true,
      codebaseId,
      path,
      revision: graph.revision,
      file: graph.files[path],
    }
  },

  async upsertFile(codebaseId, filePath, file, graphRevision, now = new Date().toISOString()) {
    const normalized = normalizeFileEntry(filePath, file, graphRevision, now)
    await this.query(
      `insert into files (
        codebase_id, path, kind, content, encoding, target, blob_hash, blob_provider,
        blob_key, blob_size, client_encryption_json, encryption_json, privacy_zone,
        zone_id, content_storage, hash, size, scope, revision, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      [
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
      ],
    )
  },
  })
}

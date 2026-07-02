import { createHash, randomBytes, randomUUID } from 'node:crypto'

export const d1CloudServiceType = 'cloudflare-d1-graph'

const defaultD1ApiBaseUrl = 'https://api.cloudflare.com/client/v4'
const defaultCodebaseId = 'hopit'
const visibleRoles = new Set(['owner', 'maintainer', 'member', 'viewer'])
const writeRoles = new Set(['owner', 'maintainer'])
const inviteRoles = new Set(['owner', 'maintainer'])
const adminRoles = new Set(['owner'])
const ensuredSchemaKeys = new Set()

export function d1ConfigFromOptions(options = {}, env = process.env) {
  return {
    accountId: stringOrNull(options['d1-account-id']) ?? stringOrNull(env.HOPIT_D1_ACCOUNT_ID) ?? stringOrNull(env.CLOUDFLARE_ACCOUNT_ID),
    databaseId: stringOrNull(options['d1-database-id']) ?? stringOrNull(env.HOPIT_D1_DATABASE_ID),
    apiToken: stringOrNull(options['d1-api-token']) ?? stringOrNull(env.HOPIT_D1_API_TOKEN) ?? stringOrNull(env.CLOUDFLARE_API_TOKEN),
    apiBaseUrl: stringOrNull(options['d1-api-base-url']) ?? stringOrNull(env.HOPIT_D1_API_BASE_URL) ?? defaultD1ApiBaseUrl,
    codebaseId: stringOrNull(options['codebase-id']) ?? stringOrNull(env.HOPIT_CODEBASE_ID) ?? defaultCodebaseId,
    agentSessionToken: stringOrNull(options['session-token']) ?? stringOrNull(options.agentSessionToken) ?? stringOrNull(env.HOPIT_AGENT_SESSION_TOKEN),
    assumeSchema: booleanOption(options['assume-schema']) ?? truthyEnv(env.HOPIT_D1_ASSUME_SCHEMA),
  }
}

export function isD1Configured(options = {}, env = process.env) {
  const config = d1ConfigFromOptions(options, env)
  if (usesCloudflareD1Api(config)) {
    return Boolean(config.accountId && config.databaseId && config.apiToken)
  }
  return Boolean(d1AuthorizationToken(config))
}

export function createD1Backend(options = {}, env = process.env) {
  return new CloudflareD1HopBackend(d1ConfigFromOptions(options, env))
}

function usesCloudflareD1Api(config) {
  return (config.apiBaseUrl ?? defaultD1ApiBaseUrl).replace(/\/+$/, '') === defaultD1ApiBaseUrl
}

function d1AuthorizationToken(config) {
  return stringOrNull(config.apiToken) ?? stringOrNull(config.agentSessionToken)
}

function schemaCacheKey(config) {
  return [
    (config.apiBaseUrl ?? defaultD1ApiBaseUrl).replace(/\/+$/, ''),
    config.accountId ?? '',
    config.databaseId ?? '',
  ].join('|')
}

function booleanOption(value) {
  if (value === true || value === false) return value
  if (typeof value !== 'string') return null
  if (/^(1|true|yes|on)$/i.test(value)) return true
  if (/^(0|false|no|off)$/i.test(value)) return false
  return null
}

function truthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ''))
}

function usesScopedD1SessionAuth(config) {
  return !stringOrNull(config.apiToken) && Boolean(stringOrNull(config.agentSessionToken)) && !usesCloudflareD1Api(config)
}

export class CloudflareD1HopBackend {
  constructor(config) {
    this.config = config
    this.codebaseId = config.codebaseId
    this.type = d1CloudServiceType
    this.location = `d1:${config.databaseId ?? 'unconfigured'}:${this.codebaseId}`
    this.schemaEnsured = false
  }

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
      await this.query(sql)
    }
    ensuredSchemaKeys.add(cacheKey)
    this.schemaEnsured = true
  }

  async exists(codebaseId = this.codebaseId) {
    return Boolean(await this.readGraphHead(codebaseId))
  }

  async initialize(graph) {
    await this.ensureSchema()
    const normalized = normalizeGraph(graph)
    this.codebaseId = normalized.codebase.id
    this.location = `d1:${this.config.databaseId}:${this.codebaseId}`
    await this.writeGraph(normalized)
    return normalized
  }

  async readGraphHead(codebaseId = this.codebaseId) {
    if (!codebaseId) return null
    await this.ensureSchema()
    const row = await this.first(
      `select * from codebases where codebase_id = ? limit 1`,
      [codebaseId],
    )
    if (!row) return null
    return summarizeCodebaseHead(codebaseRowToRecord(row))
  }

  async readGraph(codebaseId = this.codebaseId) {
    const graph = await this.readOptionalGraph(codebaseId)
    if (!graph) throw new Error(`D1 graph not found for codebase ${codebaseId ?? '(unset)'}.`)
    return graph
  }

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
  }

  async readVisibleGraph(request = {}, codebaseId = this.codebaseId) {
    const graph = await this.readGraph(codebaseId)
    const access = await this.readAccessContext(graph, {
      userId: request.requesterId,
      sessionId: request.sessionId,
    })
    return filterVisibleGraphForAccess(graph, access)
  }

  async readOptionalVisibleGraph(request = {}, codebaseId = this.codebaseId) {
    const graph = await this.readOptionalGraph(codebaseId)
    if (!graph) return null
    const access = await this.readAccessContext(graph, {
      userId: request.requesterId,
      sessionId: request.sessionId,
    })
    return filterVisibleGraphForAccess(graph, access)
  }

  async readAccessContext(graph, actor = {}) {
    await this.ensureGraphMembers(graph)
    const userId = stringOrNull(actor.userId)
    let membership = null
    if (userId) {
      membership = await this.first(
        `select * from codebase_members where codebase_id = ? and user_id = ? limit 1`,
        [graph.codebase.id, userId],
      )
    }
    return visibilityContextForGraph(graph, {
      requesterId: userId,
      sessionId: actor.sessionId,
      membership,
    })
  }

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
  }

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
  }

  async insertMemberIfMissing(member) {
    const existing = await this.first(
      `select user_id from codebase_members where codebase_id = ? and user_id = ? limit 1`,
      [member.codebaseId, member.userId],
    )
    if (existing) return
    await this.upsertMember(member)
  }

  applyJournalEntry(cloud, entry, options = {}) {
    return applyJournalEntryToCloud(cloud, entry, options)
  }

  async commitJournalEntry(cloud, entry, options = {}) {
    const acknowledgement = this.applyJournalEntry(cloud, entry, options)
    await this.writeGraph(cloud)
    return {
      ...acknowledgement,
      storageMode: 'd1-graph-save',
    }
  }

  async appendEvent({ codebaseId = this.codebaseId, event, detail, at = new Date().toISOString(), source = 'local-agent' }) {
    if (!codebaseId || !event) return
    await this.ensureSchema()
    await this.query(
      `insert into agent_events (codebase_id, event, detail_json, at, source) values (?, ?, ?, ?, ?)`,
      [codebaseId, event, stringifyJson(detail ?? {}), at, source],
    )
  }

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
  }

  async readLatestEvent(codebaseId, eventName) {
    const row = await this.first(
      `select id, event, detail_json, at, source from agent_events
       where codebase_id = ? and event = ?
       order by at desc, id desc limit 1`,
      [codebaseId, eventName],
    )
    return row ? mapD1AgentEvent(row) : null
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  async listActionJobs({ codebaseId, limit = 20, actor = {} }) {
    const graph = await this.readGraph(codebaseId)
    const access = await this.readAccessContext(graph, actor)
    if (!canRead(access)) throw new Error(`User cannot read ${codebaseId}.`)
    const rows = await this.query(
      `select * from action_jobs where codebase_id = ? order by created_at desc limit ?`,
      [codebaseId, boundedLimit(limit, 30)],
    )
    return rows.map(summarizeActionJob)
  }

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
  }

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
  }

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
  }

  async listMembers({ codebaseId, status, actor = {} }) {
    const { graph, access } = await this.requireGraphCapability(codebaseId, actor, 'read')
    const normalizedStatus = status === 'active' || status === 'suspended' ? status : null
    const rows = normalizedStatus
      ? await this.query(memberSelectSql(`where m.codebase_id = ? and m.status = ?`), [codebaseId, normalizedStatus])
      : await this.query(memberSelectSql(`where m.codebase_id = ?`), [codebaseId])
    return rows.map((row) => mapD1Member(row, graph, access))
  }

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
  }

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
  }

  async suspendMember({ codebaseId, userId, actor = {} }) {
    return this.mutateMemberStatus({ codebaseId, userId, actor, action: 'suspend' })
  }

  async removeMember({ codebaseId, userId, actor = {} }) {
    return this.mutateMemberStatus({ codebaseId, userId, actor, action: 'remove' })
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  async listWorkItems({ codebaseId, actor = {} }) {
    await this.requireGraphCapability(codebaseId, actor, 'read')
    const [issues, issueComments, discussions, discussionComments, releases, releaseAssets, projects, projectItems] = await Promise.all([
      this.query(`select * from issues where codebase_id = ? order by created_at desc, number desc`, [codebaseId]),
      this.query(`select * from issue_comments where codebase_id = ? order by created_at asc`, [codebaseId]),
      this.query(`select * from discussions where codebase_id = ? order by created_at desc, number desc`, [codebaseId]),
      this.query(`select * from discussion_comments where codebase_id = ? order by created_at asc`, [codebaseId]),
      this.query(`select * from releases where codebase_id = ? order by created_at desc, number desc`, [codebaseId]),
      this.query(`select * from release_assets where codebase_id = ? order by created_at asc`, [codebaseId]),
      this.query(`select * from projects where codebase_id = ? order by created_at desc, number desc`, [codebaseId]),
      this.query(`select * from project_items where codebase_id = ? order by project_id asc, position asc, created_at asc`, [codebaseId]),
    ])
    const commentsByIssueId = new Map()
    for (const comment of issueComments) {
      const list = commentsByIssueId.get(comment.issue_id) ?? []
      list.push(mapD1IssueComment(comment))
      commentsByIssueId.set(comment.issue_id, list)
    }
    const commentsByDiscussionId = new Map()
    for (const comment of discussionComments) {
      const list = commentsByDiscussionId.get(comment.discussion_id) ?? []
      list.push(mapD1DiscussionComment(comment))
      commentsByDiscussionId.set(comment.discussion_id, list)
    }
    const assetsByReleaseId = new Map()
    for (const asset of releaseAssets) {
      const list = assetsByReleaseId.get(asset.release_id) ?? []
      list.push(mapD1ReleaseAsset(asset))
      assetsByReleaseId.set(asset.release_id, list)
    }
    const itemsByProjectId = new Map()
    for (const item of projectItems) {
      const list = itemsByProjectId.get(item.project_id) ?? []
      list.push(mapD1ProjectItem(item))
      itemsByProjectId.set(item.project_id, list)
    }
    return {
      issues: issues.map((issue) => mapD1Issue(issue, commentsByIssueId.get(issue.issue_id) ?? [])),
      discussions: discussions.map((discussion) => mapD1Discussion(discussion, commentsByDiscussionId.get(discussion.discussion_id) ?? [])),
      releases: releases.map((release) => mapD1Release(release, assetsByReleaseId.get(release.release_id) ?? [])),
      projects: projects.map((project) => mapD1Project(project, itemsByProjectId.get(project.project_id) ?? [])),
    }
  }

  async createWorkItem(input) {
    const actor = requireAuthenticatedActor(input.actor, 'Creating collaboration items requires product auth.')
    if (input.type === 'issue') return this.createIssue({ ...input, actor })
    if (input.type === 'discussion') return this.createDiscussion({ ...input, actor })
    if (input.type === 'release') return this.createRelease({ ...input, actor })
    if (input.type === 'releaseAsset') return this.createReleaseAsset({ ...input, actor })
    if (input.type === 'project') return this.createProject({ ...input, actor })
    if (input.type === 'projectItem') return this.addProjectItem({ ...input, actor })
    if (input.type === 'issueComment') return this.createIssueComment({ ...input, actor })
    if (input.type === 'discussionComment') return this.createDiscussionComment({ ...input, actor })
    throw new Error('Expected type to be issue, discussion, release, releaseAsset, project, projectItem, issueComment, or discussionComment.')
  }

  async updateWorkItem(input) {
    const actor = requireAuthenticatedActor(input.actor, 'Updating collaboration items requires product auth.')
    if (input.action === 'setIssueStatus') return this.setIssueStatus({ ...input, actor })
    if (input.action === 'setDiscussionStatus') return this.setDiscussionStatus({ ...input, actor })
    if (input.action === 'publishRelease') return this.publishRelease({ ...input, actor })
    if (input.action === 'archiveProject') return this.archiveProject({ ...input, actor })
    if (input.action === 'moveProjectItem') return this.moveProjectItem({ ...input, actor })
    throw new Error('Unknown collaboration update action.')
  }

  async createIssue({ codebaseId, title, body, priority, labels, assigneeIds, linkedChangeSetId, linkedReleaseId, createdBy, actor }) {
    await this.requireGraphCapability(codebaseId, actor, 'write')
    const now = new Date().toISOString()
    const number = await this.allocateCollaborationNumber(codebaseId, 'issue', now)
    const issueId = `iss_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    await this.query(
      `insert into issues (
        issue_id, codebase_id, number, title, body, status, priority, labels_json, assignee_ids_json,
        linked_change_set_id, linked_release_id, created_by, created_at, updated_at
      ) values (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        issueId,
        codebaseId,
        number,
        requireTextValue(title, 'Issue title'),
        stringOrNull(body),
        issuePriorityOrNull(priority),
        stringifyJson(uniqueStrings(labels)),
        stringifyJson(uniqueStrings(assigneeIds)),
        stringOrNull(linkedChangeSetId),
        stringOrNull(linkedReleaseId),
        actorAuditId(actor, createdBy, 'Issue creator'),
        now,
        now,
      ],
    )
    return mapD1Issue(await this.first(`select * from issues where issue_id = ?`, [issueId]))
  }

  async setIssueStatus({ issueId, status, updatedBy, actor }) {
    const issue = await this.first(`select * from issues where issue_id = ? limit 1`, [issueId])
    if (!issue) throw new Error('Issue not found.')
    await this.requireGraphCapability(issue.codebase_id, actor, 'write')
    const now = new Date().toISOString()
    const nextStatus = issueStatus(status)
    await this.query(
      `update issues set status = ?, updated_by = ?, updated_at = ?, closed_at = ? where issue_id = ?`,
      [nextStatus, actorAuditId(actor, updatedBy, 'Issue updater'), now, nextStatus === 'closed' ? now : null, issueId],
    )
    return mapD1Issue(await this.first(`select * from issues where issue_id = ?`, [issueId]))
  }

  async createIssueComment({ issueId, body, createdBy, actor }) {
    const issue = await this.first(`select * from issues where issue_id = ? limit 1`, [issueId])
    if (!issue) throw new Error('Issue not found.')
    await this.requireGraphCapability(issue.codebase_id, actor, 'write')
    const now = new Date().toISOString()
    const commentId = `icom_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    const author = actorAuditId(actor, createdBy, 'Issue comment creator')
    await this.query(
      `insert into issue_comments (
        comment_id, codebase_id, issue_id, body, created_by, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?)`,
      [commentId, issue.codebase_id, issueId, requireTextValue(body, 'Issue comment body'), author, now, now],
    )
    await this.query(
      `update issues set updated_by = ?, updated_at = ? where issue_id = ?`,
      [author, now, issueId],
    )
    return mapD1IssueComment(await this.first(`select * from issue_comments where comment_id = ?`, [commentId]))
  }

  async createDiscussion({ codebaseId, title, body, category, labels, linkedIssueIds, linkedChangeSetId, createdBy, actor }) {
    await this.requireGraphCapability(codebaseId, actor, 'write')
    const now = new Date().toISOString()
    const number = await this.allocateCollaborationNumber(codebaseId, 'discussion', now)
    const discussionId = `dis_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    await this.query(
      `insert into discussions (
        discussion_id, codebase_id, number, title, body, category, status, labels_json,
        linked_issue_ids_json, linked_change_set_id, created_by, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
      [
        discussionId,
        codebaseId,
        number,
        requireTextValue(title, 'Discussion title'),
        requireTextValue(body, 'Discussion body'),
        discussionCategory(category),
        stringifyJson(uniqueStrings(labels)),
        stringifyJson(uniqueStrings(linkedIssueIds)),
        stringOrNull(linkedChangeSetId),
        actorAuditId(actor, createdBy, 'Discussion creator'),
        now,
        now,
      ],
    )
    return mapD1Discussion(await this.first(`select * from discussions where discussion_id = ?`, [discussionId]))
  }

  async setDiscussionStatus({ discussionId, status, updatedBy, actor }) {
    const discussion = await this.first(`select * from discussions where discussion_id = ? limit 1`, [discussionId])
    if (!discussion) throw new Error('Discussion not found.')
    await this.requireGraphCapability(discussion.codebase_id, actor, 'write')
    const now = new Date().toISOString()
    const nextStatus = discussionStatus(status)
    await this.query(
      `update discussions set status = ?, updated_by = ?, updated_at = ?, closed_at = ? where discussion_id = ?`,
      [nextStatus, actorAuditId(actor, updatedBy, 'Discussion updater'), now, nextStatus === 'closed' ? now : null, discussionId],
    )
    return mapD1Discussion(await this.first(`select * from discussions where discussion_id = ?`, [discussionId]))
  }

  async createDiscussionComment({ discussionId, body, createdBy, actor }) {
    const discussion = await this.first(`select * from discussions where discussion_id = ? limit 1`, [discussionId])
    if (!discussion) throw new Error('Discussion not found.')
    if (discussion.status === 'locked') throw new Error('Locked discussions cannot accept new comments.')
    await this.requireGraphCapability(discussion.codebase_id, actor, 'write')
    const now = new Date().toISOString()
    const commentId = `dcom_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    const author = actorAuditId(actor, createdBy, 'Discussion comment creator')
    await this.query(
      `insert into discussion_comments (
        comment_id, codebase_id, discussion_id, body, created_by, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?)`,
      [commentId, discussion.codebase_id, discussionId, requireTextValue(body, 'Discussion comment body'), author, now, now],
    )
    await this.query(
      `update discussions set updated_by = ?, updated_at = ? where discussion_id = ?`,
      [author, now, discussionId],
    )
    return mapD1DiscussionComment(await this.first(`select * from discussion_comments where comment_id = ?`, [commentId]))
  }

  async createRelease({ codebaseId, version, title, notes, status, target, createdBy, actor }) {
    await this.requireGraphCapability(codebaseId, actor, 'release')
    const normalizedVersion = requireTextValue(version, 'Release version')
    const existing = await this.first(
      `select release_id from releases where codebase_id = ? and version = ? limit 1`,
      [codebaseId, normalizedVersion],
    )
    if (existing) throw new Error(`Release ${normalizedVersion} already exists for ${codebaseId}.`)
    const now = new Date().toISOString()
    const nextStatus = releaseStatus(status)
    const number = await this.allocateCollaborationNumber(codebaseId, 'release', now)
    const releaseId = `rel_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    await this.query(
      `insert into releases (
        release_id, codebase_id, number, version, title, notes, status, target_json,
        created_by, created_at, updated_at, published_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        releaseId,
        codebaseId,
        number,
        normalizedVersion,
        requireTextValue(title, 'Release title'),
        requireTextValue(notes, 'Release notes'),
        nextStatus,
        stringifyJson(normalizeReleaseTarget(target)),
        actorAuditId(actor, createdBy, 'Release creator'),
        now,
        now,
        nextStatus === 'published' ? now : null,
      ],
    )
    return mapD1Release(await this.first(`select * from releases where release_id = ?`, [releaseId]), [])
  }

  async publishRelease({ releaseId, updatedBy, actor }) {
    const release = await this.first(`select * from releases where release_id = ? limit 1`, [releaseId])
    if (!release) throw new Error('Release not found.')
    await this.requireGraphCapability(release.codebase_id, actor, 'release')
    const now = new Date().toISOString()
    await this.query(
      `update releases set status = 'published', updated_by = ?, updated_at = ?, published_at = ? where release_id = ?`,
      [actorAuditId(actor, updatedBy, 'Release publisher'), now, now, releaseId],
    )
    const assets = await this.query(`select * from release_assets where release_id = ? order by created_at asc`, [releaseId])
    return mapD1Release(await this.first(`select * from releases where release_id = ?`, [releaseId]), assets.map(mapD1ReleaseAsset))
  }

  async createReleaseAsset({ codebaseId, releaseId, name, kind, url, size, checksum, createdBy, actor }) {
    const release = codebaseId
      ? await this.first(`select * from releases where codebase_id = ? and release_id = ? limit 1`, [codebaseId, releaseId])
      : await this.first(`select * from releases where release_id = ? limit 1`, [releaseId])
    if (!release) throw new Error('Release not found.')
    if (codebaseId && release.codebase_id !== codebaseId) throw new Error('Release does not belong to the selected codebase.')
    await this.requireGraphCapability(release.codebase_id, actor, 'release')
    const now = new Date().toISOString()
    const assetId = `asset_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    await this.query(
      `insert into release_assets (
        asset_id, codebase_id, release_id, name, kind, url, size, checksum, created_by, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        assetId,
        release.codebase_id,
        releaseId,
        requireTextValue(name, 'Release asset name'),
        releaseAssetKind(kind),
        stringOrNull(url),
        nullableNonNegativeInteger(size, 'Release asset size'),
        stringOrNull(checksum),
        actorAuditId(actor, createdBy, 'Release asset creator'),
        now,
      ],
    )
    await this.query(
      `update releases set updated_by = ?, updated_at = ? where codebase_id = ? and release_id = ?`,
      [actorAuditId(actor, createdBy, 'Release asset updater'), now, release.codebase_id, releaseId],
    )
    await this.createNotification({
      codebaseId: release.codebase_id,
      kind: 'release.asset_attached',
      title: 'Release asset attached',
      body: `${requireTextValue(name, 'Release asset name')} was attached to ${release.version}.`,
      href: workItemHref(release.codebase_id, 'releases', releaseId),
      createdAt: now,
    })
    return mapD1ReleaseAsset(await this.first(`select * from release_assets where codebase_id = ? and asset_id = ?`, [release.codebase_id, assetId]))
  }

  async createProject({ codebaseId, name, description, columns, createdBy, actor }) {
    await this.requireGraphCapability(codebaseId, actor, 'write')
    const now = new Date().toISOString()
    const number = await this.allocateCollaborationNumber(codebaseId, 'project', now)
    const projectId = `prj_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    const normalizedColumns = normalizeProjectColumns(columns)
    await this.query(
      `insert into projects (
        project_id, codebase_id, number, name, description, status, columns_json,
        created_by, created_at, updated_at
      ) values (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      [
        projectId,
        codebaseId,
        number,
        requireTextValue(name, 'Project name'),
        stringOrNull(description),
        stringifyJson(normalizedColumns),
        actorAuditId(actor, createdBy, 'Project creator'),
        now,
        now,
      ],
    )
    return mapD1Project(await this.first(`select * from projects where project_id = ?`, [projectId]), [])
  }

  async archiveProject({ projectId, updatedBy, actor }) {
    const project = await this.first(`select * from projects where project_id = ? limit 1`, [projectId])
    if (!project) throw new Error('Project not found.')
    await this.requireGraphCapability(project.codebase_id, actor, 'write')
    const now = new Date().toISOString()
    await this.query(
      `update projects set status = 'archived', updated_by = ?, updated_at = ?, archived_at = ? where project_id = ?`,
      [actorAuditId(actor, updatedBy, 'Project archiver'), now, now, projectId],
    )
    const items = await this.query(`select * from project_items where project_id = ? order by position asc, created_at asc`, [projectId])
    return mapD1Project(await this.first(`select * from projects where project_id = ?`, [projectId]), items.map(mapD1ProjectItem))
  }

  async addProjectItem({ projectId, item, columnId, position, createdBy, actor }) {
    const project = await this.first(`select * from projects where project_id = ? limit 1`, [projectId])
    if (!project) throw new Error('Project not found.')
    if (project.status !== 'active') throw new Error('Archived projects cannot accept new items.')
    await this.requireGraphCapability(project.codebase_id, actor, 'write')
    const columns = normalizeProjectColumns(parseJson(project.columns_json, []))
    const targetColumnId = normalizeProjectColumnId(columnId, columns)
    const normalizedItem = await this.normalizeProjectItem(project.codebase_id, item)
    const nextPosition = normalizeProjectPosition(position) ?? await this.nextProjectItemPosition(projectId, targetColumnId)
    const now = new Date().toISOString()
    const projectItemId = `pitem_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    await this.query(
      `insert into project_items (
        project_item_id, codebase_id, project_id, item_json, column_id, position,
        created_by, updated_by, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectItemId,
        project.codebase_id,
        projectId,
        stringifyJson(normalizedItem),
        targetColumnId,
        nextPosition,
        actorAuditId(actor, createdBy, 'Project item creator'),
        actorAuditId(actor, createdBy, 'Project item updater'),
        now,
        now,
      ],
    )
    return mapD1ProjectItem(await this.first(`select * from project_items where project_item_id = ?`, [projectItemId]))
  }

  async moveProjectItem({ projectItemId, columnId, position, updatedBy, actor }) {
    const existing = await this.first(`select * from project_items where project_item_id = ? limit 1`, [projectItemId])
    if (!existing) throw new Error('Project item not found.')
    const project = await this.first(`select * from projects where project_id = ? limit 1`, [existing.project_id])
    if (!project) throw new Error('Project not found.')
    if (project.status !== 'active') throw new Error('Archived project items cannot be moved.')
    await this.requireGraphCapability(project.codebase_id, actor, 'write')
    const columns = normalizeProjectColumns(parseJson(project.columns_json, []))
    const targetColumnId = normalizeProjectColumnId(columnId ?? existing.column_id, columns)
    const nextPosition = normalizeProjectPosition(position) ?? await this.nextProjectItemPosition(project.project_id, targetColumnId)
    const now = new Date().toISOString()
    await this.query(
      `update project_items set column_id = ?, position = ?, updated_by = ?, updated_at = ? where project_item_id = ?`,
      [targetColumnId, nextPosition, actorAuditId(actor, updatedBy, 'Project item updater'), now, projectItemId],
    )
    return mapD1ProjectItem(await this.first(`select * from project_items where project_item_id = ?`, [projectItemId]))
  }

  async nextProjectItemPosition(projectId, columnId) {
    const row = await this.first(
      `select max(position) as max_position from project_items where project_id = ? and column_id = ?`,
      [projectId, columnId],
    )
    const current = typeof row?.max_position === 'number' && Number.isFinite(row.max_position) ? row.max_position : 0
    return current + 1
  }

  async normalizeProjectItem(codebaseId, value) {
    const item = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
    const type = projectItemType(item.type)
    if (type === 'note') {
      return {
        type,
        title: requireTextValue(item.title, 'Project note title'),
        body: stringOrNull(item.body),
      }
    }

    const id = requireTextValue(item.id, 'Project item id')
    if (type === 'issue') {
      const row = await this.first(`select issue_id, title from issues where codebase_id = ? and issue_id = ? limit 1`, [codebaseId, id])
      if (!row) throw new Error(`Issue ${id} was not found in ${codebaseId}.`)
      return { type, id, title: row.title }
    }
    if (type === 'discussion') {
      const row = await this.first(`select discussion_id, title from discussions where codebase_id = ? and discussion_id = ? limit 1`, [codebaseId, id])
      if (!row) throw new Error(`Discussion ${id} was not found in ${codebaseId}.`)
      return { type, id, title: row.title }
    }
    const row = await this.first(`select release_id, title, version from releases where codebase_id = ? and release_id = ? limit 1`, [codebaseId, id])
    if (!row) throw new Error(`Release ${id} was not found in ${codebaseId}.`)
    return { type, id, title: row.title, version: row.version }
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  async requireGraphCapability(codebaseId, actor = {}, capability = 'read') {
    const graph = await this.readGraph(codebaseId)
    const access = await this.readAccessContext(graph, actor)
    if (!hasCapability(access, capability)) {
      throw new Error(`User ${actor.userId ?? '(anonymous)'} does not have ${capability} access to ${codebaseId}.`)
    }
    return { graph, access }
  }

  async refreshCodebaseMemberCount(codebaseId, now = new Date().toISOString()) {
    const row = await this.first(
      `select count(*) as count from codebase_members where codebase_id = ? and status = 'active'`,
      [codebaseId],
    )
    await this.query(
      `update codebases set member_count = ?, updated_at = ? where codebase_id = ?`,
      [integerValue(row?.count, 0), now, codebaseId],
    )
  }

  async readActiveMemberByEmail(codebaseId, normalizedEmail) {
    const user = await this.first(`select user_id from users where primary_email = ? limit 1`, [normalizedEmail])
    if (!user) return null
    return await this.first(
      `select * from codebase_members where codebase_id = ? and user_id = ? and status = 'active' limit 1`,
      [codebaseId, user.user_id],
    )
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  async registerDeviceKey(options = {}) {
    await this.ensureSchema()
    const codebaseId = stringOrNull(options.codebaseId) ?? this.codebaseId
    const actor = await this.resolveKeyActor(codebaseId, options, 'read')
    const now = new Date().toISOString()
    const deviceId = normalizeKeyEntityId(options.deviceId, 'Device id')
    assertDevicePublicKeyDescriptor(options)
    const existing = await this.first(`select * from device_keys where device_id = ? limit 1`, [deviceId])
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
         where device_id = ?`,
        [
          stringOrNull(options.displayName) ?? existing.display_name,
          stringOrNull(options.platform) ?? existing.platform,
          now,
          now,
          deviceId,
        ],
      )
      return summarizeDeviceKey(await this.first(`select * from device_keys where device_id = ?`, [deviceId]))
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
    return summarizeDeviceKey(await this.first(`select * from device_keys where device_id = ?`, [deviceId]))
  }

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
  }

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
  }

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
  }

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
    const recipientDevice = await this.requireTrustedRecipientDevice({ recipientType, recipientId })
    if (options.wrappedKeyType === 'user-vault' && recipientDevice?.user_id !== actor.userId) {
      throw new Error("User vault keys can only be wrapped to the owner's trusted devices.")
    }
    if (recipientDevice && recipientDevice.user_id !== actor.userId && actor.kind !== 'service') {
      await this.requireKeyActorCapability(codebaseId, actor, 'manage_members')
    }

    const existing = await this.first(`select * from wrapped_keys where wrap_id = ? limit 1`, [wrapId])
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
    return summarizeWrappedKey(await this.first(`select * from wrapped_keys where wrap_id = ?`, [wrapId]))
  }

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
  }

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
  }

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
  }

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
  }

  async resolveAgentSessionRegistrationUser(codebaseId, options = {}) {
    const sessionToken = stringOrNull(options.sessionToken) ?? this.config.agentSessionToken
    if (sessionToken) {
      const access = await this.requireD1AgentAccess(codebaseId, { sessionToken }, 'admin', { touch: true })
      return access.userId
    }
    const graph = await this.readGraph(codebaseId)
    return stringOrNull(graph.codebase?.ownerId) ?? stringOrNull(graph.owner?.id) ?? 'local-owner'
  }

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
  }

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
  }

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
  }

  async revokedByUserId(session, options = {}) {
    const sessionToken = stringOrNull(options.sessionToken) ?? this.config.agentSessionToken
    if (sessionToken) {
      const tokenSession = await this.requireActiveAgentSessionByToken(sessionToken, session.codebase_id, 'read')
      return tokenSession.user_id
    }
    const graph = await this.readGraph(session.codebase_id)
    return stringOrNull(graph.codebase?.ownerId) ?? 'service:hopit-agent'
  }

  async resolveKeyActor(codebaseId, options = {}, capability = 'read') {
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
  }

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
  }

  async requireTrustedRecipientDevice({ recipientType, recipientId }) {
    if (recipientType !== 'device') return null
    const device = await this.first(`select * from device_keys where device_id = ? limit 1`, [recipientId])
    if (!device) throw new Error(`Recipient device ${recipientId} was not found.`)
    if (device.status !== 'trusted') throw new Error(`Recipient device ${recipientId} is not trusted.`)
    return device
  }

  async assertNoDuplicateActiveWrappedKey(value) {
    const rows = await this.query(`select * from wrapped_keys where wrapped_key_id = ?`, [value.wrappedKeyId])
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
  }

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
  }

  async allocateCollaborationNumber(codebaseId, scope, now = new Date().toISOString()) {
    const normalizedScope = collaborationScope(scope)
    const existing = await this.first(
      `select next_number from collaboration_counters where codebase_id = ? and scope = ? limit 1`,
      [codebaseId, normalizedScope],
    )
    if (existing) {
      const nextNumber = integerValue(existing.next_number, 1)
      await this.query(
        `update collaboration_counters set next_number = ?, updated_at = ? where codebase_id = ? and scope = ?`,
        [nextNumber + 1, now, codebaseId, normalizedScope],
      )
      return nextNumber
    }
    await this.query(
      `insert into collaboration_counters (codebase_id, scope, next_number, updated_at) values (?, ?, 2, ?)`,
      [codebaseId, normalizedScope, now],
    )
    return 1
  }

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
  }

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
        normalized.zoneId ?? zoneIdForPath(codebaseId, filePath),
        normalized.contentStorage ?? 'inline',
        normalized.hash ?? null,
        normalized.size ?? byteLength(normalized.content ?? ''),
        normalized.scope ?? scopeForPath(filePath),
        normalized.revision ?? graphRevision,
        normalized.updatedAt ?? now,
      ],
    )
  }

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
  }

  async first(sql, params = []) {
    const rows = await this.query(sql, params)
    return rows[0] ?? null
  }

  queryUrl() {
    const base = this.config.apiBaseUrl.replace(/\/+$/, '')
    if (!usesCloudflareD1Api(this.config) && (!this.config.accountId || !this.config.databaseId)) {
      return `${base}/query`
    }
    return `${base}/accounts/${encodeURIComponent(this.config.accountId)}/d1/database/${encodeURIComponent(this.config.databaseId)}/query`
  }

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
  }
}

export const d1SchemaStatements = [
  `create table if not exists users (
    user_id text primary key,
    primary_email text,
    display_name text,
    avatar_url text,
    email_verified integer not null default 0,
    created_at text not null,
    updated_at text not null
  )`,
  `create index if not exists idx_users_primary_email on users(primary_email)`,
  `create table if not exists codebases (
    codebase_id text primary key,
    name text not null,
    owner_id text not null,
    schema_version integer not null,
    revision integer not null,
    main_json text not null,
    selected_state_json text not null,
    owner_json text not null,
    collaborators_json text not null,
    session_json text not null,
    visibility_json text not null,
    file_count integer not null default 0,
    private_file_count integer not null default 0,
    member_count integer not null default 1,
    updated_at text not null
  )`,
  `create table if not exists files (
    codebase_id text not null,
    path text not null,
    kind text not null default 'file',
    content text not null default '',
    encoding text not null default 'utf8',
    target text,
    blob_hash text,
    blob_provider text,
    blob_key text,
    blob_size integer,
    client_encryption_json text,
    encryption_json text,
    privacy_zone text,
    zone_id text,
    content_storage text not null default 'inline',
    hash text,
    size integer,
    scope text not null,
    revision integer not null,
    updated_at text not null,
    primary key (codebase_id, path),
    foreign key (codebase_id) references codebases(codebase_id) on delete cascade
  )`,
  `create index if not exists idx_files_codebase on files(codebase_id)`,
  `create table if not exists file_blobs (
    codebase_id text not null,
    hash text not null,
    content text not null,
    encoding text not null default 'utf8',
    size integer not null,
    created_at text not null,
    primary key (codebase_id, hash)
  )`,
  `create table if not exists agent_events (
    id integer primary key autoincrement,
    codebase_id text not null,
    event text not null,
    detail_json text not null,
    at text not null,
    source text
  )`,
  `create index if not exists idx_agent_events_codebase_at on agent_events(codebase_id, at)`,
  `create index if not exists idx_agent_events_codebase_event_at on agent_events(codebase_id, event, at)`,
  `create table if not exists codebase_members (
    codebase_id text not null,
    user_id text not null,
    role text not null,
    status text not null,
    source text,
    invited_by_user_id text,
    joined_at text,
    created_at text not null,
    updated_at text not null,
    primary key (codebase_id, user_id)
  )`,
  `create index if not exists idx_codebase_members_user on codebase_members(user_id)`,
  `create table if not exists codebase_invitations (
    invitation_id text primary key,
    codebase_id text not null,
    normalized_email text not null,
    role text not null,
    token_hash text not null,
    status text not null,
    invited_by_user_id text not null,
    accepted_by_user_id text,
    revoked_by_user_id text,
    expires_at text,
    accepted_at text,
    revoked_at text,
    created_at text not null,
    updated_at text not null
  )`,
  `create index if not exists idx_codebase_invitations_codebase on codebase_invitations(codebase_id)`,
  `create index if not exists idx_codebase_invitations_token on codebase_invitations(token_hash)`,
  `create table if not exists agent_sessions (
    session_id text primary key,
    user_id text not null,
    codebase_id text not null,
    device_name text,
    token_hash text,
    token_prefix text,
    capabilities_json text not null default '[]',
    expires_at text,
    status text not null,
    created_at text not null,
    last_seen_at text not null,
    updated_at text not null,
    revoked_by_user_id text,
    revoked_at text
  )`,
  `create index if not exists idx_agent_sessions_token_hash on agent_sessions(token_hash)`,
  `create index if not exists idx_agent_sessions_user on agent_sessions(user_id)`,
  `create index if not exists idx_agent_sessions_codebase on agent_sessions(codebase_id)`,
  `create table if not exists device_keys (
    device_id text primary key,
    user_id text not null,
    display_name text,
    platform text,
    encryption_public_key text not null,
    encryption_public_key_algorithm text not null,
    encryption_public_key_encoding text not null,
    signing_public_key text,
    signing_public_key_algorithm text,
    signing_public_key_encoding text,
    status text not null,
    created_at text not null,
    trusted_at text,
    revoked_at text,
    last_seen_at text
  )`,
  `create index if not exists idx_device_keys_user on device_keys(user_id)`,
  `create index if not exists idx_device_keys_user_status on device_keys(user_id, status)`,
  `create table if not exists user_keyrings (
    user_id text primary key,
    vault_key_id text not null,
    current_version integer not null,
    status text not null,
    recovery_configured integer not null default 0,
    created_at text not null,
    updated_at text not null
  )`,
  `create table if not exists codebase_keyrings (
    codebase_id text primary key,
    repo_content_key_id text not null,
    owner_private_key_id text not null,
    git_internals_key_id text not null,
    default_secret_key_id text not null,
    rotation_state text,
    created_at text not null,
    updated_at text not null
  )`,
  `create table if not exists wrapped_keys (
    wrap_id text primary key,
    wrapped_key_id text not null,
    wrapped_key_type text not null,
    key_version integer not null,
    recipient_type text not null,
    recipient_id text not null,
    codebase_id text,
    zone_id text,
    wrapping_key_id text,
    wrapping_public_key_id text,
    algorithm text not null,
    ciphertext text not null,
    created_by_user_id text,
    created_by_device_id text,
    created_at text not null,
    expires_at text,
    revoked_at text,
    status text not null
  )`,
  `create index if not exists idx_wrapped_keys_wrapped_key on wrapped_keys(wrapped_key_id)`,
  `create index if not exists idx_wrapped_keys_recipient on wrapped_keys(recipient_type, recipient_id)`,
  `create index if not exists idx_wrapped_keys_codebase on wrapped_keys(codebase_id)`,
  `create index if not exists idx_wrapped_keys_zone on wrapped_keys(zone_id)`,
  `create table if not exists key_audit_events (
    event_id text primary key,
    codebase_id text,
    actor_user_id text,
    actor_device_id text,
    event_type text not null,
    target_user_id text,
    target_device_id text,
    zone_id text,
    key_id text,
    wrap_id text,
    created_at text not null
  )`,
  `create index if not exists idx_key_audit_events_codebase on key_audit_events(codebase_id, created_at)`,
  `create index if not exists idx_key_audit_events_actor on key_audit_events(actor_user_id, created_at)`,
  `create table if not exists action_jobs (
    job_id text primary key,
    codebase_id text not null,
    kind text not null,
    command text not null,
    args_json text not null default '[]',
    status text not null,
    requested_by_user_id text not null,
    runner_id text,
    exit_code integer,
    stdout text,
    stderr text,
    summary text,
    created_at text not null,
    updated_at text not null,
    claimed_at text,
    started_at text,
    finished_at text
  )`,
  `create index if not exists idx_action_jobs_status_created on action_jobs(status, created_at)`,
  `create index if not exists idx_action_jobs_codebase_created on action_jobs(codebase_id, created_at)`,
  `create table if not exists collaboration_counters (
    codebase_id text not null,
    scope text not null,
    next_number integer not null,
    updated_at text not null,
    primary key (codebase_id, scope)
  )`,
  `create table if not exists issues (
    issue_id text primary key,
    codebase_id text not null,
    number integer not null,
    title text not null,
    body text,
    status text not null,
    priority text,
    labels_json text not null default '[]',
    assignee_ids_json text not null default '[]',
    linked_change_set_id text,
    linked_release_id text,
    created_by text not null,
    updated_by text,
    created_at text not null,
    updated_at text not null,
    closed_at text
  )`,
  `create index if not exists idx_issues_codebase_created on issues(codebase_id, created_at)`,
  `create index if not exists idx_issues_codebase_status on issues(codebase_id, status)`,
  `create unique index if not exists idx_issues_codebase_number on issues(codebase_id, number)`,
  `create table if not exists issue_comments (
    comment_id text primary key,
    codebase_id text not null,
    issue_id text not null,
    body text not null,
    created_by text not null,
    updated_by text,
    created_at text not null,
    updated_at text not null
  )`,
  `create index if not exists idx_issue_comments_issue on issue_comments(issue_id)`,
  `create index if not exists idx_issue_comments_codebase on issue_comments(codebase_id)`,
  `create table if not exists projects (
    project_id text primary key,
    codebase_id text not null,
    number integer not null,
    name text not null,
    description text,
    status text not null,
    columns_json text not null default '[]',
    created_by text not null,
    updated_by text,
    created_at text not null,
    updated_at text not null,
    archived_at text
  )`,
  `create index if not exists idx_projects_codebase_created on projects(codebase_id, created_at)`,
  `create index if not exists idx_projects_codebase_status on projects(codebase_id, status)`,
  `create unique index if not exists idx_projects_codebase_number on projects(codebase_id, number)`,
  `create table if not exists project_items (
    project_item_id text primary key,
    codebase_id text not null,
    project_id text not null,
    item_json text not null,
    column_id text not null,
    position real not null,
    created_by text not null,
    updated_by text,
    created_at text not null,
    updated_at text not null
  )`,
  `create index if not exists idx_project_items_project on project_items(project_id)`,
  `create index if not exists idx_project_items_codebase on project_items(codebase_id)`,
  `create table if not exists discussions (
    discussion_id text primary key,
    codebase_id text not null,
    number integer not null,
    title text not null,
    body text not null,
    category text not null,
    status text not null,
    labels_json text not null default '[]',
    linked_issue_ids_json text not null default '[]',
    linked_change_set_id text,
    created_by text not null,
    updated_by text,
    created_at text not null,
    updated_at text not null,
    closed_at text
  )`,
  `create index if not exists idx_discussions_codebase_created on discussions(codebase_id, created_at)`,
  `create index if not exists idx_discussions_codebase_status on discussions(codebase_id, status)`,
  `create unique index if not exists idx_discussions_codebase_number on discussions(codebase_id, number)`,
  `create table if not exists discussion_comments (
    comment_id text primary key,
    codebase_id text not null,
    discussion_id text not null,
    body text not null,
    created_by text not null,
    updated_by text,
    created_at text not null,
    updated_at text not null
  )`,
  `create index if not exists idx_discussion_comments_discussion on discussion_comments(discussion_id)`,
  `create index if not exists idx_discussion_comments_codebase on discussion_comments(codebase_id)`,
  `create table if not exists releases (
    release_id text primary key,
    codebase_id text not null,
    number integer not null,
    version text not null,
    title text not null,
    notes text not null,
    status text not null,
    target_json text not null,
    provenance_json text,
    created_by text not null,
    updated_by text,
    created_at text not null,
    updated_at text not null,
    published_at text
  )`,
  `create index if not exists idx_releases_codebase_created on releases(codebase_id, created_at)`,
  `create index if not exists idx_releases_codebase_status on releases(codebase_id, status)`,
  `create unique index if not exists idx_releases_codebase_version on releases(codebase_id, version)`,
  `create unique index if not exists idx_releases_codebase_number on releases(codebase_id, number)`,
  `create table if not exists release_assets (
    asset_id text primary key,
    codebase_id text not null,
    release_id text not null,
    name text not null,
    kind text not null,
    url text,
    size integer,
    checksum text,
    created_by text not null,
    created_at text not null
  )`,
  `create index if not exists idx_release_assets_release on release_assets(release_id)`,
  `create index if not exists idx_release_assets_codebase on release_assets(codebase_id)`,
  `create table if not exists review_threads (
    thread_id text primary key,
    codebase_id text not null,
    change_set_id text not null,
    file_path text not null,
    line_number integer,
    base_revision text,
    head_revision text,
    line_fingerprint text,
    status text not null,
    created_by text not null,
    updated_by text,
    created_at text not null,
    updated_at text not null,
    resolved_at text
  )`,
  `create index if not exists idx_review_threads_codebase_change_set on review_threads(codebase_id, change_set_id, updated_at)`,
  `create index if not exists idx_review_threads_codebase_path on review_threads(codebase_id, file_path)`,
  `create table if not exists review_thread_comments (
    comment_id text primary key,
    codebase_id text not null,
    thread_id text not null,
    body text not null,
    created_by text not null,
    updated_by text,
    created_at text not null,
    updated_at text not null
  )`,
  `create index if not exists idx_review_thread_comments_thread on review_thread_comments(thread_id)`,
  `create index if not exists idx_review_thread_comments_codebase on review_thread_comments(codebase_id)`,
  `create table if not exists review_decisions (
    decision_id text primary key,
    codebase_id text not null,
    change_set_id text not null,
    decision text not null,
    summary text,
    created_by text not null,
    created_at text not null
  )`,
  `create index if not exists idx_review_decisions_codebase_change_set on review_decisions(codebase_id, change_set_id, created_at)`,
  `create table if not exists notifications (
    notification_id text primary key,
    codebase_id text not null,
    recipient_user_id text,
    kind text not null,
    title text not null,
    body text not null,
    href text,
    read_at text,
    created_at text not null
  )`,
  `create index if not exists idx_notifications_codebase_created on notifications(codebase_id, created_at)`,
  `create index if not exists idx_notifications_recipient_created on notifications(recipient_user_id, created_at)`,
]

function memberSelectSql(whereClause) {
  return `select
    m.codebase_id,
    m.user_id,
    m.role,
    m.status,
    m.source,
    m.invited_by_user_id,
    m.joined_at,
    m.created_at,
    m.updated_at,
    u.primary_email as profile_primary_email,
    u.display_name as profile_display_name,
    u.avatar_url as profile_avatar_url
  from codebase_members m
  left join users u on u.user_id = m.user_id
  ${whereClause}
  order by
    case m.role
      when 'owner' then 0
      when 'maintainer' then 1
      when 'member' then 2
      when 'viewer' then 3
      else 4
    end,
    m.user_id asc`
}

function mapD1Member(row) {
  const userId = stringOrNull(row.user_id) ?? ''
  const id = `${row.codebase_id}:${userId}`
  return {
    _id: id,
    id,
    codebaseId: row.codebase_id,
    userId,
    role: normalizeRole(row.role),
    status: row.status === 'suspended' ? 'suspended' : 'active',
    source: stringOrNull(row.source) ?? 'membership',
    invitedByUserId: stringOrNull(row.invited_by_user_id),
    joinedAt: stringOrNull(row.joined_at),
    createdAt: stringOrNull(row.created_at),
    updatedAt: stringOrNull(row.updated_at),
    profile: {
      userId,
      primaryEmail: stringOrNull(row.profile_primary_email),
      displayName: stringOrNull(row.profile_display_name),
      avatarUrl: stringOrNull(row.profile_avatar_url),
    },
  }
}

function mapD1Invitation(row) {
  if (!row) return null
  return {
    _id: row.invitation_id,
    id: row.invitation_id,
    invitationId: row.invitation_id,
    codebaseId: row.codebase_id,
    normalizedEmail: row.normalized_email,
    email: row.normalized_email,
    role: invitationRole(row.role),
    status: invitationStatusForRead(row),
    invitedByUserId: row.invited_by_user_id,
    acceptedByUserId: stringOrNull(row.accepted_by_user_id),
    revokedByUserId: stringOrNull(row.revoked_by_user_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: stringOrNull(row.expires_at),
    acceptedAt: stringOrNull(row.accepted_at),
    revokedAt: stringOrNull(row.revoked_at),
  }
}

function mapD1Issue(row, comments = []) {
  if (!row) return null
  return {
    _id: row.issue_id,
    id: row.issue_id,
    codebaseId: row.codebase_id,
    number: integerValue(row.number, 0),
    title: stringOrNull(row.title) ?? 'Untitled issue',
    body: stringOrNull(row.body),
    status: row.status === 'closed' ? 'closed' : 'open',
    priority: issuePriorityOrNull(row.priority),
    labels: parseStringArray(row.labels_json),
    assigneeIds: parseStringArray(row.assignee_ids_json),
    linkedChangeSetId: stringOrNull(row.linked_change_set_id),
    linkedReleaseId: stringOrNull(row.linked_release_id),
    createdBy: stringOrNull(row.created_by) ?? 'unknown',
    updatedBy: stringOrNull(row.updated_by),
    createdAt: stringOrNull(row.created_at) ?? '',
    updatedAt: stringOrNull(row.updated_at) ?? '',
    closedAt: stringOrNull(row.closed_at),
    comments,
  }
}

function mapD1IssueComment(row) {
  if (!row) return null
  return {
    _id: row.comment_id,
    id: row.comment_id,
    codebaseId: row.codebase_id,
    issueId: row.issue_id,
    body: stringOrNull(row.body) ?? '',
    createdBy: stringOrNull(row.created_by) ?? 'unknown',
    updatedBy: stringOrNull(row.updated_by),
    createdAt: stringOrNull(row.created_at) ?? '',
    updatedAt: stringOrNull(row.updated_at) ?? '',
  }
}

function mapD1Discussion(row, comments = []) {
  if (!row) return null
  return {
    _id: row.discussion_id,
    id: row.discussion_id,
    codebaseId: row.codebase_id,
    number: integerValue(row.number, 0),
    title: stringOrNull(row.title) ?? 'Untitled discussion',
    body: stringOrNull(row.body) ?? '',
    category: discussionCategory(row.category),
    status: discussionStatus(row.status),
    labels: parseStringArray(row.labels_json),
    linkedIssueIds: parseStringArray(row.linked_issue_ids_json),
    linkedChangeSetId: stringOrNull(row.linked_change_set_id),
    createdBy: stringOrNull(row.created_by) ?? 'unknown',
    updatedBy: stringOrNull(row.updated_by),
    createdAt: stringOrNull(row.created_at) ?? '',
    updatedAt: stringOrNull(row.updated_at) ?? '',
    closedAt: stringOrNull(row.closed_at),
    comments,
  }
}

function mapD1DiscussionComment(row) {
  if (!row) return null
  return {
    _id: row.comment_id,
    id: row.comment_id,
    codebaseId: row.codebase_id,
    discussionId: row.discussion_id,
    body: stringOrNull(row.body) ?? '',
    createdBy: stringOrNull(row.created_by) ?? 'unknown',
    updatedBy: stringOrNull(row.updated_by),
    createdAt: stringOrNull(row.created_at) ?? '',
    updatedAt: stringOrNull(row.updated_at) ?? '',
  }
}

function mapD1Release(row, assets = []) {
  if (!row) return null
  const target = parseJson(row.target_json, null)
  return {
    _id: row.release_id,
    id: row.release_id,
    codebaseId: row.codebase_id,
    number: integerValue(row.number, 0),
    version: stringOrNull(row.version) ?? 'unversioned',
    title: stringOrNull(row.title) ?? 'Untitled release',
    notes: stringOrNull(row.notes) ?? '',
    status: releaseStatus(row.status),
    target: normalizeReleaseTarget(target),
    createdBy: stringOrNull(row.created_by) ?? 'unknown',
    updatedBy: stringOrNull(row.updated_by),
    createdAt: stringOrNull(row.created_at) ?? '',
    updatedAt: stringOrNull(row.updated_at) ?? '',
    publishedAt: stringOrNull(row.published_at),
    assets,
  }
}

function mapD1ReleaseAsset(row) {
  if (!row) return null
  return {
    _id: row.asset_id,
    id: row.asset_id,
    releaseId: row.release_id,
    name: stringOrNull(row.name) ?? 'Unnamed asset',
    kind: releaseAssetKind(row.kind),
    url: stringOrNull(row.url),
    size: integerValue(row.size, null),
    checksum: stringOrNull(row.checksum),
    createdBy: stringOrNull(row.created_by) ?? 'unknown',
    createdAt: stringOrNull(row.created_at) ?? '',
  }
}

function mapD1ReviewThread(row, comments = []) {
  if (!row) return null
  return {
    _id: row.thread_id,
    id: row.thread_id,
    codebaseId: row.codebase_id,
    changeSetId: row.change_set_id,
    filePath: row.file_path,
    lineNumber: integerValue(row.line_number, null),
    baseRevision: stringOrNull(row.base_revision),
    headRevision: stringOrNull(row.head_revision),
    lineFingerprint: stringOrNull(row.line_fingerprint),
    status: row.status === 'resolved' ? 'resolved' : 'open',
    createdBy: stringOrNull(row.created_by) ?? 'unknown',
    updatedBy: stringOrNull(row.updated_by),
    createdAt: stringOrNull(row.created_at) ?? '',
    updatedAt: stringOrNull(row.updated_at) ?? '',
    resolvedAt: stringOrNull(row.resolved_at),
    comments,
  }
}

function mapD1ReviewThreadComment(row) {
  if (!row) return null
  return {
    _id: row.comment_id,
    id: row.comment_id,
    threadId: row.thread_id,
    body: stringOrNull(row.body) ?? '',
    createdBy: stringOrNull(row.created_by) ?? 'unknown',
    updatedBy: stringOrNull(row.updated_by),
    createdAt: stringOrNull(row.created_at) ?? '',
    updatedAt: stringOrNull(row.updated_at) ?? '',
  }
}

function mapD1ReviewDecision(row) {
  if (!row) return null
  return {
    _id: row.decision_id,
    id: row.decision_id,
    codebaseId: row.codebase_id,
    changeSetId: row.change_set_id,
    decision: reviewDecision(row.decision),
    summary: stringOrNull(row.summary),
    createdBy: stringOrNull(row.created_by) ?? 'unknown',
    createdAt: stringOrNull(row.created_at) ?? '',
  }
}

function mapD1Notification(row) {
  if (!row) return null
  return {
    _id: row.notification_id,
    id: row.notification_id,
    codebaseId: row.codebase_id,
    recipientUserId: stringOrNull(row.recipient_user_id),
    kind: notificationKind(row.kind),
    title: stringOrNull(row.title) ?? 'Notification',
    body: stringOrNull(row.body) ?? '',
    href: stringOrNull(row.href),
    readAt: stringOrNull(row.read_at),
    createdAt: stringOrNull(row.created_at) ?? '',
  }
}

function mapD1Project(row, items = []) {
  if (!row) return null
  return {
    _id: row.project_id,
    id: row.project_id,
    codebaseId: row.codebase_id,
    number: integerValue(row.number, 0),
    name: stringOrNull(row.name) ?? 'Untitled project',
    description: stringOrNull(row.description),
    status: projectStatus(row.status),
    columns: normalizeProjectColumns(parseJson(row.columns_json, [])),
    items,
    createdBy: stringOrNull(row.created_by) ?? 'unknown',
    updatedBy: stringOrNull(row.updated_by),
    createdAt: stringOrNull(row.created_at) ?? '',
    updatedAt: stringOrNull(row.updated_at) ?? '',
    archivedAt: stringOrNull(row.archived_at),
  }
}

function mapD1ProjectItem(row) {
  if (!row) return null
  const item = parseJson(row.item_json, {})
  return {
    _id: row.project_item_id,
    id: row.project_item_id,
    codebaseId: row.codebase_id,
    projectId: row.project_id,
    item: typeof item === 'object' && item !== null && !Array.isArray(item) ? item : {},
    columnId: row.column_id,
    position: typeof row.position === 'number' && Number.isFinite(row.position) ? row.position : 0,
    createdBy: stringOrNull(row.created_by) ?? 'unknown',
    updatedBy: stringOrNull(row.updated_by),
    createdAt: stringOrNull(row.created_at) ?? '',
    updatedAt: stringOrNull(row.updated_at) ?? '',
  }
}

function requireAuthenticatedActor(actor = {}, message = 'Product auth is required.') {
  const userId = stringOrNull(actor.userId)
  if (!userId) throw new Error(message)
  return {
    ...actor,
    userId,
    primaryEmail: stringOrNull(actor.primaryEmail),
    displayName: stringOrNull(actor.displayName),
    avatarUrl: stringOrNull(actor.avatarUrl),
    currentAuthEmailVerified: actor.currentAuthEmailVerified === true || actor.emailVerified === true,
  }
}

function requireVerifiedEmailActor(actor = {}, message = 'A verified account email is required.') {
  const authenticated = requireAuthenticatedActor(actor, message)
  if (!normalizeEmail(authenticated.primaryEmail) || authenticated.currentAuthEmailVerified !== true) {
    throw new Error(message)
  }
  return authenticated
}

function requireOwnerClaimActor(actor = {}) {
  const ownerActor = requireVerifiedEmailActor(actor, 'A verified account email is required to claim codebase ownership.')
  const expectedEmail = normalizeEmail(process.env.HOPIT_OWNER_EMAIL)
  if (!expectedEmail) {
    throw new Error('HOPIT_OWNER_EMAIL must be configured before a codebase owner can be claimed.')
  }
  if (normalizeEmail(ownerActor.primaryEmail) !== expectedEmail) {
    throw new Error('Authenticated account email is not allowed to claim codebase ownership.')
  }
  return ownerActor
}

function isBootstrapOwnerMember(member, graph) {
  if (member.user_id === 'local-owner') return true
  return member.source === 'graph-owner' && member.user_id === graph.codebase.ownerId
}

function claimedOwnerValue(existingOwner, actor) {
  const owner = existingOwner && typeof existingOwner === 'object' && !Array.isArray(existingOwner)
    ? { ...existingOwner }
    : {}
  owner.id = actor.userId
  owner.userId = actor.userId
  if (stringOrNull(actor.displayName)) {
    owner.name = actor.displayName
    owner.displayName = actor.displayName
  }
  if (stringOrNull(actor.primaryEmail)) {
    owner.email = actor.primaryEmail
    owner.primaryEmail = actor.primaryEmail
  }
  owner.role = 'owner'
  owner.status = 'active'
  owner.source = 'owner-claim'
  owner.joinedAt = owner.joinedAt ?? new Date().toISOString()
  return owner
}

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : ''
}

function backendErrorMessage(error, fallback) {
  return error instanceof Error ? error.message : fallback
}

function invitationRole(value) {
  if (value === 'maintainer' || value === 'viewer') return value
  return 'member'
}

function invitationStatusOrNull(value) {
  if (value === 'pending' || value === 'accepted' || value === 'revoked' || value === 'expired') return value
  return null
}

function isInvitationExpired(invitation) {
  if (invitation?.status !== 'pending') return false
  const expiresAt = stringOrNull(invitation.expires_at ?? invitation.expiresAt)
  if (!expiresAt) return false
  const time = Date.parse(expiresAt)
  return !Number.isFinite(time) || time <= Date.now()
}

function invitationStatusForRead(invitation) {
  return isInvitationExpired(invitation) ? 'expired' : invitation.status
}

function normalizeFutureTimestamp(value, label) {
  const text = stringOrNull(value)
  if (!text) return null
  const time = Date.parse(text)
  if (!Number.isFinite(time)) throw new Error(`${label} must be a valid timestamp.`)
  if (time <= Date.now()) throw new Error(`${label} must be in the future.`)
  return new Date(time).toISOString()
}

function hashInvitationToken(token) {
  const normalized = stringOrNull(token)
  if (!normalized) throw new Error('Invitation token is required.')
  return `sha256:${createHash('sha256').update(`hopit.invite.v1:${normalized}`).digest('hex')}`
}

function createAgentSessionId() {
  return `as_${randomBytes(12).toString('base64url')}`
}

function createAgentSessionToken() {
  const token = `hst_${randomBytes(32).toString('base64url')}`
  return {
    token,
    tokenHash: hashAgentSessionToken(token),
    tokenPrefix: token.slice(0, 12),
  }
}

function hashAgentSessionToken(token) {
  const normalized = stringOrNull(token)
  if (!normalized) throw new Error('Agent session token is required.')
  if (!normalized.startsWith('hst_')) throw new Error('Agent session token has an invalid format.')
  return `sha256:${createHash('sha256').update(`hopit.agent-session.v1:${normalized}`).digest('hex')}`
}

function normalizeAgentSessionId(value) {
  const sessionId = stringOrNull(value)
  if (!sessionId) throw new Error('Agent session id is required.')
  if (!/^[A-Za-z0-9_.:-]{3,160}$/.test(sessionId)) {
    throw new Error('Agent session id may only contain letters, numbers, dots, underscores, colons, and dashes.')
  }
  return sessionId
}

function assertReusableAgentSession(existing, registration) {
  if (existing.user_id !== registration.userId) {
    throw new Error(`Agent session ${existing.session_id} belongs to a different user.`)
  }
  if (existing.codebase_id !== registration.codebaseId) {
    throw new Error(`Agent session ${existing.session_id} is scoped to a different codebase.`)
  }
}

function normalizeAgentSessionCapabilities(capabilities) {
  const values = Array.isArray(capabilities) && capabilities.length > 0
    ? capabilities
    : ['read', 'write', 'sync', 'watch']
  return uniqueStrings(values)
}

function agentSessionStatusOrNull(value) {
  if (value === 'active' || value === 'revoked') return value
  return null
}

function agentSessionHasCapability(session, capability) {
  const capabilities = parseJson(session.capabilities_json, [])
  return capabilities.includes('admin') || capabilities.includes(capability)
}

function codebaseCapabilityForAgentCapability(capability) {
  if (capability === 'sync' || capability === 'watch') return 'read'
  if (capability === 'admin') return 'manage_members'
  if (
    capability === 'read' ||
    capability === 'write' ||
    capability === 'invite' ||
    capability === 'review' ||
    capability === 'merge' ||
    capability === 'release'
  ) {
    return capability
  }
  return null
}

function agentCapabilityForCodebaseCapability(capability) {
  if (capability === 'manage_members') return 'admin'
  return capability
}

function normalizeKeyEntityId(value, label) {
  const id = stringOrNull(value)
  if (!id) throw new Error(`${label} is required.`)
  if (!/^[A-Za-z0-9_.:-]{3,180}$/.test(id)) {
    throw new Error(`${label} may only contain letters, numbers, dots, underscores, colons, and dashes.`)
  }
  return id
}

function normalizePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`)
  return value
}

function nullablePositiveInteger(value, label) {
  if (value === undefined || value === null || value === '') return null
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`)
  return value
}

function nullableNonNegativeInteger(value, label) {
  if (value === undefined || value === null || value === '') return null
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`)
  return value
}

function assertDevicePublicKeyDescriptor(value) {
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

function looksLikePem(value, block) {
  const text = stringOrNull(value)
  return Boolean(text && text.includes(`-----BEGIN ${block}-----`) && text.includes(`-----END ${block}-----`))
}

function assertSameDevicePublicKeys(existing, next) {
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

function assertSameCodebaseKeyring(existing, next) {
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

function wrappedKeyType(value) {
  if (value === 'repo-content' || value === 'owner-private' || value === 'secret-group' || value === 'file-dek' || value === 'user-vault') {
    return value
  }
  throw new Error('Wrapped key type is not supported.')
}

function wrappedKeyRecipientType(value) {
  if (value === 'user' || value === 'device' || value === 'member-group') return value
  throw new Error('Wrapped key recipient type is not supported.')
}

function capabilityForWrappedKey(args) {
  if (args.wrappedKeyType === 'user-vault') return 'read'
  if (args.wrappedKeyType === 'repo-content') return 'write'
  if (args.wrappedKeyType === 'file-dek' && isPrivateZoneId(stringOrNull(args.zoneId))) return 'manage_members'
  if (args.wrappedKeyType === 'file-dek') return 'write'
  return 'manage_members'
}

function isPrivateZoneId(zoneId) {
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

function assertWrappedKeyEnvelope(args) {
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

function assertSameWrappedKey(existing, next) {
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

function effectiveWrappedKeyStatus(row, now) {
  const status = row.status ?? 'active'
  if (status !== 'active') return status
  const expiresAt = stringOrNull(row.expires_at ?? row.expiresAt)
  if (expiresAt && Date.parse(expiresAt) <= now) return 'expired'
  return 'active'
}

function canActorReadWrappedKey(row, actor, actorDeviceIds) {
  if (actor.kind === 'service') return true
  if (row.created_by_user_id === actor.userId) return true
  if (row.recipient_type === 'user' && row.recipient_id === actor.userId) return true
  if (row.recipient_type === 'device' && actorDeviceIds.has(row.recipient_id)) return true
  return false
}

function createWrappedKeyId() {
  return `wrap_${randomBytes(18).toString('base64url')}`
}

function summarizeAgentSession(row) {
  if (!row) return null
  return {
    userId: row.user_id,
    sessionId: row.session_id,
    codebaseId: row.codebase_id ?? null,
    deviceName: row.device_name ?? null,
    tokenPrefix: row.token_prefix ?? null,
    capabilities: parseJson(row.capabilities_json, []),
    expiresAt: row.expires_at ?? null,
    status: row.status,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    updatedAt: row.updated_at ?? null,
    revokedByUserId: row.revoked_by_user_id ?? null,
    revokedAt: row.revoked_at ?? null,
  }
}

function summarizeDeviceKey(row) {
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

function summarizeUserKeyring(row) {
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

function summarizeCodebaseKeyring(row) {
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

function summarizeWrappedKey(row) {
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

function deviceKeyStatusOrNull(value) {
  if (value === 'trusted' || value === 'revoked' || value === 'lost') return value
  return null
}

function isExpiredTimestamp(value) {
  const time = Date.parse(value)
  return !Number.isFinite(time) || time <= Date.now()
}

function actorAuditId(actor, override, label) {
  const actorId = stringOrNull(actor?.userId)
  return requireTextValue(actorId === 'service:hopit-agent' ? override ?? actorId : actorId, label)
}

function requireTextValue(value, label) {
  const text = stringOrNull(value)
  if (!text) throw new Error(`${label} is required.`)
  return text
}

function uniqueStrings(values) {
  return Array.isArray(values)
    ? Array.from(new Set(values.map((value) => typeof value === 'string' ? value.trim() : '').filter(Boolean))).sort()
    : []
}

function parseStringArray(value) {
  const parsed = parseJson(value, [])
  return uniqueStrings(parsed)
}

function issuePriorityOrNull(value) {
  return value === 'low' || value === 'medium' || value === 'high' ? value : null
}

function issueStatus(value) {
  if (value === 'closed' || value === 'open') return value
  throw new Error('Issue status must be open or closed.')
}

function discussionCategory(value) {
  if (value === 'ideas' || value === 'q-and-a' || value === 'announcements') return value
  return 'general'
}

function discussionStatus(value) {
  if (value === 'answered' || value === 'locked' || value === 'closed') return value
  return 'open'
}

function releaseStatus(value) {
  if (value === 'published' || value === 'archived') return value
  return 'draft'
}

function releaseAssetKind(value) {
  if (value === 'archive' || value === 'binary' || value === 'source' || value === 'checksum' || value === 'installer') {
    return value
  }
  return 'other'
}

function reviewDecision(value) {
  if (value === 'approved' || value === 'changes-requested' || value === 'commented') return value
  throw new Error('Review decision must be approved, changes-requested, or commented.')
}

function notificationKind(value) {
  const text = stringOrNull(value)
  if (!text) throw new Error('Notification kind is required.')
  if (!/^[a-z0-9_.:-]{3,80}$/.test(text)) {
    throw new Error('Notification kind may only contain letters, numbers, dots, underscores, colons, and dashes.')
  }
  return text
}

function reviewDecisionTitle(decision) {
  if (decision === 'approved') return 'Change set approved'
  if (decision === 'changes-requested') return 'Changes requested'
  return 'Review comment recorded'
}

function reviewDecisionBody(decision, reviewer, summary) {
  const note = stringOrNull(summary)
  const base =
    decision === 'approved'
      ? `${reviewer} approved the change set.`
      : decision === 'changes-requested'
        ? `${reviewer} requested changes.`
        : `${reviewer} recorded a review comment.`
  return note ? `${base} ${note}` : base
}

function reviewHref(codebaseId, changeSetId) {
  const params = new URLSearchParams()
  const normalizedChangeSetId = stringOrNull(changeSetId)
  if (normalizedChangeSetId) params.set('changeSetId', normalizedChangeSetId)
  const query = params.toString()
  return `/codebases/${encodeURIComponent(codebaseId)}/review${query ? `?${query}` : ''}`
}

function workItemHref(codebaseId, kind, itemId) {
  return `/codebases/${encodeURIComponent(codebaseId)}/work-items/${encodeURIComponent(kind)}/${encodeURIComponent(itemId)}`
}

function projectStatus(value) {
  return value === 'archived' ? 'archived' : 'active'
}

function normalizeProjectColumns(value) {
  const source = Array.isArray(value) && value.length > 0
    ? value
    : [
        { id: 'todo', name: 'Todo' },
        { id: 'in-progress', name: 'In progress' },
        { id: 'done', name: 'Done' },
      ]
  const columns = []
  const seen = new Set()
  for (const column of source) {
    const id = stringOrNull(column?.id)
    const name = stringOrNull(column?.name)
    if (!id || !name || seen.has(id)) continue
    if (!/^[a-z0-9](?:[a-z0-9_.:-]{0,62}[a-z0-9])?$/.test(id)) continue
    columns.push({ id, name })
    seen.add(id)
  }
  if (columns.length === 0) return normalizeProjectColumns(null)
  return columns.slice(0, 12)
}

function normalizeProjectColumnId(value, columns) {
  const id = stringOrNull(value) ?? columns[0]?.id
  if (!id || !columns.some((column) => column.id === id)) {
    throw new Error('Project column was not found.')
  }
  return id
}

function normalizeProjectPosition(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function projectItemType(value) {
  if (value === 'issue' || value === 'discussion' || value === 'release' || value === 'note') return value
  throw new Error('Project item type must be issue, discussion, release, or note.')
}

function normalizeReleaseTarget(value) {
  const target = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const type = target.type === 'snapshot' || target.type === 'change-set' || target.type === 'git'
    ? target.type
    : 'main'
  return {
    type,
    id: stringOrNull(target.id) ?? 'main',
    revision: integerOrNull(target.revision),
  }
}

function keyRotationState(value) {
  if (value === 'planned' || value === 'rotating' || value === 'wrapped' || value === 'stable' || value === 'blocked') {
    return value
  }
  throw new Error('Key rotation state must be planned, rotating, wrapped, stable, or blocked.')
}

function collaborationScope(value) {
  if (value === 'issue' || value === 'project' || value === 'discussion' || value === 'release') return value
  throw new Error('Unknown collaboration counter scope.')
}

function hasCapability(access, capability) {
  return Array.isArray(access?.permissions) && access.permissions.includes(capability)
}

function graphFromRows(codebaseRow, fileRows) {
  const codebase = codebaseRowToRecord(codebaseRow)
  return {
    schemaVersion: codebase.schemaVersion,
    codebase: {
      id: codebase.codebaseId,
      name: codebase.name,
      ownerId: codebase.ownerId,
    },
    main: codebase.main,
    selectedState: codebase.selectedState,
    owner: codebase.owner,
    collaborators: codebase.collaborators,
    session: codebase.session,
    visibility: codebase.visibility,
    revision: codebase.revision,
    files: Object.fromEntries(fileRows.map((row) => [row.path, fileRowToEntry(row)])),
  }
}

function codebaseRowToRecord(row) {
  return {
    codebaseId: row.codebase_id,
    name: row.name,
    ownerId: row.owner_id,
    schemaVersion: integerValue(row.schema_version, 2),
    revision: integerValue(row.revision, 0),
    main: parseJson(row.main_json, {}),
    selectedState: parseJson(row.selected_state_json, {}),
    owner: parseJson(row.owner_json, {}),
    collaborators: parseJson(row.collaborators_json, []),
    session: parseJson(row.session_json, {}),
    visibility: parseJson(row.visibility_json, null),
    fileCount: integerValue(row.file_count, 0),
    privateFileCount: integerValue(row.private_file_count, 0),
    memberCount: integerValue(row.member_count, 1),
    updatedAt: row.updated_at,
  }
}

function codebaseRecordFromGraph(graph, updatedAt) {
  return {
    codebaseId: graph.codebase.id,
    name: graph.codebase.name,
    ownerId: graph.codebase.ownerId,
    schemaVersion: graph.schemaVersion,
    revision: graph.revision,
    main: graph.main,
    selectedState: graph.selectedState,
    owner: graph.owner,
    collaborators: graph.collaborators,
    session: graph.session,
    visibility: graph.visibility,
    fileCount: Object.keys(graph.files ?? {}).length,
    privateFileCount: Object.keys(graph.files ?? {}).filter((filePath) => scopeForPath(filePath) === 'owner-private').length,
    memberCount: graphMemberCount(graph),
    updatedAt,
  }
}

function fileRowToEntry(row) {
  return {
    kind: row.kind ?? 'file',
    content: row.content ?? '',
    encoding: row.encoding ?? 'utf8',
    target: row.target ?? null,
    blobHash: row.blob_hash ?? row.hash ?? null,
    blobProvider: row.blob_provider ?? null,
    blobKey: row.blob_key ?? null,
    blobSize: row.blob_size ?? null,
    clientEncryption: parseJson(row.client_encryption_json, null),
    encryption: parseJson(row.encryption_json, null),
    privacyZone: row.privacy_zone ?? privacyZoneForPath(row.path),
    zoneId: row.zone_id ?? zoneIdForPath(row.codebase_id, row.path),
    contentStorage: row.content_storage ?? 'inline',
    hash: row.hash ?? null,
    size: integerOrNull(row.size) ?? byteLength(row.content ?? ''),
    scope: row.scope ?? scopeForPath(row.path),
    revision: integerValue(row.revision, 0),
    updatedAt: row.updated_at,
  }
}

function normalizeGraph(graph) {
  if (!graph || typeof graph !== 'object') throw new Error('Cloud graph must be an object.')
  const next = structuredClone(graph)
  if (!next.files || typeof next.files !== 'object' || Array.isArray(next.files)) next.files = {}
  next.schemaVersion = next.schemaVersion ?? 2
  next.revision = Number.isInteger(next.revision) ? next.revision : 0
  next.codebase = next.codebase ?? {}
  next.codebase.id = next.codebase.id ?? defaultCodebaseId
  next.codebase.name = next.codebase.name ?? next.codebase.id
  next.owner = next.owner ?? {}
  next.owner.id = next.owner.id ?? next.codebase.ownerId ?? 'local-owner'
  next.codebase.ownerId = next.codebase.ownerId ?? next.owner.id
  next.collaborators = Array.isArray(next.collaborators) ? next.collaborators : []
  next.main = next.main ?? {}
  next.main.id = next.main.id ?? 'main'
  next.main.revision = Number.isInteger(next.main.revision) ? next.main.revision : next.revision
  next.main.updatedAt = next.main.updatedAt ?? null
  next.main.mergedChangeSetId = next.main.mergedChangeSetId ?? null
  next.selectedState = next.selectedState ?? {}
  next.selectedState.type = next.selectedState.type ?? 'active-change-set'
  next.selectedState.id = next.selectedState.id ?? `cs_${next.codebase.id}_active`
  next.selectedState.ownerId = next.selectedState.ownerId ?? next.owner.id
  next.selectedState.baseMainId = next.selectedState.baseMainId ?? next.main.id
  next.selectedState.baseRevision = Number.isInteger(next.selectedState.baseRevision)
    ? next.selectedState.baseRevision
    : next.main.revision
  next.selectedState.revision = Number.isInteger(next.selectedState.revision)
    ? next.selectedState.revision
    : next.revision
  next.selectedState.reviewState = next.selectedState.reviewState ?? 'not-open'
  next.selectedState.mergeState = next.selectedState.mergeState ?? 'unmerged'
  next.selectedState.conflictState = next.selectedState.conflictState ?? 'none'
  next.selectedState.conflict = next.selectedState.conflict ?? null
  next.selectedState.review = next.selectedState.review ?? null
  next.selectedState.merge = next.selectedState.merge ?? null
  next.session = next.session ?? {}
  next.session.id = next.session.id ?? 'session_local'
  next.session.deviceName = next.session.deviceName ?? 'local-device'
  next.visibility = normalizeVisibilityContract(next.visibility)
  next.selectedState.visibility = next.selectedState.visibility ?? next.visibility.effective
  next.selectedState.effectiveVisibility = next.selectedState.effectiveVisibility ?? next.visibility.effective

  const files = {}
  for (const [filePath, file] of Object.entries(next.files)) {
    assertSafeGraphPath(filePath)
    files[filePath] = normalizeFileEntry(filePath, file, next.revision, file?.updatedAt ?? new Date().toISOString())
  }
  next.files = files
  return next
}

function normalizeFileEntry(filePath, file, revision, now) {
  const value = file && typeof file === 'object' ? { ...file } : {}
  const kind = value.kind === 'symlink' || value.kind === 'directory' ? value.kind : 'file'
  const scope = scopeForPath(filePath)
  const privacyZone = privacyZoneForPath(filePath)

  if (kind === 'directory') {
    return {
      kind,
      content: '',
      encoding: 'utf8',
      target: null,
      hash: stringOrNull(value.hash) ?? hashText(`directory\0${filePath}`),
      size: 0,
      scope,
      privacyZone,
      zoneId: stringOrNull(value.zoneId) ?? zoneIdForPath('unknown', filePath),
      revision: integerValue(value.revision, revision),
      updatedAt: stringOrNull(value.updatedAt) ?? now,
    }
  }

  if (kind === 'symlink') {
    const target = stringOrNull(value.target) ?? String(value.content ?? '')
    return {
      kind,
      content: target,
      encoding: 'utf8',
      target,
      hash: stringOrNull(value.hash) ?? hashText(`symlink\0${target}`),
      size: integerOrNull(value.size) ?? byteLength(target),
      scope,
      privacyZone,
      zoneId: stringOrNull(value.zoneId) ?? zoneIdForPath('unknown', filePath),
      revision: integerValue(value.revision, revision),
      updatedAt: stringOrNull(value.updatedAt) ?? now,
    }
  }

  const content = typeof value.content === 'string' ? value.content : ''
  const encoding = value.encoding === 'base64' ? 'base64' : 'utf8'
  const contentStorage = value.contentStorage === 'object-blob' ? 'object-blob' : 'inline'
  const hash = stringOrNull(value.hash) ?? stringOrNull(value.blobHash) ?? hashText(content)

  return {
    kind,
    content,
    encoding,
    target: null,
    contentStorage,
    blobProvider: stringOrNull(value.blobProvider),
    blobKey: stringOrNull(value.blobKey),
    blobHash: stringOrNull(value.blobHash) ?? hash,
    blobSize: integerOrNull(value.blobSize),
    clientEncryption: value.clientEncryption ?? null,
    encryption: value.encryption ?? null,
    hash,
    size: integerOrNull(value.size) ?? byteLength(content),
    scope,
    privacyZone,
    zoneId: stringOrNull(value.zoneId) ?? zoneIdForPath('unknown', filePath),
    revision: integerValue(value.revision, revision),
    updatedAt: stringOrNull(value.updatedAt) ?? now,
  }
}

function normalizeVisibilityContract(value) {
  const base = value && typeof value === 'object' ? { ...value } : {}
  const effective = normalizeVisibilityValue(base.effective ?? base.changeSetOverride ?? base.codebaseOverride ?? 'private')
  return {
    productDefault: normalizeVisibilityValue(base.productDefault ?? 'private'),
    globalUserDefault: normalizeOptionalVisibility(base.globalUserDefault),
    codebaseOverride: normalizeOptionalVisibility(base.codebaseOverride),
    changeSetOverride: normalizeOptionalVisibility(base.changeSetOverride),
    effective,
  }
}

function normalizeOptionalVisibility(value) {
  return value === 'private' || value === 'team-visible' || value === 'review-visible' ? value : null
}

function normalizeVisibilityValue(value) {
  if (value === 'private' || value === 'team-visible' || value === 'review-visible') return value
  return 'private'
}

function visibilityContextForGraph(graph, request = {}) {
  if (!request.requesterId && !request.sessionId && graph.visibilityContext) return graph.visibilityContext
  const ownerId = graph.owner?.id ?? graph.codebase?.ownerId ?? null
  const requesterId = request.requesterId ?? ownerId
  const membership = request.membership ?? null
  const collaborator = (graph.collaborators ?? []).find((entry) => (entry.id ?? entry.userId) === requesterId) ?? null
  const isOwner = Boolean(requesterId && requesterId === ownerId)
  const activeMembership = membership?.status === 'active' ? membership : null
  const role = isOwner
    ? 'owner'
    : activeMembership
      ? normalizeRole(activeMembership.role)
      : collaborator
        ? normalizeRole(collaborator?.role)
        : 'guest'
  const context = {
    id: requesterId ?? null,
    sessionId: request.sessionId ?? null,
    role,
    isOwner,
    isCollaborator: role !== 'guest' && !isOwner,
    membershipSource: isOwner
      ? 'owner'
      : activeMembership
        ? 'membership'
        : membership
          ? stringOrNull(membership.source) ?? 'membership'
          : collaborator
            ? 'graph-collaborator'
            : 'none',
    permissions: permissionsForRole(role),
    visibleFileCount: null,
    hiddenFileCount: null,
    hiddenScopeCounts: { shared: 0, private: 0 },
  }
  return context
}

function filterVisibleGraphForRequester(graph, request = {}) {
  const next = normalizeGraph(graph)
  const context = visibilityContextForGraph(next, request)
  return filterVisibleGraphForAccess(next, context)
}

function filterVisibleGraphForAccess(graph, context) {
  const next = normalizeGraph(graph)
  const files = {}
  const hiddenPaths = []
  for (const [filePath, file] of Object.entries(next.files ?? {})) {
    if (!canRequesterSeePath(context, filePath)) {
      hiddenPaths.push(filePath)
      continue
    }
    files[filePath] = file
  }
  next.files = files
  next.visibilityContext = {
    ...context,
    visibleFileCount: Object.keys(files).length,
    hiddenFileCount: hiddenPaths.length,
    hiddenScopeCounts: countPathScopes(hiddenPaths),
  }
  return next
}

function canRequesterSeePath(context, filePath) {
  if (scopeForPath(filePath) !== 'owner-private') return visibleRoles.has(context.role)
  return context.isOwner
}

function canRead(context) {
  return visibleRoles.has(context.role)
}

function canWrite(context) {
  return writeRoles.has(context.role)
}

function permissionsForRole(role) {
  if (role === 'owner') return ['read', 'write', 'invite', 'admin', 'manage_members', 'review', 'merge', 'release']
  if (role === 'maintainer') return ['read', 'write', 'invite', 'review', 'merge', 'release']
  if (role === 'member') return ['read', 'write', 'review']
  if (role === 'viewer') return ['read']
  return []
}

function summarizeAccessContext(context) {
  if (!context) return null
  return {
    id: context.id ?? null,
    sessionId: context.sessionId ?? null,
    role: context.role ?? 'guest',
    isOwner: Boolean(context.isOwner),
    isCollaborator: Boolean(context.isCollaborator),
    membershipSource: context.membershipSource ?? 'fallback',
    permissions: Array.isArray(context.permissions) ? context.permissions : [],
    visibleFileCount: context.visibleFileCount ?? null,
    hiddenFileCount: context.hiddenFileCount ?? null,
    hiddenScopeCounts: context.hiddenScopeCounts ?? { shared: 0, private: 0 },
  }
}

function summarizeCodebaseHead(codebase, access = null) {
  const main = codebase.main && typeof codebase.main === 'object' ? codebase.main : {}
  const selectedState = codebase.selectedState && typeof codebase.selectedState === 'object'
    ? codebase.selectedState
    : null
  const ownerId = stringOrNull(codebase.ownerId) ?? stringOrNull(codebase.owner?.id)
  return {
    exists: true,
    schemaVersion: integerOrNull(codebase.schemaVersion),
    codebase: {
      id: codebase.codebaseId,
      name: stringOrNull(codebase.name) ?? codebase.codebaseId,
      ownerId,
    },
    main: {
      id: stringOrNull(main.id),
      revision: integerOrNull(main.revision),
    },
    selectedState: selectedState
      ? {
          type: stringOrNull(selectedState.type),
          id: stringOrNull(selectedState.id),
          ownerId: stringOrNull(selectedState.ownerId),
          baseMainId: stringOrNull(selectedState.baseMainId),
          baseRevision: integerOrNull(selectedState.baseRevision),
          revision: integerOrNull(selectedState.revision),
          visibility: stringOrNull(selectedState.visibility),
          effectiveVisibility: stringOrNull(selectedState.effectiveVisibility),
          reviewState: stringOrNull(selectedState.reviewState),
          mergeState: stringOrNull(selectedState.mergeState),
          conflictState: stringOrNull(selectedState.conflictState),
        }
      : null,
    owner: ownerId ? { id: ownerId } : null,
    session: codebase.session
      ? {
          id: stringOrNull(codebase.session.id),
          deviceName: stringOrNull(codebase.session.deviceName),
        }
      : null,
    visibility: codebase.visibility ?? null,
    access: access ? summarizeAccessContext(access) : null,
    revision: integerOrNull(codebase.revision),
    fileCount: integerOrNull(codebase.fileCount),
    privateFileCount: integerOrNull(codebase.privateFileCount),
    memberCount: integerOrNull(codebase.memberCount),
    remoteUpdate: summarizeCodebaseRemoteUpdate(codebase),
    updatedAt: stringOrNull(codebase.updatedAt),
  }
}

function summarizeCodebaseRemoteUpdate(codebase) {
  const selectedState = codebase.selectedState && typeof codebase.selectedState === 'object'
    ? codebase.selectedState
    : null
  return {
    state: 'cloud-head-ready',
    delivery: 'manual-or-activity-gated',
    graphRevision: integerOrNull(codebase.revision),
    mainRevision: integerOrNull(codebase.main?.revision),
    selectedStateRevision: integerOrNull(selectedState?.revision),
    updatedAt: stringOrNull(codebase.updatedAt),
  }
}

function accessContextForCodebaseHead(codebase, context) {
  if (!context) return null

  const fileCount = integerOrNull(codebase.fileCount) ?? 0
  const privateFileCount = integerOrNull(codebase.privateFileCount) ?? 0
  const sharedFileCount = Math.max(0, fileCount - privateFileCount)
  const effectiveVisibility =
    stringOrNull(codebase.selectedState?.effectiveVisibility) ??
    stringOrNull(codebase.visibility?.effective) ??
    'private'
  const visibleFileCount = context.isOwner
    ? fileCount
    : context.role === 'guest' || effectiveVisibility === 'private'
      ? 0
      : sharedFileCount
  const hiddenFileCount = Math.max(0, fileCount - visibleFileCount)

  return {
    ...context,
    visibleFileCount,
    hiddenFileCount,
    hiddenScopeCounts: {
      shared: Math.max(0, sharedFileCount - visibleFileCount),
      private: context.isOwner ? 0 : privateFileCount,
    },
  }
}

function buildStatus(graph, events, access = null, backend = {}) {
  const filePaths = Object.keys(graph.files ?? {})
  const privateCount = filePaths.filter((filePath) => scopeForPath(filePath) === 'owner-private').length
  const syncHealth = buildSyncHealth(events)
  const refreshHealth = buildRefreshHealth(events)
  const accessSummary = summarizeAccessContext(graph.visibilityContext ?? access)
  return {
    ok: syncHealth.state !== 'failed' && refreshHealth.state !== 'blocked',
    generatedAt: new Date().toISOString(),
    mode: {
      adapter: 'managed-folder',
      cacheMode: 'local-cache',
      sourceOfTruth: backend.sourceOfTruth ?? 'd1',
    },
    codebaseId: graph.codebase?.id ?? null,
    codebaseName: graph.codebase?.name ?? null,
    selectedStateType: graph.selectedState?.type ?? null,
    activeChangeSetId: graph.selectedState?.type === 'active-change-set' ? graph.selectedState?.id : null,
    mainId: graph.main?.id ?? null,
    ownerId: graph.owner?.id ?? graph.codebase?.ownerId ?? null,
    sessionId: graph.session?.id ?? null,
    requesterId: accessSummary?.id ?? null,
    requesterSessionId: accessSummary?.sessionId ?? null,
    requesterRole: accessSummary?.role ?? null,
    access: accessSummary,
    visibleFileCount: accessSummary?.visibleFileCount ?? filePaths.length,
    hiddenFileCount: accessSummary?.hiddenFileCount ?? 0,
    hiddenScopeCounts: accessSummary?.hiddenScopeCounts ?? { shared: 0, private: 0 },
    effectiveChangeSetVisibility: graph.selectedState?.effectiveVisibility ?? graph.visibility?.effective ?? null,
    review: {
      state: graph.selectedState?.reviewState ?? 'not-open',
      detail: graph.selectedState?.review ?? null,
    },
    merge: {
      state: graph.selectedState?.mergeState ?? 'unmerged',
      detail: graph.selectedState?.merge ?? null,
      mainRevision: graph.main?.revision ?? null,
    },
    conflict: {
      state: graph.selectedState?.conflictState ?? 'none',
      detail: graph.selectedState?.conflict ?? null,
    },
    workspace: {
      path: 'Cloudflare D1 backend',
      exists: true,
      adapter: 'managed-folder',
      cacheMode: 'local-cache',
    },
    cloud: {
      path: backend.path ?? `d1:${graph.codebase?.id ?? 'unknown'}`,
      service: backend.service ?? d1CloudServiceType,
      exists: true,
      schemaVersion: graph.schemaVersion ?? null,
      codebase: graph.codebase ?? null,
      main: graph.main ?? null,
      selectedState: graph.selectedState ?? null,
      owner: graph.owner ?? null,
      session: graph.session ?? null,
      requester: accessSummary,
      visibility: graph.visibility ?? null,
      revision: graph.revision ?? null,
      fileCount: filePaths.length,
      scopeCounts: { shared: filePaths.length - privateCount, private: privateCount },
    },
    journal: {
      pendingCount: 0,
      failedCount: 0,
      acknowledgedCount: 0,
    },
    sync: {
      ...syncHealth,
      lastSuccessfulAt: events.lastSync?.at ?? null,
      lastAcknowledgementAt: events.lastAcknowledgement?.at ?? null,
    },
    refresh: refreshHealth,
    remoteUpdate: {
      state: events.lastRemoteUpdate ? 'updated' : 'idle',
      lastUpdate: events.lastRemoteUpdate ?? null,
    },
    events,
  }
}

function buildSyncHealth(events) {
  const latestSyncEvent = events.latestSyncEvent
  let state = 'idle'
  if (latestSyncEvent?.event === 'sync.failed') state = 'failed'
  else if (latestSyncEvent?.event === 'sync.started') state = 'syncing'
  else if (latestSyncEvent?.event === 'sync.complete' || latestSyncEvent?.event === 'sync.recovered') state = 'healthy'
  return {
    state,
    latest: latestSyncEvent ?? null,
    lastStarted: events.lastStartedSync ?? null,
    lastCompleted: events.lastSync ?? null,
    lastFailed: events.lastFailedSync ?? null,
    lastRecovered: events.lastRecoveredSync ?? null,
  }
}

function buildRefreshHealth(events) {
  const latestRefreshEvent = events.latestRefreshEvent
  let state = 'idle'
  if (latestRefreshEvent?.event === 'refresh.blocked') state = 'blocked'
  else if (latestRefreshEvent?.event === 'refresh.started') state = 'refreshing'
  else if (latestRefreshEvent?.event === 'refresh.complete') state = 'healthy'
  return {
    state,
    latest: latestRefreshEvent ?? null,
    lastStarted: events.lastRefreshStarted ?? null,
    lastBlocked: events.lastRefreshBlocked ?? null,
    lastCompleted: events.lastRefreshComplete ?? null,
  }
}

function mapD1AgentEvent(row) {
  return {
    id: String(row.id ?? `${row.event}:${row.at}`),
    event: row.event,
    type: row.event,
    at: row.at,
    timestamp: row.at,
    detail: parseJson(row.detail_json, {}),
    payload: parseJson(row.detail_json, {}),
    source: row.source ?? null,
  }
}

function latestEventOf(events) {
  return events.reduce((latest, event) => {
    if (!event) return latest
    if (!latest) return event
    return Date.parse(event.at ?? '') >= Date.parse(latest.at ?? '') ? event : latest
  }, null)
}

function applyJournalEntryToCloud(cloud, entry, options = {}) {
  const nextRevision = (cloud.revision ?? 0) + 1
  cloud.revision = nextRevision
  cloud.main = cloud.main ?? {}
  cloud.main.revision = nextRevision
  cloud.selectedState = cloud.selectedState ?? {}
  cloud.selectedState.revision = nextRevision
  const now = new Date().toISOString()

  if (entry.type === 'delete') {
    delete cloud.files[entry.path]
  } else {
    cloud.files[entry.path] = normalizeFileEntry(entry.path, options.entry ?? {
      kind: entry.kind ?? 'file',
      content: options.content ?? '',
      encoding: entry.encoding ?? 'utf8',
      hash: entry.hash,
      size: entry.bytes,
    }, nextRevision, now)
  }

  return {
    ok: true,
    revision: nextRevision,
    path: entry.path,
    type: entry.type,
  }
}

function actionCommandForKind(kind) {
  if (kind === 'lint') return { command: 'npm', args: ['run', 'lint'] }
  if (kind === 'test') return { command: 'npm', args: ['test'] }
  if (kind === 'build') return { command: 'npm', args: ['run', 'build'] }
  throw new Error('Action kind must be lint, test, or build.')
}

function summarizeActionJob(row) {
  if (!row) return null
  const job = row.job_id
    ? {
        jobId: row.job_id,
        codebaseId: row.codebase_id,
        kind: row.kind,
        command: row.command,
        args: parseJson(row.args_json, []),
        status: row.status,
        requestedByUserId: row.requested_by_user_id,
        runnerId: row.runner_id ?? undefined,
        exitCode: row.exit_code ?? null,
        stdout: row.stdout ?? undefined,
        stderr: row.stderr ?? undefined,
        summary: row.summary ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        claimedAt: row.claimed_at ?? undefined,
        startedAt: row.started_at ?? undefined,
        finishedAt: row.finished_at ?? undefined,
      }
    : row
  return {
    jobId: job.jobId,
    codebaseId: job.codebaseId,
    kind: job.kind,
    command: job.command,
    args: Array.isArray(job.args) ? job.args : [],
    status: job.status,
    requestedByUserId: job.requestedByUserId,
    runnerId: job.runnerId ?? null,
    exitCode: job.exitCode ?? null,
    stdout: job.stdout ?? null,
    stderr: job.stderr ?? null,
    summary: job.summary ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    claimedAt: job.claimedAt ?? null,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
  }
}

function actionSummary(status, exitCode) {
  if (status === 'succeeded') return 'Command completed successfully.'
  if (status === 'cancelled') return 'Command was cancelled.'
  return `Command failed${Number.isInteger(exitCode) ? ` with exit code ${exitCode}` : ''}.`
}

function capOutput(value) {
  return typeof value === 'string' ? value.slice(-20_000) : undefined
}

function normalizeCodebaseName(value) {
  const name = stringOrNull(value)
  if (!name) throw new Error('Codebase name is required.')
  if (name.length > 120) throw new Error('Codebase name must be 120 characters or fewer.')
  return name
}

function normalizeNewCodebaseId(value) {
  const codebaseId = stringOrNull(value)
  if (!codebaseId) throw new Error('Codebase id is required.')
  if (!/^[a-z0-9][a-z0-9._-]{1,80}$/.test(codebaseId)) {
    throw new Error('Codebase id must be 2-81 lowercase letters, numbers, dots, underscores, or dashes.')
  }
  return codebaseId
}

function slugifyCodebaseId(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'codebase'
}

function normalizeRole(value) {
  if (value === 'owner' || value === 'maintainer' || value === 'member' || value === 'viewer') return value
  return 'guest'
}

function graphMemberCount(graph) {
  return 1 + (Array.isArray(graph.collaborators) ? graph.collaborators.length : 0)
}

function countPathScopes(paths) {
  const counts = { shared: 0, private: 0 }
  for (const filePath of paths) {
    if (scopeForPath(filePath) === 'owner-private') counts.private += 1
    else counts.shared += 1
  }
  return counts
}

function scopeForPath(filePath) {
  return filePath === '.private' || filePath.startsWith('.private/') ? 'owner-private' : 'shared'
}

function privacyZoneForPath(filePath) {
  if (filePath === '.private/env' || filePath.startsWith('.private/env/')) return 'secrets'
  if (filePath === '.private/git' || filePath.startsWith('.private/git/')) return 'git-internals'
  if (scopeForPath(filePath) === 'owner-private') return 'owner-private'
  return 'repo-content'
}

function zoneIdForPath(codebaseId, filePath) {
  return `${codebaseId}:${privacyZoneForPath(filePath)}`
}

function assertSafeGraphPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.startsWith('/') || filePath.includes('\\')) {
    throw new Error(`Invalid HopIt graph path: ${filePath}`)
  }
  const parts = filePath.split('/')
  if (parts.includes('..') || parts.includes('')) throw new Error(`Invalid HopIt graph path: ${filePath}`)
}

function hashText(value) {
  return createHash('sha256').update(value).digest('hex')
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8')
}

function parseJson(value, fallback) {
  if (typeof value !== 'string' || value.length === 0) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function stringifyJson(value) {
  return JSON.stringify(value ?? null)
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null
}

function integerValue(value, fallback) {
  return Number.isInteger(value) ? value : fallback
}

function boundedLimit(value, max) {
  return Math.max(1, Math.min(max, Number.isInteger(value) ? value : max))
}

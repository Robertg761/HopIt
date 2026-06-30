import { createHash, randomUUID } from 'node:crypto'

export const d1CloudServiceType = 'cloudflare-d1-graph'

const defaultD1ApiBaseUrl = 'https://api.cloudflare.com/client/v4'
const defaultCodebaseId = 'hopit'
const visibleRoles = new Set(['owner', 'maintainer', 'member', 'viewer'])
const writeRoles = new Set(['owner', 'maintainer'])
const inviteRoles = new Set(['owner', 'maintainer'])
const adminRoles = new Set(['owner'])

export function d1ConfigFromOptions(options = {}, env = process.env) {
  return {
    accountId: stringOrNull(options['d1-account-id']) ?? stringOrNull(env.HOPIT_D1_ACCOUNT_ID) ?? stringOrNull(env.CLOUDFLARE_ACCOUNT_ID),
    databaseId: stringOrNull(options['d1-database-id']) ?? stringOrNull(env.HOPIT_D1_DATABASE_ID),
    apiToken: stringOrNull(options['d1-api-token']) ?? stringOrNull(env.HOPIT_D1_API_TOKEN) ?? stringOrNull(env.CLOUDFLARE_API_TOKEN),
    apiBaseUrl: stringOrNull(options['d1-api-base-url']) ?? stringOrNull(env.HOPIT_D1_API_BASE_URL) ?? defaultD1ApiBaseUrl,
    codebaseId: stringOrNull(options['codebase-id']) ?? stringOrNull(env.HOPIT_CODEBASE_ID) ?? defaultCodebaseId,
  }
}

export function isD1Configured(options = {}, env = process.env) {
  const config = d1ConfigFromOptions(options, env)
  return Boolean(config.accountId && config.databaseId && config.apiToken)
}

export function createD1Backend(options = {}, env = process.env) {
  return new CloudflareD1HopBackend(d1ConfigFromOptions(options, env))
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
    for (const sql of d1SchemaStatements) {
      await this.query(sql)
    }
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
    return filterVisibleGraphForRequester(await this.readGraph(codebaseId), request)
  }

  async readOptionalVisibleGraph(request = {}, codebaseId = this.codebaseId) {
    const graph = await this.readOptionalGraph(codebaseId)
    return graph ? filterVisibleGraphForRequester(graph, request) : null
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

    const visibleGraph = filterVisibleGraphForRequester(graph, {
      requesterId: requesterUserId,
      sessionId: requesterSessionId,
    })
    const access = visibleGraph.visibilityContext
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
        access: summarizeAccessContext(access),
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

    return rows.map((row) => summarizeCodebaseHead(codebaseRowToRecord(row), null))
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
    const access = visibilityContextForGraph(graph, { requesterId: actor.userId })
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
    const access = visibilityContextForGraph(graph, { requesterId: actor.userId })
    if (!access.isOwner) throw new Error('Only the codebase owner can delete a codebase.')
    await this.query(`delete from files where codebase_id = ?`, [codebaseId])
    await this.query(`delete from file_blobs where codebase_id = ?`, [codebaseId])
    await this.query(`delete from agent_events where codebase_id = ?`, [codebaseId])
    await this.query(`delete from codebase_members where codebase_id = ?`, [codebaseId])
    await this.query(`delete from codebase_invitations where codebase_id = ?`, [codebaseId])
    await this.query(`delete from action_jobs where codebase_id = ?`, [codebaseId])
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
    const access = visibilityContextForGraph(graph, { requesterId: actor.userId })
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
    const access = visibilityContextForGraph(graph, { requesterId: actor.userId })
    if (!canRead(access)) throw new Error(`User cannot read ${codebaseId}.`)
    const rows = await this.query(
      `select * from action_jobs where codebase_id = ? order by created_at desc limit ?`,
      [codebaseId, boundedLimit(limit, 30)],
    )
    return rows.map(summarizeActionJob)
  }

  async createActionJob({ codebaseId, kind, actor = {} }) {
    const graph = await this.readGraph(codebaseId)
    const access = visibilityContextForGraph(graph, { requesterId: actor.userId })
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
    const response = await fetch(this.queryUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiToken}`,
        'Content-Type': 'application/json',
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
    return `${base}/accounts/${encodeURIComponent(this.config.accountId)}/d1/database/${encodeURIComponent(this.config.databaseId)}/query`
  }

  assertConfigured() {
    const missing = []
    if (!this.config.accountId) missing.push('HOPIT_D1_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID')
    if (!this.config.databaseId) missing.push('HOPIT_D1_DATABASE_ID')
    if (!this.config.apiToken) missing.push('HOPIT_D1_API_TOKEN or CLOUDFLARE_API_TOKEN')
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
]

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
  const collaborator = (graph.collaborators ?? []).find((entry) => (entry.id ?? entry.userId) === requesterId) ?? null
  const isOwner = Boolean(requesterId && requesterId === ownerId)
  const role = isOwner ? 'owner' : normalizeRole(collaborator?.role)
  const context = {
    id: requesterId ?? null,
    sessionId: request.sessionId ?? null,
    role,
    isOwner,
    isCollaborator: Boolean(collaborator),
    membershipSource: isOwner ? 'owner' : collaborator ? 'graph-collaborator' : 'fallback',
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
  const permissions = []
  if (visibleRoles.has(role)) permissions.push('read')
  if (writeRoles.has(role)) permissions.push('write')
  if (inviteRoles.has(role)) permissions.push('invite')
  if (adminRoles.has(role)) permissions.push('admin', 'manage_members')
  return permissions
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
    updatedAt: stringOrNull(codebase.updatedAt),
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

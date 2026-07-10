import { privacyZoneForPath, privacyZoneIdForPath, scopeForPath } from '@hopit/core/privacy-zone'
import { d1CloudServiceType, defaultCodebaseId } from '../config.js'
import { assertSafeGraphPath, byteLength, countPathScopes, graphMemberCount, hashText, integerOrNull, integerValue, normalizeRole, parseJson, stringOrNull, summarizeAccessContext } from './base.js'

export function graphFromRows(codebaseRow, fileRows) {
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

export function codebaseRowToRecord(row) {
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

export function codebaseRecordFromGraph(graph, updatedAt) {
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

export function fileRowToEntry(row) {
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
    zoneId: row.zone_id ?? privacyZoneIdForPath(row.codebase_id, row.path),
    contentStorage: row.content_storage ?? 'inline',
    hash: row.hash ?? null,
    size: integerOrNull(row.size) ?? byteLength(row.content ?? ''),
    scope: row.scope ?? scopeForPath(row.path),
    revision: integerValue(row.revision, 0),
    updatedAt: row.updated_at,
  }
}

export function normalizeGraph(graph) {
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
    files[filePath] = normalizeFileEntry(filePath, file, next.revision, file?.updatedAt ?? new Date().toISOString(), next.codebase.id)
  }
  next.files = files
  return next
}

export function normalizeFileEntry(filePath, file, revision, now, codebaseId = null) {
  const value = file && typeof file === 'object' ? { ...file } : {}
  const kind = value.kind === 'symlink' || value.kind === 'directory' ? value.kind : 'file'
  const scope = scopeForPath(filePath)
  const privacyZone = privacyZoneForPath(filePath)
  // Agent journal payloads never carry zoneId. Compute it from the real
  // codebase id so we never persist a `unknown:<zone>` placeholder; when the
  // caller has no codebase id we leave it null for the writer to fill.
  const zoneId = stringOrNull(value.zoneId) ?? (codebaseId ? privacyZoneIdForPath(codebaseId, filePath) : null)

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
      zoneId,
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
      zoneId,
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
    zoneId,
    revision: integerValue(value.revision, revision),
    updatedAt: stringOrNull(value.updatedAt) ?? now,
  }
}

export function normalizeVisibilityContract(value) {
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

export function normalizeOptionalVisibility(value) {
  return value === 'private' || value === 'team-visible' || value === 'review-visible' ? value : null
}

export function normalizeVisibilityValue(value) {
  if (value === 'private' || value === 'team-visible' || value === 'review-visible') return value
  return 'private'
}

export function summarizeCodebaseHead(codebase, access = null) {
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

export function summarizeCodebaseRemoteUpdate(codebase) {
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

export function buildStatus(graph, events, access = null, backend = {}) {
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

export function buildSyncHealth(events) {
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

export function buildRefreshHealth(events) {
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

export function mapD1AgentEvent(row) {
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

export function latestEventOf(events) {
  return events.reduce((latest, event) => {
    if (!event) return latest
    if (!latest) return event
    return Date.parse(event.at ?? '') >= Date.parse(latest.at ?? '') ? event : latest
  }, null)
}

export function applyJournalEntryToCloud(cloud, entry, options = {}) {
  if (!cloud.files || typeof cloud.files !== 'object') cloud.files = {}
  if (!Number.isInteger(cloud.revision)) cloud.revision = 0
  if (cloud.selectedState && !Number.isInteger(cloud.selectedState.revision)) {
    cloud.selectedState.revision = cloud.revision
  }
  assertEntrySelectedStateRevision(cloud, entry)
  assertEntryBaseRevision(cloud, entry)

  const nextRevision = cloud.revision + 1
  cloud.revision = nextRevision
  cloud.main = cloud.main ?? {}
  cloud.main.revision = nextRevision
  cloud.selectedState = cloud.selectedState ?? {}
  cloud.selectedState.revision = nextRevision
  const now = options.now ?? new Date().toISOString()

  if (entry.type === 'delete') {
    delete cloud.files[entry.path]
  } else {
    cloud.files[entry.path] = normalizeFileEntry(entry.path, options.entry ?? {
      kind: entry.kind ?? 'file',
      content: options.content ?? '',
      encoding: entry.encoding ?? 'utf8',
      hash: entry.hash,
      size: entry.bytes,
    }, nextRevision, now, cloud.codebase?.id ?? null)
  }

  return {
    ok: true,
    revision: nextRevision,
    path: entry.path,
    type: entry.type,
  }
}

function assertEntrySelectedStateRevision(cloud, entry) {
  if (!Object.hasOwn(entry, 'targetStateRevision') || entry.targetStateRevision === undefined) return

  const actualRevision = cloud.selectedState?.revision ?? null
  if (entry.targetStateRevision === actualRevision) return

  throw new BackendConflictError(
    `selected_state_revision_mismatch: expected ${entry.targetStateRevision}, got ${actualRevision}`,
    {
      reason: 'selected_state_revision_mismatch',
      id: entry.id,
      type: entry.type,
      path: entry.path,
      scope: entry.scope ?? scopeForPath(entry.path ?? ''),
      expectedRevision: entry.targetStateRevision,
      actualRevision,
      selectedStateId: cloud.selectedState?.id ?? null,
      selectedStateRevision: actualRevision,
    },
  )
}

function assertEntryBaseRevision(cloud, entry) {
  if (!Object.hasOwn(entry, 'baseRevision') || entry.baseRevision === undefined) return

  const current = cloud.files?.[entry.path]
  const actualRevision = current?.revision ?? null
  if (entry.baseRevision === actualRevision) return

  throw new BackendConflictError(
    `base_revision_mismatch: expected ${entry.baseRevision}, got ${actualRevision}`,
    {
      reason: 'base_revision_mismatch',
      id: entry.id,
      type: entry.type,
      path: entry.path,
      scope: entry.scope ?? scopeForPath(entry.path ?? ''),
      expectedRevision: entry.baseRevision,
      actualRevision,
      selectedStateId: cloud.selectedState?.id ?? null,
      selectedStateRevision: cloud.selectedState?.revision ?? null,
    },
  )
}

class BackendConflictError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'ConflictError'
    this.detail = detail
  }
}

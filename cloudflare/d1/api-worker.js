import { CodebasePushHub, normalizeRemoteUpdateEnvelope } from './push-hub.js'
import { assertScopedSessionStatementAllowed, assertServerActorStatementAllowed } from './scoped-sql.js'
import { assertBrokerKeyForCodebase, brokerR2ConfigFromEnv, isBrokerPresignPath, normalizeBrokerMethod, presignBlobUrl } from './blob-broker.js'
import {
  buildMeterUpsertStatement,
  computeUsageStatus,
  evaluateWriteQuota,
  isQuotaEnforced,
  resolvePlanLimits,
  utcDay,
  warnRatioFromEnv,
} from './quota.js'

function isMultiTenantEnabled(env) {
  return /^(1|true|yes|on)$/i.test(String(env?.HOPIT_MULTITENANT ?? ''))
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function cloudflareError(message, code = 10000, status = 400) {
  return json({
    success: false,
    errors: [{ code, message }],
    messages: [],
    result: [],
  }, status)
}

function authenticationError(message = 'Authentication error') {
  return cloudflareError(message, 10000, 403)
}

const failedAuthBuckets = new Map()
const failedAuthWindowMs = 5 * 60 * 1000
const failedAuthLimit = 20

function prepareStatement(db, statement) {
  if (!statement || typeof statement.sql !== 'string' || statement.sql.trim() === '') {
    throw new Error('Expected a non-empty SQL statement.')
  }
  const params = Array.isArray(statement.params) ? statement.params : []
  return db.prepare(statement.sql).bind(...params)
}

function statementResult(executed, startedAt) {
  if (executed?.success === false) {
    throw new Error(executed.error ?? executed.meta?.error ?? 'D1 statement failed.')
  }
  return {
    results: executed.results ?? [],
    success: true,
    meta: {
      ...(executed.meta ?? {}),
      duration: executed.meta?.duration ?? Math.max(0, Date.now() - startedAt),
    },
  }
}

async function executeStatements(db, statements) {
  const startedAt = Date.now()
  const prepared = statements.map((statement) => prepareStatement(db, statement))
  if (statements.length > 1 && typeof db.batch === 'function') {
    const executed = await db.batch(prepared)
    if (!Array.isArray(executed) || executed.length !== statements.length) {
      throw new Error('D1 batch returned an unexpected result count.')
    }
    return executed.map((result) => statementResult(result, startedAt))
  }

  const results = []
  for (const statement of prepared) {
    results.push(statementResult(await statement.all(), startedAt))
  }
  return results
}

async function authorizeRequest(request, env, statements, options = {}) {
  const token = bearerTokenFromRequest(request)
  const expectedToken = env.HOPIT_D1_PROXY_TOKEN
  if (expectedToken && await constantTimeTokenEqual(token, expectedToken)) return { kind: 'proxy' }
  // The server-actor tier is only reachable when multi-tenancy is switched on;
  // with the flag off an `hsa_` token falls through to the auth error below, so
  // single-tenant production keeps exactly its current proxy + hst_ behavior.
  if (isMultiTenantEnabled(env) && token.startsWith('hsa_')) {
    return await authorizeServerActorRequest(request, env, statements, token)
  }
  if (!token.startsWith('hst_')) throw new Error('Authentication error')

  const session = await readAgentSessionForToken(env.HOPIT_D1_DB, token)
  if (!session) throw new Error('Agent session token was not found.')
  if (session.status !== 'active') throw new Error('Agent session is not active.')
  if (session.expires_at && Date.parse(session.expires_at) <= Date.now()) {
    throw new Error('Agent session token has expired.')
  }

  const requestedCodebaseId = options.codebaseId ?? request.headers.get('x-hopit-codebase-id')?.trim() ?? ''
  if (requestedCodebaseId && requestedCodebaseId !== session.codebase_id) {
    throw new Error('Agent session is not scoped to the requested codebase.')
  }

  const statementPolicies = statements.map((statement) => assertScopedSessionStatementAllowed(session, statement))
  assertScopedMutationBatch(statementPolicies)
  const needsFileAccess = statementPolicies.some((policy) => policy.resultVisibility || policy.fileMutation || policy.journalHead)
  const fileAccess = needsFileAccess
    ? await readScopedFileAccess(env.HOPIT_D1_DB, session)
    : null
  assertScopedMutationAccess(statementPolicies, fileAccess)

  return { kind: 'session', session, statementPolicies, fileAccess }
}

async function authorizeServerActorRequest(request, env, statements, token) {
  const actor = await verifyServerActorToken(token, env.HOPIT_D1_SERVER_ACTOR_SECRET)
  if (!actor) throw new Error('Authentication error')

  const statementPolicies = statements.map((statement) => assertServerActorStatementAllowed(actor, statement))
  const referencedCodebaseIds = new Set()
  const createdCodebaseIds = new Set()
  for (const policy of statementPolicies) {
    for (const codebaseId of policy.codebaseIds ?? []) referencedCodebaseIds.add(codebaseId)
    if (policy.createsCodebaseId) createdCodebaseIds.add(policy.createsCodebaseId)
  }
  if (createdCodebaseIds.size > 0) {
    if (statements.length !== 1 || createdCodebaseIds.size !== 1 || referencedCodebaseIds.size !== 1) {
      throw new Error('Server actor codebase creation must be a single-codebase statement.')
    }
    const [createdCodebaseId] = createdCodebaseIds
    if (!referencedCodebaseIds.has(createdCodebaseId)) {
      throw new Error('Server actor codebase creation scope is invalid.')
    }
  }
  // The dynamic half of the tenant check: every codebase named by the batch must
  // be one this authenticated user owns or is an active member of. This is what
  // makes a forged/absent predicate on the dashboard path fail closed AT THE
  // WORKER rather than relying on application-level filtering.
  await assertServerActorEntitlement(
    env.HOPIT_D1_DB,
    actor.userId,
    [...referencedCodebaseIds].filter((codebaseId) => !createdCodebaseIds.has(codebaseId)),
  )

  return { kind: 'server-actor', actor, statementPolicies }
}

async function assertServerActorEntitlement(db, userId, codebaseIds) {
  if (codebaseIds.length === 0) return
  const entitled = await readServerActorEntitledCodebases(db, userId, codebaseIds)
  for (const codebaseId of codebaseIds) {
    if (!entitled.has(codebaseId)) {
      throw new Error('Server actor is not entitled to the requested codebase.')
    }
  }
}

async function readServerActorEntitledCodebases(db, userId, codebaseIds) {
  const entitled = new Set()
  for (const codebaseId of codebaseIds) {
    const result = await db.prepare(
      `select c.owner_id, m.user_id as member_user_id, m.status as member_status
      from codebases c
      left join codebase_members m on m.codebase_id = c.codebase_id and m.user_id = ?
      where c.codebase_id = ?
      limit 1`,
    ).bind(userId, codebaseId).all()
    const row = result.results?.[0]
    if (!row) continue
    const isOwner = Boolean(userId && userId === row.owner_id)
    const isActiveMember = row.member_user_id === userId && row.member_status === 'active'
    if (isOwner || isActiveMember) entitled.add(codebaseId)
  }
  return entitled
}

// --- Blob broker (Phase 3 Stage 1b — HOPIT_MULTITENANT / Front 2) ------------
//
// Authenticate the caller by the SAME principals the query path trusts (an hst_
// scoped session, the hsa_ server-actor, or the admin proxy token), resolve the
// single codebase that caller is entitled to, refuse any key outside that
// codebase's prefix, then mint a short-lived per-object presigned URL. A caller
// entitled to codebase A can never obtain a working URL for codebase B: a request
// naming B is rejected at entitlement, and a B-key under an A entitlement fails
// the prefix check before anything is signed.
async function handleBlobPresign(request, env) {
  if (request.method !== 'POST') {
    const response = cloudflareError('Method not allowed.', 1004, 405)
    logRequest({ request, env, status: response.status, rejectedReason: 'method-not-allowed' })
    return response
  }
  if (failedAuthRateLimited(request)) {
    const response = rateLimitError()
    logRequest({ request, env, status: response.status, rejectedReason: 'failed-auth-rate-limit' })
    return response
  }

  let body
  try {
    body = await request.json()
  } catch {
    const response = cloudflareError('Request body must be JSON.', 1001, 400)
    logRequest({ request, env, status: response.status, rejectedReason: 'invalid-json' })
    return response
  }

  const r2 = brokerR2ConfigFromEnv(env)
  if (!r2) {
    const response = cloudflareError('Blob broker R2 binding is not configured.', 1007, 503)
    logRequest({ request, env, status: response.status, rejectedReason: 'blob-broker-r2-missing' })
    return response
  }

  let principal
  try {
    principal = await resolveBrokerPrincipal(request, env, body)
    clearFailedAuth(request)
  } catch (error) {
    const rateLimited = recordFailedAuth(request)
    const response = rateLimited ? rateLimitError() : authenticationError(error instanceof Error ? error.message : undefined)
    logRequest({
      request,
      env,
      codebaseId: principal?.codebaseId ?? null,
      status: response.status,
      rejectedReason: rateLimited ? 'failed-auth-rate-limit' : (error instanceof Error ? error.message : 'Authentication error'),
    })
    return response
  }

  try {
    const method = normalizeBrokerMethod(body?.method)
    const key = typeof body?.key === 'string' ? body.key : ''
    assertBrokerKeyForCodebase(key, principal.codebaseId, r2.prefix)
    const presigned = await presignBlobUrl({
      method,
      key,
      endpoint: r2.endpoint,
      bucket: r2.bucket,
      region: r2.region,
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
      expiresSeconds: r2.expiresSeconds,
    })
    const response = json({ success: true, errors: [], messages: [], result: presigned })
    logRequest({ request, env, authMode: principal.kind, codebaseId: principal.codebaseId, status: response.status })
    return response
  } catch (error) {
    const response = cloudflareError(error instanceof Error ? error.message : 'Blob broker request failed.', 1002, 400)
    logRequest({
      request,
      env,
      authMode: principal.kind,
      codebaseId: principal.codebaseId,
      status: response.status,
      rejectedReason: error instanceof Error ? error.message : 'blob-broker-failed',
    })
    return response
  }
}

async function resolveBrokerPrincipal(request, env, body) {
  const token = bearerTokenFromRequest(request)
  const requestedCodebaseId = typeof body?.codebaseId === 'string' ? body.codebaseId.trim() : ''

  const expectedToken = env.HOPIT_D1_PROXY_TOKEN
  if (expectedToken && await constantTimeTokenEqual(token, expectedToken)) {
    // Admin/proxy path (migration/GC tooling): still key-scoped to whatever
    // codebase it names, but not entitlement-checked against membership.
    if (!requestedCodebaseId) throw new Error('Broker proxy requests must name a codebase id.')
    return { kind: 'proxy', codebaseId: requestedCodebaseId }
  }

  if (token.startsWith('hsa_')) {
    const actor = await verifyServerActorToken(token, env.HOPIT_D1_SERVER_ACTOR_SECRET)
    if (!actor) throw new Error('Authentication error')
    if (!requestedCodebaseId) throw new Error('Broker server-actor requests must name a codebase id.')
    await assertServerActorEntitlement(env.HOPIT_D1_DB, actor.userId, [requestedCodebaseId])
    return { kind: 'server-actor', codebaseId: requestedCodebaseId }
  }

  if (token.startsWith('hst_')) {
    const session = await readAgentSessionForToken(env.HOPIT_D1_DB, token)
    if (!session) throw new Error('Agent session token was not found.')
    if (session.status !== 'active') throw new Error('Agent session is not active.')
    if (session.expires_at && Date.parse(session.expires_at) <= Date.now()) {
      throw new Error('Agent session token has expired.')
    }
    if (requestedCodebaseId && requestedCodebaseId !== session.codebase_id) {
      throw new Error('Agent session is not scoped to the requested codebase.')
    }
    return { kind: 'session', codebaseId: session.codebase_id }
  }

  throw new Error('Authentication error')
}

async function verifyServerActorToken(token, secret) {
  if (!secret || typeof token !== 'string' || !token.startsWith('hsa_')) return null
  const body = token.slice('hsa_'.length)
  const separatorIndex = body.lastIndexOf('.')
  if (separatorIndex <= 0) return null
  const payloadPart = body.slice(0, separatorIndex)
  const signaturePart = body.slice(separatorIndex + 1)
  const expectedSignature = await hmacSha256Base64Url(secret, payloadPart)
  if (!(await constantTimeTokenEqual(signaturePart, expectedSignature))) return null

  let payload
  try {
    payload = JSON.parse(base64UrlToString(payloadPart))
  } catch {
    return null
  }
  if (!payload || typeof payload.u !== 'string' || !payload.u) return null
  if (payload.exp != null && Date.now() > Number(payload.exp)) return null
  return { userId: payload.u }
}

async function hmacSha256Base64Url(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return base64UrlFromBytes(new Uint8Array(signature))
}

function base64UrlFromBytes(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToString(value) {
  const base = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base + '='.repeat((4 - (base.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new TextDecoder().decode(bytes)
}

async function readScopedFileAccess(db, session) {
  const result = await db.prepare(
    `select c.owner_id, c.revision, c.selected_state_json, c.main_json, c.visibility_json,
      m.role as member_role, m.status as member_status
    from codebases c
    left join codebase_members m on m.codebase_id = c.codebase_id and m.user_id = ?
    where c.codebase_id = ?
    limit 1`,
  ).bind(session.user_id, session.codebase_id).all()
  const row = result.results?.[0]
  if (!row) return null
  const selectedState = parseJson(row.selected_state_json, {})
  const visibility = parseJson(row.visibility_json, {})
  return {
    codebaseId: session.codebase_id,
    // The tenant that owns this codebase — quota accrues to the OWNER, not the
    // writing session user (a collaborator's writes count against the owner's
    // tenant budget).
    ownerId: row.owner_id ?? null,
    revision: integerOrNull(row.revision),
    selectedState,
    selectedStateJson: row.selected_state_json ?? null,
    main: parseJson(row.main_json, {}),
    mainJson: row.main_json ?? null,
    isOwner: Boolean(session.user_id && session.user_id === row.owner_id),
    isActiveMember: row.member_status === 'active' && ['owner', 'maintainer', 'member', 'viewer'].includes(row.member_role),
    selectedStateType: selectedState?.type ?? null,
    selectedStateId: selectedState?.id ?? null,
    selectedStateMergeState: selectedState?.mergeState ?? null,
    effectiveVisibility: selectedState?.effectiveVisibility ?? visibility?.effective ?? 'private',
  }
}

// --- Per-tenant usage metering + quota enforcement (Phase 3 Stage 2-3) --------
//
// Runs ONLY when HOPIT_MULTITENANT is on (flag off => this path is never reached,
// so single-tenant production keeps zero metering overhead and byte-for-byte
// behavior). For a tenant (hst_ session OR hsa_ server-actor) mutating batch it:
//   1. counts the mutating statements it is about to run (rows delta) and sums
//      guarded file sizes (storage delta),
//   2. when HOPIT_ENFORCE_QUOTA is also on, reads the tenant's single meter row +
//      plan and rejects the batch CLEANLY if it would cross a hard cap (no
//      partial write, no data loss — the agent holds the change on disk),
//   3. returns a single meter upsert to be folded into the SAME batch, so the
//      write and its meter increment commit or roll back together (+1 row/batch).
// Reads, exports, and deletes (which reduce storage) are never routed here.
function mutatingStatementCount(policies) {
  let count = 0
  for (const policy of policies ?? []) {
    if (policy?.operation === 'insert' || policy?.operation === 'update' || policy?.operation === 'delete') count += 1
  }
  return count
}

async function guardedStorageDelta(db, policies) {
  let bytes = 0
  const currentByFile = new Map()
  for (const policy of policies ?? []) {
    const mutation = policy?.fileMutation
    if (mutation?.table !== 'files' || !mutation.knownGuarded) continue
    if (!mutation.codebaseId || !mutation.path) continue
    const key = `${mutation.codebaseId}\u0000${mutation.path}`
    let previousBytes = currentByFile.get(key)
    if (previousBytes === undefined) {
      previousBytes = await readCurrentFileStorageBytes(db, mutation.codebaseId, mutation.path)
    }
    const nextBytes = mutation.operation === 'delete'
      ? 0
      : nonNegativeStorageBytes(mutation.storageBytes)
    bytes += nextBytes - previousBytes
    currentByFile.set(key, nextBytes)
  }
  return bytes
}

async function readCurrentFileStorageBytes(db, codebaseId, path) {
  const result = await db.prepare(
    `select size, blob_size, length(content) as content_size
    from files where codebase_id = ? and path = ? limit 1`,
  ).bind(codebaseId, path).all()
  const row = result.results?.[0]
  return nonNegativeStorageBytes(row?.size ?? row?.blob_size ?? row?.content_size)
}

function nonNegativeStorageBytes(value) {
  const bytes = Number(value)
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0
}

async function readCodebaseOwnerId(db, codebaseId) {
  if (!codebaseId) return null
  const result = await db.prepare('select owner_id from codebases where codebase_id = ? limit 1').bind(codebaseId).all()
  return result.results?.[0]?.owner_id ?? null
}

async function readTenantUsageRow(db, tenantId) {
  if (!tenantId) return null
  const result = await db.prepare(
    'select tenant_id, plan, storage_bytes, write_day, rows_written_today from tenant_usage where tenant_id = ? limit 1',
  ).bind(tenantId).all()
  return result.results?.[0] ?? null
}

async function readTenantControlRow(db, tenantId) {
  if (!tenantId) return null
  const result = await db.prepare(
    'select tenant_id, writes_paused, reason, updated_by_user_id, updated_at from tenant_controls where tenant_id = ? limit 1',
  ).bind(tenantId).all()
  return result.results?.[0] ?? null
}

async function resolveTenantIdForAuthorization(db, authorization) {
  if (authorization.kind === 'server-actor') return authorization.actor?.userId ?? null
  if (authorization.kind === 'session') {
    return authorization.fileAccess?.ownerId
      ?? await readCodebaseOwnerId(db, authorization.session?.codebase_id)
      ?? authorization.session?.user_id
      ?? null
  }
  return null
}

// Metering/enforcement must never crash a legitimate write: infrastructure
// errors here fail OPEN (write proceeds, unmetered) so a transient meter fault
// cannot lock a tenant out. A quota *rejection* is a deliberate decision, not an
// error, and is returned (not thrown) so it does not count as a failed auth.
async function prepareTenantMetering({ env, db, authorization }) {
  if (!isMultiTenantEnabled(env)) return null
  if (authorization.kind !== 'session' && authorization.kind !== 'server-actor') return null

  const policies = authorization.statementPolicies ?? []
  const rowsDelta = mutatingStatementCount(policies)
  if (rowsDelta === 0) return null // read-only batch — never metered.

  const tenantId = await resolveTenantIdForAuthorization(db, authorization)
  if (!tenantId) return null

  const storageDelta = await guardedStorageDelta(db, policies)
  const day = utcDay()

  const control = await readTenantControlRow(db, tenantId)
  const hasStorageGrowingWrite = policies.some((policy) => policy?.operation === 'insert' || policy?.operation === 'update')
  if (Number(control?.writes_paused) === 1 && hasStorageGrowingWrite && storageDelta >= 0) {
    return {
      tenantId,
      rowsDelta,
      storageDelta,
      rejection: {
        code: 'tenant_writes_paused',
        message: control?.reason
          ? `Cloud writes are temporarily paused by the HopIt operator: ${control.reason}`
          : 'Cloud writes are temporarily paused by the HopIt operator.',
        tenantId,
        retryable: true,
      },
    }
  }

  if (isQuotaEnforced(env)) {
    const usage = await readTenantUsageRow(db, tenantId)
    const limits = resolvePlanLimits(env, usage?.plan ?? 'free')
    // A guarded delete must remain available so an over-limit tenant can free
    // space. Its real D1 rows are still metered, but the daily-write gate does
    // not prevent the storage-releasing operation itself.
    const enforcementRowsDelta = storageDelta < 0 ? 0 : rowsDelta
    const rejection = evaluateWriteQuota({ usage, limits, day, rowsDelta: enforcementRowsDelta, storageDelta })
    if (rejection) return { tenantId, rowsDelta, storageDelta, rejection }
  }

  const meterStatement = buildMeterUpsertStatement({
    tenantId,
    day,
    rowsDelta,
    storageDelta,
    now: new Date().toISOString(),
  })
  return { tenantId, rowsDelta, storageDelta, meterStatement }
}

function quotaError(rejection) {
  return json({
    success: false,
    errors: [{ code: 1008, message: rejection.message, quota: rejection }],
    messages: [],
    result: [],
  }, 429)
}

// --- Usage status surface (Phase 3 Stage 2-3) --------------------------------
//
// A read-only endpoint the desktop agent (or dashboard) can poll to render
// "X% of storage, Y% of today's writes" and the warn/block state. Authenticated
// by the SAME principals the query/broker paths trust; a caller only ever sees
// its own tenant's meter. Exists only with the flag on (falls through to 404
// otherwise, so single-tenant is unchanged).
function isUsageStatusPath(pathname) {
  return pathname === '/usage' || pathname.endsWith('/usage')
}

// --- Owner operations console ------------------------------------------------
//
// This is a typed administrative surface, not a general SQL proxy. It accepts
// the same short-lived hsa_ actor token as the tenant dashboard, then verifies
// that actor against the verified owner account stored in D1. The browser never
// receives the proxy token or a capability that can run arbitrary SQL.
function isAdminOperationsPath(pathname) {
  return pathname === '/admin/operations' || pathname.endsWith('/admin/operations')
}

async function handleAdminOperations(request, env) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return cloudflareError('Method not allowed.', 1004, 405)
  }
  if (failedAuthRateLimited(request)) return rateLimitError()

  let actor
  try {
    actor = await resolveServiceAdmin(request, env)
    clearFailedAuth(request)
  } catch (error) {
    const rateLimited = recordFailedAuth(request)
    return rateLimited
      ? rateLimitError()
      : authenticationError(error instanceof Error ? error.message : undefined)
  }

  try {
    let actionResult = null
    if (request.method === 'POST') {
      const body = await request.json().catch(() => null)
      actionResult = await applyServiceAdminAction(env.HOPIT_D1_DB, actor, body)
    }
    let result
    try {
      result = await readServiceOperations(env)
    } catch (error) {
      if (request.method !== 'POST') throw error
      const refreshWarning = error instanceof Error ? error.message : 'The operations snapshot could not be refreshed.'
      const response = json({
        success: true,
        errors: [],
        messages: [{ code: 'snapshot_refresh_failed', message: refreshWarning }],
        result: { snapshotAvailable: false, actionResult, refreshWarning },
      })
      logRequest({ request, env, authMode: 'service-admin', status: response.status, rejectedReason: 'snapshot-refresh-failed' })
      return response
    }
    const response = json({ success: true, errors: [], messages: [], result: { ...result, snapshotAvailable: true, actionResult } })
    logRequest({ request, env, authMode: 'service-admin', status: response.status })
    return response
  } catch (error) {
    const response = cloudflareError(error instanceof Error ? error.message : 'Operations request failed.', 1002, 400)
    logRequest({
      request,
      env,
      authMode: 'service-admin',
      status: response.status,
      rejectedReason: error instanceof Error ? error.message : 'operations-failed',
    })
    return response
  }
}

async function resolveServiceAdmin(request, env) {
  const token = bearerTokenFromRequest(request)
  const actor = await verifyServerActorToken(token, env.HOPIT_D1_SERVER_ACTOR_SECRET)
  if (!actor) throw new Error('Authentication error')
  const expectedEmail = normalizeEmail(env.HOPIT_OWNER_EMAIL)
  if (!expectedEmail) throw new Error('Service owner is not configured.')
  const result = await env.HOPIT_D1_DB.prepare(
    'select primary_email, email_verified from users where user_id = ? limit 1',
  ).bind(actor.userId).all()
  const owner = result.results?.[0]
  if (Number(owner?.email_verified) !== 1 || normalizeEmail(owner?.primary_email) !== expectedEmail) {
    throw new Error('Authenticated account is not the HopIt service owner.')
  }
  return actor
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

async function dbRows(db, sql, params = []) {
  const result = await db.prepare(sql).bind(...params).all()
  if (result?.success === false) throw new Error(result.error ?? 'D1 operation failed.')
  return result.results ?? []
}

async function readServiceOperations(env) {
  const db = env.HOPIT_D1_DB
  const now = Date.now()
  const day = utcDay(now)
  const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString()
  const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()
  const since30d = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
  const warnRatio = warnRatioFromEnv(env)
  const freeLimits = resolvePlanLimits(env, 'free')
  const paidLimits = resolvePlanLimits(env, 'paid')
  const paidStorageLimits = resolvePlanLimits(env, 'paid_storage')
  const storageLimitSql = `(case plan when 'paid_storage' then ${paidStorageLimits.storageBytes} when 'plus_storage' then ${paidStorageLimits.storageBytes} when 'paid' then ${paidLimits.storageBytes} when 'plus' then ${paidLimits.storageBytes} else ${freeLimits.storageBytes} end)`
  const writeLimitSql = `(case plan when 'paid_storage' then ${paidStorageLimits.dailyWrites} when 'plus_storage' then ${paidStorageLimits.dailyWrites} when 'paid' then ${paidLimits.dailyWrites} when 'plus' then ${paidLimits.dailyWrites} else ${freeLimits.dailyWrites} end)`
  const writesTodaySql = `(case when write_day = '${day}' then rows_written_today else 0 end)`
  const [
    users,
    usageRows,
    subscriptions,
    codebaseCounts,
    codebases,
    sessionCounts,
    sessions,
    deviceAuthorizations,
    deviceKeys,
    jobRows,
    actionJobs,
    eventCounts,
    recentEvents,
    adminEvents,
    webhookRows,
    keyringRows,
    codebaseKeyringRows,
    invitationRows,
    userStatsRows,
    usageStatsRows,
    usagePlanRows,
    subscriptionStatusRows,
    inventoryTotalRows,
  ] = await Promise.all([
    dbRows(db, 'select user_id, primary_email, display_name, email_verified, created_at, updated_at from users order by created_at desc limit 250'),
    dbRows(db, `select u.tenant_id, u.plan, u.storage_bytes, u.write_day, u.rows_written_today, u.created_at, u.updated_at,
      c.writes_paused, c.reason as pause_reason, c.updated_at as control_updated_at
      from tenant_usage u left join tenant_controls c on c.tenant_id = u.tenant_id
      order by u.updated_at desc limit 250`),
    dbRows(db, 'select * from subscriptions order by updated_at desc limit 250'),
    dbRows(db, 'select owner_id as tenant_id, count(*) as codebase_count, sum(file_count) as file_count, max(updated_at) as last_codebase_update from codebases group by owner_id'),
    dbRows(db, `select c.codebase_id, c.name, c.owner_id as tenant_id, u.primary_email as owner_email,
      c.schema_version, c.revision, c.file_count, c.private_file_count, c.member_count, c.updated_at
      from codebases c left join users u on u.user_id = c.owner_id
      order by c.updated_at desc limit 250`),
    dbRows(db, `select c.owner_id as tenant_id, count(*) as session_count,
      sum(case when s.status = 'active' and (s.expires_at is null or s.expires_at > ?) then 1 else 0 end) as active_session_count,
      max(s.last_seen_at) as last_seen_at
      from agent_sessions s join codebases c on c.codebase_id = s.codebase_id group by c.owner_id`, [new Date(now).toISOString()]),
    dbRows(db, `select s.session_id, s.user_id, s.codebase_id, c.owner_id as tenant_id, c.name as codebase_name,
      s.device_name, s.status, s.capabilities_json, s.expires_at, s.created_at, s.last_seen_at, s.revoked_at
      from agent_sessions s join codebases c on c.codebase_id = s.codebase_id
      order by s.last_seen_at desc limit 100`),
    dbRows(db, `select authorization_id, device_id, device_name, platform, status, user_id, codebase_id,
      session_id, requested_codebase_id, requested_codebase_name, created_at, expires_at, approved_at,
      consumed_at, updated_at from device_authorizations order by created_at desc limit 100`),
    dbRows(db, `select device_id, user_id, display_name, platform, status, created_at, trusted_at,
      revoked_at, last_seen_at from device_keys order by coalesce(last_seen_at, created_at) desc limit 100`),
    dbRows(db, `select status, count(*) as count from action_jobs
      where created_at >= ? group by status`, [since24h]),
    dbRows(db, `select j.job_id, j.codebase_id, c.name as codebase_name, c.owner_id as tenant_id,
      j.kind, j.command, j.status, j.requested_by_user_id, j.runner_id, j.exit_code, j.summary,
      j.created_at, j.updated_at, j.claimed_at, j.started_at, j.finished_at
      from action_jobs j left join codebases c on c.codebase_id = j.codebase_id
      order by j.created_at desc limit 100`),
    dbRows(db, `select event, count(*) as count from agent_events where at >= ? group by event order by count(*) desc`, [since24h]),
    dbRows(db, `select e.id, e.codebase_id, c.name as codebase_name, c.owner_id as tenant_id,
      e.event, e.detail_json, e.at, e.source
      from agent_events e left join codebases c on c.codebase_id = e.codebase_id
      order by e.at desc, e.id desc limit 100`),
    dbRows(db, 'select event_id, actor_user_id, action, target_type, target_id, detail_json, created_at from service_admin_events order by created_at desc limit 100'),
    dbRows(db, `select event_id, provider, event_created_at, received_at
      from billing_webhook_events order by received_at desc limit 50`),
    dbRows(db, 'select status, recovery_configured, count(*) as count from user_keyrings group by status, recovery_configured'),
    dbRows(db, `select coalesce(rotation_state, 'stable') as rotation_state, count(*) as count
      from codebase_keyrings group by coalesce(rotation_state, 'stable')`),
    dbRows(db, 'select status, count(*) as count from codebase_invitations group by status'),
    dbRows(db, `select count(*) as total_users,
      sum(case when email_verified = 1 then 1 else 0 end) as verified_users,
      sum(case when created_at >= ? then 1 else 0 end) as new_users_24h,
      sum(case when created_at >= ? then 1 else 0 end) as new_users_7d,
      sum(case when created_at >= ? then 1 else 0 end) as new_users_30d
      from users`, [since24h, since7d, since30d]),
    dbRows(db, `select count(*) as tenant_count,
      coalesce(sum(storage_bytes), 0) as total_storage_bytes,
      coalesce(sum(${writesTodaySql}), 0) as rows_written_today,
      sum(case when ${storageLimitSql} > 0 and storage_bytes >= ${storageLimitSql} * 0.5 then 1 else 0 end) as storage_at_50,
      sum(case when ${storageLimitSql} > 0 and storage_bytes >= ${storageLimitSql} * ${warnRatio} then 1 else 0 end) as storage_at_warn,
      sum(case when ${storageLimitSql} > 0 and storage_bytes >= ${storageLimitSql} then 1 else 0 end) as storage_blocked,
      sum(case when ${writeLimitSql} > 0 and ${writesTodaySql} >= ${writeLimitSql} * 0.5 then 1 else 0 end) as writes_at_50,
      sum(case when ${writeLimitSql} > 0 and ${writesTodaySql} >= ${writeLimitSql} * ${warnRatio} then 1 else 0 end) as writes_at_warn,
      sum(case when ${writeLimitSql} > 0 and ${writesTodaySql} >= ${writeLimitSql} then 1 else 0 end) as writes_blocked
      from tenant_usage`),
    dbRows(db, `select case when plan in ('paid_storage', 'plus_storage') then 'paid_storage'
      when plan in ('paid', 'plus') then 'paid' else 'free' end as plan, count(*) as count
      from tenant_usage group by case when plan in ('paid_storage', 'plus_storage') then 'paid_storage'
      when plan in ('paid', 'plus') then 'paid' else 'free' end`),
    dbRows(db, 'select status, count(*) as count, sum(case when entitlement_active = 1 then 1 else 0 end) as active_count from subscriptions group by status'),
    dbRows(db, `select
      (select count(*) from codebases) as codebases,
      (select count(*) from agent_sessions) as sessions,
      (select count(*) from device_keys) as devices,
      (select count(*) from device_keys where status = 'trusted') as active_devices,
      (select count(*) from device_keys where status = 'revoked') as revoked_devices,
      (select count(*) from device_authorizations) as device_authorizations,
      (select count(*) from device_authorizations where status = 'pending') as pending_device_authorizations,
      (select count(*) from action_jobs) as action_jobs,
      (select count(*) from service_admin_events) as admin_events,
      (select count(*) from billing_webhook_events) as webhooks`),
  ])

  const usersById = new Map(users.map((row) => [row.user_id, row]))
  const subscriptionsByTenant = new Map(subscriptions.map((row) => [row.tenant_id, row]))
  const codebasesByTenant = new Map(codebaseCounts.map((row) => [row.tenant_id, row]))
  const sessionsByTenant = new Map(sessionCounts.map((row) => [row.tenant_id, row]))
  const deviceCountsByTenant = groupCounts(deviceKeys, 'user_id', 'status')
  const authorizationCountsByTenant = groupCounts(deviceAuthorizations.filter((row) => row.user_id), 'user_id', 'status')
  const tenants = usageRows.map((usage) => {
    const limits = resolvePlanLimits(env, usage.plan)
    const quota = computeUsageStatus({
      usage,
      limits,
      warnRatio,
      day,
      codebaseCount: Number(codebasesByTenant.get(usage.tenant_id)?.codebase_count ?? 0),
    })
    const subscription = subscriptionsByTenant.get(usage.tenant_id)
    const session = sessionsByTenant.get(usage.tenant_id)
    const user = usersById.get(usage.tenant_id)
    return {
      tenantId: usage.tenant_id,
      email: user?.primary_email ?? null,
      displayName: user?.display_name ?? null,
      emailVerified: Number(user?.email_verified) === 1,
      plan: quota.plan,
      quota,
      writesPaused: Number(usage.writes_paused) === 1,
      pauseReason: usage.pause_reason ?? null,
      controlUpdatedAt: usage.control_updated_at ?? null,
      subscription: subscription ? {
        provider: subscription.provider,
        providerCustomerId: subscription.provider_customer_id ?? null,
        providerSubscriptionId: subscription.provider_subscription_id ?? null,
        planKey: subscription.plan_key,
        status: subscription.status,
        entitlementActive: Number(subscription.entitlement_active) === 1,
        cancelAtPeriodEnd: Number(subscription.cancel_at_period_end) === 1,
        currentPeriodEnd: subscription.current_period_end ?? null,
        lastEventId: subscription.last_event_id,
        lastEventCreatedAt: subscription.last_event_created_at,
        updatedAt: subscription.updated_at,
      } : null,
      codebaseCount: Number(codebasesByTenant.get(usage.tenant_id)?.codebase_count ?? 0),
      fileCount: Number(codebasesByTenant.get(usage.tenant_id)?.file_count ?? 0),
      lastCodebaseUpdate: codebasesByTenant.get(usage.tenant_id)?.last_codebase_update ?? null,
      sessionCount: Number(session?.session_count ?? 0),
      activeSessionCount: Number(session?.active_session_count ?? 0),
      lastSeenAt: session?.last_seen_at ?? null,
      deviceCounts: deviceCountsByTenant.get(usage.tenant_id) ?? {},
      authorizationCounts: authorizationCountsByTenant.get(usage.tenant_id) ?? {},
      userCreatedAt: user?.created_at ?? null,
      userUpdatedAt: user?.updated_at ?? null,
      createdAt: usage.created_at,
      updatedAt: usage.updated_at,
    }
  })

  const jobs = Object.fromEntries(jobRows.map((row) => [row.status, Number(row.count ?? 0)]))
  const userStats = userStatsRows[0] ?? {}
  const usageStats = usageStatsRows[0] ?? {}
  const inventoryTotals = inventoryTotalRows[0] ?? {}
  const totalStorageBytes = Number(usageStats.total_storage_bytes ?? 0)
  const rowsWrittenToday = Number(usageStats.rows_written_today ?? 0)
  const activeSubscriptionCount = subscriptionStatusRows.reduce((sum, row) => sum + Number(row.active_count ?? 0), 0)
  const planCounts = Object.fromEntries(usagePlanRows.map((row) => [row.plan, Number(row.count ?? 0)]))
  const eventTypes24h = Object.fromEntries(eventCounts.map((row) => [row.event, Number(row.count ?? 0)]))
  const subscriptionStatuses = Object.fromEntries(subscriptionStatusRows.map((row) => [row.status, Number(row.count ?? 0)]))
  const collection = (shown, total) => ({ shown, total: Number(total ?? 0), truncated: shown < Number(total ?? 0) })

  return {
    generatedAt: new Date(now).toISOString(),
    health: {
      database: 'operational',
      multiTenant: isMultiTenantEnabled(env),
      quotaEnforced: isQuotaEnforced(env),
      ownerGuard: Boolean(normalizeEmail(env.HOPIT_OWNER_EMAIL)),
      lastWebhookAt: webhookRows[0]?.received_at ?? null,
      latestEventAt: recentEvents[0]?.at ?? null,
    },
    totals: {
      users: Number(userStats.total_users ?? 0),
      tenants: Number(usageStats.tenant_count ?? 0),
      codebases: Number(inventoryTotals.codebases ?? 0),
      activeSessions: sessionCounts.reduce((sum, row) => sum + Number(row.active_session_count ?? 0), 0),
      activeSubscriptions: activeSubscriptionCount,
      subscriptionStatuses,
      totalStorageBytes,
      rowsWrittenToday,
      planCounts,
      newUsers24h: Number(userStats.new_users_24h ?? 0),
      newUsers7d: Number(userStats.new_users_7d ?? 0),
      newUsers30d: Number(userStats.new_users_30d ?? 0),
      verifiedUsers: Number(userStats.verified_users ?? 0),
      activeDevices: Number(inventoryTotals.active_devices ?? 0),
      revokedDevices: Number(inventoryTotals.revoked_devices ?? 0),
      pendingDeviceAuthorizations: Number(inventoryTotals.pending_device_authorizations ?? 0),
      actionJobs24h: jobs,
      eventTypes24h,
      storageAt50: Number(usageStats.storage_at_50 ?? 0),
      storageAt80: Number(usageStats.storage_at_warn ?? 0),
      storageBlocked: Number(usageStats.storage_blocked ?? 0),
      writesAt50: Number(usageStats.writes_at_50 ?? 0),
      writesAt80: Number(usageStats.writes_at_warn ?? 0),
      writesBlocked: Number(usageStats.writes_blocked ?? 0),
    },
    collections: {
      tenants: collection(tenants.length, usageStats.tenant_count),
      codebases: collection(codebases.length, inventoryTotals.codebases),
      sessions: collection(sessions.length, inventoryTotals.sessions),
      devices: collection(deviceKeys.length, inventoryTotals.devices),
      deviceAuthorizations: collection(deviceAuthorizations.length, inventoryTotals.device_authorizations),
      actionJobs: collection(actionJobs.length, inventoryTotals.action_jobs),
      adminEvents: collection(adminEvents.length, inventoryTotals.admin_events),
      webhooks: collection(webhookRows.length, inventoryTotals.webhooks),
    },
    tenants,
    codebases: codebases.map((row) => ({
      codebaseId: row.codebase_id,
      name: row.name,
      tenantId: row.tenant_id,
      ownerEmail: row.owner_email ?? null,
      schemaVersion: Number(row.schema_version ?? 0),
      revision: Number(row.revision ?? 0),
      fileCount: Number(row.file_count ?? 0),
      privateFileCount: Number(row.private_file_count ?? 0),
      memberCount: Number(row.member_count ?? 0),
      updatedAt: row.updated_at,
    })),
    sessions: sessions.map((row) => ({
      sessionId: row.session_id,
      userId: row.user_id,
      tenantId: row.tenant_id,
      codebaseId: row.codebase_id,
      codebaseName: row.codebase_name,
      deviceName: row.device_name ?? null,
      status: row.status,
      capabilities: parseJson(row.capabilities_json, []),
      expiresAt: row.expires_at ?? null,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      revokedAt: row.revoked_at ?? null,
    })),
    deviceAuthorizations: deviceAuthorizations.map((row) => ({
      authorizationId: row.authorization_id,
      deviceId: row.device_id,
      deviceName: row.device_name ?? null,
      platform: row.platform ?? null,
      status: row.status,
      tenantId: row.user_id ?? null,
      codebaseId: row.codebase_id ?? row.requested_codebase_id ?? null,
      requestedCodebaseName: row.requested_codebase_name ?? null,
      sessionId: row.session_id ?? null,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      approvedAt: row.approved_at ?? null,
      consumedAt: row.consumed_at ?? null,
      updatedAt: row.updated_at,
    })),
    devices: deviceKeys.map((row) => ({
      deviceId: row.device_id,
      tenantId: row.user_id,
      displayName: row.display_name ?? null,
      platform: row.platform ?? null,
      status: row.status,
      createdAt: row.created_at,
      trustedAt: row.trusted_at ?? null,
      revokedAt: row.revoked_at ?? null,
      lastSeenAt: row.last_seen_at ?? null,
    })),
    actionJobs: actionJobs.map((row) => ({
      jobId: row.job_id,
      codebaseId: row.codebase_id,
      codebaseName: row.codebase_name ?? null,
      tenantId: row.tenant_id ?? null,
      kind: row.kind,
      command: row.command,
      status: row.status,
      requestedByUserId: row.requested_by_user_id,
      runnerId: row.runner_id ?? null,
      exitCode: row.exit_code ?? null,
      summary: row.summary ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      claimedAt: row.claimed_at ?? null,
      startedAt: row.started_at ?? null,
      finishedAt: row.finished_at ?? null,
    })),
    webhooks: webhookRows,
    security: {
      userKeyrings: keyringRows.map((row) => ({ status: row.status, recoveryConfigured: Number(row.recovery_configured) === 1, count: Number(row.count ?? 0) })),
      codebaseKeyrings: codebaseKeyringRows.map((row) => ({ rotationState: row.rotation_state, count: Number(row.count ?? 0) })),
      invitations: Object.fromEntries(invitationRows.map((row) => [row.status, Number(row.count ?? 0)])),
    },
    recentEvents: recentEvents.map((row) => ({ ...row, detail: parseJson(row.detail_json, {}) })),
    adminEvents: adminEvents.map((row) => ({ ...row, detail: parseJson(row.detail_json, {}) })),
  }
}

function groupCounts(rows, keyField, statusField) {
  const result = new Map()
  for (const row of rows) {
    const key = row[keyField]
    if (!key) continue
    const counts = result.get(key) ?? {}
    const status = row[statusField] ?? 'unknown'
    counts[status] = (counts[status] ?? 0) + 1
    result.set(key, counts)
  }
  return result
}

async function applyServiceAdminAction(db, actor, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Action body is required.')
  const action = typeof input.action === 'string' ? input.action.trim() : ''
  const targetId = typeof input.tenantId === 'string'
    ? input.tenantId.trim()
    : typeof input.sessionId === 'string'
      ? input.sessionId.trim()
      : typeof input.deviceId === 'string'
        ? input.deviceId.trim()
        : typeof input.authorizationId === 'string'
          ? input.authorizationId.trim()
          : typeof input.jobId === 'string'
            ? input.jobId.trim()
            : 'hopit-service'
  const confirmation = typeof input.confirmation === 'string' ? input.confirmation.trim() : ''
  if (!targetId || confirmation !== targetId) throw new Error('Action confirmation did not match its target.')
  const now = new Date().toISOString()
  const eventId = `admin_${crypto.randomUUID()}`

  if (action === 'pause_tenant_writes' || action === 'resume_tenant_writes') {
    const tenant = (await dbRows(db, 'select tenant_id from tenant_usage where tenant_id = ? limit 1', [targetId]))[0]
    if (!tenant) throw new Error('Tenant was not found.')
    const paused = action === 'pause_tenant_writes' ? 1 : 0
    const reason = paused && typeof input.reason === 'string' && input.reason.trim()
      ? input.reason.trim().slice(0, 240)
      : null
    await executeStatements(db, [
      {
        sql: `insert into tenant_controls (tenant_id, writes_paused, reason, updated_by_user_id, created_at, updated_at)
          values (?, ?, ?, ?, ?, ?)
          on conflict(tenant_id) do update set writes_paused = excluded.writes_paused, reason = excluded.reason,
            updated_by_user_id = excluded.updated_by_user_id, updated_at = excluded.updated_at`,
        params: [targetId, paused, reason, actor.userId, now, now],
      },
      adminAuditStatement({ eventId, actor, action, targetType: 'tenant', targetId, detail: { reason }, now }),
    ])
    return { action, tenantId: targetId, writesPaused: paused === 1 }
  }

  if (action === 'revoke_session') {
    const session = (await dbRows(db, 'select session_id, codebase_id, status from agent_sessions where session_id = ? limit 1', [targetId]))[0]
    if (!session) throw new Error('Session was not found.')
    await executeStatements(db, [
      {
        sql: `update agent_sessions set status = 'revoked', revoked_by_user_id = ?, revoked_at = ?, updated_at = ?
          where session_id = ?`,
        params: [actor.userId, now, now, targetId],
      },
      adminAuditStatement({
        eventId,
        actor,
        action,
        targetType: 'session',
        targetId,
        detail: { codebaseId: session.codebase_id, previousStatus: session.status },
        now,
      }),
    ])
    return { action, sessionId: targetId, status: 'revoked' }
  }

  if (action === 'revoke_tenant_sessions') {
    const tenant = (await dbRows(db, 'select tenant_id from tenant_usage where tenant_id = ? limit 1', [targetId]))[0]
    if (!tenant) throw new Error('Tenant was not found.')
    const active = await dbRows(db, `select s.session_id from agent_sessions s join codebases c on c.codebase_id = s.codebase_id
      where c.owner_id = ? and s.status = 'active'`, [targetId])
    await executeStatements(db, [
      {
        sql: `update agent_sessions set status = 'revoked', revoked_by_user_id = ?, revoked_at = ?, updated_at = ?
          where status = 'active' and codebase_id in (select codebase_id from codebases where owner_id = ?)`,
        params: [actor.userId, now, now, targetId],
      },
      adminAuditStatement({
        eventId,
        actor,
        action,
        targetType: 'tenant',
        targetId,
        detail: { revokedSessionCount: active.length },
        now,
      }),
    ])
    return { action, tenantId: targetId, revokedSessionCount: active.length }
  }

  if (action === 'revoke_device') {
    const device = (await dbRows(db, 'select device_id, user_id, status from device_keys where device_id = ? limit 1', [targetId]))[0]
    if (!device) throw new Error('Device was not found.')
    const linkedSessions = await dbRows(db, `select session_id from device_authorizations
      where device_id = ? and session_id is not null`, [targetId])
    await executeStatements(db, [
      {
        sql: `update device_keys set status = 'revoked', revoked_at = ? where device_id = ?`,
        params: [now, targetId],
      },
      {
        sql: `update agent_sessions set status = 'revoked', revoked_by_user_id = ?, revoked_at = ?, updated_at = ?
          where session_id in (select session_id from device_authorizations where device_id = ? and session_id is not null)`,
        params: [actor.userId, now, now, targetId],
      },
      {
        sql: `update device_authorizations set status = 'expired', updated_at = ?
          where device_id = ? and status in ('pending', 'approving')`,
        params: [now, targetId],
      },
      adminAuditStatement({
        eventId,
        actor,
        action,
        targetType: 'device',
        targetId,
        detail: { tenantId: device.user_id, previousStatus: device.status, revokedSessionCount: linkedSessions.length },
        now,
      }),
    ])
    return { action, deviceId: targetId, status: 'revoked', revokedSessionCount: linkedSessions.length }
  }

  if (action === 'expire_device_authorization') {
    const authorization = (await dbRows(db, `select authorization_id, status, device_id, user_id
      from device_authorizations where authorization_id = ? limit 1`, [targetId]))[0]
    if (!authorization) throw new Error('Device authorization was not found.')
    if (authorization.status !== 'pending' && authorization.status !== 'approving') {
      throw new Error(`Device authorization is already ${authorization.status}.`)
    }
    await executeStatements(db, [
      {
        sql: `update device_authorizations set status = 'expired', updated_at = ?
          where authorization_id = ? and status in ('pending', 'approving')`,
        params: [now, targetId],
      },
      adminAuditStatement({
        eventId,
        actor,
        action,
        targetType: 'device_authorization',
        targetId,
        detail: { deviceId: authorization.device_id, tenantId: authorization.user_id, previousStatus: authorization.status },
        now,
      }),
    ])
    return { action, authorizationId: targetId, status: 'expired' }
  }

  if (action === 'cancel_action_job' || action === 'requeue_action_job') {
    const job = (await dbRows(db, `select job_id, codebase_id, status from action_jobs where job_id = ? limit 1`, [targetId]))[0]
    if (!job) throw new Error('Action job was not found.')
    if (action === 'cancel_action_job' && job.status !== 'queued') throw new Error('Only queued action jobs can be canceled safely.')
    if (action === 'requeue_action_job' && job.status !== 'failed') throw new Error('Only failed action jobs can be requeued.')
    const nextStatus = action === 'cancel_action_job' ? 'cancelled' : 'queued'
    const statement = action === 'cancel_action_job'
      ? {
          sql: `update action_jobs set status = 'cancelled', summary = 'Cancelled by service owner', updated_at = ?, finished_at = ?
            where job_id = ? and status = 'queued'`,
          params: [now, now, targetId],
        }
      : {
          sql: `update action_jobs set status = 'queued', runner_id = null, exit_code = null, stdout = null, stderr = null,
            summary = null, claimed_at = null, started_at = null, finished_at = null, updated_at = ?
            where job_id = ? and status = 'failed'`,
          params: [now, targetId],
        }
    await executeStatements(db, [
      statement,
      adminAuditStatement({
        eventId,
        actor,
        action,
        targetType: 'action_job',
        targetId,
        detail: { codebaseId: job.codebase_id, previousStatus: job.status, nextStatus },
        now,
      }),
    ])
    return { action, jobId: targetId, status: nextStatus }
  }

  if (action === 'record_billing_reconcile') {
    const detail = input.detail && typeof input.detail === 'object' && !Array.isArray(input.detail) ? input.detail : {}
    await executeStatements(db, [adminAuditStatement({ eventId, actor, action, targetType: 'service', targetId, detail, now })])
    return { action, recorded: true }
  }

  if (action === 'record_billing_action') {
    const detail = input.detail && typeof input.detail === 'object' && !Array.isArray(input.detail) ? input.detail : {}
    await executeStatements(db, [adminAuditStatement({ eventId, actor, action, targetType: 'tenant', targetId, detail, now })])
    return { action, tenantId: targetId, recorded: true }
  }

  throw new Error('Unsupported service admin action.')
}

function adminAuditStatement({ eventId, actor, action, targetType, targetId, detail, now }) {
  return {
    sql: `insert into service_admin_events
      (event_id, actor_user_id, action, target_type, target_id, detail_json, created_at)
      values (?, ?, ?, ?, ?, ?, ?)`,
    params: [eventId, actor.userId, action, targetType, targetId, JSON.stringify(detail ?? {}), now],
  }
}

async function handleUsageStatus(request, env) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    const response = cloudflareError('Method not allowed.', 1004, 405)
    logRequest({ request, env, status: response.status, rejectedReason: 'method-not-allowed' })
    return response
  }
  if (failedAuthRateLimited(request)) {
    const response = rateLimitError()
    logRequest({ request, env, status: response.status, rejectedReason: 'failed-auth-rate-limit' })
    return response
  }

  let body = {}
  if (request.method === 'POST') {
    try {
      body = await request.json()
    } catch {
      body = {}
    }
  }

  let principal
  try {
    principal = await resolveUsagePrincipal(request, env, body)
    clearFailedAuth(request)
  } catch (error) {
    const rateLimited = recordFailedAuth(request)
    const response = rateLimited ? rateLimitError() : authenticationError(error instanceof Error ? error.message : undefined)
    logRequest({ request, env, status: response.status, rejectedReason: rateLimited ? 'failed-auth-rate-limit' : 'Authentication error' })
    return response
  }

  const tenantId = await tenantIdForUsagePrincipal(env.HOPIT_D1_DB, principal)
  const usage = await readTenantUsageRow(env.HOPIT_D1_DB, tenantId)
  const limits = resolvePlanLimits(env, usage?.plan ?? 'free')
  const codebaseCount = await countCodebasesForOwner(env.HOPIT_D1_DB, tenantId)
  const status = computeUsageStatus({
    usage,
    limits,
    warnRatio: warnRatioFromEnv(env),
    day: utcDay(),
    codebaseCount,
  })
  status.enforced = isQuotaEnforced(env)
  const response = json({ success: true, errors: [], messages: [], result: status })
  logRequest({ request, env, authMode: principal.kind, codebaseId: principal.codebaseId ?? null, status: response.status })
  return response
}

// Read-only principal resolution for /usage. Unlike the broker, a server-actor
// here names no codebase (it wants its OWN tenant meter); a session maps to its
// bound codebase's owner; proxy (admin) may name a tenant/codebase explicitly.
async function resolveUsagePrincipal(request, env, body) {
  const token = bearerTokenFromRequest(request)

  const expectedToken = env.HOPIT_D1_PROXY_TOKEN
  if (expectedToken && await constantTimeTokenEqual(token, expectedToken)) {
    const tenantId = typeof body?.tenantId === 'string' ? body.tenantId.trim() : ''
    const codebaseId = typeof body?.codebaseId === 'string' ? body.codebaseId.trim() : ''
    if (!tenantId && !codebaseId) throw new Error('Usage proxy requests must name a tenant id or codebase id.')
    return { kind: 'proxy', userId: tenantId || null, codebaseId: codebaseId || null }
  }

  if (token.startsWith('hsa_')) {
    const actor = await verifyServerActorToken(token, env.HOPIT_D1_SERVER_ACTOR_SECRET)
    if (!actor) throw new Error('Authentication error')
    return { kind: 'server-actor', userId: actor.userId, codebaseId: null }
  }

  if (token.startsWith('hst_')) {
    const session = await readAgentSessionForToken(env.HOPIT_D1_DB, token)
    if (!session) throw new Error('Agent session token was not found.')
    if (session.status !== 'active') throw new Error('Agent session is not active.')
    if (session.expires_at && Date.parse(session.expires_at) <= Date.now()) {
      throw new Error('Agent session token has expired.')
    }
    return { kind: 'session', userId: null, codebaseId: session.codebase_id }
  }

  throw new Error('Authentication error')
}

// The tenant is the codebase's owner (v1 tenant == user). A server-actor/proxy
// principal already carries the user/tenant id.
async function tenantIdForUsagePrincipal(db, principal) {
  if (principal.userId) return principal.userId
  if (principal.codebaseId) return await readCodebaseOwnerId(db, principal.codebaseId)
  return null
}

async function countCodebasesForOwner(db, ownerId) {
  if (!ownerId) return null
  const result = await db.prepare('select count(*) as n from codebases where owner_id = ? limit 1').bind(ownerId).all()
  return Number(result.results?.[0]?.n ?? 0)
}

function assertScopedMutationBatch(policies) {
  const journalHeads = policies.filter((policy) => policy.journalHead)
  const guardedMutations = policies.filter((policy) => policy.fileMutation?.knownGuarded)
  if (journalHeads.length === 0 && guardedMutations.length === 0) return
  if (journalHeads.length !== 1) {
    throw new Error('Scoped journal mutations require exactly one guarded codebase head update.')
  }
  const fileMutations = guardedMutations.filter((policy) => policy.fileMutation.table === 'files')
  if (fileMutations.length === 0) {
    throw new Error('Scoped journal mutations require at least one guarded file operation.')
  }
  if (policies.some((policy) => policy.fileMutation && !policy.fileMutation.knownGuarded)) {
    throw new Error('Scoped journal batches cannot mix guarded and generic file operations.')
  }
  const filePaths = new Set(fileMutations.map((policy) => policy.fileMutation.path))
  for (const policy of guardedMutations) {
    const mutation = policy.fileMutation
    if (!mutation.path) throw new Error('Scoped journal mutations require a bound file path.')
    if (mutation.table === 'file_versions' && !filePaths.has(mutation.path)) {
      throw new Error('Scoped journal history must match a guarded file operation in the same batch.')
    }
  }
}

function assertScopedMutationAccess(policies, access) {
  const mutations = policies.filter((policy) => policy.fileMutation || policy.journalHead)
  if (mutations.length === 0) return
  if (!access) throw new Error('Scoped file mutation access could not be verified.')
  if (policies.some((policy) => policy.journalHead)) {
    if (access.selectedStateType !== 'active-change-set' || !access.selectedStateId) {
      throw new Error('Scoped journal mutations require a selected active change set.')
    }
    if (access.selectedStateMergeState !== 'unmerged') {
      throw new Error('Scoped journal mutations require an unmerged change set.')
    }
    for (const policy of policies) {
      if (policy.journalHead?.format === 'legacy') {
        assertLegacyJournalHeadMatchesCurrentAccess(policy.journalHead, access)
      }
    }
  }
  if (access.isOwner) return
  if (!access.isActiveMember) {
    throw new Error('Scoped file mutations require an active codebase membership.')
  }
  if (access.selectedStateType !== 'active-change-set'
    || (access.effectiveVisibility !== 'team-visible' && access.effectiveVisibility !== 'review-visible')) {
    throw new Error('Scoped collaborators cannot mutate a private active change set.')
  }
  for (const policy of policies) {
    const mutation = policy.fileMutation
    if (!mutation) continue
    if (!mutation.knownGuarded) {
      throw new Error('Scoped collaborators can only use guarded journal file operations.')
    }
    if (!mutation.path || ownerPrivatePath(mutation.path)) {
      throw new Error('Scoped collaborators cannot mutate owner-private paths.')
    }
  }
}

function assertLegacyJournalHeadMatchesCurrentAccess(head, access) {
  const nextSelectedState = parseJson(head.nextSelectedStateJson, null)
  const nextMain = parseJson(head.nextMainJson, null)
  if (head.codebaseId !== access.codebaseId || head.previousRevision !== access.revision) {
    throw new Error('Scoped agent session legacy guarded journal head does not match the current codebase revision.')
  }
  if (stableJson(nextMain) !== stableJson(access.main)) {
    throw new Error('Scoped agent session guarded journal updates must preserve Main.')
  }
  const expectedNext = { ...access.selectedState, revision: head.nextRevision }
  if (stableJson(nextSelectedState) !== stableJson(expectedNext)) {
    throw new Error('Scoped agent session guarded journal updates may only advance selected-state revision.')
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function upgradeLegacyScopedJournalStatements(statements, authorization) {
  if (authorization.kind !== 'session') return statements
  return statements.map((statement, index) => {
    const head = authorization.statementPolicies?.[index]?.journalHead
    if (head?.format !== 'legacy') return statement
    const access = authorization.fileAccess
    if (!access?.selectedStateJson || !access?.mainJson) {
      throw new Error('Scoped agent session legacy guarded journal upgrade requires the current codebase head.')
    }
    return {
      ...statement,
      sql: `${statement.sql.trim()} and selected_state_json = ? and main_json = ?`,
      params: [...(Array.isArray(statement.params) ? statement.params : []), access.selectedStateJson, access.mainJson],
    }
  })
}

async function enforceScopedResultVisibility(db, results, authorization) {
  if (authorization.kind !== 'session') return results
  const policies = authorization.statementPolicies ?? []
  const access = authorization.fileAccess
  const filtered = []
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]
    const policy = policies[index]
    if (!policy?.resultVisibility) {
      filtered.push(result)
      continue
    }
    if (policy.resultVisibility === 'file' || policy.resultVisibility === 'file-version') {
      filtered.push({
        ...result,
        results: (result.results ?? []).filter((row) => scopedFileRowVisible(access, row)),
      })
      continue
    }
    if (policy.resultVisibility === 'file-blob') {
      const blobVisible = await scopedBlobVisible(db, access, policy.blobHash)
      filtered.push({ ...result, results: blobVisible ? (result.results ?? []) : [] })
      continue
    }
    filtered.push({ ...result, results: [] })
  }
  return filtered
}

function scopedFileRowVisible(access, row) {
  if (!access) return false
  if (access.isOwner) return true
  if (!access.isActiveMember) return false
  if (access.selectedStateType !== 'main'
    && access.effectiveVisibility !== 'team-visible'
    && access.effectiveVisibility !== 'review-visible') return false
  return !ownerPrivatePath(row?.path) && row?.scope !== 'owner-private'
}

async function scopedBlobVisible(db, access, blobHash) {
  if (!access || !blobHash) return false
  if (access.isOwner) return true
  if (!access.isActiveMember) return false
  if (access.selectedStateType !== 'main'
    && access.effectiveVisibility !== 'team-visible'
    && access.effectiveVisibility !== 'review-visible') return false
  const result = await db.prepare(
    `select path, scope from files
    where codebase_id = ? and (blob_hash = ? or hash = ?)
    limit 20`,
  ).bind(access.codebaseId, blobHash, blobHash).all()
  return (result.results ?? []).some((row) => scopedFileRowVisible(access, row))
}

function ownerPrivatePath(value) {
  const normalized = String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
  return normalized === '.private'
    || normalized.startsWith('.private/')
    || normalized === '.git'
    || normalized.startsWith('.git/')
}

function bearerTokenFromRequest(request) {
  const authorization = request.headers.get('authorization') ?? ''
  const headerToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? ''
  if (headerToken) return headerToken
  // Query-string tokens exist only because the WebSocket client API cannot set
  // request headers; every other route must keep using the Authorization header.
  if (!isWebSocketUpgrade(request)) return ''
  const url = new URL(request.url)
  return url.searchParams.get('access_token')?.trim() || url.searchParams.get('token')?.trim() || ''
}

async function constantTimeTokenEqual(actual, expected) {
  if (!actual || !expected) return false
  const [actualHash, expectedHash] = await Promise.all([
    sha256Bytes(actual),
    sha256Bytes(expected),
  ])
  let difference = actualHash.length ^ expectedHash.length
  const length = Math.max(actualHash.length, expectedHash.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (actualHash[index] ?? 0) ^ (expectedHash[index] ?? 0)
  }
  return difference === 0
}

async function sha256Bytes(value) {
  const data = new TextEncoder().encode(value)
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data))
}

async function readAgentSessionForToken(db, token) {
  const tokenHash = await hashAgentSessionToken(token)
  const result = await db.prepare('select * from agent_sessions where token_hash = ? limit 1').bind(tokenHash).all()
  return result.results?.[0] ?? null
}

async function hashAgentSessionToken(token) {
  const data = new TextEncoder().encode(`hopit.agent-session.v1:${token}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}


function parseJson(value, fallback) {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function clientIpFromRequest(request) {
  return request.headers.get('cf-connecting-ip')?.trim()
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown'
}

function failedAuthRateLimited(request) {
  const ip = clientIpFromRequest(request)
  const now = Date.now()
  const bucket = failedAuthBuckets.get(ip)
  if (!bucket || now >= bucket.resetAt) {
    failedAuthBuckets.set(ip, { count: 0, resetAt: now + failedAuthWindowMs })
    return false
  }
  return bucket.count >= failedAuthLimit
}

function recordFailedAuth(request) {
  const ip = clientIpFromRequest(request)
  const now = Date.now()
  const bucket = failedAuthBuckets.get(ip)
  if (!bucket || now >= bucket.resetAt) {
    failedAuthBuckets.set(ip, { count: 1, resetAt: now + failedAuthWindowMs })
    return false
  }
  bucket.count += 1
  return bucket.count > failedAuthLimit
}

function clearFailedAuth(request) {
  failedAuthBuckets.delete(clientIpFromRequest(request))
}

function statementCountForBody(body) {
  if (!body) return 0
  return Array.isArray(body) ? body.length : 1
}

function requestCodebaseId(request, session = null) {
  const url = new URL(request.url)
  return request.headers.get('x-hopit-codebase-id')?.trim()
    || url.searchParams.get('codebaseId')?.trim()
    || session?.codebase_id
    || null
}

function requestedAuthMode(request) {
  const token = bearerTokenFromRequest(request)
  return token.startsWith('hst_') ? 'session' : 'proxy'
}

function logRequest({ request, env = {}, authMode = null, codebaseId = null, statementCount = 0, status, rejectedReason = null }) {
  if (env.HOPIT_D1_PROXY_LOG_REQUESTS === '0') return
  const payload = {
    event: 'hopit.d1.proxy.request',
    method: request.method,
    path: new URL(request.url).pathname,
    authMode: authMode ?? requestedAuthMode(request),
    codebaseId,
    statementCount,
    status,
  }
  if (rejectedReason) payload.rejectedReason = rejectedReason
  console.log(JSON.stringify(payload))
}

function rateLimitError() {
  return cloudflareError('Too many failed authentication attempts.', 1005, 429)
}

function isWebSocketUpgrade(request) {
  return request.headers.get('upgrade')?.toLowerCase() === 'websocket'
}

function webSocketPathAllowed(pathname) {
  return pathname === '/events' || pathname === '/push' || pathname.endsWith('/events') || pathname.endsWith('/push')
}

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (isWebSocketUpgrade(request) && webSocketPathAllowed(url.pathname)) {
      return await handleWebSocketUpgrade(request, env)
    }

    // The blob broker (Front 2) only exists when multi-tenancy is switched on.
    // With the flag off this path falls through to the 404 below, so the
    // single-tenant direct-S3-credential blob path is byte-for-byte unchanged.
    if (isMultiTenantEnabled(env) && isBrokerPresignPath(url.pathname)) {
      return await handleBlobPresign(request, env)
    }

    // The per-tenant usage status surface (Front-3 metering) also only exists
    // with the flag on; otherwise it falls through to the 404 below.
    if (isMultiTenantEnabled(env) && isUsageStatusPath(url.pathname)) {
      return await handleUsageStatus(request, env)
    }

    if (isMultiTenantEnabled(env) && isAdminOperationsPath(url.pathname)) {
      return await handleAdminOperations(request, env)
    }

    if (!url.pathname.endsWith('/query')) {
      const response = cloudflareError('Not found.', 1003, 404)
      logRequest({
        request,
        env,
        codebaseId: requestCodebaseId(request),
        status: response.status,
        rejectedReason: 'not-found',
      })
      return response
    }
    if (request.method !== 'POST') {
      const response = cloudflareError('Method not allowed.', 1004, 405)
      logRequest({
        request,
        env,
        codebaseId: requestCodebaseId(request),
        status: response.status,
        rejectedReason: 'method-not-allowed',
      })
      return response
    }

    let body
    try {
      body = await request.json()
    } catch {
      const response = cloudflareError('Request body must be JSON.', 1001, 400)
      logRequest({
        request,
        env,
        codebaseId: requestCodebaseId(request),
        status: response.status,
        rejectedReason: 'invalid-json',
      })
      return response
    }

    const statements = Array.isArray(body) ? body : [body]
    if (failedAuthRateLimited(request)) {
      const response = rateLimitError()
      logRequest({
        request,
        env,
        codebaseId: requestCodebaseId(request),
        statementCount: statementCountForBody(body),
        status: response.status,
        rejectedReason: 'failed-auth-rate-limit',
      })
      return response
    }

    let authorization
    try {
      authorization = await authorizeRequest(request, env, statements)
      clearFailedAuth(request)
    } catch (error) {
      const rateLimited = recordFailedAuth(request)
      const response = rateLimited ? rateLimitError() : authenticationError(error instanceof Error ? error.message : undefined)
      logRequest({
        request,
        env,
        codebaseId: requestCodebaseId(request),
        statementCount: statementCountForBody(body),
        status: response.status,
        rejectedReason: rateLimited ? 'failed-auth-rate-limit' : (error instanceof Error ? error.message : 'Authentication error'),
      })
      return response
    }

    // Per-tenant metering + quota enforcement (no-op unless HOPIT_MULTITENANT).
    // A quota rejection fails the write cleanly (429) BEFORE any statement runs,
    // so no data is written and the agent keeps the change on local disk. The
    // meter upsert is folded into the same batch (+1 row) so it commits with the
    // write. Infra faults in metering fail open (write proceeds, unmetered).
    let metering = null
    try {
      metering = await prepareTenantMetering({ env, db: env.HOPIT_D1_DB, authorization })
    } catch {
      metering = null
    }
    if (metering?.rejection) {
      const response = quotaError(metering.rejection)
      logRequest({
        request,
        env,
        authMode: authorization.kind,
        codebaseId: requestCodebaseId(request, authorization.session),
        statementCount: statementCountForBody(body),
        status: response.status,
        rejectedReason: metering.rejection.code,
      })
      return response
    }
    let authorizedStatements
    try {
      authorizedStatements = upgradeLegacyScopedJournalStatements(statements, authorization)
    } catch (error) {
      const response = authenticationError(error instanceof Error ? error.message : undefined)
      logRequest({
        request,
        env,
        authMode: authorization.kind,
        codebaseId: requestCodebaseId(request, authorization.session),
        statementCount: statementCountForBody(body),
        status: response.status,
        rejectedReason: error instanceof Error ? error.message : 'legacy-guard-upgrade-failed',
      })
      return response
    }
    const statementsToRun = metering?.meterStatement ? [...authorizedStatements, metering.meterStatement] : authorizedStatements

    try {
      const executed = await executeStatements(env.HOPIT_D1_DB, statementsToRun)
      const tenantExecuted = metering?.meterStatement ? executed.slice(0, statements.length) : executed
      const result = await enforceScopedResultVisibility(env.HOPIT_D1_DB, tenantExecuted, authorization)
      await notifyPushHubAfterMutation({ request, env, statements, authorization })
      const response = json({
        success: true,
        errors: [],
        messages: [],
        result,
      })
      logRequest({
        request,
        env,
        authMode: authorization.kind,
        codebaseId: requestCodebaseId(request, authorization.session),
        statementCount: statementCountForBody(body),
        status: response.status,
      })
      return response
    } catch (error) {
      const response = cloudflareError(error instanceof Error ? error.message : 'D1 query failed.', 1002, 400)
      logRequest({
        request,
        env,
        authMode: authorization.kind,
        codebaseId: requestCodebaseId(request, authorization.session),
        statementCount: statementCountForBody(body),
        status: response.status,
        rejectedReason: error instanceof Error ? error.message : 'D1 query failed.',
      })
      return response
    }
  },
}

export default worker
export { CodebasePushHub }

async function handleWebSocketUpgrade(request, env) {
  const url = new URL(request.url)
  const requestedCodebaseId = url.searchParams.get('codebaseId')?.trim() || request.headers.get('x-hopit-codebase-id')?.trim() || null
  if (failedAuthRateLimited(request)) {
    const response = rateLimitError()
    logRequest({
      request,
      env,
      codebaseId: requestedCodebaseId,
      status: response.status,
      rejectedReason: 'failed-auth-rate-limit',
    })
    return response
  }

  let authorization
  try {
    authorization = await authorizeRequest(request, env, [], { codebaseId: requestedCodebaseId })
    clearFailedAuth(request)
  } catch (error) {
    const rateLimited = recordFailedAuth(request)
    const response = rateLimited ? rateLimitError() : authenticationError(error instanceof Error ? error.message : undefined)
    logRequest({
      request,
      env,
      codebaseId: requestedCodebaseId,
      status: response.status,
      rejectedReason: rateLimited ? 'failed-auth-rate-limit' : (error instanceof Error ? error.message : 'Authentication error'),
    })
    return response
  }

  const codebaseId = requestedCodebaseId || authorization.session?.codebase_id || null
  if (!codebaseId) {
    const response = cloudflareError('WebSocket upgrade requires codebaseId.', 1006, 400)
    logRequest({
      request,
      env,
      authMode: authorization.kind,
      codebaseId,
      status: response.status,
      rejectedReason: 'codebase-id-missing',
    })
    return response
  }

  const namespace = env.HOPIT_PUSH_HUB
  if (!namespace?.idFromName || !namespace?.get) {
    const response = cloudflareError('Push hub binding is not configured.', 1007, 503)
    logRequest({
      request,
      env,
      authMode: authorization.kind,
      codebaseId,
      status: response.status,
      rejectedReason: 'push-hub-binding-missing',
    })
    return response
  }

  const forwardUrl = new URL(request.url)
  forwardUrl.searchParams.set('codebaseId', codebaseId)
  const objectId = namespace.idFromName(codebaseId)
  const response = await namespace.get(objectId).fetch(new Request(forwardUrl.toString(), request))
  logRequest({
    request,
    env,
    authMode: authorization.kind,
    codebaseId,
    status: response.status,
  })
  return response
}

async function notifyPushHubAfterMutation({ request, env, statements, authorization }) {
  const namespace = env.HOPIT_PUSH_HUB
  if (!namespace?.idFromName || !namespace?.get) return

  const codebaseIds = affectedGraphCodebaseIds({ request, statements, authorization })
  for (const codebaseId of codebaseIds) {
    try {
      const envelope = await readRemoteUpdateEnvelope(env.HOPIT_D1_DB, codebaseId)
      if (!envelope) continue
      const objectId = namespace.idFromName(codebaseId)
      const response = await namespace.get(objectId).fetch('https://push-hub.internal/notify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope),
      })
      if (!response.ok) throw new Error(`push_notify_failed: ${response.status}`)
    } catch (error) {
      logPushNotifyFailure({
        request,
        env,
        authMode: authorization.kind,
        codebaseId,
        reason: error instanceof Error ? error.message : 'push_notify_failed',
      })
    }
  }
}

function affectedGraphCodebaseIds({ request, statements, authorization }) {
  if (!statements.some(statementMutatesGraphState)) return []
  const fallback = requestCodebaseId(request, authorization.session)
  return fallback ? [fallback] : []
}

function statementMutatesGraphState(statement) {
  const normalized = statement?.sql?.trim().replace(/\s+/g, ' ').toLowerCase()
  if (!normalized || !/^(insert|update|delete)\b/.test(normalized)) return false
  return /\b(codebases|files|file_versions|file_blobs)\b/.test(normalized)
}

async function readRemoteUpdateEnvelope(db, codebaseId) {
  const head = await db.prepare(
    `select codebase_id, revision, selected_state_json from codebases where codebase_id = ? limit 1`,
  ).bind(codebaseId).all()
  const row = head.results?.[0]
  if (!row) return null

  const revision = integerOrNull(row.revision)
  const selectedState = parseJson(row.selected_state_json, null)
  const selectedStateId = typeof selectedState?.id === 'string' ? selectedState.id : null
  if (!Number.isInteger(revision) || !selectedStateId) return null

  const changed = await db.prepare(
    `select path, scope from files where codebase_id = ? and revision = ? order by path asc limit 100`,
  ).bind(codebaseId, revision).all()
  // Only shared path names go into the broadcast hint: every authenticated
  // socket for the codebase receives the envelope, so owner-private path names
  // must stay out of it and surface only as scope counts.
  const changedPaths = (changed.results ?? [])
    .filter((entry) => entry.scope !== 'owner-private' && !(typeof entry.path === 'string' && entry.path.startsWith('.private/')))
    .map((entry) => entry.path)
    .filter((entry) => typeof entry === 'string')
  const envelope = {
    type: 'codebase.remote_update',
    codebaseId,
    selectedStateId,
    revision,
    eventId: `evt_${codebaseId}_${revision}_${crypto.randomUUID()}`,
    changedPaths,
    scopeCounts: scopeCountsForRows(changed.results ?? []),
  }
  return normalizeRemoteUpdateEnvelope(envelope)
}

function scopeCountsForRows(rows) {
  let shared = 0
  let privateCount = 0
  for (const row of rows) {
    if (row.scope === 'owner-private' || (typeof row.path === 'string' && row.path.startsWith('.private/'))) {
      privateCount += 1
    } else {
      shared += 1
    }
  }
  return { shared, private: privateCount }
}

function logPushNotifyFailure({ request, env = {}, authMode = null, codebaseId = null, reason }) {
  if (env.HOPIT_D1_PROXY_LOG_REQUESTS === '0') return
  console.log(JSON.stringify({
    event: 'hopit.d1.proxy.push_notify_failed',
    method: request.method,
    path: new URL(request.url).pathname,
    authMode: authMode ?? requestedAuthMode(request),
    codebaseId,
    reason,
  }))
}

function integerOrNull(value) {
  if (Number.isInteger(value)) return value
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : null
}

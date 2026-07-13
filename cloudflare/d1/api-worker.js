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
    `select c.owner_id, c.selected_state_json, c.visibility_json,
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

function guardedStorageDelta(policies) {
  let bytes = 0
  for (const policy of policies ?? []) {
    const contribution = Number(policy?.fileMutation?.storageBytes)
    if (Number.isFinite(contribution) && contribution > 0) bytes += contribution
  }
  return bytes
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

  const storageDelta = guardedStorageDelta(policies)
  const day = utcDay()

  if (isQuotaEnforced(env)) {
    const usage = await readTenantUsageRow(db, tenantId)
    const limits = resolvePlanLimits(env, usage?.plan ?? 'free')
    const rejection = evaluateWriteQuota({ usage, limits, day, rowsDelta, storageDelta })
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
    const statementsToRun = metering?.meterStatement ? [...statements, metering.meterStatement] : statements

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

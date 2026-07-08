import { CodebasePushHub, normalizeRemoteUpdateEnvelope } from './push-hub.js'

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

async function executeStatement(db, statement) {
  if (!statement || typeof statement.sql !== 'string' || statement.sql.trim() === '') {
    throw new Error('Expected a non-empty SQL statement.')
  }
  const params = Array.isArray(statement.params) ? statement.params : []
  const startedAt = Date.now()
  const executed = await db.prepare(statement.sql).bind(...params).all()
  return {
    results: executed.results ?? [],
    success: true,
    meta: {
      ...(executed.meta ?? {}),
      duration: executed.meta?.duration ?? Math.max(0, Date.now() - startedAt),
    },
  }
}

async function authorizeRequest(request, env, statements, options = {}) {
  const token = bearerTokenFromRequest(request)
  const expectedToken = env.HOPIT_D1_PROXY_TOKEN
  if (expectedToken && await constantTimeTokenEqual(token, expectedToken)) return { kind: 'proxy' }
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

  for (const statement of statements) {
    assertScopedSessionStatementAllowed(session, statement)
  }

  return { kind: 'session', session }
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

function assertScopedSessionStatementAllowed(session, statement) {
  const sql = statement?.sql
  if (typeof sql !== 'string') throw new Error('Expected a SQL statement.')
  const normalized = sql.trim().replace(/\s+/g, ' ').toLowerCase()
  if (!/^(select|insert|update|delete)\b/.test(normalized)) {
    throw new Error('Scoped agent sessions cannot run schema or administrative SQL.')
  }

  const requiredCapability = requiredCapabilityForStatement(normalized)
  if (!agentSessionHasCapability(session, requiredCapability)) {
    throw new Error(`Agent session does not have ${requiredCapability} capability.`)
  }

  if (!statementIsScopedToCodebase(normalized, statement.params, session.codebase_id)) {
    throw new Error('Scoped agent session SQL must be constrained to its codebase.')
  }
}

function requiredCapabilityForStatement(normalizedSql) {
  if (/^select\b/.test(normalizedSql)) return 'read'
  if (touchesAdminTable(normalizedSql)) return 'admin'
  return 'write'
}

function touchesAdminTable(normalizedSql) {
  return /\b(codebase_members|codebase_invitations|agent_sessions|device_keys|user_keyrings|codebase_keyrings|wrapped_keys|key_audit_events|users)\b/.test(normalizedSql)
}

function statementIsScopedToCodebase(normalizedSql, params, codebaseId) {
  if (!codebaseId) return false
  if (!touchesCodebaseScopedTable(normalizedSql)) return false
  return Array.isArray(params) && params.includes(codebaseId)
}

function touchesCodebaseScopedTable(normalizedSql) {
  return /\b(codebases|files|file_versions|file_blobs|agent_events|action_jobs|collaboration_counters|issues|issue_comments|projects|project_items|discussions|discussion_comments|releases|release_assets|review_threads|review_thread_comments|review_decisions|notifications|codebase_members|codebase_invitations|agent_sessions|codebase_keyrings|wrapped_keys|key_audit_events)\b/.test(normalizedSql)
}

function agentSessionHasCapability(session, capability) {
  const capabilities = parseJson(session.capabilities_json, [])
  return Array.isArray(capabilities) && (capabilities.includes('admin') || capabilities.includes(capability))
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

    try {
      const result = []
      for (const statement of statements) {
        result.push(await executeStatement(env.HOPIT_D1_DB, statement))
      }
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

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

async function authorizeRequest(request, env, statements) {
  const authorization = request.headers.get('authorization') ?? ''
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? ''
  const expectedToken = env.HOPIT_D1_PROXY_TOKEN
  if (expectedToken && await constantTimeTokenEqual(token, expectedToken)) return { kind: 'proxy' }
  if (!token.startsWith('hst_')) throw new Error('Authentication error')

  const session = await readAgentSessionForToken(env.HOPIT_D1_DB, token)
  if (!session) throw new Error('Agent session token was not found.')
  if (session.status !== 'active') throw new Error('Agent session is not active.')
  if (session.expires_at && Date.parse(session.expires_at) <= Date.now()) {
    throw new Error('Agent session token has expired.')
  }

  const requestedCodebaseId = request.headers.get('x-hopit-codebase-id')?.trim() ?? ''
  if (requestedCodebaseId && requestedCodebaseId !== session.codebase_id) {
    throw new Error('Agent session is not scoped to the requested codebase.')
  }

  for (const statement of statements) {
    assertScopedSessionStatementAllowed(session, statement)
  }

  return { kind: 'session', session }
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
  return /\b(codebases|files|file_blobs|agent_events|action_jobs|collaboration_counters|issues|issue_comments|projects|project_items|discussions|discussion_comments|releases|release_assets|review_threads|review_thread_comments|review_decisions|notifications|codebase_members|codebase_invitations|agent_sessions|codebase_keyrings|wrapped_keys|key_audit_events)\b/.test(normalizedSql)
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
  return request.headers.get('x-hopit-codebase-id')?.trim() || session?.codebase_id || null
}

function requestedAuthMode(request) {
  const authorization = request.headers.get('authorization') ?? ''
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? ''
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

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url)
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

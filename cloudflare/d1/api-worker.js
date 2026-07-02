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
  if (expectedToken && token === expectedToken) return { kind: 'proxy' }
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

  return { kind: 'agent-session', session }
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

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (!url.pathname.endsWith('/query')) {
      return cloudflareError('Not found.', 1003, 404)
    }
    if (request.method !== 'POST') {
      return cloudflareError('Method not allowed.', 1004, 405)
    }

    let body
    try {
      body = await request.json()
    } catch {
      return cloudflareError('Request body must be JSON.', 1001, 400)
    }

    const statements = Array.isArray(body) ? body : [body]
    try {
      await authorizeRequest(request, env, statements)
    } catch (error) {
      return authenticationError(error instanceof Error ? error.message : undefined)
    }

    try {
      const result = []
      for (const statement of statements) {
        result.push(await executeStatement(env.HOPIT_D1_DB, statement))
      }
      return json({
        success: true,
        errors: [],
        messages: [],
        result,
      })
    } catch (error) {
      return cloudflareError(error instanceof Error ? error.message : 'D1 query failed.', 1002, 400)
    }
  },
}

export default worker

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

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (!url.pathname.endsWith('/query')) {
      return cloudflareError('Not found.', 1003, 404)
    }
    if (request.method !== 'POST') {
      return cloudflareError('Method not allowed.', 1004, 405)
    }

    const expectedToken = env.HOPIT_D1_PROXY_TOKEN
    const authorization = request.headers.get('authorization') ?? ''
    if (!expectedToken || authorization !== `Bearer ${expectedToken}`) {
      return cloudflareError('Authentication error', 10000, 403)
    }

    let body
    try {
      body = await request.json()
    } catch {
      return cloudflareError('Request body must be JSON.', 1001, 400)
    }

    const statements = Array.isArray(body) ? body : [body]
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

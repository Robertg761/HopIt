// Adversarial cross-tenant isolation, exercised end-to-end against a real
// SQLite-backed D1 Worker (Phase 3 Stage-0).
//
// Two distinct owners, each with their own codebase:
//   user_a owns codebase-a (holds a private secret file)
//   user_b owns codebase-b (holds a scoped agent session)
//
// Every attack drives user_b's scoped session against user_a's codebase and
// asserts that the boundary holds: no read leaks a byte of A's data, no write
// mutates A, and A's rows are provably unchanged afterward. A same-tenant
// control on each surface proves the rejections are the tenant boundary talking
// and not a broken harness.

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import d1ApiWorker from '../../../cloudflare/d1/api-worker.js'
import { createD1Backend } from '@hopit/backend-d1'

const SECRET = 'user-a-private-secret-do-not-leak'
const PROXY_TOKEN = 'token_test'

test('cross-tenant: user_b scoped session cannot read or mutate user_a codebase through the real Worker', async (t) => {
  const server = await startD1ApiServer(t)

  const backendA = proxyBackend(server.baseUrl, 'codebase-a')
  const backendB = proxyBackend(server.baseUrl, 'codebase-b')
  await backendA.initialize(graphFor('codebase-a', 'user_a', {
    'README.md': fileEntry('alpha readme'),
    'SECRET.md': fileEntry(SECRET),
  }))
  await backendB.initialize(graphFor('codebase-b', 'user_b', {
    'README.md': fileEntry('beta readme'),
  }))

  const registered = await backendB.registerAgentSession({
    codebaseId: 'codebase-b',
    sessionId: 'session_b',
    deviceName: 'user-b device',
    capabilities: ['read', 'write', 'admin'],
  })
  assert.match(registered.sessionToken, /^hst_/)

  const scopedB = createD1Backend({
    'codebase-id': 'codebase-b',
    'd1-api-base-url': server.baseUrl,
    'session-token': registered.sessionToken,
  })

  // Same-tenant control: user_b reads its own codebase just fine.
  const ownGraph = await scopedB.readGraph('codebase-b')
  assert.equal(ownGraph.codebase.id, 'codebase-b')
  assert.ok(ownGraph.files['README.md'])

  // Attack 1: read user_a's graph through user_b's session.
  await assert.rejects(
    () => scopedB.readGraph('codebase-a'),
    /constrained to its codebase|Authentication error|not scoped/,
    'user_b must not read codebase-a',
  )

  // Attack 2: write into user_a's codebase through user_b's session.
  const forgedGraph = graphFor('codebase-a', 'user_a', {
    'README.md': fileEntry('alpha readme'),
    'SECRET.md': fileEntry(SECRET),
    'PLANTED.md': fileEntry('user-b was here'),
  })
  forgedGraph.revision = 2
  forgedGraph.main.revision = 2
  await assert.rejects(
    () => scopedB.writeGraph(forgedGraph),
    /constrained to its codebase|Authentication error|not scoped/,
    'user_b must not write codebase-a',
  )

  // Attack 3: raw transport: hit the Worker directly with user_b's token and a
  // statement byte-identical to A's own read. The response must be a 403 and
  // must not carry A's secret anywhere in its body.
  const raw = await fetch(`${server.baseUrl}/query`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${registered.sessionToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sql: 'select * from files where codebase_id = ?', params: ['codebase-a'] }),
  })
  assert.equal(raw.status, 403)
  const rawText = await raw.text()
  assert.equal(rawText.includes(SECRET), false, 'secret must not leak in the rejection body')

  // Proof of no side effects: A is byte-for-byte intact and never grew a row.
  const afterA = await backendA.readGraph('codebase-a')
  assert.equal(afterA.files['SECRET.md'].content, SECRET)
  assert.equal(Object.hasOwn(afterA.files, 'PLANTED.md'), false)
  assert.equal(afterA.revision, 1)
})

test('cross-tenant: backend visibility hides user_a private files from a user_b requester', async (t) => {
  const server = await startD1ApiServer(t)
  const backendA = proxyBackend(server.baseUrl, 'codebase-a')
  await backendA.initialize(graphFor('codebase-a', 'user_a', {
    'README.md': fileEntry('alpha readme'),
    'SECRET.md': fileEntry(SECRET),
  }))

  // Owner sees everything.
  const ownerView = await backendA.readVisibleGraph({ requesterId: 'user_a' }, 'codebase-a')
  assert.deepEqual(Object.keys(ownerView.files).sort(), ['README.md', 'SECRET.md'])

  // A stranger from another tenant (user_b) sees nothing of a private codebase.
  const strangerView = await backendA.readVisibleGraph({ requesterId: 'user_b' }, 'codebase-a')
  assert.deepEqual(Object.keys(strangerView.files), [])
  assert.equal(JSON.stringify(strangerView).includes(SECRET), false)

  // Capability- and member-gated surfaces reject the stranger outright.
  await assert.rejects(
    () => backendA.requireGraphCapability('codebase-a', { userId: 'user_b' }, 'read'),
    /does not have read access/,
  )
  await assert.rejects(
    () => backendA.listMembers({ codebaseId: 'codebase-a', actor: { userId: 'user_b' } }),
    /does not have read access/,
  )
})

// --- harness -----------------------------------------------------------------

function proxyBackend(baseUrl, codebaseId) {
  return createD1Backend({
    'codebase-id': codebaseId,
    'd1-api-base-url': baseUrl,
    'd1-account-id': 'account_test',
    'd1-database-id': 'database_test',
    'd1-api-token': PROXY_TOKEN,
  })
}

function fileEntry(content) {
  return {
    kind: 'file',
    content,
    encoding: 'utf8',
    revision: 1,
    updatedAt: '2026-07-08T00:00:00.000Z',
  }
}

function graphFor(codebaseId, ownerId, files) {
  const now = '2026-07-08T00:00:00.000Z'
  const changeSetId = `cs_${codebaseId.replace(/[^a-z0-9]+/gi, '_')}`
  return {
    schemaVersion: 2,
    codebase: { id: codebaseId, name: codebaseId, ownerId },
    main: { id: 'main', revision: 1, updatedAt: now, mergedChangeSetId: null },
    selectedState: {
      type: 'active-change-set',
      id: changeSetId,
      ownerId,
      baseMainId: 'main',
      baseRevision: 1,
      revision: 1,
      visibility: 'private',
      effectiveVisibility: 'private',
      reviewState: 'not-open',
      mergeState: 'unmerged',
      conflictState: 'none',
      conflict: null,
      review: null,
      merge: null,
    },
    owner: { id: ownerId, name: ownerId },
    collaborators: [],
    session: { id: `session_${codebaseId.replace(/[^a-z0-9]+/gi, '_')}`, deviceName: 'test' },
    visibility: {
      productDefault: 'private',
      globalUserDefault: null,
      codebaseOverride: null,
      changeSetOverride: 'private',
      effective: 'private',
    },
    revision: 1,
    files,
  }
}

async function startD1ApiServer(t) {
  const db = new DatabaseSync(':memory:')
  const env = {
    HOPIT_D1_DB: d1Binding(db),
    HOPIT_D1_PROXY_TOKEN: PROXY_TOKEN,
    HOPIT_D1_PROXY_LOG_REQUESTS: '0',
  }
  const server = createServer(async (request, response) => {
    try {
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await readRequestBody(request)
      const workerRequest = new Request(`http://127.0.0.1${request.url ?? '/query'}`, {
        method: request.method,
        headers: request.headers,
        body,
      })
      const workerResponse = await d1ApiWorker.fetch(workerRequest, env)
      response.writeHead(workerResponse.status, Object.fromEntries(workerResponse.headers.entries()))
      response.end(await workerResponse.text())
    } catch (error) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        success: true,
        result: [{ success: false, results: [], error: error instanceof Error ? error.message : 'query failed' }],
      }))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => {
    db.close()
    server.close()
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : null
  if (!port) throw new Error('D1 test server did not bind a port.')
  return { baseUrl: `http://127.0.0.1:${port}`, db }
}

function d1Binding(db) {
  return {
    prepare(sql) {
      const statement = db.prepare(sql)
      return {
        bind(...params) {
          return {
            all() {
              const isSelect = sql.trim().toLowerCase().startsWith('select')
              const result = isSelect ? null : statement.run(...params)
              const rows = isSelect ? statement.all(...params) : []
              return { results: rows, meta: { changes: result?.changes ?? 0 } }
            },
          }
        },
      }
    },
  }
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

// End-to-end proof of the Phase 3 Stage 1a server-actor tier (Front 1), driven
// through the real @hopit/backend-d1 client against a real SQLite-backed D1
// Worker with HOPIT_MULTITENANT on.
//
// Two owners: user_a owns codebase-a, user_b owns codebase-b. The dashboard for
// user_a talks to D1 as a per-request `hsa_` server-actor principal (NOT the
// proxy super-token). The property under test: with the flag on, user_a can list
// and read only its own codebase; any statement reaching codebase-b fails closed
// AT THE WORKER, even though the same real backend methods run. A proxy-token
// control proves the seeding and harness are sound.

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import d1ApiWorker from '../../../cloudflare/d1/api-worker.js'
import { createD1Backend, mintServerActorToken, usesServerActorAuth } from '@hopit/backend-d1'

const PROXY_TOKEN = 'token_test'
const SERVER_ACTOR_SECRET = 'server-actor-secret-e2e'

test('mintServerActorToken round-trips through the Worker and gates by flag/secret config', () => {
  // usesServerActorAuth is the client-side switch: it only fires with the flag on
  // AND an authenticated user id AND a shared secret present.
  assert.equal(usesServerActorAuth({ multiTenant: false, serverActorUserId: 'u', serverActorSecret: 's' }), false)
  assert.equal(usesServerActorAuth({ multiTenant: true, serverActorUserId: null, serverActorSecret: 's' }), false)
  assert.equal(usesServerActorAuth({ multiTenant: true, serverActorUserId: 'u', serverActorSecret: null }), false)
  assert.equal(usesServerActorAuth({ multiTenant: true, serverActorUserId: 'u', serverActorSecret: 's' }), true)
  const token = mintServerActorToken({ userId: 'user_a', secret: SERVER_ACTOR_SECRET })
  assert.match(token, /^hsa_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
})

test('server-actor dashboard: user_a reads only its own codebase; codebase-b fails closed at the Worker', async (t) => {
  const server = await startD1ApiServer(t)

  // Seed two tenants with the proxy (admin) path — the residual proxy use.
  const backendA = proxyBackend(server.baseUrl, 'codebase-a')
  const backendB = proxyBackend(server.baseUrl, 'codebase-b')
  await backendA.initialize(graphFor('codebase-a', 'user_a', { 'README.md': fileEntry('alpha') }))
  await backendB.initialize(graphFor('codebase-b', 'user_b', { 'README.md': fileEntry('beta') }))

  const dashboardA = serverActorBackend(server.baseUrl, 'user_a')

  // The dashboard client presents an hsa_ token, not the proxy token.
  assert.equal(usesServerActorAuth(dashboardA.config), true)

  // user_a lists codebases: only its own appears, and the cross-codebase listing
  // is accepted because it is anchored to user_a's own id.
  const listed = await dashboardA.listCodebases({ userId: 'user_a' })
  assert.deepEqual(listed.map((summary) => summary.codebase?.id ?? summary.codebaseId ?? summary.id).sort(), ['codebase-a'])

  // Reading its own codebase works end to end through the server-actor tier.
  const ownGraph = await dashboardA.readGraph('codebase-a')
  assert.equal(ownGraph.codebase.id, 'codebase-a')
  assert.ok(ownGraph.files['README.md'])

  // Reading user_b's codebase is refused at the Worker — the server-actor is not
  // entitled to codebase-b, so no row of B leaks.
  await assert.rejects(
    () => dashboardA.readGraph('codebase-b'),
    /not entitled|Authentication error|access/,
    'user_a dashboard must not read codebase-b',
  )

  // Control: the proxy (admin) path can still read codebase-b, proving the
  // rejection above is the server-actor boundary and not a broken harness.
  const adminGraph = await backendB.readGraph('codebase-b')
  assert.equal(adminGraph.codebase.id, 'codebase-b')
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

function serverActorBackend(baseUrl, userId) {
  // Mirrors the hosted dashboard under HOPIT_MULTITENANT: no proxy token, a
  // per-request server-actor credential carrying the authenticated user id, and
  // schema assumed (DDL stays on the admin/migration proxy path).
  return createD1Backend({
    'd1-api-base-url': baseUrl,
    'multi-tenant': true,
    'server-actor-user-id': userId,
    'server-actor-secret': SERVER_ACTOR_SECRET,
    'assume-schema': true,
  }, {})
}

function fileEntry(content) {
  return { kind: 'file', content, encoding: 'utf8', revision: 1, updatedAt: '2026-07-08T00:00:00.000Z' }
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
    // The switch that lights up the server-actor tier.
    HOPIT_MULTITENANT: '1',
    HOPIT_D1_SERVER_ACTOR_SECRET: SERVER_ACTOR_SECRET,
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
    async batch(statements) {
      return statements.map((statement) => statement.all())
    },
  }
}

async function readRequestBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

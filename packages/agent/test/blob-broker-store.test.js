// Phase 3 Stage 1b: R2 blob broker, agent (client) half.
//
// Proves the agent's broker blob-store mode round-trips WITHOUT ever holding
// account R2 credentials: it asks the REAL Worker broker (authed by its hst_
// session token) for a short-lived presigned URL, then does a raw PUT/GET against
// a fake R2. The cross-tenant case proves a codebase-A client cannot obtain a
// working URL for codebase-B's blob: the broker refuses before signing. Flag-off
// keeps the direct-credential S3 provider byte-for-byte.

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import d1ApiWorker from '../../../cloudflare/d1/api-worker.js'
import { createD1Backend } from '@hopit/backend-d1'
import {
  BrokerBlobStore,
  S3CompatibleBlobStore,
  blobKeyForHash,
  createObjectBlobStore,
} from '../src/blob-stores/index.js'
import { hashBuffer } from '../src/journal.js'

const PROXY_TOKEN = 'token_test'

// --- round trip against the real Worker broker + a fake R2 -------------------

test('broker mode round-trips a blob through a presigned URL without account creds', async (t) => {
  const r2 = await startFakeR2(t)
  const broker = await startWorkerBroker(t, r2.baseUrl)
  const { tokenA } = await seedCodebases(broker.baseUrl)

  const store = new BrokerBlobStore({
    brokerUrl: `${broker.baseUrl}/blob-presign`,
    authToken: tokenA,
    prefix: '',
  })

  const buffer = Buffer.from('broker round-trip payload')
  const hash = hashBuffer(buffer)
  const descriptor = await store.putBlob({
    codebaseId: 'codebase-a',
    relativePath: 'notes/roundtrip.txt',
    hash,
    buffer,
  })
  assert.equal(descriptor.provider, 'r2')
  assert.equal(descriptor.key, blobKeyForHash('', 'codebase-a', hash))
  // The bytes actually landed in the fake R2 under codebase-a's namespace.
  assert.ok([...r2.objects.keys()].some((key) => key.includes('/codebases/codebase-a/blobs/')))

  const roundTripped = await store.getBlob({
    blobKey: descriptor.key,
    blobHash: descriptor.blobHash,
    blobSize: descriptor.blobSize,
    hash,
  })
  assert.equal(Buffer.from(roundTripped).toString('utf8'), 'broker round-trip payload')

  // A second put of identical content is a no-op upload (HEAD says it exists).
  const before = r2.putCount
  await store.putBlob({ codebaseId: 'codebase-a', relativePath: 'notes/roundtrip.txt', hash, buffer })
  assert.equal(r2.putCount, before)
})

test('broker mode: a codebase-A client cannot presign or write a codebase-B blob', async (t) => {
  const r2 = await startFakeR2(t)
  const broker = await startWorkerBroker(t, r2.baseUrl)
  const { tokenA } = await seedCodebases(broker.baseUrl)

  const store = new BrokerBlobStore({
    brokerUrl: `${broker.baseUrl}/blob-presign`,
    authToken: tokenA, // scoped to codebase-a
    prefix: '',
  })

  const buffer = Buffer.from('cross-tenant attempt')
  await assert.rejects(
    () => store.putBlob({ codebaseId: 'codebase-b', relativePath: 'steal.txt', hash: hashBuffer(buffer), buffer }),
    /broker_presign_failed/,
    'codebase-a token must not presign a codebase-b write',
  )
  // A forged GET for a codebase-b key under the codebase-a session is refused too.
  await assert.rejects(
    () => store.getBlob({ blobKey: blobKeyForHash('', 'codebase-b', hashBuffer(buffer)), hash: hashBuffer(buffer) }),
    /broker_presign_failed/,
    'codebase-a token must not presign a codebase-b read',
  )
  assert.equal(r2.putCount, 0)
})

// --- flag wiring: broker only when HOPIT_BLOB_BROKER is on --------------------

test('createObjectBlobStore returns the direct S3 store when the broker flag is off', () => {
  const store = createObjectBlobStore({
    'blob-provider': 'r2',
    'r2-account-id': 'acct',
    'r2-bucket': 'hopit-blobs',
    'r2-access-key-id': 'AKIA',
    'r2-secret-access-key': 'secret',
  })
  assert.ok(store instanceof S3CompatibleBlobStore)
  assert.equal(store.provider, 'r2')
  // The direct store still holds account credentials and signs locally: unchanged.
  assert.equal(store.accessKeyId, 'AKIA')
})

test('createObjectBlobStore returns the broker store when the broker flag is on', () => {
  const store = createObjectBlobStore({
    'blob-provider': 'r2',
    'blob-broker': '1',
    'blob-broker-url': 'https://worker.example/blob-presign',
    'session-token': 'hst_example_session',
    // Deliberately NO r2-access-key-id / r2-secret-access-key: broker mode must
    // work without the agent ever holding account credentials.
  })
  assert.ok(store instanceof BrokerBlobStore)
  assert.equal(store.provider, 'r2')
  assert.equal(store.brokerUrl, 'https://worker.example/blob-presign')
})

// --- harness -----------------------------------------------------------------

const SERVER_ACTOR_SECRET = 'server-actor-secret'

async function seedCodebases(brokerBaseUrl) {
  const backendA = proxyBackend(brokerBaseUrl, 'codebase-a')
  const backendB = proxyBackend(brokerBaseUrl, 'codebase-b')
  await backendA.initialize(graphFor('codebase-a', 'user_a'))
  await backendB.initialize(graphFor('codebase-b', 'user_b'))
  const sessionA = await backendA.registerAgentSession({
    codebaseId: 'codebase-a',
    sessionId: 'session_a',
    deviceName: 'user-a device',
    capabilities: ['read', 'write'],
  })
  assert.match(sessionA.sessionToken, /^hst_/)
  return { tokenA: sessionA.sessionToken }
}

function proxyBackend(baseUrl, codebaseId) {
  return createD1Backend({
    'codebase-id': codebaseId,
    'd1-api-base-url': baseUrl,
    'd1-account-id': 'account_test',
    'd1-database-id': 'database_test',
    'd1-api-token': PROXY_TOKEN,
  })
}

function graphFor(codebaseId, ownerId) {
  const now = '2026-07-13T00:00:00.000Z'
  return {
    schemaVersion: 2,
    codebase: { id: codebaseId, name: codebaseId, ownerId },
    main: { id: 'main', revision: 1, updatedAt: now, mergedChangeSetId: null },
    selectedState: {
      type: 'active-change-set',
      id: `cs_${codebaseId}`,
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
    session: { id: `session_${codebaseId}`, deviceName: 'test' },
    visibility: {
      productDefault: 'private',
      globalUserDefault: null,
      codebaseOverride: null,
      changeSetOverride: 'private',
      effective: 'private',
    },
    revision: 1,
    files: {},
  }
}

async function startFakeR2(t) {
  const objects = new Map()
  const state = { putCount: 0 }
  const server = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0]
    if (request.method === 'PUT') {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        objects.set(path, Buffer.concat(chunks))
        state.putCount += 1
        response.writeHead(200).end()
      })
      return
    }
    if (request.method === 'HEAD') {
      response.writeHead(objects.has(path) ? 200 : 404).end()
      return
    }
    if (request.method === 'GET') {
      const body = objects.get(path)
      if (!body) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200).end(body)
      return
    }
    response.writeHead(405).end()
  })
  await listen(server)
  t.after(() => server.close())
  const port = server.address().port
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    objects,
    get putCount() {
      return state.putCount
    },
  }
}

async function startWorkerBroker(t, r2BaseUrl) {
  const db = new DatabaseSync(':memory:')
  const env = {
    HOPIT_D1_DB: d1Binding(db),
    HOPIT_D1_PROXY_TOKEN: PROXY_TOKEN,
    HOPIT_D1_PROXY_LOG_REQUESTS: '0',
    HOPIT_MULTITENANT: '1',
    HOPIT_D1_SERVER_ACTOR_SECRET: SERVER_ACTOR_SECRET,
    HOPIT_R2_ENDPOINT: r2BaseUrl,
    HOPIT_R2_BUCKET: 'hopit-blobs',
    HOPIT_R2_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    HOPIT_R2_SECRET_ACCESS_KEY: 'secret-example',
    HOPIT_R2_REGION: 'auto',
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
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ success: false, errors: [{ message: error instanceof Error ? error.message : 'failed' }] }))
    }
  })
  await listen(server)
  t.after(() => {
    db.close()
    server.close()
  })
  const port = server.address().port
  return { baseUrl: `http://127.0.0.1:${port}` }
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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
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

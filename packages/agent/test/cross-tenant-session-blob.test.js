// Adversarial cross-tenant isolation for two surfaces that the end-to-end
// worker/visibility suites do not reach:
//
//   Surface 4: Blob storage key derivation (packages/agent/src/blob-stores).
//     Prove that one tenant's managed blob keys are codebase-namespaced and can
//     neither be computed as, mistaken for, nor deleted as another tenant's.
//
//   Surface 3: Agent-session capability boundary (packages/backend-d1).
//     Prove that an hst_ session scoped to codebase A cannot drive the
//     administrative session/key surfaces of codebase B: it can neither revoke
//     B's sessions, enumerate them, pass its access checks, nor read B's keys.
//
// Every attack has a same-tenant control so a rejection is proven to be the
// tenant boundary talking, not a broken harness.

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import d1ApiWorker from '../../../cloudflare/d1/api-worker.js'
import { createD1Backend } from '@hopit/backend-d1'
import {
  assertManagedBlobKey,
  blobKeyForHash,
  isManagedBlobKey,
  managedBlobPrefix,
  reachableBlobKeysForCloud,
} from '../src/blob-stores/index.js'
import { contentStorageMode, entryKind } from '../src/constants.js'

const PROXY_TOKEN = 'token_test'
const HASH_A = 'a'.repeat(64)
const HASH_SHARED = 'f'.repeat(64)

// --- Surface 4: blob key namespacing ----------------------------------------

test('blob keys are codebase-namespaced: same content hashes to distinct keys per tenant', () => {
  const prefix = 'hopit-prod'
  const keyA = blobKeyForHash(prefix, 'codebase-a', HASH_SHARED)
  const keyB = blobKeyForHash(prefix, 'codebase-b', HASH_SHARED)

  // Identical content (same sha256) MUST NOT collapse to a shared object key.
  assert.notEqual(keyA, keyB)
  assert.match(keyA, /\/codebases\/codebase-a\/blobs\/sha256\//)
  assert.match(keyB, /\/codebases\/codebase-b\/blobs\/sha256\//)
  // Neither key is a path-prefix of the other, so a listing of one tenant's
  // namespace can never enumerate the other's.
  assert.equal(keyA.startsWith(managedBlobPrefix(prefix, 'codebase-b')), false)
  assert.equal(keyB.startsWith(managedBlobPrefix(prefix, 'codebase-a')), false)
})

test('one tenant blob key is not a managed key for another tenant', () => {
  const prefix = 'hopit-prod'
  const keyA = blobKeyForHash(prefix, 'codebase-a', HASH_A)

  assert.equal(isManagedBlobKey(keyA, prefix, 'codebase-a'), true)
  assert.equal(isManagedBlobKey(keyA, prefix, 'codebase-b'), false)
})

test('deletion refuses a foreign tenant blob key but permits the owning tenant', () => {
  const prefix = 'hopit-prod'
  const keyA = blobKeyForHash(prefix, 'codebase-a', HASH_A)

  // A codebase-b operation must never be able to delete codebase-a's blob.
  assert.throws(() => assertManagedBlobKey(keyA, prefix, 'codebase-b'), /Refusing to delete unmanaged blob key/)
  assert.doesNotThrow(() => assertManagedBlobKey(keyA, prefix, 'codebase-a'))
})

test('reachable blob keys are derived only from the tenant own cloud graph', () => {
  const prefix = 'hopit-prod'
  const keyA = blobKeyForHash(prefix, 'codebase-a', HASH_A)
  const keyB = blobKeyForHash(prefix, 'codebase-b', HASH_A)

  const cloudA = {
    files: {
      'SECRET.md': { kind: entryKind.file, contentStorage: contentStorageMode.objectBlob, blobKey: keyA },
      'inline.txt': { kind: entryKind.file, contentStorage: 'inline', content: 'inline body' },
    },
  }

  const reachable = reachableBlobKeysForCloud(cloudA)
  assert.deepEqual([...reachable], [keyA])
  // The reachable-set (used to drive blob GC) cannot see another tenant's keys,
  // so a GC pass scoped to A can never touch B's objects.
  assert.equal(reachable.has(keyB), false)
})

test('a hostile codebase id cannot traverse into another tenant blob namespace', () => {
  const prefix = 'hopit-prod'
  // A codebaseId crafted to escape ("../codebase-b") is percent-encoded, so it
  // lands in its own literal namespace and never resolves into codebase-b's.
  const hostileKey = blobKeyForHash(prefix, '../codebase-b', HASH_A)
  assert.equal(hostileKey.includes('/codebases/../codebase-b/'), false)
  assert.match(hostileKey, /\/codebases\/\.\.%2Fcodebase-b\/blobs\//)
  assert.equal(isManagedBlobKey(hostileKey, prefix, 'codebase-b'), false)
  assert.throws(() => assertManagedBlobKey(hostileKey, prefix, 'codebase-b'), /Refusing to delete/)
})

// --- Surface 3: agent-session capability boundary ---------------------------

test('cross-tenant: codebase-a scoped session cannot drive codebase-b admin session/key surfaces', async (t) => {
  const server = await startD1ApiServer(t)
  const backendA = proxyBackend(server.baseUrl, 'codebase-a')
  const backendB = proxyBackend(server.baseUrl, 'codebase-b')
  await backendA.initialize(graphFor('codebase-a', 'user_a', { 'README.md': fileEntry('alpha') }))
  await backendB.initialize(graphFor('codebase-b', 'user_b', { 'README.md': fileEntry('beta') }))

  // user_a holds an admin session in codebase-a. user_b holds a session in
  // codebase-b that is the intended victim of a revoke/enumeration attack.
  const adminA = await backendA.registerAgentSession({
    codebaseId: 'codebase-a',
    sessionId: 'session_a_admin',
    deviceName: 'user-a admin',
    capabilities: ['read', 'write', 'admin'],
  })
  const victimB = await backendB.registerAgentSession({
    codebaseId: 'codebase-b',
    sessionId: 'session_b_victim',
    deviceName: 'user-b device',
    capabilities: ['read', 'write'],
  })

  const scopedA = createD1Backend({
    'codebase-id': 'codebase-a',
    'd1-api-base-url': server.baseUrl,
    'session-token': adminA.sessionToken,
  })

  // Same-tenant control: the admin session can enumerate its own codebase.
  const ownSessions = await scopedA.listAgentSessions({ codebaseId: 'codebase-a' })
  assert.ok(ownSessions.some((session) => session.sessionId === 'session_a_admin'))

  // Attack: enumerate codebase-b's sessions with codebase-a's admin token.
  await assert.rejects(
    () => scopedA.listAgentSessions({ codebaseId: 'codebase-b' }),
    rejectionMatcher,
    'must not list codebase-b sessions',
  )

  // Attack: revoke codebase-b's session with codebase-a's admin token.
  await assert.rejects(
    () => scopedA.revokeAgentSession({ codebaseId: 'codebase-b', sessionId: 'session_b_victim' }),
    rejectionMatcher,
    'must not revoke codebase-b session',
  )

  // Attack: revoke codebase-b's session while lying that it lives in codebase-a.
  await assert.rejects(
    () => scopedA.revokeAgentSession({ codebaseId: 'codebase-a', sessionId: 'session_b_victim' }),
    rejectionMatcher,
    'must not revoke a foreign session smuggled under its own codebase',
  )

  // Attack: pass codebase-a's session off as access to codebase-b at every level.
  for (const capability of ['read', 'write', 'admin']) {
    await assert.rejects(
      () => scopedA.requireD1AgentAccess('codebase-b', { sessionToken: adminA.sessionToken }, capability),
      rejectionMatcher,
      `must not gain ${capability} access to codebase-b`,
    )
  }

  // Attack: read codebase-b's wrapped keys / key-grant status.
  await assert.rejects(
    () => scopedA.listWrappedKeys({ codebaseId: 'codebase-b' }),
    rejectionMatcher,
    'must not read codebase-b wrapped keys',
  )
  await assert.rejects(
    () => scopedA.readKeyGrantStatus({ codebaseId: 'codebase-b', actor: { userId: 'user_a' } }),
    rejectionMatcher,
    'must not read codebase-b key grant status',
  )

  // Proof of no side effect: the victim session in codebase-b is still active.
  const victimAfter = await backendB.first(
    `select status from agent_sessions where codebase_id = ? and session_id = ? limit 1`,
    ['codebase-b', 'session_b_victim'],
  )
  assert.equal(victimAfter.status, 'active')
  assert.match(victimB.sessionToken, /^hst_/)

  // Same-tenant control: the admin session CAN revoke a peer session in its own
  // codebase, proving the rejections above are the tenant boundary, not a broken
  // admin path.
  await backendA.registerAgentSession({
    codebaseId: 'codebase-a',
    sessionId: 'session_a_peer',
    deviceName: 'user-a peer',
    capabilities: ['read'],
  })
  const revoked = await scopedA.revokeAgentSession({ codebaseId: 'codebase-a', sessionId: 'session_a_peer' })
  assert.equal(revoked.status, 'revoked')
})

// --- harness -----------------------------------------------------------------

const rejectionMatcher = /constrained to its codebase|not scoped|Authentication error|was not found|does not have|not active/

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

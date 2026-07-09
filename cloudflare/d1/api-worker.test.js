import assert from 'node:assert/strict'
import test from 'node:test'

import worker, { CodebasePushHub } from './api-worker.js'

test('proxy token auth executes statements and logs structured request metadata', async () => {
  const logs = await captureLogs(async () => {
    const db = createMockDb()
    const response = await worker.fetch(new Request('https://worker.example/query', {
      method: 'POST',
      headers: {
        authorization: 'Bearer proxy-secret',
        'content-type': 'application/json',
        'x-hopit-codebase-id': 'codebase-1',
        'cf-connecting-ip': '203.0.113.10',
      },
      body: JSON.stringify([
        { sql: 'select * from files where codebase_id = ?', params: ['codebase-1'] },
        { sql: 'select * from codebases where id = ?', params: ['codebase-1'] },
      ]),
    }), {
      HOPIT_D1_PROXY_TOKEN: 'proxy-secret',
      HOPIT_D1_DB: db,
    })

    assert.equal(response.status, 200)
    assert.equal(db.executedStatements.length, 2)
  })

  assert.equal(logs.length, 1)
  const log = JSON.parse(logs[0])
  assert.equal(log.authMode, 'proxy')
  assert.equal(log.codebaseId, 'codebase-1')
  assert.equal(log.statementCount, 2)
  assert.equal(log.status, 200)
  assert.equal(logs[0].includes('select *'), false)
  assert.equal(logs[0].includes('proxy-secret'), false)
})

test('scoped session auth validates the session and logs session mode', async () => {
  const db = createMockDb({
    session: {
      session_id: 'session-1',
      user_id: 'user-1',
      codebase_id: 'codebase-1',
      status: 'active',
      expires_at: null,
      capabilities_json: JSON.stringify(['read']),
    },
  })

  const logs = await captureLogs(async () => {
    const response = await worker.fetch(new Request('https://worker.example/query', {
      method: 'POST',
      headers: {
        authorization: 'Bearer hst_session_token',
        'content-type': 'application/json',
        'x-hopit-codebase-id': 'codebase-1',
        'cf-connecting-ip': '203.0.113.11',
      },
      body: JSON.stringify({ sql: 'select * from files where codebase_id = ?', params: ['codebase-1'] }),
    }), {
      HOPIT_D1_DB: db,
    })

    assert.equal(response.status, 200)
  })

  assert.equal(db.sessionLookups, 1)
  const log = JSON.parse(logs.at(-1))
  assert.equal(log.authMode, 'session')
  assert.equal(log.codebaseId, 'codebase-1')
  assert.equal(log.statementCount, 1)
})

test('failed auth attempts are rate limited per client ip', async () => {
  const logs = []
  const originalLog = console.log
  console.log = (message) => logs.push(String(message))
  try {
    let response
    for (let attempt = 0; attempt < 21; attempt += 1) {
      response = await worker.fetch(new Request('https://worker.example/query', {
        method: 'POST',
        headers: {
          authorization: 'Bearer wrong-token',
          'content-type': 'application/json',
          'x-hopit-codebase-id': 'codebase-1',
          'cf-connecting-ip': '203.0.113.12',
        },
        body: JSON.stringify({ sql: 'select * from files where codebase_id = ?', params: ['codebase-1'] }),
      }), {
        HOPIT_D1_PROXY_TOKEN: 'proxy-secret',
        HOPIT_D1_DB: createMockDb(),
      })
    }

    assert.equal(response.status, 429)
    const lastLog = JSON.parse(logs.at(-1))
    assert.equal(lastLog.status, 429)
    assert.equal(lastLog.rejectedReason, 'failed-auth-rate-limit')
    assert.equal(logs.some((line) => line.includes('wrong-token')), false)
  } finally {
    console.log = originalLog
  }
})

test('non-query requests are logged as rejected requests', async () => {
  const logs = await captureLogs(async () => {
    const response = await worker.fetch(new Request('https://worker.example/other', {
      headers: { 'cf-connecting-ip': '203.0.113.13' },
    }), { HOPIT_D1_DB: createMockDb() })

    assert.equal(response.status, 404)
  })

  const log = JSON.parse(logs[0])
  assert.equal(log.status, 404)
  assert.equal(log.rejectedReason, 'not-found')
  assert.equal(log.statementCount, 0)
})

test('authenticated WebSocket upgrade is routed to the codebase Durable Object', async () => {
  const namespace = createMockPushNamespace()
  const response = await worker.fetch(new Request('https://worker.example/events?codebaseId=codebase-1&selectedStateId=cs_1', {
    headers: {
      upgrade: 'websocket',
      authorization: 'Bearer proxy-secret',
      'cf-connecting-ip': '203.0.113.14',
    },
  }), {
    HOPIT_D1_PROXY_TOKEN: 'proxy-secret',
    HOPIT_D1_DB: createMockDb(),
    HOPIT_PUSH_HUB: namespace,
  })

  assert.equal(response.status, 200)
  assert.deepEqual(namespace.idNames, ['codebase-1'])
  assert.equal(namespace.fetches.length, 1)
  assert.equal(new URL(namespace.fetches[0].request.url).searchParams.get('codebaseId'), 'codebase-1')
})

test('unauthenticated WebSocket upgrade is rejected before Durable Object routing', async () => {
  const namespace = createMockPushNamespace()
  const response = await worker.fetch(new Request('https://worker.example/events?codebaseId=codebase-1', {
    headers: {
      upgrade: 'websocket',
      'cf-connecting-ip': '203.0.113.15',
    },
  }), {
    HOPIT_D1_PROXY_TOKEN: 'proxy-secret',
    HOPIT_D1_DB: createMockDb(),
    HOPIT_PUSH_HUB: namespace,
  })

  assert.equal(response.status, 403)
  assert.equal(namespace.fetches.length, 0)
})

test('Durable Object hub fans out envelopes and persists the cursor for stale reconnects', async () => {
  const state = createMockDurableObjectState()
  const hub = new CodebasePushHub(state, {})
  const socketA = createMockSocket()
  const socketB = createMockSocket()

  await hub.connectWebSocket(new Request('https://push.example/events?codebaseId=codebase-1&lastRevision=1'), socketA)
  await hub.connectWebSocket(new Request('https://push.example/events?codebaseId=codebase-1&lastRevision=1'), socketB)
  const response = await hub.notify({
    type: 'codebase.remote_update',
    codebaseId: 'codebase-1',
    selectedStateId: 'cs_1',
    revision: 2,
    eventId: 'evt_2',
    changedPaths: ['README.md'],
    scopeCounts: { shared: 1, private: 0 },
  })

  assert.equal(response.status, 200)
  assert.equal(socketA.sent.length, 1)
  assert.equal(socketB.sent.length, 1)
  const cursor = await state.storage.get('last-cursor')
  assert.equal(cursor.eventId, 'evt_2')
  assert.equal(cursor.revision, 2)
  assert.match(cursor.updatedAt, /\d{4}-/)

  const staleSocket = createMockSocket()
  await hub.connectWebSocket(new Request('https://push.example/events?codebaseId=codebase-1&lastRevision=1'), staleSocket)
  assert.equal(staleSocket.sent.length, 1)
  assert.equal(JSON.parse(staleSocket.sent[0]).eventId, 'evt_2')

  const freshSocket = createMockSocket()
  await hub.connectWebSocket(new Request('https://push.example/events?codebaseId=codebase-1&lastEventId=evt_2&lastRevision=2'), freshSocket)
  assert.equal(freshSocket.sent.length, 0)
})

test('successful graph mutation emits a compact push envelope after commit', async () => {
  const namespace = createMockPushNamespace()
  const db = createMockDb({
    codebase: {
      codebase_id: 'codebase-1',
      revision: 2,
      selected_state_json: JSON.stringify({ id: 'cs_1' }),
    },
    files: [
      { path: 'README.md', scope: 'shared', revision: 2 },
      { path: '.private/notes.md', scope: 'owner-private', revision: 2 },
    ],
  })

  const response = await worker.fetch(new Request('https://worker.example/query', {
    method: 'POST',
    headers: {
      authorization: 'Bearer proxy-secret',
      'content-type': 'application/json',
      'x-hopit-codebase-id': 'codebase-1',
      'cf-connecting-ip': '203.0.113.16',
    },
    body: JSON.stringify({ sql: 'update codebases set revision = ? where codebase_id = ?', params: [2, 'codebase-1'] }),
  }), {
    HOPIT_D1_PROXY_TOKEN: 'proxy-secret',
    HOPIT_D1_DB: db,
    HOPIT_PUSH_HUB: namespace,
  })

  assert.equal(response.status, 200)
  assert.equal(namespace.notifications.length, 1)
  const envelope = namespace.notifications[0]
  assert.equal(envelope.type, 'codebase.remote_update')
  assert.equal(envelope.codebaseId, 'codebase-1')
  assert.equal(envelope.selectedStateId, 'cs_1')
  assert.equal(envelope.revision, 2)
  assert.deepEqual(envelope.changedPaths, ['README.md'])
  assert.deepEqual(envelope.scopeCounts, { shared: 1, private: 1 })
  assert.equal(Object.hasOwn(envelope, 'files'), false)
  assert.equal(Object.hasOwn(envelope, 'bytes'), false)
})

test('scoped session accepts guarded per-file commit statements and emits one push envelope', async () => {
  const namespace = createMockPushNamespace()
  const db = createMockDb({
    session: {
      session_id: 'session-1',
      user_id: 'user-1',
      codebase_id: 'codebase-1',
      status: 'active',
      expires_at: null,
      capabilities_json: JSON.stringify(['read', 'write']),
    },
    codebase: {
      codebase_id: 'codebase-1',
      revision: 2,
      selected_state_json: JSON.stringify({ id: 'cs_1' }),
    },
    files: [{ path: 'README.md', scope: 'shared', revision: 2 }],
  })

  const response = await worker.fetch(new Request('https://worker.example/query', {
    method: 'POST',
    headers: {
      authorization: 'Bearer hst_session_token',
      'content-type': 'application/json',
      'x-hopit-codebase-id': 'codebase-1',
      'cf-connecting-ip': '203.0.113.18',
    },
    body: JSON.stringify([
      {
        sql: 'update codebases set revision = ?, selected_state_json = ?, main_json = ?, file_count = ?, private_file_count = ?, updated_at = ? where codebase_id = ? and revision = ?',
        params: [2, '{"id":"cs_1"}', '{"id":"main","revision":2}', 1, 0, '2026-07-08T00:00:00.000Z', 'codebase-1', 1],
      },
      {
        sql: 'insert into files (codebase_id, path, kind, content, encoding, target, blob_hash, blob_provider, blob_key, blob_size, client_encryption_json, encryption_json, privacy_zone, zone_id, content_storage, hash, size, scope, revision, updated_at) select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? where exists (select 1 from codebases where codebase_id = ? and revision = ? and updated_at = ?) on conflict(codebase_id, path) do update set content = excluded.content',
        params: ['codebase-1', 'README.md', 'file', 'changed', 'utf8', null, null, null, null, null, null, null, 'repo-content', 'codebase-1:repo-content', 'inline', 'hash', 7, 'shared', 2, '2026-07-08T00:00:00.000Z', 'codebase-1', 2, '2026-07-08T00:00:00.000Z'],
      },
      {
        sql: 'insert into file_versions (codebase_id, selected_state_type, selected_state_id, main_state_id, graph_revision, path, operation, kind, old_revision, new_revision, old_file_json, new_file_json, scope, privacy_zone, zone_id, content_storage, blob_provider, blob_key, blob_hash, encoding, target, size, actor_user_id, session_id, device_name, created_at) select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? where exists (select 1 from codebases where codebase_id = ? and revision = ? and updated_at = ?)',
        params: ['codebase-1', 'active-change-set', 'cs_1', 'main', 2, 'README.md', 'modify', 'file', 1, 2, '{}', '{}', 'shared', 'repo-content', 'codebase-1:repo-content', 'inline', null, null, null, 'utf8', null, 7, 'user-1', 'session-1', 'test', '2026-07-08T00:00:00.000Z', 'codebase-1', 2, '2026-07-08T00:00:00.000Z'],
      },
    ]),
  }), {
    HOPIT_D1_DB: db,
    HOPIT_PUSH_HUB: namespace,
  })

  assert.equal(response.status, 200)
  assert.equal(db.sessionLookups, 1)
  assert.equal(db.executedStatements.length, 3)
  assert.equal(namespace.notifications.length, 1)
  assert.equal(namespace.notifications[0].codebaseId, 'codebase-1')
  assert.deepEqual(namespace.notifications[0].changedPaths, ['README.md'])
})

test('push notify failure is logged without failing the committed mutation', async () => {
  const namespace = createMockPushNamespace({ notifyStatus: 503 })
  const db = createMockDb({
    codebase: {
      codebase_id: 'codebase-1',
      revision: 3,
      selected_state_json: JSON.stringify({ id: 'cs_1' }),
    },
    files: [{ path: 'README.md', scope: 'shared', revision: 3 }],
  })

  const logs = await captureLogs(async () => {
    const response = await worker.fetch(new Request('https://worker.example/query', {
      method: 'POST',
      headers: {
        authorization: 'Bearer proxy-secret',
        'content-type': 'application/json',
        'x-hopit-codebase-id': 'codebase-1',
        'cf-connecting-ip': '203.0.113.17',
      },
      body: JSON.stringify({ sql: 'update files set revision = ? where codebase_id = ?', params: [3, 'codebase-1'] }),
    }), {
      HOPIT_D1_PROXY_TOKEN: 'proxy-secret',
      HOPIT_D1_DB: db,
      HOPIT_PUSH_HUB: namespace,
    })

    assert.equal(response.status, 200)
  })

  assert.ok(logs.some((line) => JSON.parse(line).event === 'hopit.d1.proxy.push_notify_failed'))
})

async function captureLogs(callback) {
  const logs = []
  const originalLog = console.log
  console.log = (message) => logs.push(String(message))
  try {
    await callback()
  } finally {
    console.log = originalLog
  }
  return logs
}

function createMockDb({ session = null, codebase = null, files = [] } = {}) {
  const db = {
    executedStatements: [],
    sessionLookups: 0,
    prepare(sql) {
      const normalized = sql.toLowerCase()
      return {
        bind(...params) {
          return {
            async all() {
              if (normalized.includes('from agent_sessions')) {
                db.sessionLookups += 1
                return { results: session ? [session] : [] }
              }
              if (normalized.includes('select codebase_id, revision, selected_state_json from codebases')) {
                return { results: codebase ? [codebase] : [] }
              }
              if (normalized.includes('select path, scope from files')) {
                const revision = params[1]
                return {
                  results: files
                    .filter((file) => !Number.isInteger(revision) || file.revision === revision)
                    .sort((left, right) => left.path.localeCompare(right.path)),
                }
              }
              db.executedStatements.push({ sql, params })
              return {
                results: [],
                meta: { duration: 1 },
              }
            },
          }
        },
      }
    },
  }
  return db
}

function createMockPushNamespace({ notifyStatus = 200 } = {}) {
  const namespace = {
    idNames: [],
    fetches: [],
    notifications: [],
    idFromName(name) {
      namespace.idNames.push(name)
      return `id:${name}`
    },
    get(id) {
      return {
        async fetch(request, init) {
          const normalizedRequest = request instanceof Request ? request : new Request(request, init)
          namespace.fetches.push({ id, request: normalizedRequest })
          if (normalizedRequest.method === 'POST') {
            namespace.notifications.push(await normalizedRequest.json())
            return new Response(JSON.stringify({ success: notifyStatus < 400 }), { status: notifyStatus })
          }
          return new Response('upgrade-ok')
        },
      }
    },
  }
  return namespace
}

function createMockDurableObjectState() {
  const values = new Map()
  const sockets = new Set()
  return {
    storage: {
      async get(key) {
        return values.get(key)
      },
      async put(key, value) {
        values.set(key, value)
      },
    },
    acceptWebSocket(socket, tags = []) {
      socket.tags = tags
      sockets.add(socket)
    },
    getWebSockets() {
      return [...sockets]
    },
  }
}

function createMockSocket() {
  return {
    sent: [],
    tags: [],
    attachment: null,
    send(message) {
      this.sent.push(message)
    },
    close() {
      this.closed = true
    },
    serializeAttachment(value) {
      this.attachment = value
    },
    deserializeAttachment() {
      return this.attachment
    },
  }
}

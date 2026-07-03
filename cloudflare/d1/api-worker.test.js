import assert from 'node:assert/strict'
import test from 'node:test'

import worker from './api-worker.js'

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

function createMockDb({ session = null } = {}) {
  const db = {
    executedStatements: [],
    sessionLookups: 0,
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async all() {
              if (sql.includes('from agent_sessions')) {
                db.sessionLookups += 1
                return { results: session ? [session] : [] }
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

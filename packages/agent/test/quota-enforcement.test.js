// End-to-end proof of the Phase 3 Stage 2-3 quota model (metering + enforcement)
// driven through the real @hopit/backend-d1 client against a real SQLite-backed
// D1 Worker with HOPIT_MULTITENANT on.
//
// Covers the three surfaces that need real SQL (not a mock) to be convincing:
//   1. the Plane-A codebase-count gate at create time (free = 1; paid lifts it),
//   2. the folded meter upsert accumulating per-tenant-per-UTC-day in real SQLite
//      (rows reset on a day roll; storage bytes stay cumulative),
//   3. the readTenantUsage status surface computed off the real meter row.

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import d1ApiWorker from '../../../cloudflare/d1/api-worker.js'
import { buildMeterUpsertStatement } from '../../../cloudflare/d1/quota.js'
import { createD1Backend } from '@hopit/backend-d1'

const PROXY_TOKEN = 'token_test'

// A proxy-token backend that ALSO flips the multi-tenant flag: the D1 writes go
// through the (un-scoped) admin proxy so the harness stays simple, while
// config.multiTenant lights up the Plane-A createCodebase quota gate. This mirrors
// the admin/provisioning path with tenancy on.
function tenantBackend(baseUrl) {
  return createD1Backend({
    'd1-api-base-url': baseUrl,
    'd1-account-id': 'account_test',
    'd1-database-id': 'database_test',
    'd1-api-token': PROXY_TOKEN,
    'multi-tenant': true,
  })
}

test('quota: codebase-count gate rejects the 2nd free codebase and the paid plan lifts it', async (t) => {
  const server = await startD1ApiServer(t)
  const backend = tenantBackend(server.baseUrl)
  const actor = { userId: 'user_a', primaryEmail: 'a@example.com', displayName: 'A' }

  // First codebase on the free plan succeeds.
  const first = await backend.createCodebase({ name: 'alpha', actor })
  assert.ok(first)

  // The second free codebase is rejected with an honest, typed "upgrade" error.
  await assert.rejects(
    () => backend.createCodebase({ name: 'beta', actor }),
    (error) => {
      assert.match(error.message, /Codebase limit reached for the free plan/)
      assert.match(error.message, /Upgrade to add more/)
      assert.equal(error.code, 'quota_exceeded_codebases')
      return true
    },
  )

  // Upgrading the tenant to paid (as billing would) lifts the cap.
  await backend.query(
    `insert into tenant_usage (tenant_id, plan, storage_bytes, write_day, rows_written_today, created_at, updated_at)
     values (?, 'paid', 0, null, 0, ?, ?)
     on conflict(tenant_id) do update set plan = 'paid'`,
    ['user_a', new Date().toISOString(), new Date().toISOString()],
  )
  const second = await backend.createCodebase({ name: 'beta', actor })
  assert.ok(second)

  // A different tenant is unaffected by user_a's usage: its own first codebase
  // is still free.
  const otherActor = { userId: 'user_b', primaryEmail: 'b@example.com' }
  assert.ok(await backend.createCodebase({ name: 'gamma', actor: otherActor }))
})

test('quota: the folded meter upsert accumulates per day in real SQLite and resets on a day roll', async (t) => {
  const server = await startD1ApiServer(t)
  const backend = tenantBackend(server.baseUrl)
  // ensureSchema (creates tenant_usage) runs on the first create.
  await backend.createCodebase({ name: 'alpha', actor: { userId: 'user_a' } })

  const day1 = '2026-07-11'
  const day2 = '2026-07-12'
  const runMeter = (args) => {
    const statement = buildMeterUpsertStatement(args)
    return backend.query(statement.sql, statement.params)
  }

  await runMeter({ tenantId: 'tenant_x', day: day1, rowsDelta: 7, storageDelta: 100, now: 'n1' })
  await runMeter({ tenantId: 'tenant_x', day: day1, rowsDelta: 5, storageDelta: 50, now: 'n2' })

  let row = await backend.first('select * from tenant_usage where tenant_id = ?', ['tenant_x'])
  assert.equal(Number(row.rows_written_today), 12) // 7 + 5 in the same day
  assert.equal(Number(row.storage_bytes), 150) // cumulative
  assert.equal(row.write_day, day1)
  assert.equal(row.plan, 'free') // default on first insert, never overwritten by the meter

  // A new UTC day resets the daily counter but NOT the cumulative storage tally.
  await runMeter({ tenantId: 'tenant_x', day: day2, rowsDelta: 4, storageDelta: 25, now: 'n3' })
  row = await backend.first('select * from tenant_usage where tenant_id = ?', ['tenant_x'])
  assert.equal(Number(row.rows_written_today), 4) // reset, not 16
  assert.equal(Number(row.storage_bytes), 175) // still cumulative
  assert.equal(row.write_day, day2)
})

test('quota: readTenantUsage computes plan, limits, and warn/block state off the real meter', async (t) => {
  const server = await startD1ApiServer(t)
  const backend = tenantBackend(server.baseUrl)
  await backend.createCodebase({ name: 'alpha', actor: { userId: 'user_a' } })

  // No meter row yet => honest free-tier zero usage.
  const fresh = await backend.readTenantUsage({ tenantId: 'user_a' })
  assert.equal(fresh.plan, 'free')
  assert.equal(fresh.storage.used, 0)
  assert.equal(fresh.storage.limit, 2_000_000_000)
  assert.equal(fresh.codebases.used, 1)

  // Push storage to 80% of the free cap => warn state surfaces.
  await backend.query(
    `insert into tenant_usage (tenant_id, plan, storage_bytes, write_day, rows_written_today, created_at, updated_at)
     values (?, 'free', ?, ?, 0, ?, ?)`,
    ['user_a', 1_600_000_000, new Date().toISOString().slice(0, 10), 'now', 'now'],
  )
  const warned = await backend.readTenantUsage({ tenantId: 'user_a' })
  assert.equal(warned.storage.state, 'warn')
})

// --- harness (mirrors server-actor-dashboard.test.js) ------------------------

async function startD1ApiServer(t) {
  const db = new DatabaseSync(':memory:')
  const env = {
    HOPIT_D1_DB: d1Binding(db),
    HOPIT_D1_PROXY_TOKEN: PROXY_TOKEN,
    HOPIT_D1_PROXY_LOG_REQUESTS: '0',
    HOPIT_MULTITENANT: '1',
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

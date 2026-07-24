// GR-B5: CI on propose (actions-runner hardening). `packages/actions-runner`
// shipped as a working seed with zero tests -- this suite covers the
// runner's own mechanics (`createActionsRunner` in
// `packages/actions-runner/src/runner.js`): a full claim -> hydrate -> run
// -> complete success cycle against a real (loopback) D1 backend, a
// command-failure path, a timeout path, output capping, the env-lockdown
// invariant (a job step must never see cloud credentials), and
// retry/backoff on claim errors.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { createD1Backend } from '@hopit/backend-d1'
import { initCloud } from '../src/commands/import.js'
import {
  actionJobEnv,
  createActionsRunner,
  safeBaseEnv,
  trustedAgentEnv,
} from '../../actions-runner/src/runner.js'

async function makeTempRoot(t, label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `hopit-${label}-`))
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
  return root
}

async function startD1ApiServer(t) {
  const { default: d1ApiWorker } = await import('../../../cloudflare/d1/api-worker.js')
  const db = new DatabaseSync(':memory:')
  const env = {
    HOPIT_D1_DB: d1Binding(db),
    HOPIT_D1_PROXY_TOKEN: 'token_test',
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
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

function d1BackendOptions(server) {
  return {
    'codebase-id': 'hopit-core',
    'd1-api-base-url': server.baseUrl,
    'd1-account-id': 'account_test',
    'd1-database-id': 'database_test',
    'd1-api-token': 'token_test',
  }
}

// `initCloud` emits `cloud.initialized` (and journals), which needs
// somewhere to write; the runner tests below don't otherwise care about the
// journal/events files.
function eventLogOptions(root) {
  return { journal: path.join(root, 'journal.ndjson'), events: path.join(root, 'events.ndjson') }
}

function d1CredentialEnv(server) {
  return {
    ...process.env,
    HOPIT_D1_API_BASE_URL: server.baseUrl,
    HOPIT_D1_ACCOUNT_ID: 'account_test',
    HOPIT_D1_DATABASE_ID: 'database_test',
    HOPIT_D1_API_TOKEN: 'token_test',
    // Deliberately present so the env-lockdown tests below have something
    // real to assert is (or isn't) forwarded.
    CLOUDFLARE_ACCOUNT_ID: 'cf_account_test',
  }
}

// Bypasses the normal `enqueueCiJobForProposal`/`createActionJob` command
// whitelist so tests can pin the exact command a claimed job runs (a tiny
// inline Node script), instead of depending on what `npm test` happens to
// do in a hydrated fixture workspace.
function insertActionJob(server, { jobId, codebaseId = 'hopit-core', kind = 'ci', command, args = [] }) {
  const now = new Date().toISOString()
  server.db.prepare(
    `insert into action_jobs (
      job_id, codebase_id, kind, command, args_json, status, requested_by_user_id, created_at, updated_at
    ) values (?, ?, ?, ?, ?, 'queued', 'system', ?, ?)`,
  ).run(jobId, codebaseId, kind, command, JSON.stringify(args), now, now)
}

function fakeLogger() {
  return { log() {}, warn() {}, error() {} }
}

test('success: claim -> hydrate -> run -> complete lands a succeeded job end to end', async (t) => {
  const server = await startD1ApiServer(t)
  const root = await makeTempRoot(t, 'actions-runner-success')
  await initCloud({ ...d1BackendOptions(server), ...eventLogOptions(root), 'cloud-backend': 'd1', force: true })

  insertActionJob(server, {
    jobId: 'job_success_1',
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
  })

  const backend = createD1Backend(d1BackendOptions(server))
  const runner = createActionsRunner({
    backend,
    runnerId: 'runner-test',
    cloudBackendName: 'd1',
    workspaceRoot: path.join(root, 'workspaces'),
    stateRoot: path.join(root, 'state'),
    env: d1CredentialEnv(server),
    logger: fakeLogger(),
  })

  const ran = await runner.runOnce()
  assert.equal(ran, true)

  const row = server.db.prepare(`select * from action_jobs where job_id = ?`).get('job_success_1')
  assert.equal(row.status, 'succeeded')
  assert.equal(row.exit_code, 0)
  assert.equal(row.runner_id, 'runner-test')

  // Hydrate really ran against the D1 fixture -- the workspace exists with
  // the fixture's files, proving this was the full pipeline, not a stub.
  const readme = await fs.readFile(path.join(root, 'workspaces', 'hopit-core', 'README.md'), 'utf8')
  assert.match(readme, /\S/)
})

test('a job step that exits non-zero completes as failed with its stderr captured', async (t) => {
  const server = await startD1ApiServer(t)
  const root = await makeTempRoot(t, 'actions-runner-failure')
  await initCloud({ ...d1BackendOptions(server), ...eventLogOptions(root), 'cloud-backend': 'd1', force: true })

  insertActionJob(server, {
    jobId: 'job_failure_1',
    command: process.execPath,
    args: ['-e', 'console.error("boom"); process.exit(7)'],
  })

  const backend = createD1Backend(d1BackendOptions(server))
  const runner = createActionsRunner({
    backend,
    runnerId: 'runner-test',
    cloudBackendName: 'd1',
    workspaceRoot: path.join(root, 'workspaces'),
    stateRoot: path.join(root, 'state'),
    env: d1CredentialEnv(server),
    logger: fakeLogger(),
  })

  await runner.runOnce()

  const row = server.db.prepare(`select * from action_jobs where job_id = ?`).get('job_failure_1')
  assert.equal(row.status, 'failed')
  assert.equal(row.exit_code, 7)
  assert.match(row.stderr, /boom/)
})

test('a job step that never exits is killed and reported failed once its timeout elapses', async () => {
  const runner = createActionsRunner({
    backend: { claimNextActionJob: async () => null, completeActionJob: async () => {} },
    logger: fakeLogger(),
  })

  await assert.rejects(
    () => runner.runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: process.cwd(),
      timeoutMs: 50,
      env: safeBaseEnv(),
      outputCapBytes: 1000,
    }),
    /timed out/,
  )
})

test('stdout/stderr are capped to the configured byte budget, keeping the tail', async () => {
  const runner = createActionsRunner({
    backend: { claimNextActionJob: async () => null, completeActionJob: async () => {} },
    logger: fakeLogger(),
  })

  const capBytes = 50
  const result = await runner.runProcess(
    process.execPath,
    ['-e', 'process.stdout.write("a".repeat(500) + "TAIL_MARKER")'],
    { cwd: process.cwd(), timeoutMs: 10_000, env: safeBaseEnv(), outputCapBytes: capBytes },
  )

  assert.equal(result.exitCode, 0)
  assert.ok(result.stdout.length <= capBytes)
  assert.match(result.stdout, /TAIL_MARKER$/, 'the cap keeps the most recent output, not the oldest')
})

test('env lockdown: actionJobEnv never carries cloud credentials, trustedAgentEnv does', () => {
  const env = {
    PATH: '/usr/bin',
    HOME: '/home/test',
    HOPIT_D1_API_TOKEN: 'super-secret-token',
    HOPIT_D1_ACCOUNT_ID: 'account_test',
    CLOUDFLARE_API_TOKEN: 'cf-secret',
    HOPIT_R2_ACCESS_KEY: 'r2-secret',
    HOPIT_CLIENT_ENCRYPTION_KEY: 'enc-secret',
    UNRELATED_SECRET: 'should-never-appear-anywhere',
  }

  const jobEnv = actionJobEnv({ stateRoot: '/tmp/hopit-actions-state-test', env })
  for (const key of Object.keys(jobEnv)) {
    assert.equal(key.startsWith('HOPIT_D1_'), false, `job step env leaked ${key}`)
  }
  assert.equal('HOPIT_D1_API_TOKEN' in jobEnv, false)
  assert.equal('CLOUDFLARE_API_TOKEN' in jobEnv, false)
  assert.equal('HOPIT_R2_ACCESS_KEY' in jobEnv, false)
  assert.equal('HOPIT_CLIENT_ENCRYPTION_KEY' in jobEnv, false)
  assert.equal('UNRELATED_SECRET' in jobEnv, false)

  const trusted = trustedAgentEnv(env)
  assert.equal(trusted.HOPIT_D1_API_TOKEN, 'super-secret-token')
  assert.equal(trusted.CLOUDFLARE_API_TOKEN, 'cf-secret')
})

test('env lockdown end to end: a real job step never observes HOPIT_D1_* in its process env', async (t) => {
  const server = await startD1ApiServer(t)
  const root = await makeTempRoot(t, 'actions-runner-env-lockdown')
  await initCloud({ ...d1BackendOptions(server), ...eventLogOptions(root), 'cloud-backend': 'd1', force: true })

  insertActionJob(server, {
    jobId: 'job_env_lockdown_1',
    command: process.execPath,
    args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
  })

  const backend = createD1Backend(d1BackendOptions(server))
  const runner = createActionsRunner({
    backend,
    runnerId: 'runner-test',
    cloudBackendName: 'd1',
    workspaceRoot: path.join(root, 'workspaces'),
    stateRoot: path.join(root, 'state'),
    env: d1CredentialEnv(server),
    logger: fakeLogger(),
  })

  await runner.runOnce()

  const row = server.db.prepare(`select * from action_jobs where job_id = ?`).get('job_env_lockdown_1')
  assert.equal(row.status, 'succeeded')
  const observedEnv = JSON.parse(row.stdout)
  const leaked = Object.keys(observedEnv).filter((key) => key.startsWith('HOPIT_D1_') || key.startsWith('CLOUDFLARE_'))
  assert.deepEqual(leaked, [], `the job step observed cloud credential env vars: ${leaked.join(', ')}`)
})

test('claim retry/backoff: transient claim errors are retried with exponential backoff, then succeed', async () => {
  let attempts = 0
  const delays = []
  const job = { jobId: 'job_after_retries', codebaseId: 'hopit-core', kind: 'ci', command: process.execPath, args: ['-e', 'process.exit(0)'] }
  const backend = {
    claimNextActionJob: async () => {
      attempts += 1
      if (attempts < 3) throw new Error(`transient D1 error #${attempts}`)
      return job
    },
  }

  const runner = createActionsRunner({
    backend,
    claimRetry: { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 1000 },
    sleepFn: async (ms) => { delays.push(ms) },
    logger: fakeLogger(),
  })

  const claimed = await runner.claimNextJobWithRetry()
  assert.equal(attempts, 3, 'retried until the third attempt succeeded')
  assert.deepEqual(claimed, job)
  assert.deepEqual(delays, [10, 20], 'backoff doubles between attempts')
})

test('claim retry/backoff: exhausting every attempt surfaces the last error instead of hanging forever', async () => {
  let attempts = 0
  const backend = {
    claimNextActionJob: async () => {
      attempts += 1
      throw new Error(`persistent failure #${attempts}`)
    },
  }

  const runner = createActionsRunner({
    backend,
    claimRetry: { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 100 },
    sleepFn: async () => {},
    logger: fakeLogger(),
  })

  await assert.rejects(() => runner.claimNextJobWithRetry(), /persistent failure #3/)
  assert.equal(attempts, 3, 'stops exactly at maxAttempts, does not retry indefinitely')
})

test('poll retry: the poll loop survives an exhausted claim-retry cycle and keeps polling', async () => {
  let claimCalls = 0
  let cycles = 0
  const backend = {
    claimNextActionJob: async () => {
      claimCalls += 1
      throw new Error('D1 unreachable')
    },
  }

  const runner = createActionsRunner({
    backend,
    claimRetry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 10 },
    pollIntervalMs: 1,
    // `sleepFn` doubles as both the retry backoff wait and the poll-interval
    // wait here; once it has been called enough times to prove the loop
    // survived a fully-exhausted claim-retry cycle and moved on to a second
    // poll cycle, bail out via a sentinel error rather than looping forever.
    sleepFn: async () => {
      cycles += 1
      if (cycles >= 3) throw new Error('__stop_test_loop__')
    },
    logger: fakeLogger(),
  })

  await assert.rejects(() => runner.runLoop(), /__stop_test_loop__/)
  assert.ok(claimCalls >= 3, `expected multiple poll cycles to attempt claiming, got ${claimCalls}`)
})

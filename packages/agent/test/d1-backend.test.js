import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(repoRoot, 'packages/agent/src/cli.js')

test('agent can initialize, hydrate, sync, and report status through D1', async (t) => {
  const server = await startD1ApiServer(t)
  const state = await makeState()
  const args = [
    ...stateArgs(state),
    '--cloud-backend',
    'd1',
    '--codebase-id',
    'hopit-core',
    '--d1-api-base-url',
    server.baseUrl,
    '--d1-account-id',
    'account_test',
    '--d1-database-id',
    'database_test',
    '--d1-api-token',
    'token_test',
  ]

  await runCli('init', [...args, '--force'])
  await runCli('hydrate', args)

  await fs.appendFile(path.join(state.workspace, 'README.md'), '\nD1-backed edit.\n', 'utf8')
  await runCli('sync-once', args)

  const status = JSON.parse((await runCli('status', args)).stdout)
  assert.equal(status.ok, true)
  assert.equal(status.cloud.service, 'cloudflare-d1-graph')
  assert.equal(status.cloud.path, 'd1:hopit-core')
  assert.equal(status.cloud.fileCount, 4)
  assert.equal(status.cloud.revision, 2)
})

async function startD1ApiServer(t) {
  const db = new DatabaseSync(':memory:')
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || !request.url?.includes('/query')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ success: false, errors: [{ message: 'not found' }] }))
        return
      }
      const body = JSON.parse(await readRequestBody(request))
      const sql = String(body.sql ?? '')
      const params = Array.isArray(body.params) ? body.params : []
      const statement = db.prepare(sql)
      const rows = sql.trim().toLowerCase().startsWith('select')
        ? statement.all(...params)
        : (statement.run(...params), [])
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ success: true, result: [{ success: true, results: rows, meta: {} }] }))
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
  return { baseUrl: `http://127.0.0.1:${port}` }
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

async function makeState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-d1-test-'))
  return {
    root,
    cloud: path.join(root, 'cloud.json'),
    workspace: path.join(root, 'workspace'),
    journal: path.join(root, 'journal.ndjson'),
    events: path.join(root, 'events.ndjson'),
  }
}

function stateArgs(state) {
  return [
    '--cloud',
    state.cloud,
    '--workspace',
    state.workspace,
    '--journal',
    state.journal,
    '--events',
    state.events,
  ]
}

async function runCli(command, args = []) {
  return await execFileAsync(process.execPath, [cliPath, command, ...args], {
    cwd: repoRoot,
    maxBuffer: 10 * 1024 * 1024,
  })
}

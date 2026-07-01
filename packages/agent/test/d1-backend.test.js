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
import { createD1Backend } from '../../../src/lib/d1-backend.js'

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

test('D1 backend supports members, invitations, and collaboration work items', async (t) => {
  const server = await startD1ApiServer(t)
  const previousOwnerEmail = process.env.HOPIT_OWNER_EMAIL
  process.env.HOPIT_OWNER_EMAIL = 'owner@example.com'
  t.after(() => {
    if (previousOwnerEmail === undefined) delete process.env.HOPIT_OWNER_EMAIL
    else process.env.HOPIT_OWNER_EMAIL = previousOwnerEmail
  })

  const backend = createD1Backend({
    'codebase-id': 'collab-core',
    'd1-api-base-url': server.baseUrl,
    'd1-account-id': 'account_test',
    'd1-database-id': 'database_test',
    'd1-api-token': 'token_test',
  })
  await backend.initialize({
    schemaVersion: 2,
    codebase: {
      id: 'collab-core',
      name: 'Collab Core',
      ownerId: 'local-owner',
    },
    main: {
      id: 'main',
      revision: 1,
      updatedAt: new Date().toISOString(),
      mergedChangeSetId: null,
    },
    selectedState: {
      type: 'active-change-set',
      id: 'cs_collab_core_main',
      ownerId: 'local-owner',
      baseMainId: 'main',
      baseRevision: 1,
      revision: 1,
      visibility: 'team-visible',
      effectiveVisibility: 'team-visible',
      reviewState: 'not-open',
      mergeState: 'unmerged',
      conflictState: 'none',
      conflict: null,
      review: null,
      merge: null,
    },
    owner: {
      id: 'local-owner',
      name: 'Local Owner',
    },
    collaborators: [],
    session: {
      id: 'session_test',
      deviceName: 'test',
    },
    visibility: {
      productDefault: 'private',
      globalUserDefault: null,
      codebaseOverride: null,
      changeSetOverride: 'team-visible',
      effective: 'team-visible',
    },
    revision: 1,
    files: {
      'README.md': {
        kind: 'file',
        content: 'hello',
        encoding: 'utf8',
        revision: 1,
        updatedAt: new Date().toISOString(),
      },
    },
  })

  const owner = {
    userId: 'user_owner',
    primaryEmail: 'owner@example.com',
    displayName: 'Owner',
    currentAuthEmailVerified: true,
  }
  await backend.claimCodebaseOwner({ codebaseId: 'collab-core', actor: owner })

  await backend.createWorkItem({
    type: 'issue',
    codebaseId: 'collab-core',
    title: 'Track D1 collaboration',
    priority: 'high',
    labels: ['d1', 'migration', 'd1'],
    actor: owner,
  })
  await backend.createWorkItem({
    type: 'discussion',
    codebaseId: 'collab-core',
    title: 'Migration notes',
    body: 'D1 is the primary backend.',
    category: 'announcements',
    actor: owner,
  })
  await backend.createWorkItem({
    type: 'release',
    codebaseId: 'collab-core',
    version: 'v1.0.0-d1',
    title: 'D1 migration',
    notes: 'First D1-backed collaboration release.',
    actor: owner,
  })

  const items = await backend.listWorkItems({ codebaseId: 'collab-core', actor: owner })
  assert.equal(items.issues.length, 1)
  assert.equal(items.issues[0].number, 1)
  assert.deepEqual(items.issues[0].labels, ['d1', 'migration'])
  assert.equal(items.discussions.length, 1)
  assert.equal(items.releases.length, 1)

  const invitation = await backend.createInvitation({
    codebaseId: 'collab-core',
    email: 'member@example.com',
    role: 'member',
    actor: owner,
  })
  assert.match(invitation.token, /^[A-Za-z0-9_-]+$/)

  const member = {
    userId: 'user_member',
    primaryEmail: 'member@example.com',
    displayName: 'Member',
    currentAuthEmailVerified: true,
  }
  await backend.acceptInvitation({ token: invitation.token, actor: member })
  const members = await backend.listMembers({ codebaseId: 'collab-core', status: 'active', actor: owner })
  assert.deepEqual(members.map((row) => row.userId).sort(), ['user_member', 'user_owner'])

  const memberRead = await backend.readTextFile({
    codebaseId: 'collab-core',
    path: 'README.md',
    actor: member,
  })
  assert.equal(memberRead.content, 'hello')
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

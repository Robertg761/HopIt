// GR-B4 (decisions §9): "mark this Main state as a release" -- name,
// optional notes, pinned Main revision, created_at.
//
// Covers: create pins the *current* Main revision (not the caller's active
// change set head); create/list round-trip; releasing pins the exact Main
// revision (the compare engine shows zero diff between the release's pinned
// revision and the revision actually captured at creation time); duplicate
// names are rejected per codebase; list is newest-first; the CLI path
// (`hop release <name> [--notes]`, `hop release list`); and a D1 backend
// parity test proving the schema/releases-store module round-trips against a
// real (in-memory sqlite) D1 worker, not just the local/dev JSON fixture.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'

import { createD1Backend } from '@hopit/backend-d1'
import { createCloudGraphService } from '../src/cloud/d1-graph-service.js'
import { initCloud } from '../src/commands/import.js'
import { hydrateWorkspace } from '../src/commands/hydrate.js'
import { mergeChangeSet, openChangeSetReview, syncOnce } from '../src/commands/sync.js'
import { createRelease, runReleaseCommand } from '../src/commands/release.js'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(repoRoot, 'packages/agent/src/cli.js')

async function makeState(label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `hopit-release-${label}-`))
  return {
    root,
    cloud: path.join(root, 'cloud.json'),
    workspace: path.join(root, 'workspace'),
    journal: path.join(root, 'journal.ndjson'),
    events: path.join(root, 'events.ndjson'),
  }
}

function optionsFor(state, extra = {}) {
  return {
    cloud: state.cloud,
    workspace: state.workspace,
    journal: state.journal,
    events: state.events,
    ...extra,
  }
}

async function initAndHydrate(state) {
  await initCloud({ ...optionsFor(state), force: true })
  await hydrateWorkspace(optionsFor(state))
}

async function editAndSync(state, relativePath, content) {
  const target = path.join(state.workspace, relativePath)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.appendFile(target, content, 'utf8')
  return syncOnce(optionsFor(state), { trigger: 'manual' })
}

async function readCloud(state) {
  return JSON.parse(await fs.readFile(state.cloud, 'utf8'))
}

function stateArgs(state) {
  return ['--cloud', state.cloud, '--workspace', state.workspace, '--journal', state.journal, '--events', state.events]
}

async function runCli(command, args = []) {
  return execFileAsync(process.execPath, [cliPath, command, ...args], { cwd: repoRoot, encoding: 'utf8' })
}

async function mergeCurrentChangeSet(state) {
  await openChangeSetReview(optionsFor(state))
  return mergeChangeSet(optionsFor(state))
}

test('release pins the current Main revision, not the active change set head', async () => {
  const state = await makeState('pin')
  await initAndHydrate(state)
  await editAndSync(state, 'README.md', '\nShipping soon.\n')
  await mergeCurrentChangeSet(state)

  const before = await readCloud(state)
  assert.equal(before.main.revision, 2)
  assert.equal(before.selectedState.revision, before.main.revision, 'a fresh rotated change set starts at the Main head')

  const release = await createRelease(optionsFor(state), { name: 'v1.0', notes: 'First cut' })
  assert.equal(release.name, 'v1.0')
  assert.equal(release.notes, 'First cut')
  assert.equal(release.pinnedRevision, 2)
  assert.ok(release.releaseId)
  assert.ok(release.createdAt)
  assert.equal(release.createdByUserId, 'user_demo_owner')
})

test('releasing pins the exact Main revision -- compare engine shows zero diff', async () => {
  const state = await makeState('exact-pin')
  await initAndHydrate(state)
  await editAndSync(state, 'README.md', '\nExact pin.\n')
  await mergeCurrentChangeSet(state)

  const cloudService = createCloudGraphService(optionsFor(state))
  const cloudBeforeRelease = await cloudService.readGraph()
  const mainRevisionAtRelease = cloudBeforeRelease.main.revision

  const release = await createRelease(optionsFor(state), { name: 'v1.1' })
  assert.equal(release.pinnedRevision, mainRevisionAtRelease)

  const comparison = await cloudService.compareRevisions(mainRevisionAtRelease, release.pinnedRevision)
  assert.equal(comparison.ok, true)
  const changed = comparison.entries.filter((entry) => entry.state !== 'unchanged')
  assert.deepEqual(changed, [], 'zero diff between the release revision and the revision actually captured')
})

test('create/list round-trip', async () => {
  const state = await makeState('roundtrip')
  await initAndHydrate(state)
  await editAndSync(state, 'README.md', '\nOne.\n')
  await mergeCurrentChangeSet(state)

  const cloudService = createCloudGraphService(optionsFor(state))
  const codebaseId = (await cloudService.readGraph()).codebase.id

  // Two releases against the same landed revision, at explicit, distinct
  // timestamps -- releases are historical facts (decisions §9), never
  // re-pinned, so there is no need to land a second change set to exercise
  // create/list round-tripping multiple rows.
  const first = await cloudService.createRelease(codebaseId, {
    name: 'v1.0', pinnedRevision: 2, actorId: 'user_demo_owner', now: '2026-07-24T10:00:00.000Z',
  })
  const second = await cloudService.createRelease(codebaseId, {
    name: 'v2.0', notes: 'Second release', pinnedRevision: 2, actorId: 'user_demo_owner', now: '2026-07-24T11:00:00.000Z',
  })

  const listed = await cloudService.listReleases(codebaseId)
  assert.equal(listed.length, 2)
  // Newest first.
  assert.equal(listed[0].releaseId, second.releaseId)
  assert.equal(listed[1].releaseId, first.releaseId)

  const byId = await cloudService.getRelease(codebaseId, first.releaseId)
  assert.equal(byId.name, 'v1.0')
  const byName = await cloudService.getReleaseByName(codebaseId, 'v2.0')
  assert.equal(byName.releaseId, second.releaseId)
  assert.equal(byName.notes, 'Second release')
})

test('duplicate release names are rejected per codebase', async () => {
  const state = await makeState('dup')
  await initAndHydrate(state)
  await editAndSync(state, 'README.md', '\nOne.\n')
  await mergeCurrentChangeSet(state)
  await createRelease(optionsFor(state), { name: 'v1.0' })

  await assert.rejects(
    () => createRelease(optionsFor(state), { name: 'v1.0' }),
    /already exists/,
  )

  const cloudService = createCloudGraphService(optionsFor(state))
  const codebaseId = (await cloudService.readGraph()).codebase.id
  const rows = await cloudService.listReleases(codebaseId)
  assert.equal(rows.length, 1, 'the rejected duplicate did not create a second row')
})

test('release requires a name', async () => {
  const state = await makeState('no-name')
  await initAndHydrate(state)
  await assert.rejects(() => createRelease(optionsFor(state), {}), /Usage: hop release/)
})

test('CLI: hop release <name> --notes pins the current Main revision', async () => {
  const state = await makeState('cli-create')
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))
  await fs.appendFile(path.join(state.workspace, 'README.md'), '\nCLI release.\n', 'utf8')
  await runCli('sync-once', stateArgs(state))
  await runCli('review-open', stateArgs(state))
  await runCli('merge', stateArgs(state))

  const result = await runCli('release', [
    'v1.0',
    ...stateArgs(state),
    '--notes',
    'CLI notes',
    '--requester-id',
    'user_demo_owner',
  ])
  assert.match(result.stdout, /release\.created/)

  const cloudService = createCloudGraphService(optionsFor(state))
  const codebaseId = (await cloudService.readGraph()).codebase.id
  const releases = await cloudService.listReleases(codebaseId)
  assert.equal(releases.length, 1)
  assert.equal(releases[0].name, 'v1.0')
  assert.equal(releases[0].notes, 'CLI notes')
  assert.equal(releases[0].pinnedRevision, 2)
})

test('CLI: hop release list reports releases as JSON', async () => {
  const state = await makeState('cli-list')
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))
  await fs.appendFile(path.join(state.workspace, 'README.md'), '\nCLI list.\n', 'utf8')
  await runCli('sync-once', stateArgs(state))
  await runCli('review-open', stateArgs(state))
  await runCli('merge', stateArgs(state))
  await runCli('release', ['v1.0', ...stateArgs(state), '--requester-id', 'user_demo_owner'])

  const result = await runCli('release', ['list', ...stateArgs(state), '--json'])
  const parsed = JSON.parse(result.stdout.trim())
  assert.equal(parsed.ok, true)
  assert.equal(parsed.releases.length, 1)
  assert.equal(parsed.releases[0].name, 'v1.0')
})

test('runReleaseCommand dispatches list vs create the same as the CLI parser', async () => {
  const state = await makeState('dispatch')
  await initAndHydrate(state)
  await editAndSync(state, 'README.md', '\nDispatch.\n')
  await mergeCurrentChangeSet(state)

  const created = await runReleaseCommand('create', 'v1.0', { ...optionsFor(state), quiet: true, requesterId: 'user_demo_owner' })
  assert.equal(created.name, 'v1.0')

  const listed = await runReleaseCommand('list', null, { ...optionsFor(state), quiet: true })
  assert.equal(listed.releases.length, 1)
  assert.equal(listed.releases[0].name, 'v1.0')
})

// --- D1 backend parity -------------------------------------------------
// Proves the schema/releases-store module round-trips against a real
// (in-memory sqlite) D1 worker, not just the local/dev JSON fixture.

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

function d1Options(server, root) {
  return {
    'cloud-backend': 'd1',
    'codebase-id': 'hopit-core',
    'd1-api-base-url': server.baseUrl,
    'd1-account-id': 'account_test',
    'd1-database-id': 'database_test',
    'd1-api-token': 'token_test',
    workspace: path.join(root, 'workspace'),
    journal: path.join(root, 'journal.ndjson'),
    events: path.join(root, 'events.ndjson'),
  }
}

test('D1 backend: release round-trips through the real releases table, duplicate rejected', async (t) => {
  const server = await startD1ApiServer(t)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-release-d1-'))
  const options = d1Options(server, root)

  await initCloud({ ...options, force: true })
  await hydrateWorkspace(options)
  const readmePath = path.join(options.workspace, 'README.md')
  await fs.appendFile(readmePath, '\nD1 release.\n', 'utf8')
  await syncOnce(options, { trigger: 'manual' })
  await openChangeSetReview(options)
  await mergeChangeSet(options)

  const release = await createRelease(options, { name: 'v1.0', notes: 'D1 release notes' })
  assert.equal(release.pinnedRevision, 2)

  const row = server.db.prepare('select * from releases where release_id = ?').get(release.releaseId)
  assert.ok(row, 'the release row exists in the real releases table')
  assert.equal(row.name, 'v1.0')
  assert.equal(row.notes, 'D1 release notes')
  assert.equal(row.pinned_revision, 2)
  assert.equal(row.created_by_user_id, 'user_demo_owner')

  await assert.rejects(() => createRelease(options, { name: 'v1.0' }), /already exists/)

  const backend = createD1Backend({
    'codebase-id': options['codebase-id'],
    'd1-api-base-url': options['d1-api-base-url'],
    'd1-account-id': options['d1-account-id'],
    'd1-database-id': options['d1-database-id'],
    'd1-api-token': options['d1-api-token'],
  })
  const listed = await backend.listReleases('hopit-core')
  assert.equal(listed.length, 1, 'the rejected duplicate did not create a second row')
})

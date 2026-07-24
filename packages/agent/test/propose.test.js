// GR-B2 (decisions §2-4, docs/proposal-data-model-design.md): `hop propose`
// and the merge queue that lands ready proposals.
//
// Covers: propose pins the active change set head as a proposal; a second
// propose on the same still-unmerged change set re-pins the same row in
// place (owner constraint: at most one open proposal per change set); the
// solo `hop propose --merge` path self-approves and lands through the same
// merge-queue path in one command; saves made after proposing do not change
// what merges; two ready proposals merge serially with the second refreshed
// against the first's landed result (no merge races, asserted against final
// Main content); a genuine path-overlap conflict refuses to merge and
// leaves the proposal `stale`/`main_conflict`; and the plain, proposal-less
// `hop merge` path keeps working unchanged.
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
import { approveProposal, proposeAndMerge, proposeChangeSet, runMergeQueue } from '../src/commands/propose.js'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(repoRoot, 'packages/agent/src/cli.js')

async function makeState(label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `hopit-propose-${label}-`))
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

test('propose pins the active change set head as a proposal', async () => {
  const state = await makeState('pin')
  await initAndHydrate(state)
  await editAndSync(state, 'README.md', '\nProposed change.\n')

  const before = await readCloud(state)
  assert.equal(before.selectedState.revision, 2)
  assert.equal(before.main.revision, 1)

  const proposal = await proposeChangeSet(optionsFor(state), { title: 'Add proposed change' })
  assert.equal(proposal.state, 'proposed')
  assert.equal(proposal.changeSetId, 'cs_demo_active')
  assert.equal(proposal.pinnedRevision, 2)
  assert.equal(proposal.baseRevision, 1)
  assert.equal(proposal.title, 'Add proposed change')
  assert.equal(proposal.createdByUserId, 'user_demo_owner')

  const cloudService = createCloudGraphService(optionsFor(state))
  const stored = await cloudService.getProposal('hopit-core', proposal.proposalId)
  assert.deepEqual(stored, proposal)
})

test('propose without --merge only pins -- Main is untouched', async () => {
  const state = await makeState('pin-only')
  await initAndHydrate(state)
  await editAndSync(state, 'README.md', '\nPinned only.\n')
  await proposeChangeSet(optionsFor(state), { title: 'Pin only' })

  const cloud = await readCloud(state)
  assert.equal(cloud.main.revision, 1)
  assert.equal(cloud.selectedState.mergeState, 'unmerged')
  assert.equal(cloud.selectedState.id, 'cs_demo_active')
})

test('re-proposing the same unmerged change set re-pins the existing row instead of forking a new one', async () => {
  const state = await makeState('repin')
  await initAndHydrate(state)
  await editAndSync(state, 'README.md', '\nFirst pass.\n')
  const first = await proposeChangeSet(optionsFor(state), { title: 'First' })

  await editAndSync(state, 'README.md', '\nSecond pass.\n')
  const second = await proposeChangeSet(optionsFor(state))

  assert.equal(second.proposalId, first.proposalId)
  assert.equal(second.pinnedRevision, 3)
  assert.equal(second.title, 'First', 'title is preserved when a re-pin omits --title')

  const cloudService = createCloudGraphService(optionsFor(state))
  const rows = await cloudService.listProposals('hopit-core')
  assert.equal(rows.length, 1, 'at most one open proposal per change set -- re-pin, do not fork')
})

test('propose title is preserved across a re-pin that omits --title, and can be explicitly cleared', async () => {
  const state = await makeState('title')
  await initAndHydrate(state)
  await editAndSync(state, 'README.md', '\nv1.\n')
  const first = await proposeChangeSet(optionsFor(state), { title: 'Ship it' })
  assert.equal(first.title, 'Ship it')

  await editAndSync(state, 'README.md', '\nv2.\n')
  const second = await proposeChangeSet(optionsFor(state))
  assert.equal(second.title, 'Ship it')

  await editAndSync(state, 'README.md', '\nv3.\n')
  const third = await proposeChangeSet(optionsFor(state), { title: null })
  assert.equal(third.title, null)
})

test('propose --merge self-approves and lands through the merge queue in one command (solo path)', async () => {
  const state = await makeState('solo-merge')
  await initAndHydrate(state)
  await editAndSync(state, 'README.md', '\nSolo merge change.\n')

  const before = await readCloud(state)
  assert.equal(before.main.revision, 1)

  const { proposal, outcomes } = await proposeAndMerge(optionsFor(state), { title: 'Solo change' })
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0].outcome, 'merged')
  assert.equal(outcomes[0].mergedRevision, 2)

  const after = await readCloud(state)
  assert.equal(after.main.revision, 2)
  assert.equal(after.main.mergedChangeSetId, 'cs_demo_active')
  assert.notEqual(after.selectedState.id, 'cs_demo_active', 'the merged change set rotates to a fresh one')
  assert.equal(after.selectedState.baseRevision, 2)
  assert.equal(after.selectedState.revision, 2)
  assert.equal(after.selectedState.mergeState, 'unmerged', 'the rotated change set can accept new saves')

  const cloudService = createCloudGraphService(optionsFor(state))
  const merged = await cloudService.getProposal('hopit-core', proposal.proposalId)
  assert.equal(merged.state, 'merged')
  assert.equal(merged.mergedRevision, 2)
  assert.equal(merged.mergedByUserId, 'user_demo_owner')
  assert.equal(merged.queuedAt, null)

  // Rotation must actually unblock further work (no selected_state_already_merged).
  await editAndSync(state, 'README.md', '\nMore work after merge.\n')
  const afterSecondSave = await readCloud(state)
  assert.equal(afterSecondSave.selectedState.revision, 3)
})

test('saves made after proposing do not change what the merge queue lands', async () => {
  const state = await makeState('post-propose-saves')
  await initAndHydrate(state)
  await editAndSync(state, 'README.md', '\nPinned content.\n')
  const proposal = await proposeChangeSet(optionsFor(state), { title: 'Pin me' })
  assert.equal(proposal.pinnedRevision, 2)

  // Further, unproposed work on the same still-open change set.
  await editAndSync(state, 'package.json', '\n// trailing edit\n')
  const afterExtraSave = await readCloud(state)
  assert.equal(afterExtraSave.selectedState.revision, 3)

  await approveProposal(optionsFor(state), { proposalId: proposal.proposalId })
  const outcomes = await runMergeQueue(optionsFor(state))
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0].outcome, 'merged')
  assert.equal(outcomes[0].mergedRevision, 2, 'lands the pinned revision, not the live head')

  const after = await readCloud(state)
  assert.equal(after.main.revision, 2, 'Main only ever reflects the pinned revision')
  assert.equal(after.selectedState.baseRevision, 2)
  assert.equal(after.selectedState.revision, 3, 'the extra, unproposed save is preserved -- not discarded')
})

test('two ready proposals merge serially, the second refreshed against the first landed result', async () => {
  const state = await makeState('serial-queue')
  await initAndHydrate(state)

  await editAndSync(state, 'README.md', '\nProposal A change.\n')
  const proposalA = await proposeChangeSet(optionsFor(state), { title: 'A' })
  await approveProposal(optionsFor(state), { proposalId: proposalA.proposalId })

  // A second, independently based proposal touching a different file. The
  // current single-active-change-set architecture cannot itself produce two
  // simultaneously-approved proposals for one codebase (see propose.js
  // "OWNER CONSTRAINT" / rotation-on-merge), so this mirrors how GR-A2's
  // divergence tests seed `openDivergence` directly at the store layer to
  // exercise the queue's serialization guarantees in isolation.
  await editAndSync(state, 'package.json', '\nProposal B change.\n')
  const cloudService = createCloudGraphService(optionsFor(state))
  const proposalB = await cloudService.upsertProposal('hopit-core', {
    changeSetId: 'cs_seeded_b',
    title: 'B',
    pinnedRevision: 3,
    baseRevision: 1,
    actorId: 'user_demo_owner',
    now: new Date().toISOString(),
  })
  await cloudService.approveProposal('hopit-core', proposalB.proposalId, { now: new Date().toISOString() })

  const ready = await cloudService.listReadyProposals('hopit-core')
  assert.equal(ready.length, 2)

  const outcomes = await runMergeQueue(optionsFor(state))
  assert.equal(outcomes.length, 2)
  assert.equal(outcomes[0].proposalId, proposalA.proposalId)
  assert.equal(outcomes[0].outcome, 'merged')
  assert.equal(outcomes[0].mergedRevision, 2)
  assert.equal(outcomes[1].proposalId, proposalB.proposalId)
  assert.equal(outcomes[1].outcome, 'merged')
  assert.equal(outcomes[1].mergedRevision, 3)
  assert.equal(outcomes[1].previousMainRevision, 2, 'the second lands on top of the first, not the stale base')

  const after = await readCloud(state)
  assert.equal(after.main.revision, 3)
  assert.equal(after.main.mergedChangeSetId, 'cs_seeded_b')

  // Assert final Main content genuinely carries BOTH proposals' changes.
  const compare = await cloudService.compareRevisions(1, after.main.revision, { requesterId: 'user_demo_owner' })
  assert.equal(compare.ok, true)
  const changed = compare.entries.filter((entry) => entry.state !== 'unchanged').map((entry) => entry.path).sort()
  assert.deepEqual(changed, ['README.md', 'package.json'])
})

test('a merge attempt evaluated after an earlier one observes that earlier merge\'s already-updated Main revision', async () => {
  const state = await makeState('serialized-attempts')
  await initAndHydrate(state)

  await editAndSync(state, 'README.md', '\nFirst change.\n')
  const proposalA = await proposeChangeSet(optionsFor(state), { title: 'A' })
  await approveProposal(optionsFor(state), { proposalId: proposalA.proposalId })
  const firstOutcomes = await runMergeQueue(optionsFor(state))
  assert.equal(firstOutcomes[0].outcome, 'merged')

  const midCloud = await readCloud(state)
  assert.equal(midCloud.main.revision, 2)

  // A later, independently-based merge attempt must observe the first
  // merge's Main revision, not the pre-merge value it would have seen had
  // it raced ahead of the first write.
  await editAndSync(state, 'package.json', '\nSecond change.\n')
  const cloudService = createCloudGraphService(optionsFor(state))
  const proposalB = await cloudService.upsertProposal('hopit-core', {
    changeSetId: 'cs_seeded_second_attempt',
    title: 'B',
    pinnedRevision: 3,
    baseRevision: 1,
    actorId: 'user_demo_owner',
    now: new Date().toISOString(),
  })
  await cloudService.approveProposal('hopit-core', proposalB.proposalId, { now: new Date().toISOString() })
  const secondOutcomes = await runMergeQueue(optionsFor(state))
  assert.equal(secondOutcomes.length, 1)
  assert.equal(secondOutcomes[0].outcome, 'merged')
  assert.equal(secondOutcomes[0].previousMainRevision, 2, 'observed the first attempt\'s result, not a stale revision')
  assert.equal(secondOutcomes[0].mergedRevision, 3)

  const after = await readCloud(state)
  assert.equal(after.main.revision, 3)
})

test('a proposal with a genuine path overlap against Main refuses to merge and becomes stale/main_conflict', async () => {
  const state = await makeState('conflict')
  await initAndHydrate(state)

  await editAndSync(state, 'README.md', '\nProposal A change.\n')
  const proposalA = await proposeChangeSet(optionsFor(state), { title: 'A' })
  await approveProposal(optionsFor(state), { proposalId: proposalA.proposalId })

  // A second edit to the SAME path, seeded as an independent proposal based
  // on the same pre-A Main revision -- a genuine double-edit conflict.
  await editAndSync(state, 'README.md', '\nConflicting change to the same file.\n')
  const cloudService = createCloudGraphService(optionsFor(state))
  const proposalB = await cloudService.upsertProposal('hopit-core', {
    changeSetId: 'cs_seeded_conflict',
    title: 'B',
    pinnedRevision: 3,
    baseRevision: 1,
    actorId: 'user_demo_owner',
    now: new Date().toISOString(),
  })
  await cloudService.approveProposal('hopit-core', proposalB.proposalId, { now: new Date().toISOString() })

  const outcomes = await runMergeQueue(optionsFor(state))
  assert.equal(outcomes.length, 2)
  assert.equal(outcomes[0].outcome, 'merged')
  assert.equal(outcomes[1].outcome, 'stale')
  assert.equal(outcomes[1].reason, 'main_conflict')

  const after = await readCloud(state)
  assert.equal(after.main.revision, 2, 'the conflicting proposal never lands')

  const staleRow = await cloudService.getProposal('hopit-core', proposalB.proposalId)
  assert.equal(staleRow.state, 'stale')
  assert.equal(staleRow.staleReason, 'main_conflict')
  assert.equal(staleRow.queuedAt, null)
})

test('approving with no existing proposal for the change set throws', async () => {
  const state = await makeState('approve-missing')
  await initAndHydrate(state)
  await assert.rejects(() => approveProposal(optionsFor(state)), /No proposal found/)
})

test('approving an already-merged proposal is rejected', async () => {
  const state = await makeState('approve-merged')
  await initAndHydrate(state)
  await editAndSync(state, 'README.md', '\nChange.\n')
  const { proposal } = await proposeAndMerge(optionsFor(state))
  await assert.rejects(
    () => approveProposal(optionsFor(state), { proposalId: proposal.proposalId }),
    /already merged/,
  )
})

test('propose refuses when the selected change set is already merged via the plain merge path', async () => {
  const state = await makeState('propose-after-plain-merge')
  await initAndHydrate(state)
  await editAndSync(state, 'README.md', '\nPlain merge change.\n')
  await openChangeSetReview(optionsFor(state))
  await mergeChangeSet(optionsFor(state))

  await assert.rejects(() => proposeChangeSet(optionsFor(state)), /already merged/)
})

test('the plain, proposal-less hop merge path keeps working unchanged alongside proposals', async () => {
  const state = await makeState('plain-merge-unchanged')
  await initAndHydrate(state)
  await editAndSync(state, 'README.md', '\nPlain path change.\n')

  await openChangeSetReview(optionsFor(state))
  await mergeChangeSet(optionsFor(state))

  const after = await readCloud(state)
  assert.equal(after.main.revision, 2)
  assert.equal(after.main.mergedChangeSetId, 'cs_demo_active')
  assert.equal(after.selectedState.reviewState, 'merged')
  assert.equal(after.selectedState.mergeState, 'merged')

  // The plain path never touches the proposals table.
  const cloudService = createCloudGraphService(optionsFor(state))
  const rows = await cloudService.listProposals('hopit-core')
  assert.equal(rows.length, 0)
})

test('CLI: hop propose --title ... --merge pins, self-approves, and merges via the merge queue', async () => {
  const state = await makeState('cli-solo')
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))
  await fs.appendFile(path.join(state.workspace, 'README.md'), '\nCLI change.\n', 'utf8')
  await runCli('sync-once', stateArgs(state))

  const result = await runCli('propose', [
    ...stateArgs(state),
    '--title',
    'CLI proposal',
    '--merge',
    '--requester-id',
    'user_demo_owner',
  ])
  assert.match(result.stdout, /proposal\.pinned/)
  assert.match(result.stdout, /proposal\.approved/)
  assert.match(result.stdout, /proposal\.merged/)

  const cloud = await readCloud(state)
  assert.equal(cloud.main.revision, 2)
  assert.equal(cloud.main.mergedChangeSetId, 'cs_demo_active')
})

test('CLI: hop propose without --merge only pins (no merge/approve events)', async () => {
  const state = await makeState('cli-pin-only')
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))
  await fs.appendFile(path.join(state.workspace, 'README.md'), '\nCLI pin only.\n', 'utf8')
  await runCli('sync-once', stateArgs(state))

  const result = await runCli('propose', [...stateArgs(state), '--title', 'CLI pin', '--requester-id', 'user_demo_owner'])
  assert.match(result.stdout, /proposal\.pinned/)
  assert.doesNotMatch(result.stdout, /proposal\.approved/)
  assert.doesNotMatch(result.stdout, /proposal\.merged/)

  const cloud = await readCloud(state)
  assert.equal(cloud.main.revision, 1)
})

// --- D1 backend parity -------------------------------------------------
// Proves the schema/proposals-store module round-trips against a real
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

function backendFor(options) {
  return createD1Backend({
    'codebase-id': options['codebase-id'],
    'd1-api-base-url': options['d1-api-base-url'],
    'd1-account-id': options['d1-account-id'],
    'd1-database-id': options['d1-database-id'],
    'd1-api-token': options['d1-api-token'],
  })
}

// GR-B5: claims and completes the most recently queued 'ci' action_job,
// exactly like a hosted runner would after actually running the check --
// tests never run real npm scripts, they just decide the outcome directly.
async function completeLatestCiJob(backend, status = 'succeeded') {
  const claimed = await backend.claimNextActionJob({ runnerId: 'ci-test-runner' })
  assert.equal(claimed.kind, 'ci', 'the queued job is the CI check, not something else')
  await backend.completeActionJob({
    jobId: claimed.jobId,
    runnerId: 'ci-test-runner',
    status,
    exitCode: status === 'succeeded' ? 0 : 1,
    stdout: '',
    stderr: status === 'succeeded' ? '' : 'test failed',
  })
  return claimed
}

test('D1 backend: propose --merge round-trips through the real proposals table', async (t) => {
  const server = await startD1ApiServer(t)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-propose-d1-'))
  const options = d1Options(server, root)
  const backend = backendFor(options)

  await initCloud({ ...options, force: true })
  await hydrateWorkspace(options)
  const readmePath = path.join(options.workspace, 'README.md')
  await fs.appendFile(readmePath, '\nD1 change.\n', 'utf8')
  await syncOnce(options, { trigger: 'manual' })

  // GR-B5: propose --merge enqueues CI and blocks on it (decisions §3) --
  // the first drain attempt cannot land yet.
  const { proposal, outcomes } = await proposeAndMerge(options, { title: 'D1 proposal' })
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0].outcome, 'ci-pending')

  await completeLatestCiJob(backend, 'succeeded')
  const landed = await runMergeQueue(options)
  assert.equal(landed.length, 1)
  assert.equal(landed[0].outcome, 'merged')

  const row = server.db.prepare('select * from proposals where proposal_id = ?').get(proposal.proposalId)
  assert.ok(row, 'the proposal row exists in the real proposals table')
  assert.equal(row.state, 'merged')
  assert.equal(row.merged_revision, 2)
  assert.equal(row.merged_by_user_id, 'user_demo_owner')

  const graph = await backend.readGraph('hopit-core')
  assert.equal(graph.main.revision, 2)
  assert.notEqual(graph.selectedState.id, 'cs_demo_active')
})

test('the merge queue blocks on red CI and lands once a fresh CI job succeeds', async (t) => {
  const server = await startD1ApiServer(t)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-propose-d1-ci-red-'))
  const options = d1Options(server, root)
  const backend = backendFor(options)

  await initCloud({ ...options, force: true })
  await hydrateWorkspace(options)
  await fs.appendFile(path.join(options.workspace, 'README.md'), '\nRed CI change.\n', 'utf8')
  await syncOnce(options, { trigger: 'manual' })

  const proposal = await proposeChangeSet(options, { title: 'Gated proposal' })
  await approveProposal(options, { proposalId: proposal.proposalId })

  // Queue drain #1: no CI job has run yet -- blocked, Main untouched.
  const pending = await runMergeQueue(options)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].outcome, 'ci-pending')
  assert.equal((await backend.readGraph('hopit-core')).main.revision, 1)

  // The runner reports the check failed -- still blocked, Main still
  // untouched (red CI must never land).
  await completeLatestCiJob(backend, 'failed')
  const afterRed = await runMergeQueue(options)
  assert.equal(afterRed.length, 1)
  assert.equal(afterRed[0].outcome, 'ci-failed')
  assert.equal((await backend.readGraph('hopit-core')).main.revision, 1, 'red CI never lands the proposal')

  const jobRows = server.db.prepare(`select * from action_jobs where proposal_id = ? order by created_at asc`).all(proposal.proposalId)
  assert.equal(jobRows.length, 2, 'a failed check gets re-queued, not silently retried in place')
  assert.equal(jobRows[0].status, 'failed')
  assert.equal(jobRows[1].status, 'queued')

  // A fresh CI job for the same proposal goes green -- now it lands.
  await completeLatestCiJob(backend, 'succeeded')
  const landed = await runMergeQueue(options)
  assert.equal(landed.length, 1)
  assert.equal(landed[0].outcome, 'merged')
  assert.equal((await backend.readGraph('hopit-core')).main.revision, 2)
})

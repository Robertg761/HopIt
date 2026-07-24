// GR-B3 (decisions §4, docs/proposal-data-model-design.md "How review
// staleness is derived"): re-pinning a proposal automatically stales its
// existing review decisions, and the merge queue must never land a revision
// with no non-stale approval -- except the solo `hop propose --merge`
// self-approve path from GR-B2, which stays intact and creates no linked
// review_decisions row at all.
//
// The team review-approval door (`createReviewDecision` in
// packages/backend-d1/src/collaboration.js) only exists against the real D1
// backend -- the agent-side fixture/local-dev graph service has no
// `review_decisions` table (see `getLatestDecisionForProposal` stub in
// packages/agent/src/cloud/d1-graph-service.js) -- so every test here runs
// against an in-memory-sqlite-backed D1 worker, mirroring the "D1 backend:
// propose --merge round-trips" pattern in propose.test.js.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'

import { createD1Backend } from '@hopit/backend-d1'
import { initCloud } from '../src/commands/import.js'
import { hydrateWorkspace } from '../src/commands/hydrate.js'
import { syncOnce } from '../src/commands/sync.js'
import { proposeChangeSet, runMergeQueue } from '../src/commands/propose.js'

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

function d1Backend(options) {
  return createD1Backend({
    'codebase-id': options['codebase-id'],
    'd1-api-base-url': options['d1-api-base-url'],
    'd1-account-id': options['d1-account-id'],
    'd1-database-id': options['d1-database-id'],
    'd1-api-token': options['d1-api-token'],
  })
}

const reviewerActor = { userId: 'user_demo_owner' }

// GR-B5 (Wave 4 integration): every `hop propose` against the real D1
// backend enqueues a `ci` action_job, and the merge queue's CI gate runs
// alongside the stale-review guard these tests exercise -- so any drain that
// expects a land must first complete the queued CI job(s), exactly like a
// hosted runner would (same helper as propose.test.js).
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

async function setUp(t, label) {
  const server = await startD1ApiServer(t)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `hopit-stale-review-${label}-`))
  const options = d1Options(server, root)
  await initCloud({ ...options, force: true })
  await hydrateWorkspace(options)
  return { server, root, options, backend: d1Backend(options) }
}

async function editAndSync(options, relativePath, content) {
  const target = path.join(options.workspace, relativePath)
  await fs.appendFile(target, content, 'utf8')
  return syncOnce(options, { trigger: 'manual' })
}

test('an approved review decision links to the proposal and transitions it into the merge queue', async (t) => {
  const { options, backend } = await setUp(t, 'approve')
  await editAndSync(options, 'README.md', '\nTeam review change.\n')
  const proposal = await proposeChangeSet(options, { title: 'Team change' })
  assert.equal(proposal.pinnedRevision, 2)

  const decisions = await backend.createReviewDecision({
    codebaseId: 'hopit-core',
    changeSetId: proposal.changeSetId,
    decision: 'approved',
    summary: 'Looks good',
    createdBy: 'reviewer_1',
    actor: reviewerActor,
  })
  assert.equal(decisions.proposalId, proposal.proposalId)
  assert.equal(decisions.decisionRevision, 2)
  assert.equal(decisions.stale, false)
  assert.equal(decisions.currentPinnedRevision, 2)

  const stored = await backend.getProposal('hopit-core', proposal.proposalId)
  assert.equal(stored.state, 'approved', 'an approved team review decision is a door into the merge queue, same as solo self-approve')
  assert.ok(stored.queuedAt)

  await completeLatestCiJob(backend)
  const outcomes = await runMergeQueue(options)
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0].outcome, 'merged')
  assert.equal(outcomes[0].mergedRevision, 2)
})

test('re-pinning after an approval flags the prior decision stale and blocks the queue until re-approval', async (t) => {
  const { options, backend } = await setUp(t, 'repin-stale')
  await editAndSync(options, 'README.md', '\nFirst pass.\n')
  const proposal = await proposeChangeSet(options, { title: 'Re-pin test' })
  assert.equal(proposal.pinnedRevision, 2)

  await backend.createReviewDecision({
    codebaseId: 'hopit-core',
    changeSetId: proposal.changeSetId,
    decision: 'approved',
    createdBy: 'reviewer_1',
    actor: reviewerActor,
  })

  // The proposer explicitly updates the proposal (decisions §4) -- a second
  // save plus a second `hop propose`, re-pinning the same row in place.
  await editAndSync(options, 'README.md', '\nSecond pass.\n')
  const repinned = await proposeChangeSet(options)
  assert.equal(repinned.proposalId, proposal.proposalId)
  assert.equal(repinned.pinnedRevision, 3)
  assert.equal(repinned.state, 'proposed', 're-pinning resets state -- prior approval no longer makes it mergeable')

  const decisions = await backend.listReviewDecisions({
    codebaseId: 'hopit-core',
    changeSetId: proposal.changeSetId,
    actor: reviewerActor,
  })
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].decisionRevision, 2, 'the decision itself is append-only, never mutated')
  assert.equal(decisions[0].currentPinnedRevision, 3, 'reflects the proposal\'s live pin')
  assert.equal(decisions[0].stale, true, '"changed since your review" -- decisions §4 automation')

  // Merge blocked until re-approval: nothing is ready.
  const blockedOutcomes = await runMergeQueue(options)
  assert.equal(blockedOutcomes.length, 0)

  // Re-approval at the new pin clears the block.
  const reapproved = await backend.createReviewDecision({
    codebaseId: 'hopit-core',
    changeSetId: proposal.changeSetId,
    decision: 'approved',
    createdBy: 'reviewer_1',
    actor: reviewerActor,
  })
  assert.equal(reapproved.decisionRevision, 3)
  assert.equal(reapproved.stale, false)

  // Both proposes (initial pin + re-pin) enqueued a CI job; the gate reads
  // the proposal's *latest* job, so green both.
  await completeLatestCiJob(backend)
  await completeLatestCiJob(backend)
  const outcomes = await runMergeQueue(options)
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0].outcome, 'merged')
  assert.equal(outcomes[0].mergedRevision, 3)
})

test('the merge-queue guard refuses to land when the most recent linked decision is not a non-stale approval', async (t) => {
  const { options, backend } = await setUp(t, 'queue-guard')
  await editAndSync(options, 'README.md', '\nGuard test.\n')
  const proposal = await proposeChangeSet(options, { title: 'Guard test' })

  await backend.createReviewDecision({
    codebaseId: 'hopit-core',
    changeSetId: proposal.changeSetId,
    decision: 'approved',
    createdBy: 'reviewer_1',
    actor: reviewerActor,
  })

  // A second reviewer requests changes at the *same* pin -- no re-pin
  // happened, so the state-reset guard alone would not catch this: the
  // proposal is still `state = 'approved'` with `queued_at` set. The most
  // recent linked decision is no longer an approval, which is what the
  // explicit queue guard in `landOneProposal` must catch.
  await backend.createReviewDecision({
    codebaseId: 'hopit-core',
    changeSetId: proposal.changeSetId,
    decision: 'changes-requested',
    createdBy: 'reviewer_2',
    actor: reviewerActor,
  })

  const stillApproved = await backend.getProposal('hopit-core', proposal.proposalId)
  assert.equal(stillApproved.state, 'approved', 'a changes-requested decision does not itself flip proposal state')

  const outcomes = await runMergeQueue(options)
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0].outcome, 'stale')
  assert.equal(outcomes[0].reason, 'review_stale')

  const stale = await backend.getProposal('hopit-core', proposal.proposalId)
  assert.equal(stale.state, 'stale')
  assert.equal(stale.staleReason, 'review_stale')

  // Nothing landed on Main.
  const graph = await backend.readGraph('hopit-core')
  assert.equal(graph.main.revision, 1)

  // A fresh approval clears the guard and the proposal lands.
  await backend.createReviewDecision({
    codebaseId: 'hopit-core',
    changeSetId: proposal.changeSetId,
    decision: 'approved',
    createdBy: 'reviewer_1',
    actor: reviewerActor,
  })
  await completeLatestCiJob(backend)
  const landed = await runMergeQueue(options)
  assert.equal(landed.length, 1)
  assert.equal(landed[0].outcome, 'merged')
})

test('the solo self-approve path never links a review decision and is exempt from the guard', async (t) => {
  const { options, backend } = await setUp(t, 'solo-exempt')
  await editAndSync(options, 'README.md', '\nSolo path.\n')
  const proposal = await proposeChangeSet(options, { title: 'Solo' })
  await backend.approveProposal('hopit-core', proposal.proposalId, { now: new Date().toISOString() })

  const decisions = await backend.listReviewDecisions({
    codebaseId: 'hopit-core',
    changeSetId: proposal.changeSetId,
    actor: reviewerActor,
  })
  assert.equal(decisions.length, 0, 'solo self-approve creates no review_decisions row')

  await completeLatestCiJob(backend)
  const outcomes = await runMergeQueue(options)
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0].outcome, 'merged', 'no linked decision -- solo path stays intact, never blocked')
})

test('a decision recorded before any proposal exists for the change set stays unlinked and never stale', async (t) => {
  const { backend } = await setUp(t, 'unlinked')

  const decision = await backend.createReviewDecision({
    codebaseId: 'hopit-core',
    changeSetId: 'cs_demo_active',
    decision: 'commented',
    summary: 'Early comment, before propose exists.',
    createdBy: 'reviewer_1',
    actor: reviewerActor,
  })
  assert.equal(decision.proposalId, null)
  assert.equal(decision.decisionRevision, null)
  assert.equal(decision.stale, false)
})

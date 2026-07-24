// GR-E2: mirror automation on merge (decisions doc §8).
//
// Covers: `hop mirror-set-remote` persists remote/branch/deploy-key
// server-side; a successful merge enqueues a mirror `action_job`; a hosted
// runner claiming and running that job advances the mirror; a mirror
// failure notifies without touching the merge/Main state; and the deploy
// key is ciphertext-only at rest.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import { createD1Backend } from '@hopit/backend-d1'
import { initCloud } from '../src/commands/import.js'
import { hydrateWorkspace } from '../src/commands/hydrate.js'
import { mergeChangeSet, openChangeSetReview, syncOnce } from '../src/commands/sync.js'
import { decryptMirrorDeployKey, runMirrorSetRemote, runMirrorSync } from '../src/commands/mirror.js'

async function makeTempRoot(t, label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `hopit-${label}-`))
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
  return root
}

async function makeBareRemote(root, name) {
  const remotePath = path.join(root, `${name}.git`)
  runGitOrThrow(['init', '--bare', '--quiet', remotePath], root)
  return remotePath
}

function runGitOrThrow(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result
}

function commitLog(remotePath, branch = 'main') {
  const result = runGitOrThrow(['log', '--format=%H', branch], remotePath)
  return result.stdout.trim().split('\n').filter(Boolean)
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

async function makeD1Workspace(t, server, label) {
  const root = await makeTempRoot(t, `mirror-automation-ws-${label}`)
  const options = d1Options(server, root)
  await initCloud({ ...options, force: true })
  await hydrateWorkspace(options)
  return { root, options }
}

async function editAndSync(options, relativePath, content) {
  const target = path.join(options.workspace, relativePath)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.appendFile(target, content, 'utf8')
  return syncOnce(options, { trigger: 'manual' })
}

test('mirror-set-remote persists remote/branch and mirror-sync falls back to it without --remote', async (t) => {
  const server = await startD1ApiServer(t)
  const { root, options } = await makeD1Workspace(t, server, 'mirror-remote-fallback')
  const remote = await makeBareRemote(root, 'origin')

  const setRemote = await runMirrorSetRemote({ ...options, remote })
  assert.equal(setRemote.ok, true)
  assert.equal(setRemote.mirrorRemoteUrl, remote)
  assert.equal(setRemote.mirrorBranch, 'main')
  assert.equal(setRemote.deployKeyConfigured, false)

  // No `remote` passed here: mirror-sync must fall back to the
  // server-persisted setting -- this is what lets a hosted runner with no
  // local mirror-state.json run on its very first invocation.
  const synced = await runMirrorSync({ ...options })
  assert.equal(synced.ok, true)
  assert.equal(synced.remote, remote)
  assert.ok(synced.commitsCreated >= 1)
  assert.ok(commitLog(remote).length >= 1)
})

test('mirror deploy key is stored ciphertext-only at rest and decrypts back to the original key', async (t) => {
  const server = await startD1ApiServer(t)
  const { root, options } = await makeD1Workspace(t, server, 'mirror-deploy-key')
  const remote = await makeBareRemote(root, 'origin')
  const deployKeyPlaintext = '-----BEGIN OPENSSH PRIVATE KEY-----\nsupersecretdeploykeymaterial\n-----END OPENSSH PRIVATE KEY-----\n'
  const deployKeyPath = path.join(root, 'deploy_key')
  await fs.writeFile(deployKeyPath, deployKeyPlaintext, 'utf8')

  const encryptionKey = { 'client-encryption-key': `base64:${Buffer.alloc(32, 7).toString('base64')}` }

  await runMirrorSetRemote({ ...options, ...encryptionKey, remote, 'deploy-key': deployKeyPath })

  const row = server.db.prepare('select * from codebase_settings where codebase_id = ?').get('hopit-core')
  assert.ok(row.mirror_deploy_key_ciphertext, 'ciphertext column populated')
  assert.ok(row.mirror_deploy_key_metadata, 'metadata column populated')
  const ciphertextBuffer = Buffer.from(row.mirror_deploy_key_ciphertext, 'base64')
  assert.equal(
    ciphertextBuffer.toString('latin1').includes('supersecretdeploykeymaterial'),
    false,
    'plaintext must never appear in the stored ciphertext',
  )
  assert.equal(row.mirror_deploy_key_metadata.includes('supersecretdeploykeymaterial'), false)

  const settings = {
    codebaseId: 'hopit-core',
    mirrorDeployKeyCiphertext: row.mirror_deploy_key_ciphertext,
    mirrorDeployKeyMetadata: JSON.parse(row.mirror_deploy_key_metadata),
  }
  const decrypted = decryptMirrorDeployKey(settings, encryptionKey)
  assert.equal(decrypted, deployKeyPlaintext)

  // Without the client encryption key, decrypting must fail loudly rather
  // than silently returning garbage.
  assert.throws(() => decryptMirrorDeployKey(settings, {}), /client_encryption_key_missing/)
})

test('setting a mirror deploy key without a client encryption key is rejected (never stores plaintext)', async (t) => {
  const server = await startD1ApiServer(t)
  const { root, options } = await makeD1Workspace(t, server, 'mirror-deploy-key-rejected')
  const remote = await makeBareRemote(root, 'origin')
  const deployKeyPath = path.join(root, 'deploy_key')
  await fs.writeFile(deployKeyPath, 'plaintext-key-material', 'utf8')

  await assert.rejects(
    () => runMirrorSetRemote({ ...options, remote, 'deploy-key': deployKeyPath }),
    /client encryption key/i,
  )

  const row = server.db.prepare('select * from codebase_settings where codebase_id = ?').get('hopit-core')
  assert.equal(row, undefined, 'no settings row should exist after a rejected deploy-key set')
})

test('merging a change set enqueues a mirror action_job, which a runner claims and advances the mirror', async (t) => {
  const server = await startD1ApiServer(t)
  const { root, options } = await makeD1Workspace(t, server, 'mirror-merge-advance')
  const remote = await makeBareRemote(root, 'origin')

  await runMirrorSetRemote({ ...options, remote })

  await editAndSync(options, 'README.md', '\nMirror automation change.\n')
  await openChangeSetReview({ ...options, 'requester-id': 'user_demo_owner' })
  await mergeChangeSet({ ...options, 'requester-id': 'user_demo_owner' })

  const cloudAfterMerge = JSON.parse(JSON.stringify(await readMainD1Graph(options)))
  assert.equal(cloudAfterMerge.selectedState.mergeState, 'merged')

  const queuedRows = server.db.prepare(`select * from action_jobs where codebase_id = ? and kind = 'mirror'`).all('hopit-core')
  assert.equal(queuedRows.length, 1, 'exactly one mirror job is enqueued per merge')
  assert.equal(queuedRows[0].status, 'queued')

  // Simulate the hosted runner: claim the job, run `mirror-sync` (exactly
  // what `packages/actions-runner/src/runner.js` invokes for kind 'mirror'),
  // then report completion.
  const backend = backendFor(options)
  const claimed = await backend.claimNextActionJob({ runnerId: 'runner-test' })
  assert.equal(claimed.kind, 'mirror')
  assert.equal(claimed.codebaseId, 'hopit-core')

  const syncResult = await runMirrorSync({ ...options })
  assert.equal(syncResult.ok, true)
  assert.ok(syncResult.commitsCreated >= 1, 'one job cycle is enough to advance the mirror (mirror lag = one job cycle)')

  await backend.completeActionJob({
    jobId: claimed.jobId,
    runnerId: 'runner-test',
    status: 'succeeded',
    exitCode: 0,
    stdout: JSON.stringify(syncResult),
    stderr: '',
  })

  const finishedRows = server.db.prepare(`select * from action_jobs where job_id = ?`).all(claimed.jobId)
  assert.equal(finishedRows[0].status, 'succeeded')
  assert.ok(commitLog(remote).length >= 1, 'the bare remote advanced')

  const mirroredReadme = runGitOrThrow(['show', 'main:README.md'], remote).stdout
  assert.match(mirroredReadme, /Mirror automation change\./)
})

test('a mirror failure notifies without blocking or unwinding the merge', async (t) => {
  const server = await startD1ApiServer(t)
  const { root, options } = await makeD1Workspace(t, server, 'mirror-merge-failure')

  // A path that is not a git repository at all: mirror-sync will fail at
  // push time, which is exactly the failure this test wants to trigger.
  const brokenRemote = path.join(root, 'not-a-repo')
  await fs.mkdir(brokenRemote, { recursive: true })
  await runMirrorSetRemote({ ...options, remote: brokenRemote })

  await editAndSync(options, 'README.md', '\nBroken mirror change.\n')
  await openChangeSetReview({ ...options, 'requester-id': 'user_demo_owner' })
  await mergeChangeSet({ ...options, 'requester-id': 'user_demo_owner' })

  const cloudAfterMerge = await readMainD1Graph(options)
  assert.equal(cloudAfterMerge.selectedState.mergeState, 'merged')

  const backend = backendFor(options)
  const claimed = await backend.claimNextActionJob({ runnerId: 'runner-test' })
  assert.equal(claimed.kind, 'mirror')

  let failureMessage = null
  await assert.rejects(async () => {
    try {
      await runMirrorSync({ ...options })
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : String(error)
      throw error
    }
  })
  assert.ok(failureMessage)

  await backend.completeActionJob({
    jobId: claimed.jobId,
    runnerId: 'runner-test',
    status: 'failed',
    exitCode: 1,
    stdout: '',
    stderr: failureMessage,
  })

  const notifications = server.db.prepare(`select * from notifications where codebase_id = ? and kind = 'mirror.failed'`).all('hopit-core')
  assert.equal(notifications.length, 1)
  assert.match(notifications[0].body, /failed|error/i)

  // Main/merge state is exactly what it was right after the (already
  // successful) merge -- the mirror failure did not touch it.
  const cloudAfterFailure = await readMainD1Graph(options)
  assert.deepEqual(cloudAfterFailure.main, cloudAfterMerge.main)
  assert.equal(cloudAfterFailure.selectedState.mergeState, 'merged')
})

async function readMainD1Graph(options) {
  const backend = backendFor(options)
  return backend.readGraph(options['codebase-id'])
}

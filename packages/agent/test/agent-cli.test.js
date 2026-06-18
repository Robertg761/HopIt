import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(repoRoot, 'packages/agent/src/cli.js')

async function makeState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-agent-test-'))

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
  return execFileAsync(process.execPath, [cliPath, command, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

async function runCliFailure(command, args = []) {
  try {
    await runCli(command, args)
  } catch (error) {
    return error
  }

  throw new Error(`Expected ${command} to fail.`)
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

async function readNdjson(filePath) {
  const content = await fs.readFile(filePath, 'utf8')
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex')
}

async function appendJournalEntry(state, entry) {
  await fs.appendFile(state.journal, `${JSON.stringify(entry)}\n`, 'utf8')
}

test('CLI classifies .private files as owner-private while snapshotting and syncing them', async () => {
  const state = await makeState()

  const init = await runCli('init', [...stateArgs(state), '--force'])
  assert.match(init.stdout, /cloud\.initialized/)
  assert.match(init.stdout, /"scopeCounts":\{"shared":3,"private":1\}/)

  const initialCloud = await readJson(state.cloud)
  assert.equal(initialCloud.files['.private/agent-note.md'].scope, 'owner-private')
  assert.equal(Object.keys(initialCloud.files).length, 4)

  await runCli('hydrate', stateArgs(state))

  const privateNotePath = path.join(state.workspace, '.private/agent-note.md')
  const privateNote = await fs.readFile(privateNotePath, 'utf8')
  assert.match(privateNote, /owner-private scope metadata/)

  await fs.appendFile(path.join(state.workspace, 'README.md'), '\nShared local edit.\n', 'utf8')
  await fs.appendFile(privateNotePath, '\nPrivate local edit.\n', 'utf8')
  await fs.writeFile(path.join(state.workspace, '.private/local-secret.txt'), 'private but synced\n', 'utf8')

  const sync = await runCli('sync-once', stateArgs(state))
  assert.match(sync.stdout, /sync\.complete/)
  assert.match(sync.stdout, /"journaledScopeCounts":\{"shared":1,"private":2\}/)

  const syncedCloud = await readJson(state.cloud)
  assert.equal(syncedCloud.files['README.md'].scope, 'shared')
  assert.equal(syncedCloud.files['.private/agent-note.md'].scope, 'owner-private')
  assert.equal(syncedCloud.files['.private/local-secret.txt'].scope, 'owner-private')
  assert.match(syncedCloud.files['.private/local-secret.txt'].content, /private but synced/)

  const statusResult = await runCli('status', stateArgs(state))
  const status = JSON.parse(statusResult.stdout)
  assert.deepEqual(status.cloud.scopeCounts, { shared: 3, private: 2 })
  assert.equal(status.cloud.fileCount, 5)
  assert.equal(status.journal.totalEntries, 3)
  assert.equal(status.journal.pendingCount, 0)
  assert.deepEqual(status.journal.scopeCounts, { shared: 1, private: 2 })
  assert.deepEqual(status.journal.pendingScopeCounts, { shared: 0, private: 0 })
  assert.equal(status.events.lastSync.detail.writes, 3)
  assert.deepEqual(status.events.lastSync.detail.scopeCounts, { shared: 3, private: 2 })
  assert.deepEqual(status.events.lastSync.detail.journaledScopeCounts, { shared: 1, private: 2 })

  const journal = await readNdjson(state.journal)
  assert.equal(journal.length, 3)
  assert.deepEqual(
    journal.map((entry) => [entry.path, entry.scope]).sort(),
    [
      ['.private/agent-note.md', 'owner-private'],
      ['.private/local-secret.txt', 'owner-private'],
      ['README.md', 'shared'],
    ],
  )
})

test('recover replays pending shared and owner-private journal entries after restart', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))

  const sharedContent = '# hopit-core\n\nRecovered shared edit.\n'
  const privateContent = '# Owner notes\n\nRecovered private edit.\n'
  const sharedPath = path.join(state.workspace, 'README.md')
  const privatePath = path.join(state.workspace, '.private/agent-note.md')

  await fs.writeFile(sharedPath, sharedContent, 'utf8')
  await fs.writeFile(privatePath, privateContent, 'utf8')

  const createdAt = new Date().toISOString()
  const sharedEntry = {
    id: randomUUID(),
    type: 'write',
    path: 'README.md',
    scope: 'shared',
    hash: hashContent(sharedContent),
    bytes: Buffer.byteLength(sharedContent),
    createdAt,
    status: 'pending',
  }
  const privateEntry = {
    id: randomUUID(),
    type: 'write',
    path: '.private/agent-note.md',
    scope: 'owner-private',
    hash: hashContent(privateContent),
    bytes: Buffer.byteLength(privateContent),
    createdAt,
    status: 'pending',
  }

  await appendJournalEntry(state, sharedEntry)
  await appendJournalEntry(state, privateEntry)

  const beforeStatus = JSON.parse((await runCli('status', stateArgs(state))).stdout)
  assert.equal(beforeStatus.journal.pendingCount, 2)
  assert.deepEqual(beforeStatus.journal.pendingScopeCounts, { shared: 1, private: 1 })
  assert.equal(beforeStatus.journal.acknowledgedCount, 0)

  const recovery = await runCli('recover', stateArgs(state))
  assert.match(recovery.stdout, /journal\.recovery_complete/)
  assert.match(recovery.stdout, /"attempted":2/)
  assert.match(recovery.stdout, /"acknowledged":2/)
  assert.match(recovery.stdout, /"failed":0/)

  const recoveredCloud = await readJson(state.cloud)
  assert.equal(recoveredCloud.files['README.md'].content, sharedContent)
  assert.equal(recoveredCloud.files['README.md'].scope, 'shared')
  assert.equal(recoveredCloud.files['.private/agent-note.md'].content, privateContent)
  assert.equal(recoveredCloud.files['.private/agent-note.md'].scope, 'owner-private')

  const afterStatus = JSON.parse((await runCli('status', stateArgs(state))).stdout)
  assert.equal(afterStatus.ok, true)
  assert.equal(afterStatus.journal.pendingCount, 0)
  assert.equal(afterStatus.journal.failedCount, 0)
  assert.equal(afterStatus.journal.acknowledgedCount, 2)
  assert.deepEqual(afterStatus.journal.acknowledgedScopeCounts, { shared: 1, private: 1 })
  assert.equal(afterStatus.events.lastRecovery.detail.attempted, 2)
  assert.equal(afterStatus.events.lastRecovery.detail.acknowledged, 2)
})

test('recover keeps unsafe pending entries failed and visible in status', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))

  await fs.writeFile(path.join(state.workspace, 'README.md'), 'local content does not match journal\n', 'utf8')

  const entry = {
    id: randomUUID(),
    type: 'write',
    path: 'README.md',
    scope: 'shared',
    hash: hashContent('different journaled content\n'),
    bytes: Buffer.byteLength('different journaled content\n'),
    createdAt: new Date().toISOString(),
    status: 'pending',
  }
  await appendJournalEntry(state, entry)

  const failure = await runCliFailure('recover', stateArgs(state))
  assert.equal(failure.code, 1)
  assert.match(failure.stdout, /journal\.recovery_failed/)
  assert.match(failure.stdout, /workspace_hash_mismatch/)
  assert.match(failure.stdout, /journal\.recovery_complete/)
  assert.match(failure.stdout, /"failed":1/)

  const status = JSON.parse((await runCli('status', stateArgs(state))).stdout)
  assert.equal(status.ok, false)
  assert.equal(status.journal.pendingCount, 0)
  assert.equal(status.journal.failedCount, 1)
  assert.equal(status.journal.acknowledgedCount, 0)
  assert.deepEqual(status.journal.failedScopeCounts, { shared: 1, private: 0 })
  assert.equal(status.events.lastRecovery.detail.failed, 1)
})

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { reconnectBucket } from '../src/reconnect.js'
import {
  buildsOnRefreshedContent,
  classifySaveAgainstRefresh,
  clearWriterLedgerPath,
  emptyWriterLedger,
  markLocalSaveWriter,
  markRefreshWriter,
  readWriterLedger,
  writeWriterLedger,
  writerLedgerPathFor,
} from '../src/save-clobber.js'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(repoRoot, 'packages/agent/src/cli.js')

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex')
}

// ---------------------------------------------------------------------------
// Unit-level classification tests (packages/agent/src/save-clobber.js)
// ---------------------------------------------------------------------------

test('classifySaveAgainstRefresh: no pending refresh for the path is an ordinary edit', () => {
  const ledger = emptyWriterLedger()
  const classification = classifySaveAgainstRefresh({
    ledger,
    relativePath: 'README.md',
    kind: 'file',
    newHash: hashContent('anything\n'),
    newContent: Buffer.from('anything\n'),
    refreshedContent: null,
  })
  assert.equal(classification.bucket, reconnectBucket.onlyLocal)
  assert.equal(classification.reason, 'no_pending_refresh')
})

test('classifySaveAgainstRefresh: save identical to the refreshed content auto-resolves', () => {
  const ledger = emptyWriterLedger()
  const refreshed = 'Main moved this file.\n'
  markRefreshWriter(ledger, 'README.md', { hash: hashContent(refreshed), revision: 7 })

  const classification = classifySaveAgainstRefresh({
    ledger,
    relativePath: 'README.md',
    kind: 'file',
    newHash: hashContent(refreshed),
    newContent: Buffer.from(refreshed),
    refreshedContent: Buffer.from(refreshed),
  })
  assert.equal(classification.bucket, reconnectBucket.autoResolved)
  assert.equal(classification.reason, 'identical_content')
})

test('classifySaveAgainstRefresh: a save that builds on (contains) the refreshed content is a clean edit', () => {
  const ledger = emptyWriterLedger()
  const refreshed = 'line from Main\n'
  markRefreshWriter(ledger, 'notes.md', { hash: hashContent(refreshed), revision: 4 })

  const newContent = `${refreshed}my addition on top\n`
  const classification = classifySaveAgainstRefresh({
    ledger,
    relativePath: 'notes.md',
    kind: 'file',
    newHash: hashContent(newContent),
    newContent: Buffer.from(newContent),
    refreshedContent: Buffer.from(refreshed),
  })
  assert.equal(classification.bucket, reconnectBucket.autoResolved)
  assert.equal(classification.reason, 'builds_on_refreshed_content')
})

test('classifySaveAgainstRefresh: a save that neither matches nor builds on the refresh is a divergence', () => {
  const ledger = emptyWriterLedger()
  const refreshed = 'Main moved this file forward.\n'
  markRefreshWriter(ledger, 'README.md', { hash: hashContent(refreshed), revision: 9 })

  const staleSave = 'Stale editor buffer, unrelated to the refresh.\n'
  const classification = classifySaveAgainstRefresh({
    ledger,
    relativePath: 'README.md',
    kind: 'file',
    newHash: hashContent(staleSave),
    newContent: Buffer.from(staleSave),
    refreshedContent: Buffer.from(refreshed),
  })
  assert.equal(classification.bucket, reconnectBucket.diverged)
  assert.equal(classification.reason, 'content_differs')
})

test('buildsOnRefreshedContent: an empty refresh is trivially built upon, binary content never is', () => {
  assert.equal(buildsOnRefreshedContent(Buffer.from('anything'), Buffer.from('')), true)
  const binary = Buffer.from([0, 1, 2, 3, 255])
  assert.equal(buildsOnRefreshedContent(binary, binary), false)
})

test('writer ledger: markRefreshWriter/markLocalSaveWriter/clearWriterLedgerPath round-trip through disk', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-writer-ledger-'))
  t.after(async () => fs.rm(root, { recursive: true, force: true }))
  const options = { journal: path.join(root, 'journal.ndjson') }

  const empty = await readWriterLedger(options)
  assert.deepEqual(empty.paths, {})

  const ledger = emptyWriterLedger()
  markRefreshWriter(ledger, 'a.txt', { hash: 'hash-a', revision: 1 })
  await writeWriterLedger(options, ledger)

  const reloaded = await readWriterLedger(options)
  assert.equal(reloaded.paths['a.txt'].pendingRefresh.hash, 'hash-a')

  markLocalSaveWriter(reloaded, 'a.txt', { revision: 2 })
  assert.equal(reloaded.paths['a.txt'].pendingRefresh, null)
  assert.equal(reloaded.paths['a.txt'].lastLocalSaveRevision, 2)
  await writeWriterLedger(options, reloaded)

  const afterSave = await readWriterLedger(options)
  assert.equal(afterSave.paths['a.txt'].pendingRefresh, null)

  clearWriterLedgerPath(afterSave, 'a.txt')
  assert.equal('a.txt' in afterSave.paths, false)

  assert.equal(writerLedgerPathFor(options), path.join(root, 'journal.writer-ledger.json'))
})

// ---------------------------------------------------------------------------
// End-to-end wiring through `hop refresh` / `hop sync-once`
// (packages/agent/src/commands/sync.js)
// ---------------------------------------------------------------------------

async function makeTwoDeviceState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-save-clobber-test-'))
  const cloud = path.join(root, 'cloud.json')
  function makeDevice(name) {
    return {
      root,
      cloud,
      workspace: path.join(root, `${name}-workspace`),
      journal: path.join(root, `${name}-journal.ndjson`),
      events: path.join(root, `${name}-events.ndjson`),
    }
  }
  return { root, cloud, deviceA: makeDevice('device-a'), deviceB: makeDevice('device-b') }
}

function stateArgs(state) {
  return ['--cloud', state.cloud, '--workspace', state.workspace, '--journal', state.journal, '--events', state.events, '--json']
}

async function runCli(command, args = []) {
  return execFileAsync(process.execPath, [cliPath, command, ...args], { cwd: repoRoot, encoding: 'utf8' })
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

test('save-side clobber: a stale-buffer save that ignores a refresh opens a divergence and never clobbers Main', async () => {
  const { deviceA, deviceB } = await makeTwoDeviceState()
  await runCli('init', [...stateArgs(deviceA), '--force'])
  await runCli('hydrate', stateArgs(deviceA))
  await runCli('hydrate', stateArgs(deviceB))

  const mainUpdate = '# hopit-core\n\nMain moved this file forward while device B was away.\n'
  await fs.writeFile(path.join(deviceA.workspace, 'README.md'), mainUpdate, 'utf8')
  await runCli('sync-once', stateArgs(deviceA))

  const afterMainUpdate = await readJson(deviceA.cloud)
  assert.equal(afterMainUpdate.files['README.md'].content, mainUpdate)

  // Device B refreshes: README.md is remote-refreshed to Main's content on
  // disk, and the writer ledger now has a pending refresh for that path.
  await runCli('refresh', stateArgs(deviceB))
  assert.equal(await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8'), mainUpdate)

  // A stale editor buffer (never saw the refresh) is saved back over it.
  const staleBufferSave = '# hopit-core\n\nDevice B stale buffer, oblivious to the refresh.\n'
  await fs.writeFile(path.join(deviceB.workspace, 'README.md'), staleBufferSave, 'utf8')

  const syncResult = await runCli('sync-once', stateArgs(deviceB))
  assert.match(syncResult.stdout, /sync\.save_clobber_diverged/)
  assert.match(syncResult.stdout, /"path":\s*"README\.md"/)
  assert.match(syncResult.stdout, /"saveClobberDiverged":\s*1/)

  // Main's content is still exactly what device A committed: never silently
  // reverted or overwritten by device B's stale save.
  const afterClobberAttempt = await readJson(deviceA.cloud)
  assert.equal(afterClobberAttempt.files['README.md'].content, mainUpdate)

  // Device B's own disk bytes are untouched (no silent revert of the local
  // save either) -- the divergence is flagged, not resolved automatically.
  assert.equal(await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8'), staleBufferSave)

  const status = JSON.parse((await runCli('status', stateArgs(deviceB))).stdout)
  assert.ok(status, 'status command should still succeed after a save-side divergence')
})

test('save-side clobber: a save that builds on the refreshed content is a clean edit (no false positive)', async () => {
  const { deviceA, deviceB } = await makeTwoDeviceState()
  await runCli('init', [...stateArgs(deviceA), '--force'])
  await runCli('hydrate', stateArgs(deviceA))
  await runCli('hydrate', stateArgs(deviceB))

  const mainUpdate = '# hopit-core\n\nMain moved this file forward.\n'
  await fs.writeFile(path.join(deviceA.workspace, 'README.md'), mainUpdate, 'utf8')
  await runCli('sync-once', stateArgs(deviceA))

  await runCli('refresh', stateArgs(deviceB))

  // Device B's editor picked up the refresh (its buffer now contains the
  // refreshed content) and appended to it before saving.
  const cleanEdit = `${mainUpdate}Device B addition on top of the refresh.\n`
  await fs.writeFile(path.join(deviceB.workspace, 'README.md'), cleanEdit, 'utf8')

  const syncResult = await runCli('sync-once', stateArgs(deviceB))
  assert.doesNotMatch(syncResult.stdout, /sync\.save_clobber_diverged/)
  assert.match(syncResult.stdout, /"writes":\s*1/)

  const afterCleanEdit = await readJson(deviceA.cloud)
  assert.equal(afterCleanEdit.files['README.md'].content, cleanEdit)
})

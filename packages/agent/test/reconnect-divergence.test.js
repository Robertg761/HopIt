import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  classifyReconnectEntries,
  classifyReconnectEntry,
  partitionEntriesForReconnect,
  reconnectBucket,
  sortEntriesByCausality,
} from '../src/reconnect.js'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(repoRoot, 'packages/agent/src/cli.js')

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex')
}

function makeCloudFile(content, revision) {
  return {
    kind: 'file',
    content,
    encoding: 'utf8',
    hash: hashContent(content),
    size: Buffer.byteLength(content),
    scope: 'shared',
    revision,
  }
}

function makeEntry(overrides = {}) {
  return {
    id: randomUUID(),
    type: 'write',
    path: 'README.md',
    scope: 'shared',
    kind: 'file',
    createdAt: new Date().toISOString(),
    status: 'pending',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Unit-level classification tests (packages/agent/src/reconnect.js)
// ---------------------------------------------------------------------------

test('reconnect classification: only-local-touched replays cleanly when baseRevision matches the cloud head', () => {
  const cloud = { files: { 'README.md': makeCloudFile('original\n', 5) } }
  const entry = makeEntry({ baseRevision: 5, hash: hashContent('edited locally\n') })
  const classification = classifyReconnectEntry(cloud, entry)
  assert.equal(classification.bucket, reconnectBucket.onlyLocal)
  assert.equal(classification.reason, 'only_local_touched')
})

test('reconnect classification: entries without a recorded baseRevision fall back to only-local (legacy journals stay byte-identical)', () => {
  const cloud = { files: { 'README.md': makeCloudFile('something else entirely\n', 9) } }
  const entry = makeEntry({ hash: hashContent('edited locally\n') })
  assert.equal(Object.hasOwn(entry, 'baseRevision'), false)
  const classification = classifyReconnectEntry(cloud, entry)
  assert.equal(classification.bucket, reconnectBucket.onlyLocal)
  assert.equal(classification.baseRevision, null)
})

test('reconnect classification: both devices wrote identical content auto-resolves without divergence', () => {
  const sharedContent = 'same content on both devices\n'
  const cloud = { files: { 'README.md': makeCloudFile(sharedContent, 7) } }
  const entry = makeEntry({ baseRevision: 6, hash: hashContent(sharedContent) })
  const classification = classifyReconnectEntry(cloud, entry)
  assert.equal(classification.bucket, reconnectBucket.autoResolved)
  assert.equal(classification.reason, 'identical_content')
})

test('reconnect classification: both devices wrote differing content is a real divergence', () => {
  const cloud = { files: { 'README.md': makeCloudFile('cloud winner\n', 7) } }
  const entry = makeEntry({ baseRevision: 6, hash: hashContent('local draft\n') })
  const classification = classifyReconnectEntry(cloud, entry)
  assert.equal(classification.bucket, reconnectBucket.diverged)
  assert.equal(classification.reason, 'content_differs')
  assert.equal(classification.cloudHash, hashContent('cloud winner\n'))
  assert.equal(classification.localHash, hashContent('local draft\n'))
})

test('reconnect classification: delete-on-one-device vs edit-on-another is a divergence with "deleted" as one side', () => {
  const cloud = { files: { 'README.md': makeCloudFile('edited elsewhere\n', 7) } }
  const entry = makeEntry({ type: 'delete', baseRevision: 6, hash: undefined })
  const classification = classifyReconnectEntry(cloud, entry)
  assert.equal(classification.bucket, reconnectBucket.diverged)
  assert.equal(classification.reason, 'delete_vs_edit')
  assert.equal(classification.localSide, 'deleted')
})

test('reconnect classification: edit-on-one-device vs delete-on-another is a divergence with "deleted" as the cloud side', () => {
  const cloud = { files: {} }
  const entry = makeEntry({ baseRevision: 6, hash: hashContent('kept editing locally\n') })
  const classification = classifyReconnectEntry(cloud, entry)
  assert.equal(classification.bucket, reconnectBucket.diverged)
  assert.equal(classification.reason, 'edit_vs_delete')
  assert.equal(classification.cloudSide, 'deleted')
})

test('reconnect classification: both devices deleted the same path auto-resolves', () => {
  const cloud = { files: {} }
  const entry = makeEntry({ type: 'delete', baseRevision: 6 })
  const classification = classifyReconnectEntry(cloud, entry)
  assert.equal(classification.bucket, reconnectBucket.autoResolved)
  assert.equal(classification.reason, 'both_deleted')
})

test('reconnect classification: a mixed batch sorts each path into its correct bucket', () => {
  const cloud = {
    files: {
      'only-local.md': makeCloudFile('unchanged\n', 3),
      'auto-resolve.md': makeCloudFile('same\n', 4),
      'diverged.md': makeCloudFile('cloud side\n', 5),
      'delete-vs-edit.md': makeCloudFile('still here\n', 2),
    },
  }
  const entries = [
    makeEntry({ path: 'only-local.md', baseRevision: 3, hash: hashContent('local edit\n') }),
    makeEntry({ path: 'auto-resolve.md', baseRevision: 3, hash: hashContent('same\n') }),
    makeEntry({ path: 'diverged.md', baseRevision: 4, hash: hashContent('local side\n') }),
    makeEntry({ path: 'delete-vs-edit.md', type: 'delete', baseRevision: 1 }),
    makeEntry({ path: 'brand-new.md', type: 'create', hash: hashContent('new file\n') }),
  ]

  const { buckets } = classifyReconnectEntries(cloud, entries)
  assert.deepEqual(buckets[reconnectBucket.onlyLocal].map((c) => c.path).sort(), ['brand-new.md', 'only-local.md'])
  assert.deepEqual(buckets[reconnectBucket.autoResolved].map((c) => c.path), ['auto-resolve.md'])
  assert.deepEqual(buckets[reconnectBucket.diverged].map((c) => c.path).sort(), ['delete-vs-edit.md', 'diverged.md'])
})

test('reconnect classification: ordering follows causality (baseRevision), never wall-clock time', () => {
  const entries = [
    makeEntry({ path: 'c.md', baseRevision: 2, createdAt: '2020-01-01T00:00:00Z' }),
    makeEntry({ path: 'a.md', baseRevision: 0, createdAt: '2099-01-01T00:00:00Z' }),
    makeEntry({ path: 'b.md', baseRevision: 1, createdAt: '2010-01-01T00:00:00Z' }),
  ]
  const ordered = sortEntriesByCausality(entries)
  assert.deepEqual(ordered.map((entry) => entry.path), ['a.md', 'b.md', 'c.md'])
})

test('reconnect classification: a reconnecting device with its clock set years off classifies identically to one with a correct clock', () => {
  const cloud = { files: { 'README.md': makeCloudFile('cloud winner\n', 7) } }
  const skewedEntry = makeEntry({
    baseRevision: 6,
    hash: hashContent('local draft\n'),
    createdAt: '1999-01-01T00:00:00Z',
  })
  const normalEntry = makeEntry({
    baseRevision: 6,
    hash: hashContent('local draft\n'),
    createdAt: new Date().toISOString(),
  })
  const skewed = classifyReconnectEntry(cloud, skewedEntry)
  const normal = classifyReconnectEntry(cloud, normalEntry)
  assert.equal(skewed.bucket, normal.bucket)
  assert.equal(skewed.bucket, reconnectBucket.diverged)
})

test('reconnect classification: every entry for a diverged path is excluded from replay, not just the last one', () => {
  const cloud = {
    files: {
      'README.md': makeCloudFile('cloud winner\n', 7),
      'notes.md': makeCloudFile('untouched\n', 1),
    },
  }
  const earlierEntry = makeEntry({ id: 'earlier', baseRevision: 5, hash: hashContent('first local draft\n') })
  const laterEntry = makeEntry({ id: 'later', baseRevision: 6, hash: hashContent('second local draft\n') })
  const untouchedEntry = makeEntry({ id: 'other', path: 'notes.md', baseRevision: 1, hash: hashContent('fine\n') })

  const { replayable, diverged } = partitionEntriesForReconnect(cloud, [earlierEntry, laterEntry, untouchedEntry])
  assert.deepEqual(replayable.map((entry) => entry.id), ['other'])
  assert.equal(diverged.length, 1)
  assert.equal(diverged[0].path, 'README.md')
})

test('reconnect classification: a 1,000-file journal with 3 divergent files classifies in under 5 seconds', () => {
  const files = {}
  const entries = []
  for (let index = 0; index < 1000; index += 1) {
    const relativePath = `file-${index}.md`
    files[relativePath] = makeCloudFile(`cloud content ${index}\n`, index)
    const diverge = index === 10 || index === 500 || index === 999
    entries.push(
      makeEntry({
        path: relativePath,
        baseRevision: diverge ? index - 1 : index,
        hash: diverge ? hashContent(`diverging local content ${index}\n`) : hashContent(`cloud content ${index}\n`),
      }),
    )
  }
  const cloud = { files }

  const startedAt = Date.now()
  const { buckets } = classifyReconnectEntries(cloud, entries)
  const elapsedMs = Date.now() - startedAt

  assert.equal(buckets[reconnectBucket.diverged].length, 3)
  assert.equal(buckets[reconnectBucket.onlyLocal].length, 997)
  assert.ok(elapsedMs < 5000, `classification took ${elapsedMs}ms, expected under 5000ms`)
})

// ---------------------------------------------------------------------------
// End-to-end wiring through `hop recover` (packages/agent/src/commands/sync.js)
// ---------------------------------------------------------------------------

async function makeState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-reconnect-test-'))
  return {
    root,
    cloud: path.join(root, 'cloud.json'),
    workspace: path.join(root, 'workspace'),
    journal: path.join(root, 'journal.ndjson'),
    events: path.join(root, 'events.ndjson'),
  }
}

async function makeTwoSessionState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-reconnect-two-device-test-'))
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
  return ['--cloud', state.cloud, '--workspace', state.workspace, '--journal', state.journal, '--events', state.events]
}

async function runCli(command, args = []) {
  return execFileAsync(process.execPath, [cliPath, command, ...args], { cwd: repoRoot, encoding: 'utf8' })
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

async function appendJournalEntry(state, entry) {
  await fs.appendFile(state.journal, `${JSON.stringify(entry)}\n`, 'utf8')
}

test('recover: a clean two-entry journal with no divergence replays byte-identically to the pre-classification result shape', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))

  const sharedContent = '# hopit-core\n\nRegression fixture edit.\n'
  await fs.writeFile(path.join(state.workspace, 'README.md'), sharedContent, 'utf8')
  await appendJournalEntry(state, {
    id: randomUUID(),
    type: 'write',
    path: 'README.md',
    scope: 'shared',
    hash: hashContent(sharedContent),
    bytes: Buffer.byteLength(sharedContent),
    createdAt: new Date().toISOString(),
    status: 'pending',
  })

  const recovery = await runCli('recover', stateArgs(state))
  assert.match(recovery.stdout, /journal\.recovery_complete/)
  assert.match(recovery.stdout, /"attempted":1/)
  assert.match(recovery.stdout, /"acknowledged":1/)
  assert.match(recovery.stdout, /"failed":0/)
  assert.match(recovery.stdout, /"diverged":0/)
  assert.doesNotMatch(recovery.stdout, /journal\.reconnect_diverged/)

  const cloud = await readJson(state.cloud)
  assert.equal(cloud.files['README.md'].content, sharedContent)
})

test('recover: identical content written on both devices auto-resolves without a divergence', async () => {
  const { deviceA, deviceB } = await makeTwoSessionState()
  await runCli('init', [...stateArgs(deviceA), '--force'])
  await runCli('hydrate', stateArgs(deviceA))
  await runCli('hydrate', stateArgs(deviceB))

  const initialCloud = await readJson(deviceA.cloud)
  const sameContent = '# hopit-core\n\nBoth devices wrote this exact text.\n'
  await fs.writeFile(path.join(deviceA.workspace, 'README.md'), sameContent, 'utf8')
  await runCli('sync-once', stateArgs(deviceA))

  await fs.writeFile(path.join(deviceB.workspace, 'README.md'), sameContent, 'utf8')
  await appendJournalEntry(deviceB, {
    id: randomUUID(),
    type: 'write',
    path: 'README.md',
    scope: 'shared',
    hash: hashContent(sameContent),
    bytes: Buffer.byteLength(sameContent),
    baseRevision: initialCloud.files['README.md'].revision,
    createdAt: new Date().toISOString(),
    status: 'pending',
  })

  const recovery = await runCli('recover', stateArgs(deviceB))
  assert.match(recovery.stdout, /"diverged":0/)
  assert.doesNotMatch(recovery.stdout, /journal\.reconnect_diverged/)

  const status = JSON.parse((await runCli('status', stateArgs(deviceB))).stdout)
  assert.equal(status.journal.pendingCount, 0)
  assert.equal(status.journal.failedCount, 0)
})

test('recover: a mixed batch replays the clean path and defers only the diverged one', async () => {
  const { deviceA, deviceB } = await makeTwoSessionState()
  await runCli('init', [...stateArgs(deviceA), '--force'])
  await runCli('hydrate', stateArgs(deviceA))
  await runCli('hydrate', stateArgs(deviceB))

  const initialCloud = await readJson(deviceA.cloud)
  await fs.writeFile(path.join(deviceA.workspace, 'README.md'), '# hopit-core\n\nDevice A cloud winner.\n', 'utf8')
  await runCli('sync-once', stateArgs(deviceA))

  const deviceBReadme = '# hopit-core\n\nDevice B diverging draft.\n'
  await fs.writeFile(path.join(deviceB.workspace, 'README.md'), deviceBReadme, 'utf8')
  await appendJournalEntry(deviceB, {
    id: randomUUID(),
    type: 'write',
    path: 'README.md',
    scope: 'shared',
    hash: hashContent(deviceBReadme),
    bytes: Buffer.byteLength(deviceBReadme),
    baseRevision: initialCloud.files['README.md'].revision,
    createdAt: new Date().toISOString(),
    status: 'pending',
  })

  const cleanContent = 'A brand new note only device B ever touched.\n'
  await fs.writeFile(path.join(deviceB.workspace, 'DEVICE-B-NOTES.md'), cleanContent, 'utf8')
  await appendJournalEntry(deviceB, {
    id: randomUUID(),
    type: 'create',
    path: 'DEVICE-B-NOTES.md',
    scope: 'shared',
    hash: hashContent(cleanContent),
    bytes: Buffer.byteLength(cleanContent),
    createdAt: new Date().toISOString(),
    status: 'pending',
  })

  const recovery = await runCli('recover', stateArgs(deviceB))
  assert.match(recovery.stdout, /"attempted":1/)
  assert.match(recovery.stdout, /"acknowledged":1/)
  assert.match(recovery.stdout, /"diverged":1/)
  assert.match(recovery.stdout, /journal\.reconnect_diverged/)

  const cloud = await readJson(deviceB.cloud)
  assert.equal(cloud.files['DEVICE-B-NOTES.md'].content, cleanContent)
  assert.equal(cloud.files['README.md'].content, '# hopit-core\n\nDevice A cloud winner.\n')
  assert.equal(await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8'), deviceBReadme)

  const status = JSON.parse((await runCli('status', stateArgs(deviceB))).stdout)
  assert.equal(status.journal.pendingCount, 1)
  assert.equal(status.journal.failedCount, 0)
})

test('recover: an offline delete against a file another device edited surfaces as a divergence, not a silent restore', async () => {
  const { deviceA, deviceB } = await makeTwoSessionState()
  await runCli('init', [...stateArgs(deviceA), '--force'])
  await runCli('hydrate', stateArgs(deviceA))
  await runCli('hydrate', stateArgs(deviceB))

  const initialCloud = await readJson(deviceA.cloud)
  await fs.writeFile(path.join(deviceA.workspace, 'README.md'), '# hopit-core\n\nDevice A kept editing.\n', 'utf8')
  await runCli('sync-once', stateArgs(deviceA))

  await fs.rm(path.join(deviceB.workspace, 'README.md'))
  await appendJournalEntry(deviceB, {
    id: randomUUID(),
    type: 'delete',
    path: 'README.md',
    scope: 'shared',
    baseRevision: initialCloud.files['README.md'].revision,
    createdAt: new Date().toISOString(),
    status: 'pending',
  })

  const recovery = await runCli('recover', stateArgs(deviceB))
  assert.match(recovery.stdout, /"diverged":1/)
  assert.match(recovery.stdout, /journal\.reconnect_diverged/)
  assert.match(recovery.stdout, /"reason":"delete_vs_edit"/)

  // The delete must not be silently dropped or silently replayed: device B's
  // workspace stays deleted (never clobbered back from cloud) and device A's
  // edit stays on the cloud (never wiped by the offline delete).
  await assert.rejects(fs.access(path.join(deviceB.workspace, 'README.md')))
  const cloud = await readJson(deviceB.cloud)
  assert.equal(cloud.files['README.md'].content, '# hopit-core\n\nDevice A kept editing.\n')
})

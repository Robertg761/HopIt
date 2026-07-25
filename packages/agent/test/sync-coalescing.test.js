import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { bulkJournalCommitChunkSize } from '../src/constants.js'
import { parseOptions } from '../src/options.js'
import { createWatchSyncScheduler } from '../src/watch.js'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(repoRoot, 'packages/agent/src/cli.js')

async function makeState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-sync-coalescing-'))
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
    '--cloud', state.cloud,
    '--workspace', state.workspace,
    '--journal', state.journal,
    '--events', state.events,
  ]
}

async function runCli(command, args = []) {
  return execFileAsync(process.execPath, [cliPath, command, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

// This poller reads the journal while the sync scheduler is still appending
// to it, so the file's last line can be a half-written record (an append is
// not atomic). Every *complete* line is valid JSON; only the trailing
// fragment can be torn, so parse it defensively and let the caller's
// `waitFor` re-read once the append lands. Dropping it weakens nothing --
// the assertions are all "eventually N entries", never "at most N".
async function readNdjson(filePath) {
  try {
    const lines = (await fs.readFile(filePath, 'utf8')).split('\n')
    const trailing = lines.pop()
    const rows = lines.filter(Boolean).map((line) => JSON.parse(line))
    if (trailing) {
      try {
        rows.push(JSON.parse(trailing))
      } catch {
        // Torn trailing append; the next poll sees the complete line.
      }
    }
    return rows
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs = 4000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const result = await predicate()
    if (result) return result
    await sleep(10)
  }
  throw new Error(`Timed out after ${timeoutMs}ms.`)
}

// A burst of rapid saves to the SAME path collapses into one journaled sync that
// carries the final content: one cloud revision instead of one per keystroke.
test('same-path save burst coalesces into one cloud revision with the final content', async (t) => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))
  const before = await readJson(state.cloud)

  const options = parseOptions([...stateArgs(state), '--sync-debounce-ms', '60', '--sync-max-delay-ms', '2000'])
  const schedule = createWatchSyncScheduler(options, {})
  t.after(() => schedule.cancel())

  const target = path.join(state.workspace, 'README.md')
  for (let index = 0; index < 6; index += 1) {
    await fs.writeFile(target, `coalesced revision ${index}\n`, 'utf8')
    schedule('change', 'README.md')
    await sleep(12)
  }

  await waitFor(async () => (await readNdjson(state.events)).some((event) => event.event === 'sync.complete'))
  await waitFor(async () => schedule.isIdle())
  await sleep(120)

  const after = await readJson(state.cloud)
  assert.equal(after.files['README.md'].content, 'coalesced revision 5\n')
  assert.equal(after.revision, before.revision + 1, 'six same-path saves must produce exactly one revision bump')

  const events = await readNdjson(state.events)
  assert.equal(
    events.filter((event) => event.event === 'sync.complete').length,
    1,
    'the burst must produce a single sync pass',
  )
  const readmeAcks = events.filter(
    (event) => event.event === 'cloud.acknowledged' && event.detail?.path === 'README.md',
  )
  assert.equal(readmeAcks.length, 1, 'only the final content should be acknowledged once')

  const journal = await readNdjson(state.journal)
  assert.equal(
    journal.filter((entry) => entry.path === 'README.md').length,
    1,
    'only one journal entry is written for the coalesced burst',
  )
})

// Coalescing must never drop distinct files: a burst touching several paths within
// one window still commits every file in the single coalesced sync.
test('distinct-path save burst still commits every file in one coalesced sync', async (t) => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))
  const before = await readJson(state.cloud)

  const options = parseOptions([...stateArgs(state), '--sync-debounce-ms', '80', '--sync-max-delay-ms', '2000'])
  const schedule = createWatchSyncScheduler(options, {})
  t.after(() => schedule.cancel())

  const newPaths = ['coalesce-a.txt', 'coalesce-b.txt', 'coalesce-c.txt']
  for (const relativePath of newPaths) {
    await fs.writeFile(path.join(state.workspace, relativePath), `content for ${relativePath}\n`, 'utf8')
    schedule('rename', relativePath)
    await sleep(12)
  }

  await waitFor(async () => (await readNdjson(state.events)).some((event) => event.event === 'sync.complete'))
  await waitFor(async () => schedule.isIdle())
  await sleep(120)

  const after = await readJson(state.cloud)
  for (const relativePath of newPaths) {
    assert.equal(after.files[relativePath]?.content, `content for ${relativePath}\n`)
  }
  assert.equal(after.revision, before.revision + newPaths.length, 'all three files commit in one coalesced pass')

  const events = await readNdjson(state.events)
  assert.equal(
    events.filter((event) => event.event === 'sync.complete').length,
    1,
    'the distinct-path burst is still a single sync pass',
  )
  const acks = events.filter((event) => event.event === 'cloud.acknowledged')
  assert.equal(acks.length, newPaths.length, 'every distinct file is acknowledged')
  // The multi-file commit is batched into one guarded round trip (one head-row
  // write) rather than one per file.
  const bulkCommits = events.filter((event) => event.event === 'sync.bulk_commit')
  assert.equal(bulkCommits.length, 1, 'the coalesced multi-file sync commits as one batch')
  assert.equal(bulkCommits[0].detail.count, newPaths.length)
})

// The delay cap bounds how long a continuously-edited file is held: even when the
// quiet window never elapses (saves keep arriving), a flush is forced by the cap.
test('a continuously-saved file is never held past the delay cap', async (t) => {
  const debounceMs = 50
  const maxDelayMs = 120
  const syncTimes = []
  const schedule = createWatchSyncScheduler({}, {
    debounceMs,
    maxDelayMs,
    syncOnce: async () => {
      syncTimes.push(Date.now())
    },
  })
  t.after(() => schedule.cancel())

  const startedAt = Date.now()
  // Save faster than the debounce window so the quiet-window timer keeps resetting
  // and would, on its own, never fire.
  const interval = setInterval(() => schedule('change', 'always-editing.txt'), 20)
  t.after(() => clearInterval(interval))

  await waitFor(() => syncTimes.length >= 1, 1500)
  clearInterval(interval)

  const elapsed = syncTimes[0] - startedAt
  assert.ok(
    elapsed >= debounceMs,
    `flush at ${elapsed}ms proves the debounce window did not fire early`,
  )
  assert.ok(
    elapsed <= maxDelayMs + 80,
    `flush must happen by the cap (${maxDelayMs}ms), saw ${elapsed}ms`,
  )
})

// HOPIT_SYNC_DEBOUNCE_MS=0 disables coalescing and the delay cap, restoring the
// legacy micro-debounce: saves spaced apart each commit separately.
test('debounce=0 preserves the pre-coalescing behavior', async (t) => {
  let calls = 0
  const schedule = createWatchSyncScheduler({}, {
    debounceMs: 0,
    syncOnce: async () => {
      calls += 1
    },
  })
  t.after(() => schedule.cancel())

  schedule('change', 'legacy.txt')
  await waitFor(() => calls >= 1, 2000)
  // A gap longer than the legacy 250ms micro-debounce; with coalescing enabled
  // (default 2000ms window) these two saves would merge into one.
  await sleep(320)
  schedule('change', 'legacy.txt')
  await waitFor(() => calls >= 2, 2000)

  assert.equal(calls, 2, 'with coalescing disabled the two spaced saves stay two syncs')
  await waitFor(() => schedule.isIdle())
})

// Durability: a crash mid-window may only DELAY a change, never lose it. The
// unsynced edit stays on disk, is not journaled or committed during the window,
// and is journaled + committed by the next scan on restart.
test('a crash mid-window loses nothing on disk: the edit is journaled on the next scan', async (t) => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))

  // A long window so the flush is guaranteed not to fire before the simulated crash.
  const options = parseOptions([...stateArgs(state), '--sync-debounce-ms', '5000', '--sync-max-delay-ms', '5000'])
  const schedule = createWatchSyncScheduler(options, {})

  const crashPath = path.join(state.workspace, 'crash-note.txt')
  await fs.writeFile(crashPath, 'unsynced keystrokes\n', 'utf8')
  schedule('rename', 'crash-note.txt')
  await sleep(60)

  // Mid-window: nothing has been journaled or committed to the cloud yet.
  assert.equal((await readNdjson(state.journal)).length, 0, 'nothing is journaled during the window')
  const midCloud = await readJson(state.cloud)
  assert.equal(midCloud.files['crash-note.txt'], undefined, 'nothing is committed to the cloud during the window')

  // "Crash": the process dies, discarding the in-memory coalescing window.
  schedule.cancel()

  // Restart scan (what watch startup recovery + the first sync pass performs).
  await runCli('sync-once', stateArgs(state))

  const afterCloud = await readJson(state.cloud)
  assert.equal(
    afterCloud.files['crash-note.txt']?.content,
    'unsynced keystrokes\n',
    'the on-disk edit reaches the cloud after restart',
  )
  const journal = await readNdjson(state.journal)
  assert.ok(
    journal.some((entry) => entry.path === 'crash-note.txt'),
    'the recovered edit is journaled on the next scan',
  )
  assert.equal(
    await fs.readFile(crashPath, 'utf8'),
    'unsynced keystrokes\n',
    'the on-disk file is never deleted',
  )
})

// GR-G3: a legitimate source-write storm (e.g. a format-on-save sweep touching
// 1,000 distinct non-derived files) must coalesce into a single sync pass and a
// bounded number of batch commits (the existing bulk-commit chunk size), never
// thousands of individual round trips, and must not lose a single write.
test('a 1,000-file save storm coalesces into a bounded number of batch commits with zero lost writes', async (t) => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))

  const options = parseOptions([...stateArgs(state), '--sync-debounce-ms', '150', '--sync-max-delay-ms', '5000'])
  const schedule = createWatchSyncScheduler(options, {})
  t.after(() => schedule.cancel())

  const fileCount = 1000
  const expected = new Map()
  for (let index = 0; index < fileCount; index += 1) {
    const relativePath = `burst-${index}.txt`
    const content = `burst content ${index}\n`
    expected.set(relativePath, content)
    await fs.writeFile(path.join(state.workspace, relativePath), content, 'utf8')
    schedule('rename', relativePath)
  }

  await waitFor(async () => (await readNdjson(state.events)).some((event) => event.event === 'sync.complete'), 20000)
  await waitFor(() => schedule.isIdle(), 20000)
  await sleep(200)

  const events = await readNdjson(state.events)
  const syncCompletes = events.filter((event) => event.event === 'sync.complete')
  assert.equal(syncCompletes.length, 1, 'the entire storm collapses into a single sync pass')

  // The bound comes straight from the existing bulk-commit chunk size: a storm
  // of N files never needs more than ceil(N / chunkSize) batch commits.
  const expectedMaxBulkCommits = Math.ceil(fileCount / bulkJournalCommitChunkSize)
  const bulkCommits = events.filter((event) => event.event === 'sync.bulk_commit')
  assert.ok(
    bulkCommits.length <= expectedMaxBulkCommits,
    `expected at most ${expectedMaxBulkCommits} batch commits (chunk size ${bulkJournalCommitChunkSize}), saw ${bulkCommits.length}`,
  )
  assert.ok(bulkCommits.length > 1, 'a storm this large is still chunked, not a single unbounded batch')
  for (const commit of bulkCommits) {
    assert.ok(
      commit.detail.count <= bulkJournalCommitChunkSize,
      `each batch commit stays within the chunk size, saw ${commit.detail.count}`,
    )
  }

  // Content-hash audit: every one of the 1,000 paths reached the cloud with the
  // exact content written, and the on-disk workspace still matches too.
  const after = await readJson(state.cloud)
  let auditedCount = 0
  for (const [relativePath, content] of expected) {
    const expectedHash = createHash('sha256').update(content, 'utf8').digest('hex')
    const cloudEntry = after.files[relativePath]
    assert.ok(cloudEntry, `${relativePath} reached the cloud`)
    assert.equal(cloudEntry.content, content, `${relativePath} carries the exact written content`)
    assert.equal(cloudEntry.hash, expectedHash, `${relativePath} content-hash matches what was written`)
    const onDisk = await fs.readFile(path.join(state.workspace, relativePath), 'utf8')
    assert.equal(onDisk, content, `${relativePath} on-disk content is unchanged`)
    auditedCount += 1
  }
  assert.equal(auditedCount, fileCount, 'every one of the 1,000 paths was audited, none lost')

  const journal = await readNdjson(state.journal)
  const journaledPaths = new Set(journal.map((entry) => entry.path))
  assert.equal(journaledPaths.size, fileCount, 'every distinct path has exactly one journal entry, none dropped')

  const acks = events.filter((event) => event.event === 'cloud.acknowledged')
  assert.equal(acks.length, fileCount, 'every one of the 1,000 writes is individually acknowledged inside the batches')
})

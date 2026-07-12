import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  DEFAULT_EVENTS_MAX_BYTES,
  appendEventNdjson,
  emit,
  eventsMaxBytes,
  readEventsWithHistory,
  readNdjson,
  rotateEventsIfNeeded,
  rotatedNdjsonPath,
} from '../src/io.js'

async function makeTempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-events-rotation-'))
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
  return root
}

// Restore an env var to its prior value after the test, whether or not it was set.
function withEnv(t, key, value) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key)
  const prior = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
  t.after(() => {
    if (had) process.env[key] = prior
    else delete process.env[key]
  })
}

// Emit N events straight through the io helper so both the rotation path and the
// append are exercised exactly as the daemon exercises them.
async function appendEvents(filePath, from, count) {
  for (let index = from; index < from + count; index += 1) {
    await appendEventNdjson(filePath, { event: 'tick', detail: { seq: index }, at: `t-${index}` })
  }
}

test('rotatedNdjsonPath names the single retained generation as <name>.1.ndjson', () => {
  assert.equal(
    rotatedNdjsonPath('/state/events/hopit.ndjson'),
    path.join('/state/events', 'hopit.1.ndjson'),
  )
  // Falls back gracefully when the basename has no .ndjson extension.
  assert.equal(rotatedNdjsonPath('/state/events/e'), path.join('/state/events', 'e.1.ndjson'))
})

test('eventsMaxBytes defaults, honours override, and rejects bad values', (t) => {
  withEnv(t, 'HOPIT_EVENTS_MAX_BYTES', undefined)
  assert.equal(eventsMaxBytes(), DEFAULT_EVENTS_MAX_BYTES)
  assert.equal(DEFAULT_EVENTS_MAX_BYTES, 16 * 1024 * 1024)

  process.env.HOPIT_EVENTS_MAX_BYTES = '4096'
  assert.equal(eventsMaxBytes(), 4096)

  process.env.HOPIT_EVENTS_MAX_BYTES = 'not-a-number'
  assert.equal(eventsMaxBytes(), DEFAULT_EVENTS_MAX_BYTES)

  process.env.HOPIT_EVENTS_MAX_BYTES = '-5'
  assert.equal(eventsMaxBytes(), DEFAULT_EVENTS_MAX_BYTES)

  process.env.HOPIT_EVENTS_MAX_BYTES = '0'
  assert.equal(eventsMaxBytes(), DEFAULT_EVENTS_MAX_BYTES)
})

test('no rotation occurs while the events file is below the threshold', async (t) => {
  const root = await makeTempRoot(t)
  const events = path.join(root, 'events', 'hopit.ndjson')
  await appendEvents(events, 0, 5)

  const rotated = await rotateEventsIfNeeded(events, 1024 * 1024)
  assert.equal(rotated, false)
  assert.equal(existsSync(rotatedNdjsonPath(events)), false)
  assert.equal((await readNdjson(events)).length, 5)
})

test('rotation triggers at the threshold and keeps exactly two generations', async (t) => {
  const root = await makeTempRoot(t)
  const events = path.join(root, 'events', 'hopit.ndjson')
  const rotatedPath = rotatedNdjsonPath(events)

  await appendEvents(events, 0, 40)
  const firstSize = (await fs.stat(events)).size
  assert.ok(firstSize > 0)

  // Threshold below the current size -> next rotation check rotates.
  const rotatedFirst = await rotateEventsIfNeeded(events, Math.floor(firstSize / 2))
  assert.equal(rotatedFirst, true)
  assert.equal(existsSync(events), false)
  assert.equal(existsSync(rotatedPath), true)
  const genOne = await readNdjson(rotatedPath)
  assert.equal(genOne.length, 40)

  // Fill a fresh generation and rotate again: the previous .1 is replaced in
  // place, never accumulated into a .2 file.
  await appendEvents(events, 40, 40)
  const secondSize = (await fs.stat(events)).size
  const rotatedSecond = await rotateEventsIfNeeded(events, Math.floor(secondSize / 2))
  assert.equal(rotatedSecond, true)

  const dirEntries = (await fs.readdir(path.dirname(events))).sort()
  assert.deepEqual(dirEntries, ['hopit.1.ndjson'])
  assert.equal(existsSync(path.join(path.dirname(events), 'hopit.2.ndjson')), false)

  const retained = await readNdjson(rotatedPath)
  assert.deepEqual(retained.map((entry) => entry.detail.seq), Array.from({ length: 40 }, (_, i) => i + 40))
})

test('the event written at rotation time lands in the fresh current file', async (t) => {
  const root = await makeTempRoot(t)
  const events = path.join(root, 'events', 'hopit.ndjson')
  const rotatedPath = rotatedNdjsonPath(events)

  // Pre-fill above a small threshold, then set that threshold via env so the
  // very next appendEventNdjson rotates BEFORE appending.
  await appendEvents(events, 0, 30)
  const size = (await fs.stat(events)).size
  withEnv(t, 'HOPIT_EVENTS_MAX_BYTES', String(Math.floor(size / 2)))

  await appendEventNdjson(events, { event: 'boundary', detail: { seq: 999 }, at: 't-boundary' })

  const current = await readNdjson(events)
  assert.equal(current.length, 1, 'fresh current file holds only the boundary event')
  assert.equal(current[0].detail.seq, 999)

  const rotated = await readNdjson(rotatedPath)
  assert.equal(rotated.length, 30, 'pre-rotation events preserved in the rotated generation')
  assert.equal(rotated.some((entry) => entry.detail.seq === 999), false, 'boundary event not lost into rotation')
})

test('readers see a consistent recent window across a rotation', async (t) => {
  const root = await makeTempRoot(t)
  const events = path.join(root, 'events', 'hopit.ndjson')

  // Threshold sized so exactly one rotation happens across the stream: it trips
  // once the current file holds ~12 events, and the trailing events stay well
  // under that so a second rotation never drops any of them.
  await appendEventNdjson(events, { event: 'seed', detail: { seq: 0 }, at: 't-0' })
  const perEvent = (await fs.stat(events)).size
  withEnv(t, 'HOPIT_EVENTS_MAX_BYTES', String(perEvent * 12))

  await appendEvents(events, 1, 14) // seq 0..14 total

  // The rotation must actually have happened for this to be a real test.
  assert.equal(existsSync(rotatedNdjsonPath(events)), true)

  // Recent-window readers (status) read only the current file. The newest event
  // is always present there and the tail is contiguous and correctly ordered.
  const current = await readNdjson(events)
  const recent = current.slice(-20)
  assert.equal(recent.at(-1).detail.seq, 14, 'newest event lives in the current file')
  for (let i = 1; i < recent.length; i += 1) {
    assert.equal(recent[i].detail.seq - recent[i - 1].detail.seq, 1, 'recent window is gap-free')
  }

  // History-aware readers (remote-push cursor resume) see the full ordered
  // sequence across the rotation boundary with no gaps and no duplicates.
  const full = await readEventsWithHistory(events)
  assert.deepEqual(full.map((entry) => entry.detail.seq), Array.from({ length: 15 }, (_, i) => i))
})

test('readEventsWithHistory returns only the current file when nothing has rotated', async (t) => {
  const root = await makeTempRoot(t)
  const events = path.join(root, 'events', 'hopit.ndjson')
  await appendEvents(events, 0, 3)

  const full = await readEventsWithHistory(events)
  assert.deepEqual(full.map((entry) => entry.detail.seq), [0, 1, 2])
})

test('emit rotates the events journal and retains only a bounded, contiguous newest window', async (t) => {
  const root = await makeTempRoot(t)
  const events = path.join(root, 'events', 'hopit.ndjson')
  const options = { events, quiet: true, 'cloud-backend': 'local' }

  await emit(options, 'first', { seq: 0 })
  const perEvent = (await fs.stat(events)).size
  // A tight threshold drives several rotations, so older generations are
  // deliberately discarded -- that bounded retention is the whole point.
  withEnv(t, 'HOPIT_EVENTS_MAX_BYTES', String(perEvent * 3))

  for (let index = 1; index <= 12; index += 1) {
    await emit(options, 'tick', { seq: index })
  }

  assert.equal(existsSync(rotatedNdjsonPath(events)), true)
  // At most two generations exist on disk (current + one rotated), no .2.
  const dirEntries = (await fs.readdir(path.dirname(events))).sort()
  assert.deepEqual(dirEntries, ['hopit.1.ndjson', 'hopit.ndjson'])

  const full = await readEventsWithHistory(events)
  const seqs = full.map((entry) => entry.detail.seq)
  // The retained events are a contiguous suffix ending at the newest event:
  // no gaps, no duplicates, and the boundary event is never lost. Older events
  // are intentionally dropped, so the window is shorter than the full stream.
  assert.equal(seqs.at(-1), 12, 'newest emitted event is always retained')
  for (let i = 1; i < seqs.length; i += 1) {
    assert.equal(seqs[i] - seqs[i - 1], 1, 'retained window is contiguous across rotations')
  }
  assert.ok(seqs.length < 13, 'older events are dropped, keeping the journal bounded')
})

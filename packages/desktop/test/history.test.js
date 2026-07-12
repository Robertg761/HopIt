import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { deriveHistory, revisionFromEvent, triggerForEvent } from '../src/lib/history.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const realEvents = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'events-hopit.json'), 'utf8'))

test('sync.bulk_commit maps to a local revision with count and sample paths', () => {
  const record = revisionFromEvent({
    event: 'sync.bulk_commit',
    at: '2026-07-10T00:00:00Z',
    detail: { storageMode: 'd1-bulk-mutation', count: 24, fromRevision: 4412, toRevision: 4436, paths: ['a.ts', 'b.ts'] },
  })
  assert.equal(record.revision, 4436)
  assert.equal(record.changedCount, 24)
  assert.deepEqual(record.samplePaths, ['a.ts', 'b.ts'])
  assert.equal(record.trigger.code, 'local')
})

test('sync.complete maps writes/path; zero writes yields no sample path', () => {
  const withWrite = revisionFromEvent({
    event: 'sync.complete',
    at: '2026-07-11T00:00:00Z',
    detail: { trigger: 'watch', path: 'docs/progress.md', writes: 1, revision: 4437 },
  })
  assert.equal(withWrite.revision, 4437)
  assert.equal(withWrite.changedCount, 1)
  assert.deepEqual(withWrite.samplePaths, ['docs/progress.md'])

  const noWrite = revisionFromEvent({
    event: 'sync.complete',
    detail: { trigger: 'watch', path: 'docs/progress.md', writes: 0, revision: 4437 },
  })
  assert.deepEqual(noWrite.samplePaths, [])
  assert.equal(noWrite.changedCount, 0)
})

test('remote-push.applied maps to a remote-trigger revision without fabricated paths', () => {
  const record = revisionFromEvent({
    event: 'remote-push.applied',
    at: '2026-07-11T02:41:38Z',
    detail: { state: 'push-applied', trigger: 'remote-push', fromRevision: 4436, toRevision: 4437, pushedRevision: 4437 },
  })
  assert.equal(record.revision, 4437)
  assert.equal(record.trigger.code, 'remote')
  assert.equal(record.changedCount, null) // the event carries no path detail; do not invent
  assert.deepEqual(record.samplePaths, [])
})

test('refresh.complete counts written+deleted and samples changed paths', () => {
  const record = revisionFromEvent({
    event: 'refresh.complete',
    detail: { revision: 4437, written: 2, deleted: 1, changedPaths: ['x.ts', 'y.ts'], deletedPaths: ['z.ts'] },
  })
  assert.equal(record.changedCount, 3)
  assert.deepEqual(record.samplePaths, ['x.ts', 'y.ts', 'z.ts'])
  assert.equal(record.trigger.code, 'refresh')
})

test('non-revision events return null', () => {
  assert.equal(revisionFromEvent({ event: 'watch.started', detail: {} }), null)
  assert.equal(revisionFromEvent({ event: 'remote-push.connected', detail: { lastPushedRevision: 4437 } }), null)
  assert.equal(revisionFromEvent({}), null)
})

test('deriveHistory dedupes by revision preferring the most informative record', () => {
  const rows = deriveHistory([
    { event: 'remote-push.applied', at: 't1', detail: { toRevision: 100 } },
    { event: 'sync.bulk_commit', at: 't2', detail: { toRevision: 100, count: 5, paths: ['a', 'b'] } },
    { event: 'sync.complete', at: 't3', detail: { revision: 99, writes: 1, path: 'c.ts' } },
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].revision, 100) // newest first
  assert.equal(rows[0].changedCount, 5) // the richer record won
  assert.equal(rows[1].revision, 99)
})

test('deriveHistory over the real captured events window produces plausible rows', () => {
  const rows = deriveHistory(realEvents.recent)
  // The captured window may or may not contain revision events; the invariant
  // is: no crash, rows sorted desc, each row has a numeric revision + trigger.
  let previous = Infinity
  for (const row of rows) {
    assert.equal(typeof row.revision, 'number')
    assert.ok(row.revision <= previous)
    previous = row.revision
    assert.ok(['local', 'remote', 'refresh', 'other'].includes(row.trigger.code))
  }
})

test('triggerForEvent labels are human-friendly', () => {
  assert.equal(triggerForEvent('sync.complete').label, 'Local edit')
  assert.equal(triggerForEvent('remote-push.applied').label, 'Another device')
  assert.equal(triggerForEvent('refresh.complete').label, 'Refresh from cloud')
})

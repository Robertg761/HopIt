import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describeEvent, formatActivity, humanizeEventName, relativeTime } from '../src/lib/activity.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const realEvents = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'events-hopit.json'), 'utf8'))

test('known events get plain-language lines', () => {
  assert.equal(describeEvent('sync.complete', { revision: 4437 }), 'Sync complete (rev 4437)')
  assert.equal(describeEvent('remote-push.applied', { toRevision: 4437 }), 'Applied a pushed change (rev 4437)')
  assert.equal(describeEvent('write.journaled', { path: 'src/a.ts' }), 'Recorded a local change to src/a.ts')
  assert.equal(describeEvent('remote-push.fallback_polling'), 'Sync hub offline: polling instead')
  assert.equal(describeEvent('change_set.conflict_detected'), 'Conflict detected')
})

test('unknown events fall back to a humanized name instead of being dropped', () => {
  assert.equal(humanizeEventName('some.new_event'), 'Some new event')
  assert.equal(describeEvent('totally.unknown_thing'), 'Totally unknown thing')
})

test('formatActivity orders newest first and caps the count', () => {
  const lines = formatActivity(
    [
      { event: 'sync.started', at: '2026-07-11T00:00:00Z' },
      { event: 'sync.complete', at: '2026-07-11T00:00:05Z', detail: { revision: 9 } },
    ],
    { limit: 1 },
  )
  assert.equal(lines.length, 1)
  assert.equal(lines[0].text, 'Sync complete (rev 9)')
})

test('formatActivity over the real captured events produces a line per event', () => {
  const lines = formatActivity(realEvents.recent)
  assert.equal(lines.length, Math.min(20, realEvents.recent.length))
  for (const line of lines) {
    assert.equal(typeof line.text, 'string')
    assert.ok(line.text.length > 0)
    assert.ok(!line.text.includes('undefined'))
  }
})

test('codebase prefix is applied when requested', () => {
  const [line] = formatActivity([{ event: 'sync.started', at: '2026-07-11T00:00:00Z' }], { codebaseId: 'lunarlog' })
  assert.equal(line.text, 'lunarlog: Sync started')
})

test('relativeTime buckets seconds/minutes/hours/days', () => {
  const now = Date.parse('2026-07-11T12:00:00Z')
  assert.equal(relativeTime('2026-07-11T11:59:30Z', now), '30s')
  assert.equal(relativeTime('2026-07-11T11:30:00Z', now), '30m')
  assert.equal(relativeTime('2026-07-11T06:00:00Z', now), '6h')
  assert.equal(relativeTime('2026-07-09T12:00:00Z', now), '2d')
  assert.equal(relativeTime('not-a-date', now), null)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  projectStateFromProbe,
  aggregateTrayState,
  deriveViewModel,
  projectSummaryLine,
} from '../src/lib/state.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const realStatus = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'status-hopit.json'), 'utf8'))

test('a real healthy /status derives synced', () => {
  const state = projectStateFromProbe({ codebaseId: 'hopit', reachable: true, status: realStatus })
  assert.equal(state, 'synced')
})

test('an unreachable service derives stopped', () => {
  assert.equal(projectStateFromProbe({ codebaseId: 'x', reachable: false, status: null }), 'stopped')
  assert.equal(projectStateFromProbe(undefined), 'stopped')
})

test('failed journal entries derive attention', () => {
  const status = structuredClone(realStatus)
  status.journal.failedCount = 2
  assert.equal(projectStateFromProbe({ codebaseId: 'hopit', reachable: true, status }), 'attention')
})

test('a conflict derives attention', () => {
  const status = structuredClone(realStatus)
  status.conflict = { state: 'conflict', detail: {} }
  assert.equal(projectStateFromProbe({ codebaseId: 'hopit', reachable: true, status }), 'attention')
})

test('blocked refresh and degraded watch derive attention', () => {
  const blocked = structuredClone(realStatus)
  blocked.refresh = { state: 'blocked' }
  assert.equal(projectStateFromProbe({ codebaseId: 'hopit', reachable: true, status: blocked }), 'attention')

  const degraded = structuredClone(realStatus)
  degraded.watch = { state: 'degraded' }
  assert.equal(projectStateFromProbe({ codebaseId: 'hopit', reachable: true, status: degraded }), 'attention')
})

test('pending journal entries derive syncing', () => {
  const status = structuredClone(realStatus)
  status.journal.pendingCount = 3
  assert.equal(projectStateFromProbe({ codebaseId: 'hopit', reachable: true, status }), 'syncing')
})

test('partial hydration derives syncing', () => {
  const status = structuredClone(realStatus)
  status.workspace.hydration.state = 'partial'
  assert.equal(projectStateFromProbe({ codebaseId: 'hopit', reachable: true, status }), 'syncing')
})

test('attention beats syncing when both are present', () => {
  const status = structuredClone(realStatus)
  status.journal.pendingCount = 3
  status.journal.failedCount = 1
  assert.equal(projectStateFromProbe({ codebaseId: 'hopit', reachable: true, status }), 'attention')
})

test('aggregate: empty list is service-stopped', () => {
  assert.equal(aggregateTrayState([]), 'service-stopped')
})

test('aggregate: all synced', () => {
  assert.equal(aggregateTrayState(['synced', 'synced']), 'all-synced')
})

test('aggregate: any syncing wins over synced', () => {
  assert.equal(aggregateTrayState(['synced', 'syncing']), 'syncing')
})

test('aggregate: any attention wins over everything', () => {
  assert.equal(aggregateTrayState(['synced', 'syncing', 'attention']), 'attention')
})

test('aggregate: all stopped is service-stopped', () => {
  assert.equal(aggregateTrayState(['stopped', 'stopped']), 'service-stopped')
})

test('aggregate: a mix of synced and stopped needs attention', () => {
  assert.equal(aggregateTrayState(['synced', 'stopped']), 'attention')
})

test('deriveViewModel maps the real status into project rows', () => {
  const view = deriveViewModel([
    { codebaseId: 'hopit', name: 'HopIt', workspacePath: '/w/hopit', reachable: true, status: realStatus },
    { codebaseId: 'lunarlog', name: 'LunarLog', workspacePath: '/w/lunarlog', reachable: false, status: null, error: 'connection refused' },
  ])
  assert.equal(view.trayState, 'attention') // one synced + one stopped
  const [hopit, lunarlog] = view.projects
  assert.equal(hopit.codebaseId, 'hopit')
  assert.equal(hopit.state, 'synced')
  assert.equal(hopit.revision, realStatus.merge.mainRevision)
  assert.equal(hopit.visibleFileCount, realStatus.visibleFileCount)
  assert.equal(hopit.hydrationState, 'materialized')
  assert.equal(lunarlog.state, 'stopped')
  assert.equal(lunarlog.error, 'connection refused')
})

test('projectSummaryLine renders a one-liner with revision', () => {
  const view = deriveViewModel([
    { codebaseId: 'hopit', name: 'HopIt', reachable: true, status: realStatus },
  ])
  const line = projectSummaryLine(view.projects[0])
  assert.match(line, /^HopIt — Synced · rev \d+$/)
})

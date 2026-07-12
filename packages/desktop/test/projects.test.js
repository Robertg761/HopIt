import assert from 'node:assert/strict'
import test from 'node:test'

import { listProjectsFromIndex } from '../src/lib/projects.js'

const indexJson = {
  schemaVersion: 1,
  codebases: [
    {
      id: 'hopit',
      name: 'HopIt',
      workspace: { path: '/Users/robert/HopIt Workspaces/hopit' },
      activeChangeSetId: 'cs_hopit_local',
      mainId: 'main',
      hydration: { state: 'materialized' },
    },
    {
      id: 'lunarlog',
      name: 'LunarLog',
      workspace: { path: '/Users/robert/HopIt Workspaces/lunarlog' },
      activeChangeSetId: 'cs_lunarlog_main',
      mainId: 'main',
      hydration: { state: 'materialized' },
    },
  ],
}

test('index rows map to projects with derived ports and URLs', () => {
  const projects = listProjectsFromIndex(indexJson, ['lunarlog'])
  assert.equal(projects.length, 2)
  const hopit = projects.find((p) => p.codebaseId === 'hopit')
  assert.equal(hopit.port, 4785)
  assert.equal(hopit.statusUrl, 'http://127.0.0.1:4785/status')
  assert.equal(hopit.name, 'HopIt')
  assert.equal(hopit.hydrationState, 'materialized')
  const lunarlog = projects.find((p) => p.codebaseId === 'lunarlog')
  assert.ok(lunarlog.port >= 4786 && lunarlog.port <= 5785)
})

test('connection-store ids missing from the index appear as bare projects', () => {
  const projects = listProjectsFromIndex(indexJson, ['brand-new'])
  const fresh = projects.find((p) => p.codebaseId === 'brand-new')
  assert.ok(fresh)
  assert.equal(fresh.name, 'brand-new')
  assert.equal(fresh.workspacePath, null)
})

test('duplicates dedupe with the index winning; output is sorted', () => {
  const projects = listProjectsFromIndex(indexJson, ['hopit', 'aaa'])
  assert.equal(projects.filter((p) => p.codebaseId === 'hopit').length, 1)
  assert.equal(projects.find((p) => p.codebaseId === 'hopit').name, 'HopIt')
  assert.deepEqual(projects.map((p) => p.codebaseId), ['aaa', 'hopit', 'lunarlog'])
})

test('null index with no connections yields an empty list', () => {
  assert.deepEqual(listProjectsFromIndex(null, []), [])
})

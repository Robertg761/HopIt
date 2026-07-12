import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyPickedFolder, formatBytes } from '../src/lib/add-inspect.js'

const workspaceRoot = '/Users/robert/HopIt Workspaces'
const projects = [
  { codebaseId: 'hopit', name: 'HopIt', workspacePath: '/Users/robert/HopIt Workspaces/hopit' },
  { codebaseId: 'lunarlog', name: 'LunarLog', workspacePath: '/Users/robert/HopIt Workspaces/lunarlog' },
]

test('a normal outside folder is recommended for add with a copy explanation', () => {
  const result = classifyPickedFolder({
    folderPath: '/Users/robert/Documents/Projects/MyApp',
    workspaceRoot,
    projects,
    walk: { fileCount: 320, totalBytes: 5 * 1024 * 1024, truncated: false },
  })
  assert.equal(result.recommendation, 'add')
  assert.equal(result.insideWorkspaceRoot, false)
  assert.equal(result.fileCount, 320)
  assert.match(result.description, /copied to HopIt Cloud/)
  assert.match(result.description, /original folder stays/)
})

test('an existing managed workspace folder diverts to open-existing', () => {
  const result = classifyPickedFolder({
    folderPath: '/Users/robert/HopIt Workspaces/lunarlog',
    workspaceRoot,
    projects,
  })
  assert.equal(result.recommendation, 'open-existing')
  assert.equal(result.existingProjectId, 'lunarlog')
  assert.match(result.headline, /LunarLog/)
})

test('any other folder inside the Workspace Root is blocked', () => {
  const result = classifyPickedFolder({
    folderPath: '/Users/robert/HopIt Workspaces/hopit/src',
    workspaceRoot,
    projects,
  })
  assert.equal(result.recommendation, 'blocked-inside-root')
  assert.match(result.description, /already managed by HopIt/)
})

test('the Workspace Root itself is blocked', () => {
  const result = classifyPickedFolder({ folderPath: workspaceRoot, workspaceRoot, projects })
  assert.equal(result.recommendation, 'blocked-inside-root')
})

test('a sibling folder whose name shares the root prefix is NOT treated as inside', () => {
  const result = classifyPickedFolder({
    folderPath: '/Users/robert/HopIt Workspaces-backup/thing',
    workspaceRoot,
    projects,
  })
  assert.equal(result.recommendation, 'add')
})

test('missing walk stats degrade to nulls, not fake numbers', () => {
  const result = classifyPickedFolder({
    folderPath: '/Users/robert/Documents/Projects/Other',
    workspaceRoot,
    projects,
    walk: null,
  })
  assert.equal(result.fileCount, null)
  assert.equal(result.totalBytes, null)
})

test('formatBytes is human friendly', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(formatBytes(-1), '—')
  assert.equal(formatBytes(null), '—')
})

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { applyRuntimeDefaults, indexedWorkspaceDefaults } from '../src/options.js'
import { migrateWorkspaceRoot } from '../src/commands/workspace-root.js'

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-root-migration-'))
  const oldRoot = path.join(root, 'Old Workspaces')
  const newRoot = path.join(root, 'New Workspaces')
  const stateRoot = path.join(root, 'state')
  const indexPath = path.join(stateRoot, 'workspaces.json')
  const envPath = path.join(root, 'production.env')
  const alpha = path.join(oldRoot, 'alpha')
  const beta = path.join(oldRoot, 'beta')
  await fs.mkdir(path.join(alpha, 'src'), { recursive: true })
  await fs.mkdir(beta, { recursive: true })
  await fs.writeFile(path.join(alpha, 'src', 'index.js'), 'export const alpha = true\n')
  await fs.writeFile(path.join(beta, 'README.md'), '# beta\n')
  await fs.mkdir(stateRoot, { recursive: true })
  await fs.writeFile(indexPath, `${JSON.stringify({
    schemaVersion: 1,
    updatedAt: null,
    root: { path: oldRoot, adapter: 'managed-folder' },
    codebases: [
      { id: 'alpha', name: 'Alpha', workspace: { root: oldRoot, path: alpha, exists: true } },
      { id: 'beta', name: 'Beta', workspace: { root: oldRoot, path: beta, exists: true } },
    ],
  }, null, 2)}\n`)
  await fs.writeFile(envPath, `HOPIT_PROFILE=production\nHOPIT_WORKSPACE_ROOT=${JSON.stringify(oldRoot)}\nHOPIT_REMOTE_PULL=1\n`)
  return {
    root, oldRoot, newRoot, stateRoot, indexPath, envPath, alpha, beta,
    options: {
      profile: 'production',
      'state-root': stateRoot,
      'workspace-root': oldRoot,
      'workspace-index': indexPath,
      workspace: alpha,
      journal: path.join(stateRoot, 'journal', 'alpha.ndjson'),
      'new-root': newRoot,
      projects: 'alpha',
      'env-path': envPath,
    },
  }
}

test('workspace root migration moves only selected projects and changes the future default', async (t) => {
  const state = await fixture()
  t.after(() => fs.rm(state.root, { recursive: true, force: true }))

  const result = await migrateWorkspaceRoot(state.options)
  const movedAlpha = path.join(state.newRoot, 'alpha')
  assert.equal(result.ok, true)
  assert.deepEqual(result.migrated.map((row) => row.codebaseId), ['alpha'])
  assert.deepEqual(result.stayed.map((row) => row.codebaseId), ['beta'])
  assert.equal(await fs.readFile(path.join(movedAlpha, 'src', 'index.js'), 'utf8'), 'export const alpha = true\n')
  await assert.rejects(fs.stat(state.alpha), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(state.beta, 'README.md'), 'utf8'), '# beta\n')

  const index = JSON.parse(await fs.readFile(state.indexPath, 'utf8'))
  assert.equal(index.root.path, state.newRoot)
  assert.equal(index.codebases.find((entry) => entry.id === 'alpha').workspace.path, movedAlpha)
  assert.equal(index.codebases.find((entry) => entry.id === 'alpha').workspace.root, state.newRoot)
  assert.equal(index.codebases.find((entry) => entry.id === 'beta').workspace.path, state.beta)
  assert.equal(index.codebases.find((entry) => entry.id === 'beta').workspace.root, state.oldRoot)

  const env = await fs.readFile(state.envPath, 'utf8')
  assert.match(env, new RegExp(`HOPIT_WORKSPACE_ROOT=${escapeRegex(JSON.stringify(state.newRoot))}`))
  assert.equal(indexedWorkspaceDefaults({ codebaseId: 'alpha', workspaceIndex: state.indexPath }).workspace, movedAlpha)
  assert.equal(indexedWorkspaceDefaults({ codebaseId: 'beta', workspaceIndex: state.indexPath }).workspace, state.beta)
})

test('workspace root migration refuses destination collisions without moving anything', async (t) => {
  const state = await fixture()
  t.after(() => fs.rm(state.root, { recursive: true, force: true }))
  await fs.mkdir(path.join(state.newRoot, 'alpha'), { recursive: true })

  await assert.rejects(
    migrateWorkspaceRoot(state.options),
    /destination already exists/,
  )
  assert.equal(await fs.readFile(path.join(state.alpha, 'src', 'index.js'), 'utf8'), 'export const alpha = true\n')
  const index = JSON.parse(await fs.readFile(state.indexPath, 'utf8'))
  assert.equal(index.root.path, state.oldRoot)
  assert.match(await fs.readFile(state.envPath, 'utf8'), new RegExp(escapeRegex(JSON.stringify(state.oldRoot))))
})

test('workspace root migration can change the default without moving existing projects', async (t) => {
  const state = await fixture()
  t.after(() => fs.rm(state.root, { recursive: true, force: true }))
  const result = await migrateWorkspaceRoot({ ...state.options, projects: '' })
  assert.equal(result.migrated.length, 0)
  assert.equal(result.stayed.length, 2)
  const index = JSON.parse(await fs.readFile(state.indexPath, 'utf8'))
  assert.equal(index.root.path, state.newRoot)
  assert.equal(index.codebases.find((entry) => entry.id === 'alpha').workspace.path, state.alpha)
  assert.equal(await fs.readFile(path.join(state.alpha, 'src', 'index.js'), 'utf8'), 'export const alpha = true\n')
})

test('workspace root migration rejects unknown projects before touching disk', async (t) => {
  const state = await fixture()
  t.after(() => fs.rm(state.root, { recursive: true, force: true }))
  await assert.rejects(migrateWorkspaceRoot({ ...state.options, projects: 'missing' }), /Unknown HopIt project/)
  assert.equal(await fs.readFile(path.join(state.alpha, 'src', 'index.js'), 'utf8'), 'export const alpha = true\n')
})

test('production commands use per-project paths while preserving the global default for add', async (t) => {
  const state = await fixture()
  t.after(() => fs.rm(state.root, { recursive: true, force: true }))
  const options = applyRuntimeDefaults({
    profile: 'production',
    'codebase-id': 'alpha',
    'state-root': state.stateRoot,
    'workspace-index': state.indexPath,
    'workspace-root': state.newRoot,
  }, new Set())
  assert.equal(options.workspace, state.alpha)
  assert.equal(options['workspace-root'], state.oldRoot)
  assert.equal(options._defaultWorkspaceRoot, state.newRoot)
})

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

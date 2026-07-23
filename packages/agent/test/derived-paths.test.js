import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readNdjson } from '../src/io.js'
import { syncOnce } from '../src/commands/sync.js'
import { initCloud } from '../src/commands/import.js'
import { hydrateWorkspace } from '../src/commands/hydrate.js'
import { createCloudGraphService } from '../src/cloud/d1-graph-service.js'
import { runDerivedCommand } from '../src/commands/derived.js'
import {
  isDerivedWorkspacePath,
  listDerivedWorkspaceRoots,
  shouldSkipWorkspacePath,
} from '../src/workspace-manifest.js'
import { curatedDerivedPathRules } from '../src/constants.js'

async function makeWorkspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-derived-'))
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
  const options = {
    cloud: path.join(root, 'cloud.json'),
    workspace: path.join(root, 'workspace'),
    journal: path.join(root, 'journal.ndjson'),
    events: path.join(root, 'events.ndjson'),
  }
  await initCloud({ ...options, force: true })
  await hydrateWorkspace(options)
  return options
}

// -------------------------------------------------------------------------
// Curated built-in classification
// -------------------------------------------------------------------------

test('curated built-in list matches the decisions §6 examples plus the plan extensions', () => {
  for (const name of ['node_modules', '.venv', 'venv', 'target', 'dist', 'build', '.next', '__pycache__', '.cache', '.turbo', '.gradle']) {
    assert.ok(curatedDerivedPathRules.includes(name), `expected ${name} in the curated list`)
  }
  assert.ok(curatedDerivedPathRules.includes('vendor/bundle'))
})

test('isDerivedWorkspacePath matches a curated segment name anywhere in the path', () => {
  assert.equal(isDerivedWorkspacePath('node_modules/lodash/index.js'), true)
  assert.equal(isDerivedWorkspacePath('packages/agent/node_modules/foo/bar.js'), true)
  assert.equal(isDerivedWorkspacePath('src/dist/bundle.js'), true)
})

test('isDerivedWorkspacePath treats a multi-segment curated rule as a root-anchored subtree', () => {
  assert.equal(isDerivedWorkspacePath('vendor/bundle/lib.rb'), true, 'vendor/bundle itself is derived')
  assert.equal(isDerivedWorkspacePath('vendor/gems/lib.rb'), false, 'a plain top-level vendor/ is not derived')
  assert.equal(isDerivedWorkspacePath('vendor'), false)
})

test('isDerivedWorkspacePath does not flag ordinary source paths', () => {
  assert.equal(isDerivedWorkspacePath('src/index.ts'), false)
  assert.equal(isDerivedWorkspacePath('README.md'), false)
  assert.equal(isDerivedWorkspacePath('.private/env/.env'), false, 'secrets are a distinct classification, not derived')
})

test('shouldSkipWorkspacePath treats derived paths and secret paths as distinct reasons to skip', () => {
  const fileEntry = { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }
  assert.equal(shouldSkipWorkspacePath('node_modules/x.js', fileEntry), true)
  assert.equal(shouldSkipWorkspacePath('.private/env/.env', fileEntry), true)
  assert.equal(shouldSkipWorkspacePath('src/index.ts', fileEntry), false)
})

// -------------------------------------------------------------------------
// Simulation: 500 derived files + 3 source files -> journal has exactly 3
// -------------------------------------------------------------------------

test('derived-burst simulation: 500 node_modules files journal 0 entries, 3 source files journal 3', async (t) => {
  const options = await makeWorkspace(t)
  await fs.mkdir(path.join(options.workspace, 'node_modules', 'some-package'), { recursive: true })
  for (let i = 0; i < 500; i += 1) {
    await fs.writeFile(
      path.join(options.workspace, 'node_modules', 'some-package', `file-${i}.js`),
      `module.exports = ${i};\n`,
      'utf8',
    )
  }
  await fs.writeFile(path.join(options.workspace, 'src-a.ts'), 'export const a = 1\n', 'utf8')
  await fs.writeFile(path.join(options.workspace, 'src-b.ts'), 'export const b = 2\n', 'utf8')
  await fs.writeFile(path.join(options.workspace, 'src-c.ts'), 'export const c = 3\n', 'utf8')

  await syncOnce(options, { trigger: 'manual' })

  const journalEntries = await readNdjson(options.journal)
  assert.equal(journalEntries.length, 3, 'only the 3 source files should be journaled')
  const journaledPaths = journalEntries.map((entry) => entry.path).sort()
  assert.deepEqual(journaledPaths, ['src-a.ts', 'src-b.ts', 'src-c.ts'])

  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()
  assert.equal('node_modules/some-package/file-0.js' in (cloud.files ?? {}), false)
  assert.equal(Object.keys(cloud.files ?? {}).some((p) => p.startsWith('node_modules/')), false)
})

// -------------------------------------------------------------------------
// Overrides: un-derive a curated path; derive a custom path
// -------------------------------------------------------------------------

test('override: un-deriving a curated path makes it sync again', async (t) => {
  const options = await makeWorkspace(t)
  const cloudService = createCloudGraphService(options)
  await cloudService.setDerivedPathOverrides(options['codebase-id'], { remove: ['dist'] })

  await fs.mkdir(path.join(options.workspace, 'dist'), { recursive: true })
  await fs.writeFile(path.join(options.workspace, 'dist', 'bundle.js'), 'console.log(1)\n', 'utf8')

  await syncOnce(options, { trigger: 'manual' })

  const journalEntries = await readNdjson(options.journal)
  assert.deepEqual(journalEntries.map((entry) => entry.path), ['dist/bundle.js'])
})

test('override: adding a custom path stops it from syncing', async (t) => {
  const options = await makeWorkspace(t)
  const cloudService = createCloudGraphService(options)
  await cloudService.setDerivedPathOverrides(options['codebase-id'], { add: ['generated'] })

  await fs.mkdir(path.join(options.workspace, 'generated'), { recursive: true })
  await fs.writeFile(path.join(options.workspace, 'generated', 'out.txt'), 'built\n', 'utf8')
  await fs.writeFile(path.join(options.workspace, 'kept.txt'), 'kept\n', 'utf8')

  await syncOnce(options, { trigger: 'manual' })

  const journalEntries = await readNdjson(options.journal)
  assert.deepEqual(journalEntries.map((entry) => entry.path), ['kept.txt'])
})

test('normalizeDerivedPathOverrides gives remove precedence over the curated list, and add extends it', () => {
  assert.equal(isDerivedWorkspacePath('dist/bundle.js', { derivedPathOverrides: { remove: ['dist'] } }), false)
  assert.equal(isDerivedWorkspacePath('generated/out.txt', { derivedPathOverrides: { add: ['generated'] } }), true)
  assert.equal(isDerivedWorkspacePath('generated-other/out.txt', { derivedPathOverrides: { add: ['generated'] } }), false)
})

// -------------------------------------------------------------------------
// hop derived CLI round trip
// -------------------------------------------------------------------------

test('hop derived add/remove/list round-trips through codebase_settings', async (t) => {
  const options = await makeWorkspace(t)
  options._humanOutput = false

  const added = await runDerivedCommand('add', 'scripts/generated', options)
  assert.equal(added.ok, true)
  assert.ok(added.derivedPathOverrides.add.includes('scripts/generated'))

  const listed = await runDerivedCommand('list', null, options)
  assert.ok(listed.overrides.add.includes('scripts/generated'))
  assert.deepEqual(listed.builtin, curatedDerivedPathRules)

  const removed = await runDerivedCommand('remove', 'scripts/generated', options)
  // remove-list add: un-deriving a path that was only in `add` clears it from
  // `add` (the newer intent wins) rather than leaving a contradictory pair.
  assert.equal(removed.derivedPathOverrides.add.includes('scripts/generated'), false)
})

// -------------------------------------------------------------------------
// hop status: excluded roots
// -------------------------------------------------------------------------

test('listDerivedWorkspaceRoots reports present derived roots without descending into them', async (t) => {
  const options = await makeWorkspace(t)
  await fs.mkdir(path.join(options.workspace, 'node_modules', 'pkg'), { recursive: true })
  await fs.writeFile(path.join(options.workspace, 'node_modules', 'pkg', 'index.js'), '1\n', 'utf8')
  await fs.mkdir(path.join(options.workspace, 'src', 'dist'), { recursive: true })
  await fs.writeFile(path.join(options.workspace, 'src', 'dist', 'out.js'), '1\n', 'utf8')
  await fs.writeFile(path.join(options.workspace, 'kept.ts'), '1\n', 'utf8')

  const roots = await listDerivedWorkspaceRoots(options.workspace, {})
  assert.deepEqual(roots.sort(), ['node_modules', 'src/dist'])
})

// -------------------------------------------------------------------------
// Performance: classification overhead
// -------------------------------------------------------------------------

test('classification overhead in the watch path is under 1ms per event', () => {
  const samplePaths = [
    'src/index.ts',
    'node_modules/lodash/index.js',
    'packages/agent/node_modules/foo/bar.js',
    '.private/env/.env',
    'vendor/bundle/lib.rb',
    'vendor/gems/lib.rb',
    'dist/bundle.js',
    'README.md',
  ]
  const overrides = { derivedPathOverrides: { add: ['generated'], remove: ['out'] } }
  const iterations = 20_000
  const started = process.hrtime.bigint()
  for (let i = 0; i < iterations; i += 1) {
    isDerivedWorkspacePath(samplePaths[i % samplePaths.length], overrides)
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  const perEventMs = elapsedMs / iterations
  assert.ok(perEventMs < 1, `classification took ${perEventMs}ms per event, expected < 1ms`)
})

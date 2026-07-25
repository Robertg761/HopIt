// GR-G1 (decisions §11): idle dehydration with a user-tunable window and
// safety invariants -- never evict content with unacknowledged journal
// writes, per-folder "keep on this device" pins survive eviction,
// disk-pressure shortens the window, and re-opening re-materializes
// byte-identical content. v1 dehydration is dematerialization of the whole
// codebase back to metadata-only state via the existing dehydrateWorkspace /
// pruneWorkspaceCache machinery (Track G intro) -- no per-file placeholder
// stubs.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { initCloud } from '../src/commands/import.js'
import { hydrateWorkspace, pruneWorkspaceCache, setWorkspaceCachePin } from '../src/commands/hydrate.js'
import { readJson, readNdjson, writeJson } from '../src/io.js'
import { readWorkspaceFiles } from '../src/workspace-manifest.js'
import { findIndexedCodebase, localCachePatchForPaths, readWorkspaceIndex, upsertWorkspaceIndexFromCloud } from '../src/workspace-index.js'

const sevenDays = 7 * 24 * 60 * 60 * 1000
const codebaseId = 'hopit-core'

async function makeWorkspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-idle-dehydration-'))
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
  const options = {
    quiet: true,
    cloud: path.join(root, 'cloud.json'),
    workspace: path.join(root, 'workspace'),
    journal: path.join(root, 'journal.ndjson'),
    events: path.join(root, 'events.ndjson'),
  }
  await initCloud({ ...options, force: true })
  await hydrateWorkspace(options)
  return options
}

// Backdates every visible path's localCache activity timestamps to `at` so
// pruneWorkspaceCache's "recently_active" check treats the codebase as idle
// as of that instant, without depending on wall-clock time.
async function backdateActivity(options, at) {
  const cloud = await readJson(options.cloud)
  const paths = Object.keys(cloud.files ?? {})
  await upsertWorkspaceIndexFromCloud(options, cloud, {
    reason: 'test-seed',
    lastEvent: null,
    hydrationState: 'materialized',
    hydratedPaths: paths,
    materialization: 'materialized',
    localCache: localCachePatchForPaths(cloud, paths, {
      now: options.now,
      state: 'hydrated',
      // Overwrite every activity timestamp the initial hydrate recorded (at
      // real wall-clock time) so latestIsoTimestamp cannot pick a more-recent
      // real timestamp over the backdated one below.
      lastSyncedAt: at,
      lastHydratedAt: at,
      lastEditedAt: at,
    }),
  })
  return paths
}

function hashFile(content) {
  return createHash('sha256').update(content).digest('hex')
}

test('an idle codebase dehydrates once the configured window elapses', async (t) => {
  const options = await makeWorkspace(t)
  const t0 = '2026-01-01T00:00:00.000Z'
  await backdateActivity(options, t0)

  // Just short of the window: nothing evicts yet.
  await pruneWorkspaceCache({
    ...options,
    path: 'all',
    recursive: true,
    execute: true,
    'inactive-ms': String(sevenDays),
    now: new Date(new Date(t0).getTime() + sevenDays - 1000).toISOString(),
  })
  const stillPresent = Object.keys(await readWorkspaceFiles(options.workspace, options))
  assert.ok(stillPresent.length > 0, 'nothing should be evicted before the idle window elapses')

  // Past the window: the whole codebase becomes metadata-only.
  await pruneWorkspaceCache({
    ...options,
    path: 'all',
    recursive: true,
    execute: true,
    'inactive-ms': String(sevenDays),
    now: new Date(new Date(t0).getTime() + sevenDays + 1000).toISOString(),
  })
  const remaining = Object.keys(await readWorkspaceFiles(options.workspace, options))
  assert.deepEqual(remaining, [], 'an idle codebase past its window must dehydrate to metadata-only')

  const evicted = (await readNdjson(options.events)).findLast((event) => event.event === 'cache.evicted')
  assert.ok(evicted)
  assert.ok(evicted.detail.removed > 0)
})

test('a pinned path survives the idle window that would otherwise evict it', async (t) => {
  const options = await makeWorkspace(t)
  const t0 = '2026-01-01T00:00:00.000Z'
  await backdateActivity(options, t0)
  await setWorkspaceCachePin({ ...options, quiet: true, path: 'README.md' }, true)

  await pruneWorkspaceCache({
    ...options,
    path: 'all',
    recursive: true,
    execute: true,
    'inactive-ms': String(sevenDays),
    now: new Date(new Date(t0).getTime() + sevenDays + 1000).toISOString(),
  })

  const remaining = Object.keys(await readWorkspaceFiles(options.workspace, options)).sort()
  assert.ok(remaining.includes('README.md'), 'a pinned path must survive auto-prune eviction')
  assert.ok(!remaining.includes('package.json'), 'unpinned idle paths still evict')

  const index = await readWorkspaceIndex(options)
  const indexedCodebase = findIndexedCodebase(index, codebaseId, options.workspace)
  assert.equal(indexedCodebase?.localCache?.files?.['README.md']?.pinned, true)
})

test('a path with an unacknowledged (pending) journal entry refuses eviction', async (t) => {
  const options = await makeWorkspace(t)
  const t0 = '2026-01-01T00:00:00.000Z'
  await backdateActivity(options, t0)

  await fs.appendFile(options.journal, `${JSON.stringify({
    id: randomUUID(),
    type: 'write',
    path: 'README.md',
    scope: 'shared',
    hash: hashFile('unacknowledged content\n'),
    bytes: Buffer.byteLength('unacknowledged content\n'),
    createdAt: t0,
    status: 'pending',
  })}\n`, 'utf8')

  const result = await pruneWorkspaceCache({
    ...options,
    path: 'all',
    recursive: true,
    execute: true,
    'inactive-ms': String(sevenDays),
    now: new Date(new Date(t0).getTime() + sevenDays + 1000).toISOString(),
  })

  const remaining = Object.keys(await readWorkspaceFiles(options.workspace, options)).sort()
  assert.ok(remaining.includes('README.md'), 'a path with an unacknowledged journal write must never be evicted')

  const skipReason = result.skipped.find((entry) => entry.path === 'README.md')?.reason
  assert.equal(skipReason, 'journal_pending')

  const plannedEvent = (await readNdjson(options.events)).findLast((event) => event.event === 'cache.evicted')
  assert.ok(!plannedEvent.detail.removedPaths.includes('README.md'))
})

test('the journal and events files themselves are never eviction candidates', async (t) => {
  const options = await makeWorkspace(t)
  const t0 = '2026-01-01T00:00:00.000Z'
  await backdateActivity(options, t0)

  // Adversarial setup: the journal lives inside the workspace tree (an
  // unusual but not impossible configuration) and the cloud graph happens to
  // have a visible file at that same relative path, proving the guard is a
  // real absolute-path comparison rather than relying solely on "the journal
  // is never part of the cloud file graph" being true in practice.
  const journalRelativePath = '.hopit-agent-journal.ndjson'
  const adversarialOptions = {
    ...options,
    journal: path.join(options.workspace, journalRelativePath),
  }
  await fs.writeFile(adversarialOptions.journal, '', 'utf8')

  const cloud = await readJson(options.cloud)
  cloud.files[journalRelativePath] = {
    content: 'not the real journal\n',
    scope: 'shared',
    revision: 1,
    updatedAt: t0,
  }
  await writeJson(options.cloud, cloud)

  const result = await pruneWorkspaceCache({
    ...adversarialOptions,
    path: 'all',
    recursive: true,
    execute: true,
    'inactive-ms': String(sevenDays),
    now: new Date(new Date(t0).getTime() + sevenDays + 1000).toISOString(),
  })

  const skipReason = result.skipped.find((entry) => entry.path === journalRelativePath)?.reason
  assert.equal(skipReason, 'journal_path')
  assert.equal(await fs.readFile(adversarialOptions.journal, 'utf8'), '', 'the real journal file must be untouched')
})

test('re-opening a dehydrated codebase re-materializes byte-identical content', async (t) => {
  const options = await makeWorkspace(t)
  const originalBytes = {}
  for (const relativePath of Object.keys(await readWorkspaceFiles(options.workspace, options))) {
    originalBytes[relativePath] = hashFile(await fs.readFile(path.join(options.workspace, relativePath)))
  }

  const t0 = '2026-01-01T00:00:00.000Z'
  await backdateActivity(options, t0)
  await pruneWorkspaceCache({
    ...options,
    path: 'all',
    recursive: true,
    execute: true,
    'inactive-ms': String(sevenDays),
    now: new Date(new Date(t0).getTime() + sevenDays + 1000).toISOString(),
  })
  assert.deepEqual(Object.keys(await readWorkspaceFiles(options.workspace, options)), [])

  await hydrateWorkspace(options)
  const rehydrated = await readWorkspaceFiles(options.workspace, options)
  assert.deepEqual(Object.keys(rehydrated).sort(), Object.keys(originalBytes).sort())
  for (const relativePath of Object.keys(originalBytes)) {
    const rehydratedHash = hashFile(await fs.readFile(path.join(options.workspace, relativePath)))
    assert.equal(rehydratedHash, originalBytes[relativePath], `${relativePath} must re-materialize byte-identical`)
  }
})

test("dehydrated codebase's on-disk footprint is metadata-only (bounded)", async (t) => {
  const options = await makeWorkspace(t)
  const t0 = '2026-01-01T00:00:00.000Z'
  await backdateActivity(options, t0)
  await pruneWorkspaceCache({
    ...options,
    path: 'all',
    recursive: true,
    execute: true,
    'inactive-ms': String(sevenDays),
    now: new Date(new Date(t0).getTime() + sevenDays + 1000).toISOString(),
  })

  let totalBytesOnDisk = 0
  async function walk(dir) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(entryPath)
      } else {
        totalBytesOnDisk += (await fs.stat(entryPath)).size
      }
    }
  }
  await walk(options.workspace)
  // Metadata-only: no source bytes remain in the workspace tree at all.
  assert.equal(totalBytesOnDisk, 0)
})

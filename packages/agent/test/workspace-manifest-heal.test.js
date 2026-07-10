import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readNdjson } from '../src/io.js'
import { syncOnce, refreshWorkspace } from '../src/commands/sync.js'
import { initCloud } from '../src/commands/import.js'
import { hydrateWorkspace } from '../src/commands/hydrate.js'
import { findIndexedCodebase, readWorkspaceIndex, writeWorkspaceIndex } from '../src/workspace-index.js'
import { exoneratedLocalChanges, workspaceLocalChanges } from '../src/workspace-manifest.js'

async function makeWorkspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-manifest-heal-'))
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

async function indexedCodebase(options) {
  const index = await readWorkspaceIndex(options)
  return findIndexedCodebase(index, index.codebases[0]?.id, options.workspace)
}

async function makeManifestStale(options, relativePath) {
  const index = await readWorkspaceIndex(options)
  const codebase = index.codebases[0]
  delete codebase.contentManifest.files[relativePath]
  codebase.contentManifest.fileCount = Object.keys(codebase.contentManifest.files).length
  await writeWorkspaceIndex(options, index)
}

test('syncOnce records committed files in the content manifest and leaves the scan clean', async (t) => {
  const options = await makeWorkspace(t)
  await fs.writeFile(path.join(options.workspace, 'added.txt'), 'fresh content\n', 'utf8')
  await syncOnce(options, { trigger: 'manual' })

  const codebase = await indexedCodebase(options)
  assert.ok('added.txt' in (codebase.contentManifest?.files ?? {}), 'manifest should include the synced file')

  const changes = await workspaceLocalChanges(options, codebase)
  assert.equal(changes.safe, true)
  assert.equal(changes.addedCount, 0)
  assert.equal(changes.modifiedCount, 0)
})

test('syncOnce drops deleted files from the content manifest', async (t) => {
  const options = await makeWorkspace(t)
  await fs.writeFile(path.join(options.workspace, 'temp.txt'), 'temp\n', 'utf8')
  await syncOnce(options, { trigger: 'manual' })
  assert.ok('temp.txt' in (await indexedCodebase(options)).contentManifest.files)

  await fs.rm(path.join(options.workspace, 'temp.txt'))
  await syncOnce(options, { trigger: 'manual' })

  const codebase = await indexedCodebase(options)
  assert.equal('temp.txt' in codebase.contentManifest.files, false, 'deleted file must leave the manifest')
  const changes = await workspaceLocalChanges(options, codebase)
  assert.equal(changes.safe, true)
})

test('refreshWorkspace self-heals a stale manifest whose disk files already match cloud', async (t) => {
  const options = await makeWorkspace(t)
  await fs.writeFile(path.join(options.workspace, 'committed.txt'), 'committed content\n', 'utf8')
  await syncOnce(options, { trigger: 'manual' })

  // Simulate the production deadlock: the file is committed + acknowledged in
  // cloud (identical hash) and present on disk, but missing from the manifest.
  await makeManifestStale(options, 'committed.txt')
  const staleCodebase = await indexedCodebase(options)
  const staleScan = await workspaceLocalChanges(options, staleCodebase)
  assert.equal(staleScan.safe, false, 'a stale manifest reports the committed file as drift')

  await refreshWorkspace(options)

  const healed = await indexedCodebase(options)
  assert.ok('committed.txt' in healed.contentManifest.files, 'refresh rebuilds and heals the manifest')
  const healedScan = await workspaceLocalChanges(options, healed)
  assert.equal(healedScan.safe, true)

  const events = await readNdjson(options.events)
  const complete = events.findLast((event) => event.event === 'refresh.complete')
  assert.equal(complete.detail.manifestSelfHealed, true)
  assert.deepEqual(complete.detail.manifestStaleSamplePaths, ['committed.txt'])
  assert.equal(complete.detail.manifestStalePathCount, 1)
})

test('refreshWorkspace still blocks on genuine local drift', async (t) => {
  const options = await makeWorkspace(t)
  await fs.writeFile(path.join(options.workspace, 'doc.txt'), 'v1\n', 'utf8')
  await syncOnce(options, { trigger: 'manual' })

  // Edit on disk without journaling/syncing: disk differs from cloud.
  await fs.writeFile(path.join(options.workspace, 'doc.txt'), 'v2 local only\n', 'utf8')

  await assert.rejects(
    () => refreshWorkspace(options),
    /Refresh blocked because the local workspace has unjournaled changes/,
  )
  // The genuine local edit is preserved (fail-closed).
  assert.equal(await fs.readFile(path.join(options.workspace, 'doc.txt'), 'utf8'), 'v2 local only\n')
})

test('exoneratedLocalChanges clears synced deletes but keeps genuine drift', async (t) => {
  const cloud = {
    files: {
      'keep.txt': { kind: 'file', content: 'keep\n', encoding: 'utf8' },
    },
  }
  const diskEntries = {
    'keep.txt': { kind: 'file', content: 'keep\n', encoding: 'utf8' },
    'drifted.txt': { kind: 'file', content: 'local only\n', encoding: 'utf8' },
  }
  const changes = {
    safe: false,
    addedPaths: ['drifted.txt'],
    modifiedPaths: [],
    // Deleted from disk + already absent from cloud -> not drift.
    deletedPaths: ['already-gone.txt'],
  }
  const result = exoneratedLocalChanges(changes, cloud, diskEntries)
  assert.equal(result.safe, false, 'a genuinely new local file keeps blocking')
  assert.equal(result.addedCount, 1)
  assert.equal(result.deletedCount, 0)
  assert.deepEqual(result.samplePaths, ['drifted.txt'])
  assert.equal(result.exoneratedCount, 1)
  assert.deepEqual(result.exoneratedSamplePaths, ['already-gone.txt'])
  // The returned scan is compact: no unbounded path arrays leak into events.
  assert.equal('addedPaths' in result, false)
  assert.equal('modifiedPaths' in result, false)
  assert.equal('deletedPaths' in result, false)
  assert.equal('exoneratedPaths' in result, false)

  // A committed-and-identical added file plus a synced delete exonerate fully.
  const cleanResult = exoneratedLocalChanges(
    { safe: false, addedPaths: ['keep.txt'], modifiedPaths: [], deletedPaths: ['already-gone.txt'] },
    cloud,
    diskEntries,
  )
  assert.equal(cleanResult.safe, true)
  assert.equal(cleanResult.manifestStale, true)
  assert.equal(cleanResult.exoneratedCount, 2)
  assert.deepEqual([...cleanResult.exoneratedSamplePaths].sort(), ['already-gone.txt', 'keep.txt'])
})

test('exoneratedSamplePaths is capped at 10 entries for large exonerations', async (t) => {
  const cloud = { files: {} }
  const diskEntries = {}
  const paths = []
  for (let index = 0; index < 25; index += 1) {
    const relativePath = `bulk/file-${String(index).padStart(2, '0')}.txt`
    paths.push(relativePath)
    cloud.files[relativePath] = { kind: 'file', content: `c${index}\n`, encoding: 'utf8' }
    diskEntries[relativePath] = { kind: 'file', content: `c${index}\n`, encoding: 'utf8' }
  }
  const result = exoneratedLocalChanges(
    { safe: false, addedPaths: paths, modifiedPaths: [], deletedPaths: [] },
    cloud,
    diskEntries,
  )
  assert.equal(result.safe, true)
  assert.equal(result.manifestStale, true)
  assert.equal(result.exoneratedCount, 25)
  assert.equal(result.exoneratedSamplePaths.length, 10)
})

test('workspaceLocalChanges omits full path arrays unless includePaths is requested', async (t) => {
  const options = await makeWorkspace(t)
  await fs.writeFile(path.join(options.workspace, 'seed.txt'), 'seed\n', 'utf8')
  await syncOnce(options, { trigger: 'manual' })
  // Make the workspace dirty with an unjournaled file.
  await fs.writeFile(path.join(options.workspace, 'unjournaled.txt'), 'dirty\n', 'utf8')

  const codebase = await indexedCodebase(options)
  const compact = await workspaceLocalChanges(options, codebase)
  assert.equal(compact.safe, false)
  assert.equal(compact.addedCount, 1)
  assert.equal('addedPaths' in compact, false)
  assert.equal('modifiedPaths' in compact, false)
  assert.equal('deletedPaths' in compact, false)
  assert.deepEqual(compact.samplePaths, ['unjournaled.txt'])

  const detailed = await workspaceLocalChanges(options, codebase, { includePaths: true })
  assert.deepEqual(detailed.addedPaths, ['unjournaled.txt'])
})

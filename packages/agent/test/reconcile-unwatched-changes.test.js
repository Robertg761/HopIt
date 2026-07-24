import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readNdjson } from '../src/io.js'
import { initCloud } from '../src/commands/import.js'
import { hydrateWorkspace } from '../src/commands/hydrate.js'
import { syncOnce } from '../src/commands/sync.js'
import { reconcileUnwatchedChanges, watchWorkspace } from '../src/watch.js'
import { classifyReconnectEntry, reconnectBucket, synthesizeDiffScanEntries } from '../src/reconnect.js'
import { findIndexedCodebase, readWorkspaceIndex } from '../src/workspace-index.js'
import { readWorkspaceFiles } from '../src/workspace-manifest.js'

// GR-A4 (decisions §1: unified reconciliation). On startup, a diff-scan
// against the workspace's last-known content manifest synthesizes journal
// entries for edits made while the agent was not running (offline, crashed,
// force-quit, or a workspace folder restored from an external backup), then
// the normal GR-A1 classification pass replays or opens a divergence for
// each one -- one path for all four cases, never a second startup-only
// mechanism.

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex')
}

async function makeWorkspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-reconcile-unwatched-'))
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

async function indexedCodebase(options) {
  const index = await readWorkspaceIndex(options)
  return findIndexedCodebase(index, index.codebases[0]?.id, options.workspace)
}

async function readCloud(options) {
  return JSON.parse(await fs.readFile(options.cloud, 'utf8'))
}

async function eventsSince(options, offset) {
  const events = await readNdjson(options.events)
  return events.slice(offset)
}

// ---------------------------------------------------------------------------
// Unit-level: synthesizeDiffScanEntries (pure, I/O injected)
// ---------------------------------------------------------------------------

test('synthesizeDiffScanEntries builds write entries carrying the baseline revision as baseRevision', async () => {
  const baseline = {
    files: {
      'modified.txt': { revision: 4, scope: 'shared' },
    },
  }
  const diff = { addedPaths: ['added.txt'], modifiedPaths: ['modified.txt'], deletedPaths: [] }
  const disk = {
    'added.txt': { kind: 'file', hash: hashContent('added\n'), size: 6, scope: 'shared' },
    'modified.txt': { kind: 'file', hash: hashContent('modified\n'), size: 9, scope: 'shared' },
  }
  const entries = await synthesizeDiffScanEntries({ diff, baseline, readDiskEntry: (p) => disk[p] ?? null })

  const added = entries.find((entry) => entry.path === 'added.txt')
  const modified = entries.find((entry) => entry.path === 'modified.txt')
  assert.equal(added.type, 'write')
  assert.equal(added.baseRevision, null, 'a genuinely new path carries no known base revision')
  assert.equal(added.synthesized, true)
  assert.equal(modified.type, 'write')
  assert.equal(modified.baseRevision, 4, 'a modified path carries the baseline manifest revision for that path')
})

test('synthesizeDiffScanEntries tags deleted-path entries with forceDivergence only when massDeleteShaped', async () => {
  const baseline = { files: { 'gone.txt': { revision: 2, scope: 'shared' } } }
  const diff = { addedPaths: [], modifiedPaths: [], deletedPaths: ['gone.txt'] }

  const normal = await synthesizeDiffScanEntries({ diff, baseline, readDiskEntry: async () => null, massDeleteShaped: false })
  assert.equal(normal[0].type, 'delete')
  assert.equal(normal[0].baseRevision, 2)
  assert.equal('forceDivergence' in normal[0], false)

  const guarded = await synthesizeDiffScanEntries({ diff, baseline, readDiskEntry: async () => null, massDeleteShaped: true })
  assert.equal(guarded[0].forceDivergence, true)
  assert.equal(guarded[0].forceDivergenceReason, 'restored_workspace_deletion_guard')
})

// ---------------------------------------------------------------------------
// Unit-level: classifyReconnectEntry's forceDivergence handling
// ---------------------------------------------------------------------------

test('classifyReconnectEntry forces a divergence for a forced-divergence delete when cloud still has the file', () => {
  const cloud = { files: { 'README.md': { kind: 'file', content: 'still on cloud\n', encoding: 'utf8', hash: hashContent('still on cloud\n'), size: 15, scope: 'shared', revision: 5 } } }
  // Even though baseRevision matches the cloud head exactly (which would
  // normally mean "only local touched" -> replay), forceDivergence must win.
  const entry = { id: 'e1', type: 'delete', path: 'README.md', scope: 'shared', baseRevision: 5, forceDivergence: true, forceDivergenceReason: 'restored_workspace_deletion_guard' }
  const classification = classifyReconnectEntry(cloud, entry)
  assert.equal(classification.bucket, reconnectBucket.diverged)
  assert.equal(classification.reason, 'restored_workspace_deletion_guard')
  assert.equal(classification.localSide, 'deleted')
})

test('classifyReconnectEntry lets a forced-divergence delete fall through to the normal both-deleted auto-resolve once cloud no longer has the file', () => {
  const cloud = { files: {} }
  const entry = { id: 'e1', type: 'delete', path: 'README.md', scope: 'shared', baseRevision: 5, forceDivergence: true, forceDivergenceReason: 'restored_workspace_deletion_guard' }
  const classification = classifyReconnectEntry(cloud, entry)
  assert.equal(classification.bucket, reconnectBucket.autoResolved)
  assert.equal(classification.reason, 'both_deleted')
})

// ---------------------------------------------------------------------------
// Integration: kill agent, edit files, restart via watchWorkspace
// ---------------------------------------------------------------------------

test('watchWorkspace journals and acknowledges an edit made while the agent was not running', async (t) => {
  const options = await makeWorkspace(t)
  await fs.writeFile(path.join(options.workspace, 'notes.txt'), 'v1\n', 'utf8')
  await syncOnce(options, { trigger: 'manual' })

  // Simulate the agent being dead: no watcher running while this edit lands.
  await fs.writeFile(path.join(options.workspace, 'notes.txt'), 'v2 offline edit\n', 'utf8')

  const before = (await readNdjson(options.events)).length
  const handle = await watchWorkspace(options)
  t.after(() => handle?.close())
  const newEvents = await eventsSince(options, before)

  const scanned = newEvents.find((event) => event.event === 'watch.diff_scan_synthesized')
  assert.ok(scanned, 'diff-scan must synthesize and emit a summary event')
  assert.equal(scanned.detail.modifiedCount, 1)
  assert.equal(scanned.detail.synthesizedCount, 1)
  assert.equal(scanned.detail.massDeleteShaped, false)

  const recovered = newEvents.find((event) => event.event === 'journal.recovery_complete')
  assert.ok(recovered, 'recovery must run against the synthesized entry')
  assert.equal(recovered.detail.diverged, 0)
  assert.equal(recovered.detail.acknowledged, 1)

  const cloud = await readCloud(options)
  assert.equal(cloud.files['notes.txt'].content, 'v2 offline edit\n')

  // Ordering: the diff-scan event must precede the recovery-complete event.
  assert.ok(newEvents.indexOf(scanned) < newEvents.indexOf(recovered))
})

test('watchWorkspace journals a brand-new file created while the agent was not running', async (t) => {
  const options = await makeWorkspace(t)
  await fs.writeFile(path.join(options.workspace, 'created-offline.txt'), 'new content\n', 'utf8')

  const before = (await readNdjson(options.events)).length
  const handle = await watchWorkspace(options)
  t.after(() => handle?.close())
  const newEvents = await eventsSince(options, before)

  const scanned = newEvents.find((event) => event.event === 'watch.diff_scan_synthesized')
  assert.ok(scanned)
  assert.equal(scanned.detail.addedCount, 1)

  const cloud = await readCloud(options)
  assert.equal(cloud.files['created-offline.txt'].content, 'new content\n')
})

test('watchWorkspace replays a small offline deletion as a normal delete (no mass-delete guard)', async (t) => {
  const options = await makeWorkspace(t)
  await fs.writeFile(path.join(options.workspace, 'temp.txt'), 'temp\n', 'utf8')
  await syncOnce(options, { trigger: 'manual' })

  await fs.rm(path.join(options.workspace, 'temp.txt'))

  const before = (await readNdjson(options.events)).length
  const handle = await watchWorkspace(options)
  t.after(() => handle?.close())
  const newEvents = await eventsSince(options, before)

  const scanned = newEvents.find((event) => event.event === 'watch.diff_scan_synthesized')
  assert.ok(scanned)
  assert.equal(scanned.detail.deletedCount, 1)
  assert.equal(scanned.detail.massDeleteShaped, false)

  const recovered = newEvents.find((event) => event.event === 'journal.recovery_complete')
  assert.equal(recovered.detail.diverged, 0)
  assert.equal(recovered.detail.acknowledged, 1)

  const cloud = await readCloud(options)
  assert.equal('temp.txt' in cloud.files, false)
})

test('watchWorkspace opens a divergence for an offline edit that genuinely conflicts with a Main change (crash + real divergence)', async (t) => {
  const options = await makeWorkspace(t)
  await fs.writeFile(path.join(options.workspace, 'shared.txt'), 'v1\n', 'utf8')
  await syncOnce(options, { trigger: 'manual' })

  // While this device was "crashed", another device committed a different
  // edit to the same path directly to cloud.
  const cloud = await readCloud(options)
  cloud.files['shared.txt'] = {
    ...cloud.files['shared.txt'],
    content: 'main moved on without me\n',
    hash: hashContent('main moved on without me\n'),
    size: Buffer.byteLength('main moved on without me\n'),
    revision: (cloud.files['shared.txt'].revision ?? 1) + 1,
  }
  cloud.revision = (cloud.revision ?? 1) + 1
  await fs.writeFile(options.cloud, JSON.stringify(cloud, null, 2), 'utf8')

  // Meanwhile this device made its own unwatched offline edit to the same file.
  await fs.writeFile(path.join(options.workspace, 'shared.txt'), 'my offline draft\n', 'utf8')

  const before = (await readNdjson(options.events)).length
  const handle = await watchWorkspace(options)
  t.after(() => handle?.close())
  const newEvents = await eventsSince(options, before)

  const recovered = newEvents.find((event) => event.event === 'journal.recovery_complete')
  assert.equal(recovered.detail.diverged, 1)
  assert.deepEqual(recovered.detail.divergedPaths, ['shared.txt'])

  const diverged = newEvents.find((event) => event.event === 'journal.reconnect_diverged')
  assert.equal(diverged.detail.reason, 'content_differs')

  // Neither side is lost: the local file is untouched, and cloud keeps the
  // other device's content until the user resolves.
  assert.equal(await fs.readFile(path.join(options.workspace, 'shared.txt'), 'utf8'), 'my offline draft\n')
  const cloudAfter = await readCloud(options)
  assert.equal(cloudAfter.files['shared.txt'].content, 'main moved on without me\n')
})

// ---------------------------------------------------------------------------
// Integration: restored-from-backup (Time-Machine-style) mass-delete guard
// ---------------------------------------------------------------------------

test('watchWorkspace opens divergences instead of mass-deleting when a restored workspace is missing most of its known files', async (t) => {
  const options = await makeWorkspace(t)

  const total = 150
  for (let index = 0; index < total; index += 1) {
    await fs.writeFile(path.join(options.workspace, `file${String(index).padStart(3, '0')}.txt`), `content-${index}\n`, 'utf8')
  }
  await syncOnce(options, { trigger: 'manual' })

  const beforeCodebase = await indexedCodebase(options)
  const baselineCount = Object.keys(beforeCodebase.contentManifest.files).length
  assert.ok(baselineCount >= total, 'baseline manifest should record every synced file')

  // Simulate a workspace folder restored from an old backup: most files are
  // simply missing from disk, as if the restore predates them.
  const keep = 10
  for (let index = keep; index < total; index += 1) {
    await fs.rm(path.join(options.workspace, `file${String(index).padStart(3, '0')}.txt`))
  }

  const before = (await readNdjson(options.events)).length
  const handle = await watchWorkspace(options)
  t.after(() => handle?.close())
  const newEvents = await eventsSince(options, before)

  const scanned = newEvents.find((event) => event.event === 'watch.diff_scan_synthesized')
  assert.ok(scanned)
  assert.equal(scanned.detail.deletedCount, total - keep)
  assert.equal(scanned.detail.massDeleteShaped, true)

  const recovered = newEvents.find((event) => event.event === 'journal.recovery_complete')
  assert.equal(recovered.detail.diverged, total - keep, 'every missing file opens a divergence instead of replaying a delete')
  assert.equal(recovered.detail.acknowledged, 0, 'nothing is silently deleted from cloud')

  // Nothing was mass-deleted from cloud: every original file is still there.
  const cloud = await readCloud(options)
  assert.equal(Object.keys(cloud.files).length, baselineCount)

  // Divergence records were persisted for each missing path, with cloud
  // content still recoverable and nothing about "mine" fabricated (the local
  // side genuinely has no content, so localEntry stays null).
  assert.equal(cloud.divergences.length, total - keep)
  for (const record of cloud.divergences) {
    assert.equal(record.state, 'open')
    assert.equal(record.reason, 'restored_workspace_deletion_guard')
    assert.equal(record.localSide, 'deleted')
    assert.equal(record.localEntry, null)
  }

  // The local workspace is left exactly as the restore left it -- nothing
  // auto-restored, nothing further deleted -- until the user resolves.
  const diskFiles = Object.keys(await readWorkspaceFiles(options.workspace, options))
  assert.equal(diskFiles.length, baselineCount - (total - keep))
})

// ---------------------------------------------------------------------------
// Ordering invariant: personal reconciliation completes fully before the
// safe-refresh path applies missed Main updates (never interleaved).
// ---------------------------------------------------------------------------

test('watchWorkspace startup reconciles the personal change set fully before applying a Main update made while this device was away', async (t) => {
  const options = await makeWorkspace(t)
  await fs.writeFile(path.join(options.workspace, 'local.txt'), 'v1\n', 'utf8')
  await syncOnce(options, { trigger: 'manual' })

  // "Main moved while away": another device's commit landed directly on cloud.
  const cloudBefore = await readCloud(options)
  cloudBefore.files['from-main.txt'] = {
    kind: 'file',
    content: 'arrived while this device was away\n',
    encoding: 'utf8',
    hash: hashContent('arrived while this device was away\n'),
    size: Buffer.byteLength('arrived while this device was away\n'),
    scope: 'shared',
    revision: (cloudBefore.revision ?? 1) + 1,
  }
  cloudBefore.revision = (cloudBefore.revision ?? 1) + 1
  await fs.writeFile(options.cloud, JSON.stringify(cloudBefore, null, 2), 'utf8')

  // This device's own unwatched offline edit, to be reconciled first.
  await fs.writeFile(path.join(options.workspace, 'local.txt'), 'v2 offline edit\n', 'utf8')

  const before = (await readNdjson(options.events)).length
  const handle = await watchWorkspace(options)
  t.after(() => handle?.close())
  const events = await eventsSince(options, before)

  const scannedIndex = events.findIndex((event) => event.event === 'watch.diff_scan_synthesized')
  const recoveredIndex = events.findIndex((event) => event.event === 'journal.recovery_complete')
  // `workspace.ready` (from hydrateWorkspace) is where a Main update this
  // device missed while away actually lands on disk -- watchWorkspace's own
  // startup sequence (reconcile -> recover -> hydrate) is what this asserts.
  const readyIndex = events.findIndex((event) => event.event === 'workspace.ready')

  assert.ok(scannedIndex >= 0 && recoveredIndex >= 0 && readyIndex >= 0, 'all three phases ran')
  assert.ok(scannedIndex < recoveredIndex, 'diff-scan synthesis must complete before recovery classifies it')
  assert.ok(recoveredIndex < readyIndex, 'reconciliation must complete before the missed Main update is applied')

  const cloud = await readCloud(options)
  assert.equal(cloud.files['local.txt'].content, 'v2 offline edit\n')

  const finalDiskFiles = Object.keys(await readWorkspaceFiles(options.workspace, options))
  assert.ok(finalDiskFiles.includes('from-main.txt'), 'the missed Main update is applied after reconciliation completes')
})

// ---------------------------------------------------------------------------
// Non-interference: a clean restart with no unwatched drift is a no-op.
// ---------------------------------------------------------------------------

test('reconcileUnwatchedChanges is a no-op on a clean, unmodified workspace', async (t) => {
  const options = await makeWorkspace(t)
  await fs.writeFile(path.join(options.workspace, 'clean.txt'), 'clean\n', 'utf8')
  await syncOnce(options, { trigger: 'manual' })

  const before = (await readNdjson(options.events)).length
  const journalBefore = (await readNdjson(options.journal)).length
  const result = await reconcileUnwatchedChanges(options)
  assert.equal(result.scanned, true)
  assert.equal(result.synthesizedCount, 0)

  const newEvents = await eventsSince(options, before)
  assert.equal(newEvents.some((event) => event.event === 'watch.diff_scan_synthesized'), false, 'a clean scan emits no summary event')

  const journalAfter = (await readNdjson(options.journal)).length
  assert.equal(journalAfter, journalBefore, 'nothing is appended to the journal when nothing changed')
})

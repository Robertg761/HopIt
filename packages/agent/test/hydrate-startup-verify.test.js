import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readNdjson } from '../src/io.js'
import { initCloud } from '../src/commands/import.js'
import { hydrateWorkspace } from '../src/commands/hydrate.js'
import { watchWorkspace } from '../src/watch.js'
import { readWorkspaceFiles } from '../src/workspace-manifest.js'

async function makeWorkspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-hydrate-verify-'))
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

async function eventsSince(options, offset) {
  const events = await readNdjson(options.events)
  return events.slice(offset)
}

test('re-hydrating an unchanged materialized workspace skips every file (no file.hydrated)', async (t) => {
  const options = await makeWorkspace(t)
  const diskFiles = Object.keys(await readWorkspaceFiles(options.workspace, options))
  assert.ok(diskFiles.length >= 3, 'fixture should materialize several files')

  const before = (await readNdjson(options.events)).length
  await hydrateWorkspace(options)
  const newEvents = await eventsSince(options, before)

  const hydratedAgain = newEvents.filter((entry) => entry.event === 'file.hydrated')
  assert.equal(hydratedAgain.length, 0, 'a clean workspace must not re-emit per-file file.hydrated')

  const ready = newEvents.findLast((entry) => entry.event === 'workspace.ready')
  assert.ok(ready, 'the second pass still reaches workspace.ready')
  assert.equal(ready.detail.materializedFileCount, 0)
  assert.equal(ready.detail.verifiedFileCount, diskFiles.length)

  // Disk content is untouched by the verify pass.
  const stillThere = Object.keys(await readWorkspaceFiles(options.workspace, options))
  assert.deepEqual(stillThere.sort(), diskFiles.sort())
})

test('re-hydrate slow-paths only files that are missing or dirty on disk', async (t) => {
  const options = await makeWorkspace(t)

  // Missing file: deleted from disk. Dirty file: edited away from cloud.
  await fs.rm(path.join(options.workspace, 'README.md'))
  await fs.writeFile(path.join(options.workspace, 'package.json'), 'local drift\n', 'utf8')

  const before = (await readNdjson(options.events)).length
  await hydrateWorkspace(options)
  const newEvents = await eventsSince(options, before)

  const hydratedPaths = newEvents
    .filter((entry) => entry.event === 'file.hydrated')
    .map((entry) => entry.detail.path)
    .sort()
  assert.deepEqual(hydratedPaths, ['README.md', 'package.json'])

  // The missing file is restored and the drifted file is rewritten to cloud.
  assert.equal(
    await fs.readFile(path.join(options.workspace, 'README.md'), 'utf8'),
    '# hopit-core\n\nThis file hydrates from the HopIt cloud graph.\n',
  )
  assert.equal(
    await fs.readFile(path.join(options.workspace, 'package.json'), 'utf8'),
    '{\n  "name": "hopit-core",\n  "private": true,\n  "type": "module"\n}\n',
  )

  const ready = newEvents.findLast((entry) => entry.event === 'workspace.ready')
  assert.equal(ready.detail.materializedFileCount, 2)
})

test('watch startup on a materialized workspace reaches watch.started without re-materializing', async (t) => {
  const options = await makeWorkspace(t)
  const diskFiles = Object.keys(await readWorkspaceFiles(options.workspace, options))

  const before = (await readNdjson(options.events)).length
  const handle = await watchWorkspace(options)
  t.after(() => handle?.close())

  const newEvents = await eventsSince(options, before)
  const started = newEvents.findLast((entry) => entry.event === 'watch.started')
  assert.ok(started, 'watch startup must reach watch.started')
  assert.equal(started.detail.state, 'watching')

  const hydratedAgain = newEvents.filter((entry) => entry.event === 'file.hydrated')
  assert.equal(hydratedAgain.length, 0, 'watch restart must not re-download a clean workspace')

  const ready = newEvents.findLast((entry) => entry.event === 'workspace.ready')
  assert.equal(ready.detail.verifiedFileCount, diskFiles.length)
  assert.equal(ready.detail.materializedFileCount, 0)
})

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readNdjson } from '../src/io.js'
import { materializeCloudToWorkspace, refreshWorkspace, syncOnce } from '../src/commands/sync.js'
import { initCloud } from '../src/commands/import.js'
import { hydrateWorkspace } from '../src/commands/hydrate.js'
import { readWorkspaceFiles } from '../src/workspace-manifest.js'
import { normalizeCloudFileEntry } from '../src/journal.js'

async function makeTempRoot(t, label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `hopit-${label}-`))
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
  return root
}

async function makeWorkspace(t) {
  const root = await makeTempRoot(t, 'refresh-guard')
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

// Build a minimal visible cloud graph that keeps `keptPaths` (identical to disk)
// and reports the remaining disk files as hidden/deleted.
function cloudKeeping(keptPaths, contents, { role = 'owner', diskCount }) {
  const files = {}
  for (const relativePath of keptPaths) {
    files[relativePath] = normalizeCloudFileEntry(relativePath, {
      kind: 'file',
      content: contents.get(relativePath),
      encoding: 'utf8',
    })
  }
  const hiddenFileCount = Math.max(0, diskCount - keptPaths.length)
  return {
    revision: 1,
    codebase: { id: 'guard-codebase', name: 'guard-codebase', ownerId: 'user_demo_owner' },
    owner: { id: 'user_demo_owner' },
    files,
    visibilityContext: {
      role,
      isOwner: role === 'owner',
      isCollaborator: false,
      visibleFileCount: keptPaths.length,
      hiddenFileCount,
      hiddenScopeCounts: { shared: hiddenFileCount, private: 0 },
    },
  }
}

async function populateWorkspace(dir, count, prefix = 'file') {
  await fs.mkdir(dir, { recursive: true })
  const contents = new Map()
  const paths = []
  for (let index = 0; index < count; index += 1) {
    const relativePath = `${prefix}${String(index).padStart(3, '0')}.txt`
    const content = `content-${index}\n`
    await fs.writeFile(path.join(dir, relativePath), content, 'utf8')
    contents.set(relativePath, content)
    paths.push(relativePath)
  }
  return { paths, contents }
}

test('refresh blocks and deletes nothing when a guest read yields an empty visible graph', async (t) => {
  const options = await makeWorkspace(t)
  // Populate + sync several files as the owner so the manifest is clean.
  for (let index = 0; index < 6; index += 1) {
    await fs.writeFile(path.join(options.workspace, `owned-${index}.txt`), `owned ${index}\n`, 'utf8')
  }
  await syncOnce(options, { trigger: 'manual' })

  const before = Object.keys(await readWorkspaceFiles(options.workspace, options))
  assert.ok(before.length >= 6, 'workspace should hold a non-trivial number of files')

  // A session id without a requester id reads the cloud as a guest -> zero visible files.
  const guestOptions = { ...options, 'session-id': 'session_guest_device' }
  await assert.rejects(
    () => refreshWorkspace(guestOptions),
    /visible cloud graph has 0 files/,
  )

  const after = Object.keys(await readWorkspaceFiles(options.workspace, options))
  assert.deepEqual(after.sort(), before.sort(), 'no workspace files may be deleted when the guard blocks')

  const events = await readNdjson(options.events)
  const blocked = events.findLast((entry) => entry.event === 'refresh.blocked')
  assert.ok(blocked, 'a refresh.blocked event must be emitted')
  assert.equal(blocked.detail.reason, 'visible_graph_empty_local_files_present')
  assert.equal(blocked.detail.visibleFileCount, 0)
  assert.equal(blocked.detail.requesterRole, 'guest')
  assert.ok(blocked.detail.hiddenFileCount > 0)
  assert.equal(blocked.detail.wouldDeleteCount, before.length)
})

test('materialize blocks a mass delete and --allow-mass-delete lets it proceed', async (t) => {
  const root = await makeTempRoot(t, 'refresh-budget')
  const workspace = path.join(root, 'workspace')
  const events = path.join(root, 'events.ndjson')
  const { paths, contents } = await populateWorkspace(workspace, 150)

  const kept = paths.slice(0, 5)
  const cloud = cloudKeeping(kept, contents, { role: 'owner', diskCount: paths.length })
  const options = { quiet: true, workspace, events }

  await assert.rejects(
    () => materializeCloudToWorkspace(options, cloud, null),
    /would delete 145 of 150/,
  )

  const afterBlock = Object.keys(await readWorkspaceFiles(workspace, options))
  assert.equal(afterBlock.length, 150, 'nothing may be deleted while the guard blocks')

  const events0 = await readNdjson(events)
  const blocked = events0.findLast((entry) => entry.event === 'refresh.blocked')
  assert.equal(blocked.detail.reason, 'refresh_would_mass_delete')
  assert.equal(blocked.detail.wouldDeleteCount, 145)
  assert.equal(blocked.detail.diskFileCount, 150)

  // The explicit opt-in flag lets the mass delete proceed.
  const result = await materializeCloudToWorkspace(
    { ...options, 'allow-mass-delete': true },
    cloud,
    null,
  )
  assert.equal(result.deleted, 145)
  const afterAllow = Object.keys(await readWorkspaceFiles(workspace, options))
  assert.equal(afterAllow.length, 5)
  assert.deepEqual(afterAllow.sort(), kept.sort())
})

test('materialize allows a normal small deletion without the flag', async (t) => {
  const root = await makeTempRoot(t, 'refresh-small')
  const workspace = path.join(root, 'workspace')
  const events = path.join(root, 'events.ndjson')
  const { paths, contents } = await populateWorkspace(workspace, 20)

  const kept = paths.slice(0, 18) // cloud legitimately dropped 2 files
  const cloud = cloudKeeping(kept, contents, { role: 'owner', diskCount: paths.length })
  const options = { quiet: true, workspace, events }

  const result = await materializeCloudToWorkspace(options, cloud, null)
  assert.equal(result.deleted, 2)
  const after = Object.keys(await readWorkspaceFiles(workspace, options))
  assert.equal(after.length, 18)
  assert.equal(after.includes('file018.txt'), false)
  assert.equal(after.includes('file000.txt'), true)

  const emitted = await readNdjson(events)
  assert.equal(emitted.some((entry) => entry.event === 'refresh.blocked'), false)
})

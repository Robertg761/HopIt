// GR-E3 (decisions §8/§9): creating a release pushes an annotated git tag
// (release name + notes in the tag message) at the mirror commit for that
// release's pinned Main revision.
//
// Covers: no mirror configured -> `mirrorTag: null`, no error, release still
// created; mirror configured and caught up -> tag lands on the correct
// mirror commit, tag message carries the notes, and the tagged commit's
// tree hash equals the mirrored tree hash captured independently at
// mirror-sync time (the metric); mirror configured but not yet caught up to
// the release's pinned revision -> release still succeeds, tagging failure
// surfaces as a `git.mirror_tag_failed` event, never blocks the release;
// invalid release names as git tag names are rejected.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import { initCloud } from '../src/commands/import.js'
import { hydrateWorkspace } from '../src/commands/hydrate.js'
import { syncOnce, openChangeSetReview, mergeChangeSet } from '../src/commands/sync.js'
import { runMirrorSync, assertSafeGitTagName } from '../src/commands/mirror.js'
import { createRelease } from '../src/commands/release.js'
import { createCloudGraphService } from '../src/cloud/d1-graph-service.js'
import { readNdjson } from '../src/io.js'

async function makeTempRoot(t, label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `hopit-${label}-`))
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
  return root
}

async function makeBareRemote(root, name) {
  const remotePath = path.join(root, `${name}.git`)
  runGitOrThrow(['init', '--bare', '--quiet', remotePath], root)
  return remotePath
}

function runGitOrThrow(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result
}

function treeShaOf(remotePath, rev) {
  return runGitOrThrow(['rev-parse', `${rev}^{tree}`], remotePath).stdout.trim()
}

async function makeWorkspace(t, root) {
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

async function writeAndSync(options, relativePath, content) {
  await fs.mkdir(path.dirname(path.join(options.workspace, relativePath)), { recursive: true })
  await fs.writeFile(path.join(options.workspace, relativePath), content, 'utf8')
  return syncOnce(options, { trigger: 'manual' })
}

// A release always pins the current *Main* revision, so tests that assert
// something about the pinned revision need to actually land the change on
// Main (not just leave it sitting in an open change set) via the same
// review/merge steps `hop merge` takes.
async function writeSyncAndMerge(options, relativePath, content) {
  await writeAndSync(options, relativePath, content)
  await openChangeSetReview(options)
  return mergeChangeSet(options)
}

async function lastEvent(options, eventName) {
  const rows = await readNdjson(options.events).catch(() => [])
  const match = rows.filter((row) => row.event === eventName).at(-1)
  return match ? match.detail : null
}

test('release with no mirror configured tags nothing and does not error', async (t) => {
  const root = await makeTempRoot(t, 'release-tag-no-mirror')
  const options = await makeWorkspace(t, root)

  const release = await createRelease(options, { name: 'v1.0' })
  assert.equal(release.mirrorTag, null)

  const failed = await lastEvent(options, 'git.mirror_tag_failed')
  assert.equal(failed, null, 'no tag-failed event when no mirror is configured at all')
})

test('release pushes an annotated tag at the mirror commit; tag message carries the notes; tree hash matches the mirror', async (t) => {
  const root = await makeTempRoot(t, 'release-tag')
  const options = await makeWorkspace(t, root)
  const remote = await makeBareRemote(root, 'origin')

  await writeSyncAndMerge(options, 'src/a.txt', 'first change\n')
  const mirrored = await runMirrorSync({ ...options, remote })
  assert.equal(mirrored.ok, true)

  // Independently captured, at mirror-sync time, from the bare remote --
  // this is "the release revision's mirrored tree hash" the metric compares
  // the tag against.
  const expectedTreeSha = treeShaOf(remote, 'main')
  const expectedCommitSha = runGitOrThrow(['rev-parse', 'main'], remote).stdout.trim()

  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()
  assert.equal(cloud.main.revision, mirrored.lastMirroredRevision, 'release will pin exactly the revision just mirrored')

  const release = await createRelease({ ...options, remote }, { name: 'v1.0', notes: 'First cut of the mirror.' })
  assert.ok(release.mirrorTag, 'release auto-tagged the mirror')
  assert.equal(release.mirrorTag.tagName, 'v1.0')
  assert.equal(release.mirrorTag.commitSha, expectedCommitSha, 'tag lands on the exact mirror commit for the pinned revision')
  assert.equal(release.mirrorTag.treeSha, expectedTreeSha, 'GR-E3 metric: tag commit tree hash equals the release revision mirrored tree hash')

  // The tag actually exists on the remote, peeling to the right commit, with
  // the release name + notes as the tag message.
  const tagList = runGitOrThrow(['tag', '-l', 'v1.0'], remote).stdout.trim().split('\n')
  assert.deepEqual(tagList, ['v1.0'])
  const peeled = runGitOrThrow(['rev-parse', 'refs/tags/v1.0^{}'], remote).stdout.trim()
  assert.equal(peeled, expectedCommitSha)
  const tagMessage = runGitOrThrow(['tag', '-l', '--format=%(contents)', 'v1.0'], remote).stdout
  assert.match(tagMessage, /^v1\.0/)
  assert.match(tagMessage, /First cut of the mirror\./)

  const tagged = await lastEvent(options, 'git.mirror_tagged')
  assert.ok(tagged)
  assert.equal(tagged.commitSha, expectedCommitSha)
})

test('release created before the mirror catches up: release still succeeds, tagging failure is a non-blocking notification', async (t) => {
  const root = await makeTempRoot(t, 'release-tag-behind')
  const options = await makeWorkspace(t, root)
  const remote = await makeBareRemote(root, 'origin')

  // Mirror is configured and has synced once, but the workspace advances
  // again *without* another mirror-sync before the release is created --
  // the mirror has not caught up to the revision being released.
  await runMirrorSync({ ...options, remote })
  await writeSyncAndMerge(options, 'src/b.txt', 'not yet mirrored\n')

  const release = await createRelease({ ...options, remote }, { name: 'v2.0' })
  assert.ok(release.releaseId, 'the release itself is created regardless of tagging failure')
  assert.equal(release.mirrorTag, null)

  const failed = await lastEvent(options, 'git.mirror_tag_failed')
  assert.ok(failed, 'tagging failure surfaced as a notification event')
  assert.equal(failed.releaseId, release.releaseId)
  assert.match(failed.error, /mirror-sync/)

  const tags = runGitOrThrow(['tag', '-l'], remote).stdout.trim()
  assert.equal(tags, '', 'no tag was pushed for the un-mirrored revision')
})

test('assertSafeGitTagName rejects names that are not valid git refs', () => {
  assert.throws(() => assertSafeGitTagName('has a space'), /not usable as a git tag name/)
  assert.throws(() => assertSafeGitTagName('bad..name'), /not usable as a git tag name/)
  assert.throws(() => assertSafeGitTagName(''), /non-empty string/)
  assert.doesNotThrow(() => assertSafeGitTagName('v1.2.3'))
  assert.doesNotThrow(() => assertSafeGitTagName('-looks-like-a-flag'))
})

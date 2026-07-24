import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import { initCloud } from '../src/commands/import.js'
import { hydrateWorkspace } from '../src/commands/hydrate.js'
import { syncOnce } from '../src/commands/sync.js'
import { runMirrorSync } from '../src/commands/mirror.js'
import { readJson } from '../src/io.js'

async function makeTempRoot(t, label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `hopit-${label}-`))
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
  return root
}

async function makeBareRemote(t, root, name) {
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

// Clone `remotePath` into a temp checkout and return { files: Map<relativePath, Buffer> }
// covering everything except `.git`.
async function checkoutRemote(t, root, remotePath, label) {
  const checkoutDir = path.join(root, `checkout-${label}`)
  runGitOrThrow(['clone', '--quiet', '--branch', 'main', remotePath, checkoutDir], root)
  const files = new Map()
  await walk(checkoutDir, checkoutDir, files)
  return files
}

async function walk(root, dir, files) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === '.git') continue
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(root, absolute, files)
    } else {
      const relative = path.relative(root, absolute).split(path.sep).join('/')
      files.set(relative, await fs.readFile(absolute))
    }
  }
}

function commitLog(remotePath, branch = 'main') {
  const result = runGitOrThrow(['log', '--format=%H', branch], remotePath)
  return result.stdout.trim().split('\n').filter(Boolean)
}

test('mirror-sync creates one commit per Main revision advance and is idempotent on re-run', async (t) => {
  const root = await makeTempRoot(t, 'mirror-sync')
  const options = await makeWorkspace(t, root)
  const remote = await makeBareRemote(t, root, 'origin')

  // Consume the fixture's baseline revision (1) first so the "3 changes -> 3
  // commits" assertion below is not muddied by the initial seed commit.
  const baseline = await runMirrorSync({ ...options, remote })
  assert.equal(baseline.ok, true)
  assert.ok(baseline.commitsCreated >= 1)

  await writeAndSync(options, 'src/a.txt', 'first change\n')
  await writeAndSync(options, 'src/b.txt', 'second change\n')
  await writeAndSync(options, 'src/a.txt', 'first change, revised\n')

  const synced = await runMirrorSync({ ...options, remote })
  assert.equal(synced.ok, true)
  assert.equal(synced.commitsCreated, 3, 'one commit per merged Main revision advance')

  const commitsAfterFirstRun = commitLog(remote)

  // Re-run with no new source revisions: idempotent, zero new commits.
  const rerun = await runMirrorSync({ ...options, remote })
  assert.equal(rerun.commitsCreated, 0)
  assert.deepEqual(commitLog(remote), commitsAfterFirstRun, 'no new commits landed on re-run')

  // Checkout of mirror HEAD is byte-identical to the Main snapshot.
  const cloud = await readJson(options.cloud)
  const checkedOut = await checkoutRemote(t, root, remote, 'head')

  assert.equal(checkedOut.has('.private/agent-note.md'), false, '.private/ paths never enter the mirror')

  const expectedSharedPaths = Object.keys(cloud.files).filter((p) => !p.startsWith('.private/'))
  assert.deepEqual([...checkedOut.keys()].sort(), expectedSharedPaths.sort())

  for (const relativePath of expectedSharedPaths) {
    const file = cloud.files[relativePath]
    const expectedBuffer = Buffer.from(file.content ?? '', file.encoding === 'base64' ? 'base64' : 'utf8')
    assert.deepEqual(checkedOut.get(relativePath), expectedBuffer, `${relativePath} is byte-identical to the Main snapshot`)
  }
})

test('mirror-sync rejects malformed remote URLs via the existing git validators', async (t) => {
  const root = await makeTempRoot(t, 'mirror-sync-bad-remote')
  const options = await makeWorkspace(t, root)

  await assert.rejects(
    () => runMirrorSync({ ...options, remote: '-evil-flag-injection' }),
    /cannot start with a dash/,
  )
  await assert.rejects(
    () => runMirrorSync({ ...options, remote: 'not\na\nvalid\nurl' }),
    /control characters/,
  )
})

test('mirror-sync is deterministic: two independent runs over the same Main history produce identical commit SHAs', async (t) => {
  const root = await makeTempRoot(t, 'mirror-sync-determinism')
  const optionsA = await makeWorkspace(t, root)

  await writeAndSync(optionsA, 'notes.md', 'hello\n')
  await writeAndSync(optionsA, 'notes.md', 'hello again\n')

  // Copy the resulting fixed history (with its already-recorded, non-wall-clock
  // timestamps) into a second, completely independent state root.
  const rootB = await makeTempRoot(t, 'mirror-sync-determinism-b')
  const optionsB = { ...optionsA, cloud: path.join(rootB, 'cloud.json'), journal: path.join(rootB, 'journal.ndjson'), events: path.join(rootB, 'events.ndjson') }
  await fs.mkdir(rootB, { recursive: true })
  await fs.copyFile(optionsA.cloud, optionsB.cloud)

  const remoteA = await makeBareRemote(t, root, 'remote-a')
  const remoteB = await makeBareRemote(t, rootB, 'remote-b')

  await runMirrorSync({ ...optionsA, remote: remoteA })
  await runMirrorSync({ ...optionsB, remote: remoteB })

  const shasA = commitLog(remoteA)
  const shasB = commitLog(remoteB)
  assert.ok(shasA.length > 0)
  assert.deepEqual(shasA, shasB, 'identical Main history yields byte-for-byte identical commit chains')
})

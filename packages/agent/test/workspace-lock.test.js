import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  WorkspaceLockError,
  acquireWorkspaceLock,
  isProcessAlive,
  readWorkspaceLockRecord,
  workspaceLockPath,
} from '../src/workspace-lock.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(repoRoot, 'packages/agent/src/cli.js')

async function makeWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-workspace-lock-test-'))
  const workspace = path.join(root, 'workspace')
  await fs.mkdir(workspace, { recursive: true })
  return { root, workspace }
}

function optionsFor(workspace, overrides = {}) {
  return {
    workspace,
    'codebase-id': 'hopit-core',
    ...overrides,
  }
}

/** Returns a pid that is guaranteed to no longer be running, for stale-lock
 * takeover tests. */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  const pid = child.pid
  await new Promise((resolve) => child.once('close', resolve))
  return pid
}

test('acquireWorkspaceLock grants the lock and writes holder metadata', async () => {
  const { workspace } = await makeWorkspace()
  const lock = await acquireWorkspaceLock(optionsFor(workspace))
  try {
    assert.equal(lock.path, workspaceLockPath(optionsFor(workspace)))
    assert.equal(lock.holder.pid, process.pid)
    assert.equal(lock.holder.codebaseId, 'hopit-core')

    const record = await readWorkspaceLockRecord(lock.path)
    assert.equal(record.pid, process.pid)
  } finally {
    await lock.release()
  }
})

test('a second acquire against a live holder refuses with the holder identified', async () => {
  const { workspace } = await makeWorkspace()
  const first = await acquireWorkspaceLock(optionsFor(workspace))
  try {
    await assert.rejects(
      () => acquireWorkspaceLock(optionsFor(workspace)),
      (error) => {
        assert.ok(error instanceof WorkspaceLockError)
        assert.match(error.message, new RegExp(`pid ${process.pid}`))
        assert.match(error.message, /hopit-core/)
        assert.equal(error.detail.pid, process.pid)
        return true
      },
    )
  } finally {
    await first.release()
  }
})

test('a stale lock left by a dead pid is taken over automatically', async () => {
  const { workspace } = await makeWorkspace()
  const pid = await deadPid()
  assert.equal(isProcessAlive(pid), false)

  const lockPath = workspaceLockPath(optionsFor(workspace))
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  await fs.writeFile(
    lockPath,
    JSON.stringify({
      pid,
      hostname: os.hostname(),
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      codebaseId: 'stale-codebase',
    }),
    'utf8',
  )

  const lock = await acquireWorkspaceLock(optionsFor(workspace))
  try {
    assert.equal(lock.holder.pid, process.pid)
    const record = await readWorkspaceLockRecord(lockPath)
    assert.equal(record.pid, process.pid)
  } finally {
    await lock.release()
  }
})

test('a lock recorded on a different host is never treated as stale', async () => {
  const { workspace } = await makeWorkspace()
  const pid = await deadPid()
  const lockPath = workspaceLockPath(optionsFor(workspace))
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  await fs.writeFile(
    lockPath,
    JSON.stringify({ pid, hostname: 'some-other-machine', startedAt: new Date().toISOString() }),
    'utf8',
  )

  await assert.rejects(
    () => acquireWorkspaceLock(optionsFor(workspace)),
    WorkspaceLockError,
  )
})

test('release only removes the lock while it is still owned by the releasing holder', async () => {
  const { workspace } = await makeWorkspace()
  const lock = await acquireWorkspaceLock(optionsFor(workspace))
  // Simulate another process taking over after this handle's process died:
  // overwrite the lock file with a different holder before releasing.
  await fs.writeFile(
    lock.path,
    JSON.stringify({ pid: process.pid + 1, hostname: os.hostname(), startedAt: new Date().toISOString() }),
    'utf8',
  )

  await lock.release()

  const record = await readWorkspaceLockRecord(lock.path)
  assert.equal(record.pid, process.pid + 1, 'release must not clobber a newer holder')
})

test('concurrent acquisition of the same workspace lock: exactly one caller wins (20 iterations)', async () => {
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const { workspace } = await makeWorkspace()
    const options = optionsFor(workspace)

    const results = await Promise.allSettled([
      acquireWorkspaceLock(options),
      acquireWorkspaceLock(options),
    ])

    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')

    assert.equal(fulfilled.length, 1, `iteration ${iteration}: expected exactly one winner`)
    assert.equal(rejected.length, 1, `iteration ${iteration}: expected exactly one refusal`)
    assert.ok(
      rejected[0].reason instanceof WorkspaceLockError,
      `iteration ${iteration}: refusal must be a WorkspaceLockError`,
    )

    await fulfilled[0].value.release()
  }
})

// --- CLI-level integration: exercises watch.js/service.js startup wiring. ---

async function makeCliState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-workspace-lock-cli-test-'))
  return {
    root,
    cloud: path.join(root, 'cloud.json'),
    workspace: path.join(root, 'workspace'),
    journal: path.join(root, 'journal.ndjson'),
    events: path.join(root, 'events.ndjson'),
  }
}

function stateArgs(state) {
  return ['--cloud', state.cloud, '--workspace', state.workspace, '--journal', state.journal, '--events', state.events]
}

function spawnWatch(state) {
  const child = spawn(process.execPath, [cliPath, 'watch', ...stateArgs(state)], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate, timeoutMs = 15000) {
  const startedAt = Date.now()
  let lastError
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await predicate()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await delay(50)
  }
  throw lastError ?? new Error(`Timed out after ${timeoutMs}ms.`)
}

async function waitForOutput(process_, pattern, timeoutMs = 15000) {
  await waitFor(() => pattern.test(`${process_.stdout()}\n${process_.stderr()}`), timeoutMs)
}

async function waitForExit(child, timeoutMs = 5000) {
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, timeoutMs)
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  try {
    await waitForExit(child, 2000)
  } catch {
    child.kill('SIGKILL')
    await waitForExit(child, 2000)
  }
}

test('a second `hop watch` attach of the same folder refuses with a non-zero exit and names the holder', async (t) => {
  const state = await makeCliState()
  const first = spawnWatch(state)
  t.after(() => stopProcess(first.child))
  await waitForOutput(first, /watch\.started/)

  const second = spawnWatch(state)
  await waitForExit(second.child, 15000)

  assert.notEqual(second.child.exitCode, 0)
  const combinedOutput = `${second.stdout()}\n${second.stderr()}`
  assert.match(combinedOutput, /already locked/i)
  assert.match(combinedOutput, new RegExp(`pid ${first.child.pid}`))
})

test('the workspace lock is released on a clean `hop watch` shutdown', async (t) => {
  const state = await makeCliState()
  const first = spawnWatch(state)
  t.after(() => stopProcess(first.child))
  await waitForOutput(first, /watch\.started/)

  const lockPath = path.join(state.workspace, '.hopit-agent', 'lock.json')
  await waitFor(async () => {
    const record = await readWorkspaceLockRecord(lockPath)
    return record?.pid === first.child.pid
  })

  await stopProcess(first.child)

  await waitFor(async () => (await readWorkspaceLockRecord(lockPath)) === null)

  const second = spawnWatch(state)
  t.after(() => stopProcess(second.child))
  await waitForOutput(second, /watch\.started/)
  assert.equal(second.child.exitCode, null, 'a fresh start after clean shutdown must succeed')
})

test('a stale `hop watch` lock (dead pid) is taken over instead of blocking startup', async (t) => {
  const state = await makeCliState()
  await fs.mkdir(state.workspace, { recursive: true })
  const lockPath = path.join(state.workspace, '.hopit-agent', 'lock.json')
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  const pid = await deadPid()
  await fs.writeFile(
    lockPath,
    JSON.stringify({ pid, hostname: os.hostname(), startedAt: new Date(Date.now() - 60_000).toISOString() }),
    'utf8',
  )

  const child = spawnWatch(state)
  t.after(() => stopProcess(child.child))
  await waitForOutput(child, /watch\.started/)
  await waitForOutput(child, /watch\.lock_takeover/)

  const record = await readWorkspaceLockRecord(lockPath)
  assert.equal(record.pid, child.child.pid)
})

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createCloudGraphService } from '../src/cloud/d1-graph-service.js'
import { initCloud } from '../src/commands/import.js'
import { hydrateWorkspace } from '../src/commands/hydrate.js'
import { runDoctor } from '../src/commands/export.js'
import { readAgentState } from '../src/status-state.js'
import { readNdjson } from '../src/io.js'
import { isWatchLimitExhaustedError, watchLimitRemedyMessage, watchWorkspace } from '../src/watch.js'

async function makeWorkspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-watch-limit-'))
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
  const options = {
    quiet: true,
    profile: 'development',
    cloud: path.join(root, 'cloud.json'),
    workspace: path.join(root, 'workspace'),
    journal: path.join(root, 'journal.ndjson'),
    events: path.join(root, 'events.ndjson'),
    // Tight enough to keep the test fast without depending on the production default.
    'watch-limit-poll-interval-ms': '100',
  }
  await initCloud({ ...options, force: true })
  await hydrateWorkspace(options)
  return options
}

function enospcError() {
  const error = new Error('ENOSPC: System limit for number of file watchers reached')
  error.code = 'ENOSPC'
  return error
}

function throwingWatchFn() {
  throw enospcError()
}

async function runDoctorCaptured(options) {
  const savedExitCode = process.exitCode
  const savedLog = console.log
  const lines = []
  console.log = (...args) => lines.push(args.join(' '))
  try {
    await runDoctor(options)
  } finally {
    console.log = savedLog
    process.exitCode = savedExitCode
  }
  const payload = lines
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .findLast((value) => value && Array.isArray(value.checks))
  assert.ok(payload, 'doctor should print a JSON payload with checks')
  return payload
}

async function waitFor(predicate, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const result = await predicate()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  throw new Error(`Timed out after ${timeoutMs}ms.`)
}

test('isWatchLimitExhaustedError only matches ENOSPC', () => {
  assert.equal(isWatchLimitExhaustedError(enospcError()), true)
  const other = new Error('boom')
  other.code = 'EPERM'
  assert.equal(isWatchLimitExhaustedError(other), false)
  assert.equal(isWatchLimitExhaustedError(null), false)
})

test('watch-limit exhaustion at the fs.watch constructor degrades to scan-only mode, stays up, and surfaces degraded_watch', async (t) => {
  const options = await makeWorkspace(t)

  const handle = await watchWorkspace(options, { watchFn: throwingWatchFn })
  t.after(() => handle?.close())
  assert.ok(handle, 'watchWorkspace must return a live handle instead of throwing')

  const events = await readNdjson(options.events)
  const degraded = events.findLast((entry) => entry.event === 'watch.degraded')
  assert.ok(degraded, 'a watch.degraded event must be journaled')
  assert.equal(degraded.detail.state, 'polling')
  assert.equal(degraded.detail.kind, 'watch-limit-exhausted')
  assert.equal(degraded.detail.code, 'ENOSPC')
  assert.equal(degraded.detail.remedy, watchLimitRemedyMessage)
  assert.match(degraded.detail.remedy, /fs\.inotify\.max_user_watches/)

  const stateAfterDegrade = await readAgentState(options)
  assert.equal(stateAfterDegrade.status.watch.state, 'degraded_watch')
  assert.equal(stateAfterDegrade.status.watch.remedy, watchLimitRemedyMessage)
  // Reported but not fatal: the agent is expected to keep running in this mode.
  assert.equal(stateAfterDegrade.status.ok, false)

  const doctorPayload = await runDoctorCaptured(options)
  const watchCheck = doctorPayload.checks.find((check) => check.name === 'watch')
  assert.ok(watchCheck, 'doctor must report a watch check')
  assert.equal(watchCheck.ok, false)
  assert.match(watchCheck.detail, /fs\.inotify\.max_user_watches/)
  assert.equal(doctorPayload.status.watch, 'degraded_watch')
  assert.equal(doctorPayload.status.watchRemedy, watchLimitRemedyMessage)
})

test('writes made while watch-limit-degraded still sync via the scan fallback, with zero missed writes', async (t) => {
  const options = await makeWorkspace(t)
  const handle = await watchWorkspace(options, { watchFn: throwingWatchFn })
  t.after(() => handle?.close())

  const writes = new Map([
    ['notes/first.txt', 'first note, written while the watcher is unavailable\n'],
    ['notes/second.txt', 'second note, also written during degraded scan-only mode\n'],
    ['top-level.txt', 'a third file outside the notes directory\n'],
  ])

  await fs.mkdir(path.join(options.workspace, 'notes'), { recursive: true })
  for (const [relativePath, content] of writes) {
    await fs.writeFile(path.join(options.workspace, relativePath), content, 'utf8')
  }

  const cloudService = createCloudGraphService(options)
  await waitFor(async () => {
    const graph = await cloudService.readGraph()
    return writes.size === [...writes.keys()].filter((relativePath) => graph.files?.[relativePath]).length
  })

  const graph = await cloudService.readGraph()
  for (const [relativePath, content] of writes) {
    const file = graph.files[relativePath]
    assert.ok(file, `${relativePath} must have synced via the scan fallback`)
    const syncedContent = file.encoding === 'base64' ? Buffer.from(file.content, 'base64').toString('utf8') : file.content
    assert.equal(syncedContent, content, `${relativePath} content must match exactly (no missed/partial write)`)
  }

  const state = await readAgentState(options)
  assert.equal(state.status.journal.pendingCount, 0, 'the scan fallback must fully drain the journal, no missed writes left pending')
  assert.equal(state.status.journal.failedCount, 0)
})

test('a non-ENOSPC watcher failure still degrades to the generic polling state, not degraded_watch', async (t) => {
  const options = await makeWorkspace(t)
  const watchFn = () => {
    const error = new Error('EPERM: operation not permitted')
    error.code = 'EPERM'
    throw error
  }

  const handle = await watchWorkspace(options, { watchFn })
  t.after(() => handle?.close())

  const state = await readAgentState(options)
  assert.equal(state.status.watch.state, 'polling-degraded')
  assert.equal(state.status.watch.remedy, null)
})

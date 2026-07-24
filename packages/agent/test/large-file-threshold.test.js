import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { parseOptions } from '../src/options.js'
import { createCloudGraphService } from '../src/cloud/d1-graph-service.js'
import { performSyncOnce, resolveLargeFileThresholdBytes } from '../src/commands/sync.js'
import { defaultLargeFileThresholdBytes } from '../src/constants.js'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(repoRoot, 'packages/agent/src/cli.js')

async function makeState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-large-file-'))
  return {
    root,
    cloud: path.join(root, 'cloud.json'),
    workspace: path.join(root, 'workspace'),
    journal: path.join(root, 'journal.ndjson'),
    events: path.join(root, 'events.ndjson'),
  }
}

function stateArgs(state) {
  return [
    '--cloud', state.cloud,
    '--workspace', state.workspace,
    '--journal', state.journal,
    '--events', state.events,
  ]
}

async function runCli(command, args = []) {
  return execFileAsync(process.execPath, [cliPath, command, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

async function readNdjson(filePath) {
  try {
    return (await fs.readFile(filePath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function setUpWorkspace() {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))
  return state
}

// -------------------------------------------------------------------------
// Threshold default and per-codebase override
// -------------------------------------------------------------------------

test('resolveLargeFileThresholdBytes falls back to the 100 MB default with no override', async () => {
  const state = await setUpWorkspace()
  const options = parseOptions(stateArgs(state))
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()
  const threshold = await resolveLargeFileThresholdBytes(cloudService, cloud, options)
  assert.equal(threshold, defaultLargeFileThresholdBytes)
  assert.equal(threshold, 100 * 1024 * 1024)
})

test('a per-codebase override is respected by resolveLargeFileThresholdBytes', async () => {
  const state = await setUpWorkspace()
  const options = parseOptions(stateArgs(state))
  const cloudService = createCloudGraphService(options)
  await cloudService.setLargeFileThreshold(null, { thresholdBytes: 2048 })

  const cloud = await cloudService.readGraph()
  const threshold = await resolveLargeFileThresholdBytes(cloudService, cloud, options)
  assert.equal(threshold, 2048)
})

test('clearing the override (thresholdBytes: null) restores the default', async () => {
  const state = await setUpWorkspace()
  const options = parseOptions(stateArgs(state))
  const cloudService = createCloudGraphService(options)
  await cloudService.setLargeFileThreshold(null, { thresholdBytes: 2048 })
  await cloudService.setLargeFileThreshold(null, { thresholdBytes: null })

  const cloud = await cloudService.readGraph()
  const threshold = await resolveLargeFileThresholdBytes(cloudService, cloud, options)
  assert.equal(threshold, defaultLargeFileThresholdBytes)
})

// -------------------------------------------------------------------------
// Sparse-file behavior at sync time: no real GB is ever written. The
// per-codebase override is dialed down to a few bytes so an ordinary small
// fixture file can stand in for "large" without allocating real disk space.
// -------------------------------------------------------------------------

test('an over-threshold file syncs normally and emits file.large', async () => {
  const state = await setUpWorkspace()
  const options = parseOptions(stateArgs(state))
  const cloudService = createCloudGraphService(options)
  await cloudService.setLargeFileThreshold(null, { thresholdBytes: 16 })

  const content = 'this content is comfortably over sixteen bytes\n'
  await fs.writeFile(path.join(state.workspace, 'big.bin'), content, 'utf8')

  await performSyncOnce(options)

  const cloud = await readJson(state.cloud)
  assert.equal(cloud.files['big.bin'].content, content, 'the file syncs with its full content -- no cap')

  const events = await readNdjson(state.events)
  const largeEvents = events.filter((event) => event.event === 'file.large')
  assert.equal(largeEvents.length, 1)
  assert.equal(largeEvents[0].detail.path, 'big.bin')
  assert.equal(largeEvents[0].detail.bytes, Buffer.byteLength(content))
  assert.equal(largeEvents[0].detail.thresholdBytes, 16)
})

test('an under-threshold file syncs with no file.large event', async () => {
  const state = await setUpWorkspace()
  const options = parseOptions(stateArgs(state))
  const cloudService = createCloudGraphService(options)
  await cloudService.setLargeFileThreshold(null, { thresholdBytes: 1_000_000 })

  const content = 'tiny file\n'
  await fs.writeFile(path.join(state.workspace, 'small.txt'), content, 'utf8')

  await performSyncOnce(options)

  const cloud = await readJson(state.cloud)
  assert.equal(cloud.files['small.txt'].content, content)

  const events = await readNdjson(state.events)
  assert.equal(events.filter((event) => event.event === 'file.large').length, 0)
})

test('per-codebase threshold override changes which files get flagged', async () => {
  const state = await setUpWorkspace()
  const options = parseOptions(stateArgs(state))
  const cloudService = createCloudGraphService(options)

  const content = 'exactly medium sized content here\n' // 35 bytes
  const bytes = Buffer.byteLength(content)
  await fs.writeFile(path.join(state.workspace, 'medium.txt'), content, 'utf8')

  // Default threshold (100 MB): not flagged.
  await performSyncOnce(options)
  let events = await readNdjson(state.events)
  assert.equal(events.filter((event) => event.event === 'file.large').length, 0)

  // Lower the per-codebase override below the file's size and touch the file
  // again (change content so sync sees a diff) -- now it is flagged.
  await cloudService.setLargeFileThreshold(null, { thresholdBytes: bytes - 1 })
  await fs.writeFile(path.join(state.workspace, 'medium.txt'), `${content}more\n`, 'utf8')
  await performSyncOnce(options)

  events = await readNdjson(state.events)
  const largeEvents = events.filter((event) => event.event === 'file.large')
  assert.equal(largeEvents.length, 1)
  assert.equal(largeEvents[0].detail.path, 'medium.txt')
  assert.equal(largeEvents[0].detail.thresholdBytes, bytes - 1)
})

// -------------------------------------------------------------------------
// Metric: sync behavior is byte-identical with or without the large-file
// flag firing -- the warning is purely additive, never a gate or a cap.
// -------------------------------------------------------------------------

test('cloud content is byte-identical whether or not the large-file warning fires', async () => {
  const content = 'identical payload bytes, over or under threshold\n'

  const flaggedState = await setUpWorkspace()
  const flaggedOptions = parseOptions(stateArgs(flaggedState))
  const flaggedService = createCloudGraphService(flaggedOptions)
  await flaggedService.setLargeFileThreshold(null, { thresholdBytes: 4 })
  await fs.writeFile(path.join(flaggedState.workspace, 'payload.txt'), content, 'utf8')
  await performSyncOnce(flaggedOptions)
  const flaggedCloud = await readJson(flaggedState.cloud)
  const flaggedEvents = await readNdjson(flaggedState.events)

  const unflaggedState = await setUpWorkspace()
  const unflaggedOptions = parseOptions(stateArgs(unflaggedState))
  const unflaggedService = createCloudGraphService(unflaggedOptions)
  await unflaggedService.setLargeFileThreshold(null, { thresholdBytes: 1_000_000 })
  await fs.writeFile(path.join(unflaggedState.workspace, 'payload.txt'), content, 'utf8')
  await performSyncOnce(unflaggedOptions)
  const unflaggedCloud = await readJson(unflaggedState.cloud)
  const unflaggedEvents = await readNdjson(unflaggedState.events)

  assert.equal(
    flaggedCloud.files['payload.txt'].content,
    unflaggedCloud.files['payload.txt'].content,
    'the synced content is identical regardless of the warning',
  )
  assert.equal(flaggedCloud.files['payload.txt'].hash, unflaggedCloud.files['payload.txt'].hash)
  assert.equal(flaggedCloud.files['payload.txt'].size, unflaggedCloud.files['payload.txt'].size)

  assert.equal(flaggedEvents.filter((event) => event.event === 'file.large').length, 1)
  assert.equal(unflaggedEvents.filter((event) => event.event === 'file.large').length, 0)

  // Every other event kind fired identically on both runs -- the flag is
  // purely additive, not a fork in sync behavior.
  const nonLargeKinds = (events) => events.filter((event) => event.event !== 'file.large').map((event) => event.event)
  assert.deepEqual(nonLargeKinds(flaggedEvents), nonLargeKinds(unflaggedEvents))
})

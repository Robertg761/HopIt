import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { parseOptions } from '../src/options.js'
import { runtimeArgsFromOptions } from '../src/service.js'
import { createAutoPruneScheduler, createWorkspaceScanScheduler, diskPressureAcceleratedInactiveMs, parseAutoPruneMs, parseWorkspaceScanMs } from '../src/watch.js'

async function makeState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-watch-scheduler-test-'))
  return {
    workspace: path.join(root, 'workspace'),
    journal: path.join(root, 'journal.ndjson'),
    events: path.join(root, 'events.ndjson'),
  }
}

async function readEvents(filePath) {
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

async function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const result = await predicate()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out after ${timeoutMs}ms.`)
}

test('scheduled auto-prune reuses the conservative cache-prune contract', async (t) => {
  const state = await makeState()
  let receivedOptions = null
  const scheduler = await createAutoPruneScheduler({
    ...state,
    'auto-prune': true,
  }, {
    intervalMs: 20,
    inactiveMs: 60_000,
    localSyncIdle: () => true,
    pruneWorkspace: async (options) => {
      receivedOptions = options
    },
  })
  t.after(() => scheduler?.close())

  await waitFor(() => receivedOptions)
  assert.equal(receivedOptions.execute, true)
  assert.equal(receivedOptions.path, 'all')
  assert.equal(receivedOptions.recursive, true)
  assert.equal(receivedOptions['inactive-ms'], '60000')

  const started = (await readEvents(state.events)).find((event) => event.event === 'cache.auto_prune_started')
  assert.equal(started.detail.preservesPinned, true)
  assert.equal(started.detail.cleanAcknowledgedOnly, true)
})

test('scheduled auto-prune does not run while the journal is unresolved', async (t) => {
  const state = await makeState()
  await fs.writeFile(state.journal, `${JSON.stringify({
    id: 'pending-entry',
    type: 'write',
    path: 'README.md',
    scope: 'shared',
  })}\n`, 'utf8')
  let calls = 0
  const scheduler = await createAutoPruneScheduler({
    ...state,
    'auto-prune': true,
  }, {
    intervalMs: 20,
    inactiveMs: 60_000,
    localSyncIdle: () => true,
    pruneWorkspace: async () => {
      calls += 1
    },
  })
  t.after(() => scheduler?.close())

  const skipped = await waitFor(async () => {
    return (await readEvents(state.events)).find((event) => event.event === 'cache.auto_prune_skipped')
  })
  assert.equal(skipped.detail.reason, 'journal_has_unresolved_entries')
  assert.equal(calls, 0)
})

test('auto-prune production cadence rejects aggressive intervals', () => {
  assert.throws(
    () => parseAutoPruneMs('59999', 60_000, '--auto-prune-interval-ms'),
    /Use at least 60000ms/,
  )
})

test('explicit --auto-prune survives service argument forwarding', () => {
  const options = parseOptions([
    '--auto-prune',
    '--auto-prune-interval-ms',
    '21600000',
    '--auto-prune-inactive-ms',
    '604800000',
  ])
  const serviceArgs = runtimeArgsFromOptions(options)

  assert.equal(options['auto-prune'], true)
  assert.deepEqual(
    serviceArgs.slice(serviceArgs.indexOf('--auto-prune'), serviceArgs.indexOf('--auto-prune') + 5),
    [
      '--auto-prune',
      '--auto-prune-interval-ms',
      '21600000',
      '--auto-prune-inactive-ms',
      '604800000',
    ],
  )
})

// GR-G1 (decisions §11): idle dehydration is default-on, not opt-in.

test('auto-prune defaults on without any flag', () => {
  const options = parseOptions([])
  assert.equal(options['auto-prune'], true)
})

test('--no-auto-prune disables it and is forwarded to the service child', () => {
  const options = parseOptions(['--no-auto-prune'])
  assert.equal(options['auto-prune'], false)

  const serviceArgs = runtimeArgsFromOptions(options)
  assert.ok(serviceArgs.includes('--no-auto-prune'))
  assert.ok(!serviceArgs.includes('--auto-prune'))
})

test('HOPIT_AUTO_PRUNE=0 disables the default-on scheduler', async () => {
  const previous = process.env.HOPIT_AUTO_PRUNE
  process.env.HOPIT_AUTO_PRUNE = '0'
  try {
    const options = parseOptions([])
    assert.equal(options['auto-prune'], false)
    assert.equal(await createAutoPruneScheduler(options), null)
  } finally {
    if (previous === undefined) delete process.env.HOPIT_AUTO_PRUNE
    else process.env.HOPIT_AUTO_PRUNE = previous
  }
})

test('a default-on scheduler starts without any --auto-prune flag', async (t) => {
  const state = await makeState()
  const scheduler = await createAutoPruneScheduler({
    ...state,
  }, {
    intervalMs: 60_000,
    inactiveMs: 60_000,
    localSyncIdle: () => true,
    pruneWorkspace: async () => {},
  })
  t.after(() => scheduler?.close())
  assert.ok(scheduler, 'auto-prune must start by default even with no explicit flag')

  const started = (await readEvents(state.events)).find((event) => event.event === 'cache.auto_prune_started')
  assert.ok(started)
})

// GR-G1 (decisions §11): disk-pressure acceleration shortens the idle window
// on a nearly-full disk instead of leaving it fixed at the configured default.

test('disk-pressure acceleration leaves the window untouched with ample free space', () => {
  const sevenDays = 7 * 24 * 60 * 60 * 1000
  const result = diskPressureAcceleratedInactiveMs(sevenDays, {
    freeBytes: 500 * 1024 * 1024 * 1024,
    totalBytes: 1000 * 1024 * 1024 * 1024,
  })
  assert.equal(result, sevenDays)
})

test('disk-pressure acceleration shortens the window below the absolute free-bytes floor', () => {
  const sevenDays = 7 * 24 * 60 * 60 * 1000
  const result = diskPressureAcceleratedInactiveMs(sevenDays, {
    freeBytes: 1 * 1024 * 1024 * 1024, // under the 5 GB default floor
    totalBytes: 1000 * 1024 * 1024 * 1024,
  })
  assert.ok(result < sevenDays, 'low absolute free space must shorten the window')
  assert.equal(result, Math.round(sevenDays * 0.25))
})

test('disk-pressure acceleration shortens the window below the free-fraction floor', () => {
  const sevenDays = 7 * 24 * 60 * 60 * 1000
  const result = diskPressureAcceleratedInactiveMs(sevenDays, {
    freeBytes: 8 * 1024 * 1024 * 1024, // above the absolute floor...
    totalBytes: 1000 * 1024 * 1024 * 1024, // ...but under the 10% fraction floor
  })
  assert.ok(result < sevenDays, 'low free-space fraction must shorten the window')
})

test('disk-pressure acceleration never shortens below the scheduler minimum cadence', () => {
  const result = diskPressureAcceleratedInactiveMs(90_000, {
    freeBytes: 0,
    totalBytes: 1000 * 1024 * 1024 * 1024,
  })
  assert.ok(result >= 60_000)
})

test('disk-pressure acceleration is a no-op when disk stats are unavailable', () => {
  const sevenDays = 7 * 24 * 60 * 60 * 1000
  assert.equal(diskPressureAcceleratedInactiveMs(sevenDays, null), sevenDays)
})

test('a scheduled prune under disk pressure narrows the inactive-ms it hands to pruneWorkspaceCache', async (t) => {
  const state = await makeState()
  let receivedOptions = null
  const scheduler = await createAutoPruneScheduler({
    ...state,
    'auto-prune': true,
  }, {
    intervalMs: 20,
    inactiveMs: 604_800_000, // 7 days
    localSyncIdle: () => true,
    statDisk: async () => ({ freeBytes: 1024, totalBytes: 1000 * 1024 * 1024 * 1024 }),
    pruneWorkspace: async (options) => {
      receivedOptions = options
    },
  })
  t.after(() => scheduler?.close())

  await waitFor(() => receivedOptions)
  assert.ok(Number(receivedOptions['inactive-ms']) < 604_800_000)

  const pressureEvent = (await readEvents(state.events)).find((event) => event.event === 'cache.auto_prune_disk_pressure')
  assert.ok(pressureEvent, 'disk-pressure acceleration must be observable in the event log')
  assert.equal(pressureEvent.detail.baseInactiveMs, 604_800_000)
  assert.equal(pressureEvent.detail.inactiveMs, Number(receivedOptions['inactive-ms']))
})

test('a scheduled prune with ample free disk does not emit a disk-pressure event', async (t) => {
  const state = await makeState()
  let receivedOptions = null
  const scheduler = await createAutoPruneScheduler({
    ...state,
    'auto-prune': true,
  }, {
    intervalMs: 20,
    inactiveMs: 604_800_000,
    localSyncIdle: () => true,
    statDisk: async () => ({ freeBytes: 500 * 1024 * 1024 * 1024, totalBytes: 1000 * 1024 * 1024 * 1024 }),
    pruneWorkspace: async (options) => {
      receivedOptions = options
    },
  })
  t.after(() => scheduler?.close())

  await waitFor(() => receivedOptions)
  assert.equal(Number(receivedOptions['inactive-ms']), 604_800_000)

  const pressureEvent = (await readEvents(state.events)).find((event) => event.event === 'cache.auto_prune_disk_pressure')
  assert.equal(pressureEvent, undefined)
})

// GR-H1: periodic full workspace diff-scan (decisions §12 — missed watcher
// events are assumed, not exceptional).

test('workspace scan cadence rejects sub-second intervals', () => {
  assert.throws(
    () => parseWorkspaceScanMs('999', 600_000, '--scan-interval-ms'),
    /Use at least 1000ms/,
  )
})

test('workspace scan interval defaults to 10 minutes and survives service argument forwarding', () => {
  const options = parseOptions(['--scan-interval-ms', '120000'])
  const serviceArgs = runtimeArgsFromOptions(options)

  assert.deepEqual(
    serviceArgs.slice(serviceArgs.indexOf('--scan-interval-ms'), serviceArgs.indexOf('--scan-interval-ms') + 2),
    ['--scan-interval-ms', '120000'],
  )

  const defaulted = parseOptions([])
  assert.equal(defaulted['scan-interval-ms'], undefined)
})

test('workspace scan interval can be set via HOPIT_SCAN_INTERVAL_MS', () => {
  const previous = process.env.HOPIT_SCAN_INTERVAL_MS
  process.env.HOPIT_SCAN_INTERVAL_MS = '90000'
  try {
    const options = parseOptions([])
    assert.equal(options['scan-interval-ms'], '90000')
  } finally {
    if (previous === undefined) delete process.env.HOPIT_SCAN_INTERVAL_MS
    else process.env.HOPIT_SCAN_INTERVAL_MS = previous
  }
})

test('a missed watcher event heals on the next periodic scan', async (t) => {
  const state = await makeState()
  await fs.mkdir(state.workspace, { recursive: true })
  await fs.writeFile(path.join(state.workspace, 'existing.txt'), 'seed', 'utf8')

  const changes = []
  const scanner = await createWorkspaceScanScheduler(state, {
    intervalMs: 20,
    onChange: (eventType, changedPath) => {
      changes.push({ eventType, changedPath })
    },
  })
  t.after(() => scanner?.close())

  const startedAt = (await readEvents(state.events)).find((event) => event.event === 'watch.scan_started')
  assert.equal(startedAt.detail.intervalMs, 20)

  // Simulate the watcher missing this write entirely (no scheduleSync call) —
  // the file lands on disk with nothing observing it until the next scan.
  await fs.writeFile(path.join(state.workspace, 'missed-write.txt'), 'healed by scan', 'utf8')

  await waitFor(() => changes.length > 0)
  assert.equal(changes[0].eventType, 'scan')
  assert.equal(changes[0].changedPath, 'missed-write.txt')

  const healed = await waitFor(async () => {
    return (await readEvents(state.events)).find((event) => event.event === 'watch.scan_healed')
  })
  assert.equal(healed.detail.path, 'missed-write.txt')

  const completed = (await readEvents(state.events)).filter((event) => event.event === 'watch.scan_completed')
  assert.ok(completed.some((event) => event.detail.changed === true))
})

test('the periodic scan skips derived directories (GR-C1) so cache output never triggers a heal', async (t) => {
  const state = await makeState()
  await fs.mkdir(path.join(state.workspace, 'node_modules', 'pkg'), { recursive: true })
  await fs.writeFile(path.join(state.workspace, 'node_modules', 'pkg', 'index.js'), 'module.exports = {}', 'utf8')

  let runs = 0
  const scanner = await createWorkspaceScanScheduler(state, {
    intervalMs: 20,
    onChange: () => {
      runs += 1
    },
  })
  t.after(() => scanner?.close())

  // Churn the derived directory repeatedly; none of it should ever surface as
  // a change because shouldSkipWorkspacePath excludes it from the snapshot.
  for (let i = 0; i < 3; i += 1) {
    await fs.writeFile(path.join(state.workspace, 'node_modules', 'pkg', 'index.js'), `module.exports = { i: ${i} }`, 'utf8')
    await scanner.runOnce()
  }

  assert.equal(runs, 0)
  const completed = (await readEvents(state.events)).filter((event) => event.event === 'watch.scan_completed')
  assert.ok(completed.length >= 3)
  assert.ok(completed.every((event) => event.detail.changed === false))
})

test('a 5,000-file workspace scan completes within a generous bound', async (t) => {
  const state = await makeState()
  const dir = path.join(state.workspace, 'many-files')
  await fs.mkdir(dir, { recursive: true })
  const fileCount = 5000
  const batchSize = 250
  for (let start = 0; start < fileCount; start += batchSize) {
    const batch = []
    for (let i = start; i < Math.min(start + batchSize, fileCount); i += 1) {
      batch.push(fs.writeFile(path.join(dir, `file-${i}.txt`), `content-${i}`, 'utf8'))
    }
    await Promise.all(batch)
  }

  const scanner = await createWorkspaceScanScheduler(state, {
    intervalMs: 60_000,
    onChange: () => {},
  })
  t.after(() => scanner?.close())

  const startedAt = Date.now()
  await scanner.runOnce()
  const elapsedMs = Date.now() - startedAt

  // Generous bound: stat-based scan of 5k files should stay well under this
  // on any CI/dev machine; this guards against an accidental O(n^2) or
  // content-hashing regression, not a tight performance target.
  assert.ok(elapsedMs < 20_000, `scan of ${fileCount} files took ${elapsedMs}ms`)

  const completed = (await readEvents(state.events)).filter((event) => event.event === 'watch.scan_completed')
  assert.ok(completed.some((event) => typeof event.detail.durationMs === 'number'))
})

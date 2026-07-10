import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { parseOptions } from '../src/options.js'
import { runtimeArgsFromOptions } from '../src/service.js'
import { createAutoPruneScheduler, parseAutoPruneMs } from '../src/watch.js'

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

test('auto-prune remains opt-in and survives service argument forwarding', () => {
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

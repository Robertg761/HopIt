// GR-A3 (decisions §1: divergence surfaces). Covers `deriveOpenDivergences`
// (unit) and the `hop conflicts` list/resolve CLI (end to end, two devices
// sharing one fixture cloud.json like reconnect-divergence.test.js).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { deriveOpenDivergences } from '../src/reconnect.js'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(repoRoot, 'packages/agent/src/cli.js')

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex')
}

function divergedEvent(overrides = {}) {
  return {
    event: 'journal.reconnect_diverged',
    at: '2026-07-24T10:00:00.000Z',
    detail: {
      id: 'entry-1',
      type: 'write',
      path: 'README.md',
      scope: 'shared',
      reason: 'content_differs',
      baseRevision: 3,
      cloudRevision: 5,
      cloudHash: 'cloud-hash',
      localHash: 'local-hash',
      localDeviceName: 'MacBook',
      cloudDeviceName: 'Desktop',
      ...overrides,
    },
  }
}

function resolvedEvent(overrides = {}) {
  return {
    event: 'conflicts.resolved',
    at: '2026-07-24T11:00:00.000Z',
    detail: {
      path: 'README.md',
      keep: 'local',
      ...overrides,
    },
  }
}

// ---------------------------------------------------------------------------
// Unit-level: deriveOpenDivergences (packages/agent/src/reconnect.js)
// ---------------------------------------------------------------------------

test('deriveOpenDivergences: a diverged path with no resolution event is open', () => {
  const open = deriveOpenDivergences([divergedEvent()])
  assert.equal(open.length, 1)
  assert.equal(open[0].path, 'README.md')
  assert.equal(open[0].reason, 'content_differs')
  assert.equal(open[0].localDeviceName, 'MacBook')
  assert.equal(open[0].cloudDeviceName, 'Desktop')
  assert.equal(typeof open[0].ageMs, 'number')
  assert.ok(open[0].ageMs >= 0)
})

test('deriveOpenDivergences: a resolution event after the divergence closes it', () => {
  const open = deriveOpenDivergences([divergedEvent(), resolvedEvent()])
  assert.equal(open.length, 0)
})

test('deriveOpenDivergences: a divergence detected again after an earlier resolution is open (reopened)', () => {
  const open = deriveOpenDivergences([
    resolvedEvent({ path: 'README.md' }), // at 11:00
    { ...divergedEvent({ path: 'README.md' }), at: '2026-07-24T12:00:00.000Z' },
  ])
  assert.equal(open.length, 1)
})

test('deriveOpenDivergences: multiple diverged paths are all reported, sorted by path', () => {
  const open = deriveOpenDivergences([
    divergedEvent({ path: 'zebra.md' }),
    divergedEvent({ path: 'apple.md' }),
  ])
  assert.deepEqual(open.map((entry) => entry.path), ['apple.md', 'zebra.md'])
})

test('deriveOpenDivergences: an empty event log has no open divergences', () => {
  assert.deepEqual(deriveOpenDivergences([]), [])
})

test('deriveOpenDivergences: events with no path in detail are ignored rather than throwing', () => {
  const open = deriveOpenDivergences([
    { event: 'journal.reconnect_diverged', at: '2026-07-24T10:00:00.000Z', detail: {} },
    { event: 'conflicts.resolved', at: '2026-07-24T10:00:00.000Z', detail: {} },
  ])
  assert.deepEqual(open, [])
})

// ---------------------------------------------------------------------------
// End-to-end: `hop conflicts` / `hop conflicts resolve` through the CLI
// ---------------------------------------------------------------------------

async function makeTwoDeviceState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-conflicts-test-'))
  const cloud = path.join(root, 'cloud.json')
  function makeDevice(name) {
    return {
      root,
      cloud,
      workspace: path.join(root, `${name}-workspace`),
      journal: path.join(root, `${name}-journal.ndjson`),
      events: path.join(root, `${name}-events.ndjson`),
    }
  }
  return { root, cloud, deviceA: makeDevice('device-a'), deviceB: makeDevice('device-b') }
}

function stateArgs(state) {
  return ['--cloud', state.cloud, '--workspace', state.workspace, '--journal', state.journal, '--events', state.events]
}

async function runCli(command, args = []) {
  return execFileAsync(process.execPath, [cliPath, command, ...args], { cwd: repoRoot, encoding: 'utf8' })
}

async function runCliExpectFailure(command, args = []) {
  try {
    await runCli(command, args)
    throw new Error('expected command to fail')
  } catch (error) {
    if (!error.stderr && !error.stdout) throw error
    return error
  }
}

async function appendJournalEntry(state, entry) {
  await fs.appendFile(state.journal, `${JSON.stringify(entry)}\n`, 'utf8')
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

// In machine-output mode `hop conflicts`/`hop conflicts resolve` print one
// raw NDJSON line per emitted agent event (write.journaled, cloud.acknowledged,
// conflicts.resolved, ...), then the command's own pretty-printed JSON summary
// last (`reportResult`, via `console.log(JSON.stringify(result, null, 2))`).
// The summary is the only part of stdout that starts a line with a bare `{`,
// so the last such line marks where it begins.
function lastJsonResult(stdout) {
  const lines = stdout.split('\n')
  const start = lines.lastIndexOf('{')
  if (start === -1) throw new Error(`No JSON summary found in stdout: ${stdout}`)
  return JSON.parse(lines.slice(start).join('\n'))
}

async function setUpDivergence(deviceA, deviceB, { id = 'entry-1', localContent = 'device B diverging draft.\n' } = {}) {
  const cloudReadme = '# hopit-core\n\nDevice A cloud winner.\n'
  await fs.writeFile(path.join(deviceA.workspace, 'README.md'), cloudReadme, 'utf8')
  await runCli('sync-once', stateArgs(deviceA))

  await fs.writeFile(path.join(deviceB.workspace, 'README.md'), localContent, 'utf8')
  await appendJournalEntry(deviceB, {
    id,
    type: 'write',
    path: 'README.md',
    scope: 'shared',
    hash: hashContent(localContent),
    bytes: Buffer.byteLength(localContent),
    createdAt: new Date().toISOString(),
    status: 'pending',
    baseRevision: 0,
  })

  const recovery = await runCli('recover', stateArgs(deviceB))
  assert.match(recovery.stdout, /"diverged":1/)
  return { cloudReadme, localContent }
}

test('hop conflicts: lists an open divergence with both device labels and an age', async () => {
  const { deviceA, deviceB } = await makeTwoDeviceState()
  await runCli('init', [...stateArgs(deviceA), '--force'])
  await runCli('hydrate', stateArgs(deviceA))
  await runCli('hydrate', stateArgs(deviceB))

  await setUpDivergence(deviceA, deviceB)

  const conflicts = await runCli('conflicts', [...stateArgs(deviceB), '--json'])
  const result = lastJsonResult(conflicts.stdout)
  assert.equal(result.count, 1)
  assert.equal(result.divergences[0].path, 'README.md')
  assert.equal(typeof result.divergences[0].localDeviceName, 'string')
  assert.equal(typeof result.divergences[0].cloudDeviceName, 'string')
  assert.equal(typeof result.divergences[0].ageMs, 'number')
})

test('hop conflicts resolve --keep local: local content wins, is pushed to cloud, and the divergence closes', async () => {
  const { deviceA, deviceB } = await makeTwoDeviceState()
  await runCli('init', [...stateArgs(deviceA), '--force'])
  await runCli('hydrate', stateArgs(deviceA))
  await runCli('hydrate', stateArgs(deviceB))

  const { localContent } = await setUpDivergence(deviceA, deviceB)

  const resolution = await runCli('conflicts', ['resolve', 'README.md', '--keep', 'local', ...stateArgs(deviceB), '--json'])
  const result = lastJsonResult(resolution.stdout)
  assert.equal(result.ok, true)
  assert.equal(result.keep, 'local')
  assert.equal(result.combined, false)

  // Local file on device B is untouched (it already held the local version).
  assert.equal(await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8'), localContent)

  // The divergence is closed.
  const status = JSON.parse((await runCli('status', stateArgs(deviceB))).stdout)
  assert.deepEqual(status.divergences, [])

  // Cloud now carries device B's content, and device A picks it up on refresh.
  const cloud = await readJson(deviceB.cloud)
  assert.equal(cloud.files['README.md'].content, localContent)
  await runCli('refresh', stateArgs(deviceA))
  assert.equal(await fs.readFile(path.join(deviceA.workspace, 'README.md'), 'utf8'), localContent)
})

test('hop conflicts resolve --keep cloud: cloud content wins and overwrites the local file', async () => {
  const { deviceA, deviceB } = await makeTwoDeviceState()
  await runCli('init', [...stateArgs(deviceA), '--force'])
  await runCli('hydrate', stateArgs(deviceA))
  await runCli('hydrate', stateArgs(deviceB))

  const { cloudReadme } = await setUpDivergence(deviceA, deviceB)

  const resolution = await runCli('conflicts', ['resolve', 'README.md', '--keep', 'cloud', ...stateArgs(deviceB), '--json'])
  const result = lastJsonResult(resolution.stdout)
  assert.equal(result.ok, true)
  assert.equal(result.keep, 'cloud')

  assert.equal(await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8'), cloudReadme)

  const status = JSON.parse((await runCli('status', stateArgs(deviceB))).stdout)
  assert.deepEqual(status.divergences, [])
})

test('hop conflicts resolve --keep local after a manual hand-merge is reported as combined', async () => {
  const { deviceA, deviceB } = await makeTwoDeviceState()
  await runCli('init', [...stateArgs(deviceA), '--force'])
  await runCli('hydrate', stateArgs(deviceA))
  await runCli('hydrate', stateArgs(deviceB))

  await setUpDivergence(deviceA, deviceB)

  // No automatic line-level merge exists (decisions §1): the user combines
  // both sides by hand before resolving.
  const combinedContent = 'device A and device B, combined by hand.\n'
  await fs.writeFile(path.join(deviceB.workspace, 'README.md'), combinedContent, 'utf8')

  const resolution = await runCli('conflicts', ['resolve', 'README.md', '--keep', 'local', ...stateArgs(deviceB), '--json'])
  const result = lastJsonResult(resolution.stdout)
  assert.equal(result.combined, true)

  const cloud = await readJson(deviceB.cloud)
  assert.equal(cloud.files['README.md'].content, combinedContent)
})

test('hop conflicts resolve: an already-resolved path does not reopen on a later `hop recover`', async () => {
  const { deviceA, deviceB } = await makeTwoDeviceState()
  await runCli('init', [...stateArgs(deviceA), '--force'])
  await runCli('hydrate', stateArgs(deviceA))
  await runCli('hydrate', stateArgs(deviceB))

  await setUpDivergence(deviceA, deviceB)
  await runCli('conflicts', ['resolve', 'README.md', '--keep', 'local', ...stateArgs(deviceB)])

  const secondRecovery = await runCli('recover', stateArgs(deviceB))
  assert.match(secondRecovery.stdout, /"diverged":0/)
  assert.doesNotMatch(secondRecovery.stdout, /journal\.reconnect_diverged/)
})

test('hop conflicts resolve: rejects an unknown --keep value', async () => {
  const { deviceA, deviceB } = await makeTwoDeviceState()
  await runCli('init', [...stateArgs(deviceA), '--force'])
  await runCli('hydrate', stateArgs(deviceA))
  await runCli('hydrate', stateArgs(deviceB))
  await setUpDivergence(deviceA, deviceB)

  const failure = await runCliExpectFailure('conflicts', ['resolve', 'README.md', '--keep', 'bogus', ...stateArgs(deviceB)])
  assert.match(failure.stderr, /--keep local\|cloud/)
})

test('hop conflicts resolve: rejects a path with no open divergence', async () => {
  const { deviceA, deviceB } = await makeTwoDeviceState()
  await runCli('init', [...stateArgs(deviceA), '--force'])
  await runCli('hydrate', stateArgs(deviceA))
  await runCli('hydrate', stateArgs(deviceB))

  const failure = await runCliExpectFailure('conflicts', ['resolve', 'DOES-NOT-EXIST.md', '--keep', 'local', ...stateArgs(deviceB)])
  assert.match(failure.stderr, /No open divergence for path/)
})

test('hop conflicts: reports no open divergences on a clean codebase', async () => {
  const { deviceA } = await makeTwoDeviceState()
  await runCli('init', [...stateArgs(deviceA), '--force'])
  await runCli('hydrate', stateArgs(deviceA))

  const conflicts = await runCli('conflicts', [...stateArgs(deviceA), '--json'])
  const result = lastJsonResult(conflicts.stdout)
  assert.equal(result.count, 0)
  assert.deepEqual(result.divergences, [])
})

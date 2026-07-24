import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { createCloudGraphService } from '../src/cloud/d1-graph-service.js'
import { recoverJournal, resolveDivergence } from '../src/commands/sync.js'

// GR-A2 (decisions §1): divergence persistence. Before a diverged path is
// ever resolved, both sides must be uploaded/retained so nothing is silently
// dropped, the local workspace file must never be clobbered, and resolution
// itself must be a normal journaled step that only ever *closes* the
// divergence record, never deletes it.

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(repoRoot, 'packages/agent/src/cli.js')

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex')
}

async function makeTwoDeviceState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-divergence-persistence-test-'))
  const cloud = path.join(root, 'cloud.json')
  function makeDevice(name) {
    return {
      root,
      cloud,
      workspace: path.join(root, `${name}-workspace`),
      journal: path.join(root, `${name}-journal.ndjson`),
      events: path.join(root, `${name}-events.ndjson`),
      options: {
        cloud,
        workspace: path.join(root, `${name}-workspace`),
        journal: path.join(root, `${name}-journal.ndjson`),
        events: path.join(root, `${name}-events.ndjson`),
      },
    }
  }
  return { root, cloud, deviceA: makeDevice('device-a'), deviceB: makeDevice('device-b') }
}

function stateArgs(state) {
  return ['--cloud', state.cloud, '--workspace', state.workspace, '--journal', state.journal, '--events', state.events]
}

async function runCli(command, args = [], env = {}) {
  return execFileAsync(process.execPath, [cliPath, command, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, HOPIT_JSON: '1', ...env },
  })
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

async function appendJournalEntry(state, entry) {
  await fs.appendFile(state.journal, `${JSON.stringify(entry)}\n`, 'utf8')
}

// Sets up the standard fixture: device A commits a cloud edit, device B has a
// diverging offline edit to the same path still pending in its journal, then
// device B reconnects (`hop recover`), which opens the divergence.
async function setupDivergedReadme({ deviceAText, deviceBText } = {}) {
  const { deviceA, deviceB } = await makeTwoDeviceState()
  await runCli('init', [...stateArgs(deviceA), '--force'])
  await runCli('hydrate', stateArgs(deviceA))
  await runCli('hydrate', stateArgs(deviceB))

  const initialCloud = await readJson(deviceA.cloud)
  const cloudContent = deviceAText ?? '# hopit-core\n\nDevice A cloud winner.\n'
  await fs.writeFile(path.join(deviceA.workspace, 'README.md'), cloudContent, 'utf8')
  await runCli('sync-once', stateArgs(deviceA))

  const localContent = deviceBText ?? '# hopit-core\n\nDevice B diverging draft.\n'
  await fs.writeFile(path.join(deviceB.workspace, 'README.md'), localContent, 'utf8')
  await appendJournalEntry(deviceB, {
    id: randomUUID(),
    type: 'write',
    path: 'README.md',
    scope: 'shared',
    hash: hashContent(localContent),
    bytes: Buffer.byteLength(localContent),
    baseRevision: initialCloud.files['README.md'].revision,
    createdAt: new Date().toISOString(),
    status: 'pending',
  })

  const recovery = await runCli('recover', stateArgs(deviceB))
  return { deviceA, deviceB, cloudContent, localContent, recovery }
}

test('divergence persistence: opens a record with both revision refs and the offline device\'s full content, and never touches the local file', async () => {
  const { deviceB, cloudContent, localContent } = await setupDivergedReadme()

  const cloud = await readJson(deviceB.cloud)
  assert.equal(Array.isArray(cloud.divergences), true)
  assert.equal(cloud.divergences.length, 1)

  const record = cloud.divergences[0]
  assert.equal(record.path, 'README.md')
  assert.equal(record.state, 'open')
  assert.equal(record.reason, 'content_differs')
  assert.equal(record.baseRevision, 1)
  assert.equal(record.cloudRevision, 2)
  assert.equal(record.localHash, hashContent(localContent))
  assert.equal(record.cloudHash, hashContent(cloudContent))
  assert.ok(record.divergenceId)
  assert.ok(record.openedAt)
  assert.equal(record.resolvedAt, null)

  // Both sides retrievable: the offline device's version lives in full on
  // the record, and the cloud's winning version lives in `files`.
  assert.equal(record.localEntry.content, localContent)
  assert.equal(record.localEntry.hash, hashContent(localContent))
  assert.equal(cloud.files['README.md'].content, cloudContent)

  // The local workspace copy is never clobbered while diverged.
  assert.equal(await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8'), localContent)
})

test('divergence persistence: agent restart mid-divergence preserves the open record instead of duplicating or losing it', async () => {
  const { deviceB, localContent } = await setupDivergedReadme()

  const beforeRestart = await readJson(deviceB.cloud)
  assert.equal(beforeRestart.divergences.length, 1)
  const originalId = beforeRestart.divergences[0].divergenceId
  const originalOpenedAt = beforeRestart.divergences[0].openedAt

  // Simulate the agent restarting and reconnecting again while the same
  // divergence is still unresolved (crash, force-quit, plane mode again).
  const secondRecovery = await runCli('recover', stateArgs(deviceB))
  assert.match(secondRecovery.stdout, /"diverged":1/)

  const afterRestart = await readJson(deviceB.cloud)
  assert.equal(afterRestart.divergences.length, 1, 'must not open a second record for the same still-diverged path')
  assert.equal(afterRestart.divergences[0].divergenceId, originalId)
  assert.equal(afterRestart.divergences[0].openedAt, originalOpenedAt, 'openedAt is preserved across the restart, not reset')
  assert.equal(afterRestart.divergences[0].state, 'open')

  // Still never clobbered.
  assert.equal(await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8'), localContent)
})

test('divergence persistence: resolving with keep "cloud" closes the record but the losing local content stays fetchable', async () => {
  const { deviceA, deviceB, cloudContent, localContent } = await setupDivergedReadme()
  const cloudBefore = await readJson(deviceB.cloud)
  const divergenceId = cloudBefore.divergences[0].divergenceId

  const { record, applied } = await resolveDivergence(deviceB.options, { divergenceId, keep: 'cloud' })
  assert.equal(applied, true)
  assert.equal(record.state, 'resolved')
  assert.equal(record.resolvedKeep, 'cloud')
  assert.equal(record.resolvedRevision, cloudBefore.divergences[0].cloudRevision)

  const cloudAfter = await readJson(deviceB.cloud)
  assert.equal(cloudAfter.files['README.md'].content, cloudContent, 'the cloud side stays the winning content')

  // The record itself is never deleted -- "theirs" won, but "mine" is still
  // there and fetchable in full.
  const stillFetchable = cloudAfter.divergences.find((row) => row.divergenceId === divergenceId)
  assert.ok(stillFetchable)
  assert.equal(stillFetchable.localEntry.content, localContent)

  // Resolving with "keep cloud" is a decision recorded on the divergence,
  // not an instruction that silently rewrites the workspace file underneath
  // the user -- device B's disk copy is untouched by this call.
  assert.equal(await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8'), localContent)
  void deviceA
})

test('divergence persistence: resolving with keep "local" writes a normal journaled step and the cloud\'s prior content stays reachable by revision', async () => {
  const { deviceB, cloudContent, localContent } = await setupDivergedReadme()
  const cloudBefore = await readJson(deviceB.cloud)
  const divergenceId = cloudBefore.divergences[0].divergenceId
  const priorCloudRevision = cloudBefore.divergences[0].cloudRevision

  const { record, applied } = await resolveDivergence(deviceB.options, { divergenceId, keep: 'local' })
  assert.equal(applied, true)
  assert.equal(record.state, 'resolved')
  assert.equal(record.resolvedKeep, 'local')
  assert.ok(record.resolvedRevision > priorCloudRevision)

  const cloudAfter = await readJson(deviceB.cloud)
  assert.equal(cloudAfter.files['README.md'].content, localContent, 'the offline device\'s content is now the cloud head')

  // The content that lost is still reachable in the trail at its old
  // revision -- resolving in favor of one side never discards the other.
  const priorVersion = cloudAfter.fileVersions.find(
    (row) => row.path === 'README.md' && row.newRevision === priorCloudRevision,
  )
  assert.ok(priorVersion, 'the cloud content that lost the divergence is still in file_versions history')
  assert.equal(priorVersion.newFile?.content, cloudContent)
})

test('divergence persistence: a locally offline delete against a cloud edit records the divergence without content on the deleted side, and "keep local" replays the delete', async () => {
  const { deviceA, deviceB } = await makeTwoDeviceState()
  await runCli('init', [...stateArgs(deviceA), '--force'])
  await runCli('hydrate', stateArgs(deviceA))
  await runCli('hydrate', stateArgs(deviceB))

  const initialCloud = await readJson(deviceA.cloud)
  const cloudContent = '# hopit-core\n\nDevice A kept editing.\n'
  await fs.writeFile(path.join(deviceA.workspace, 'README.md'), cloudContent, 'utf8')
  await runCli('sync-once', stateArgs(deviceA))

  await fs.rm(path.join(deviceB.workspace, 'README.md'))
  await appendJournalEntry(deviceB, {
    id: randomUUID(),
    type: 'delete',
    path: 'README.md',
    scope: 'shared',
    baseRevision: initialCloud.files['README.md'].revision,
    createdAt: new Date().toISOString(),
    status: 'pending',
  })

  await runCli('recover', stateArgs(deviceB))

  const cloudWithDivergence = await readJson(deviceB.cloud)
  const record = cloudWithDivergence.divergences[0]
  assert.equal(record.reason, 'delete_vs_edit')
  assert.equal(record.localSide, 'deleted')
  assert.equal(record.localEntry, null)
  assert.equal(record.cloudHash, hashContent(cloudContent))

  const { record: resolved } = await resolveDivergence(deviceB.options, { divergenceId: record.divergenceId, keep: 'local' })
  assert.equal(resolved.state, 'resolved')
  assert.equal(resolved.resolvedKeep, 'local')

  const cloudAfter = await readJson(deviceB.cloud)
  assert.equal(Object.hasOwn(cloudAfter.files, 'README.md'), false, 'the offline delete is now applied to the cloud head')
})

test('divergence persistence: 0 code paths discard a diverged version -- both sides remain independently retrievable via the cloud service after resolution', async () => {
  const { deviceB, cloudContent, localContent } = await setupDivergedReadme()
  const cloudService = createCloudGraphService(deviceB.options)
  const cloud = await cloudService.readGraph()
  const openRecord = await cloudService.getOpenDivergence(cloud.codebase.id, 'README.md')
  assert.ok(openRecord)

  await resolveDivergence(deviceB.options, { divergenceId: openRecord.divergenceId, keep: 'cloud' })

  // "Theirs" (cloud) won, but "mine" (local) is still fetchable by id.
  const resolvedRecord = await cloudService.getDivergence(cloud.codebase.id, openRecord.divergenceId)
  assert.equal(resolvedRecord.state, 'resolved')
  assert.equal(resolvedRecord.localEntry.content, localContent)

  const finalCloud = await cloudService.readGraph()
  assert.equal(finalCloud.files['README.md'].content, cloudContent)
})

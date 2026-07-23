import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(repoRoot, 'packages/agent/src/cli.js')

async function makeState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-restore-test-'))
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
    '--cloud',
    state.cloud,
    '--workspace',
    state.workspace,
    '--journal',
    state.journal,
    '--events',
    state.events,
  ]
}

async function runCli(command, args = []) {
  return execFileAsync(process.execPath, [cliPath, command, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
}

async function runCliFailure(command, args = []) {
  try {
    await runCli(command, args)
  } catch (error) {
    return error
  }
  throw new Error(`Expected ${command} to fail.`)
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function parseLastJsonObject(stdout) {
  const trimmed = stdout.trim()
  const start = trimmed.lastIndexOf('\n{')
  return JSON.parse(start === -1 ? trimmed : trimmed.slice(start + 1))
}

// Full init+hydrate+backup against the fixture cloud graph (README.md,
// package.json, src/presence.ts, .private/agent-note.md -- see
// packages/agent/fixtures/demo-cloud.json), producing a real backup folder
// the same way an operator would with `hop backup`.
async function makeFixtureBackup(state, outputDirName = 'backup') {
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))
  // Edit + sync so the backup captures a journal, the way a real operator
  // backup would after any actual work.
  await fs.writeFile(path.join(state.workspace, 'README.md'), '# HopIt Core (edited before backup)\n', 'utf8')
  await runCli('sync', stateArgs(state))
  const output = path.join(state.root, outputDirName)
  const backup = parseLastJsonObject((await runCli('backup', [...stateArgs(state), '--output', output, '--force'])).stdout)
  assert.equal(backup.ok, true)
  return output
}

async function addObjectBackedCloudFile(state, relativePath, { hash, blobKey, blobProvider = 'filesystem', size = 42 }) {
  const cloud = await readJson(state.cloud)
  cloud.revision += 1
  if (cloud.selectedState) cloud.selectedState.revision = cloud.revision
  cloud.files[relativePath] = {
    kind: 'file',
    content: '',
    encoding: 'utf8',
    contentStorage: 'object-blob',
    blobProvider,
    blobKey,
    blobHash: hash,
    blobSize: size,
    hash,
    size,
    scope: relativePath.startsWith('.private/') ? 'owner-private' : 'shared',
    revision: cloud.revision,
    updatedAt: new Date(Date.UTC(2026, 0, cloud.revision)).toISOString(),
  }
  await writeJson(state.cloud, cloud)
}

test('restore verify roundtrips a fresh backup: ok, categories, and manifest counts line up', async () => {
  const state = await makeState()
  const output = await makeFixtureBackup(state)

  const report = parseLastJsonObject((await runCli('restore', ['--from', output, '--events', state.events])).stdout)

  assert.equal(report.ok, true)
  assert.equal(report.mode, 'verify')
  assert.equal(report.issues.length, 0)
  assert.equal(report.manifest.codebaseId, 'hopit-core')
  assert.equal(report.manifest.cloud.fileCount, 4)
  assert.equal(report.filesChecked, report.filesVerified)
  assert.equal(report.categories.restorableWithContent.count, 4)
  assert.equal(report.categories.hashOnly.count, 0)
  assert.equal(report.categories.missing.count, 0)
  // One of the four fixture files is .private/agent-note.md (owner-private).
  assert.equal(report.categories.restorableWithContent.scopeCounts.private, 1)
  assert.equal(report.categories.restorableWithContent.scopeCounts.shared, 3)
  assert.equal(report.journal.present, true)
  assert.equal(report.events.present, true)
})

test('restore verify fails a non-existent backup directory with a non-zero exit', async () => {
  const state = await makeState()
  const failure = await runCliFailure('restore', ['--from', path.join(state.root, 'does-not-exist'), '--events', state.events])
  assert.equal(failure.code, 1)
  const report = parseLastJsonObject(failure.stdout)
  assert.equal(report.ok, false)
  assert.match(report.issues[0], /does not exist/)
})

test('restore verify detects a corrupt manifest schemaVersion and reports it without throwing', async () => {
  const state = await makeState()
  const output = await makeFixtureBackup(state, 'corrupt-schema-backup')
  const manifest = await readJson(path.join(output, 'manifest.json'))
  manifest.schemaVersion = 2
  await writeJson(path.join(output, 'manifest.json'), manifest)

  const failure = await runCliFailure('restore', ['--from', output, '--events', state.events])
  assert.equal(failure.code, 1)
  const report = parseLastJsonObject(failure.stdout)
  assert.equal(report.ok, false)
  assert.ok(report.issues.some((issue) => /schemaVersion/.test(issue)))
})

test('restore verify detects a hash mismatch on a backed-up file (bit rot / tampering)', async () => {
  const state = await makeState()
  const output = await makeFixtureBackup(state, 'tampered-backup')
  const cloudPath = path.join(output, 'cloud.json')
  const raw = await fs.readFile(cloudPath, 'utf8')
  assert.ok(raw.includes('"codebase":'), 'fixture cloud.json should contain a codebase key')
  // Length-preserving corruption so this exercises the hash check specifically,
  // not the earlier byte-length check.
  await fs.writeFile(cloudPath, raw.replace('"codebase":', '"codebasE":'), 'utf8')

  const failure = await runCliFailure('restore', ['--from', output, '--events', state.events])
  assert.equal(failure.code, 1)
  const report = parseLastJsonObject(failure.stdout)
  assert.equal(report.ok, false)
  assert.ok(report.issues.some((issue) => /Hash mismatch/.test(issue) && /cloud\.json/.test(issue)))
})

test('restore verify flags an unparsable ndjson line in journal/events without crashing', async () => {
  const state = await makeState()
  const output = await makeFixtureBackup(state, 'bad-ndjson-backup')
  await fs.appendFile(path.join(output, 'events.ndjson'), 'not-json\n')
  // The manifest's recorded hash/bytes for events.ndjson no longer match, so
  // both the hash-integrity check and the ndjson parse check should fire.
  const failure = await runCliFailure('restore', ['--from', output, '--events', state.events])
  assert.equal(failure.code, 1)
  const report = parseLastJsonObject(failure.stdout)
  assert.equal(report.ok, false)
  assert.ok(report.issues.some((issue) => /events\.ndjson has 1 unparsable line/.test(issue)))
})

test('restore --execute refuses a non-empty workspace target without --force', async () => {
  const state = await makeState()
  const output = await makeFixtureBackup(state)
  const target = path.join(state.root, 'restore-target')
  await fs.mkdir(target, { recursive: true })
  await fs.writeFile(path.join(target, 'pre-existing.txt'), 'do not clobber me\n', 'utf8')

  const failure = await runCliFailure('restore', ['--from', output, '--workspace', target, '--execute', '--events', state.events])
  assert.match(failure.stderr, /not empty/)
  assert.equal(await pathExists(path.join(target, 'pre-existing.txt')), true)
})

test('restore --execute refuses to materialize a backup that fails verification', async () => {
  const state = await makeState()
  const output = await makeFixtureBackup(state, 'refused-execute-backup')
  const manifest = await readJson(path.join(output, 'manifest.json'))
  manifest.schemaVersion = 99
  await writeJson(path.join(output, 'manifest.json'), manifest)
  const target = path.join(state.root, 'refused-target')

  const failure = await runCliFailure('restore', ['--from', output, '--workspace', target, '--execute', '--events', state.events])
  assert.equal(failure.code, 1)
  const report = parseLastJsonObject(failure.stdout)
  assert.equal(report.ok, false)
  // Nothing should have been written into a target that was never verified safe.
  assert.equal(await pathExists(target), false)
})

test('restore --execute --force overwrites a non-empty target and materializes matching content', async () => {
  const state = await makeState()
  const output = await makeFixtureBackup(state)
  const target = path.join(state.root, 'restore-target-force')
  await fs.mkdir(target, { recursive: true })
  await fs.writeFile(path.join(target, 'stale.txt'), 'stale\n', 'utf8')

  const result = parseLastJsonObject((await runCli('restore', [
    '--from',
    output,
    '--workspace',
    target,
    '--execute',
    '--force',
    '--events',
    state.events,
  ])).stdout)

  assert.equal(result.ok, true)
  assert.equal(result.mode, 'execute')
  assert.equal(result.filesWritten, 4)
  assert.equal(result.hashOnlySkipped, 0)
  assert.equal(result.missingSkipped, 0)
  assert.equal(await pathExists(path.join(target, 'stale.txt')), false)
})

test('restore --execute materializes fixture files byte-for-byte, restores .private, and writes restore-report.json', async () => {
  const state = await makeState()
  const output = await makeFixtureBackup(state)
  const cloud = await readJson(path.join(output, 'cloud.json'))
  const target = path.join(state.root, 'restore-target-clean')

  const result = parseLastJsonObject((await runCli('restore', [
    '--from',
    output,
    '--workspace',
    target,
    '--execute',
    '--events',
    state.events,
  ])).stdout)

  assert.equal(result.ok, true)
  assert.equal(result.filesWritten, Object.keys(cloud.files).length)
  assert.equal(result.privateFilesRestored, 1)

  // Owner-private backups ARE restored: a backup is inherently owner-private,
  // unlike `export`/`publish` which omit .private/ by default.
  assert.equal(await pathExists(path.join(target, '.private/agent-note.md')), true)

  for (const [relativePath, file] of Object.entries(cloud.files)) {
    const restoredBytes = await fs.readFile(path.join(target, relativePath))
    const expectedBytes = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8')
    assert.equal(hashBuffer(restoredBytes), hashBuffer(expectedBytes), `content mismatch for ${relativePath}`)
    assert.equal(hashBuffer(restoredBytes), file.hash, `hash mismatch vs cloud.json for ${relativePath}`)
  }

  const reportPath = path.join(state.root, 'restore-report.json')
  assert.equal(await pathExists(reportPath), true)
  const report = await readJson(reportPath)
  assert.equal(report.ok, true)
  assert.equal(report.filesWritten, result.filesWritten)
  assert.equal(result.report, reportPath)
})

test('restore reports object-backed cloud files as hash-only (verify) and skips their body on --execute', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))

  const plaintext = 'super secret payload, lives only in the (unconfigured) blob store\n'
  const hash = hashBuffer(Buffer.from(plaintext, 'utf8'))
  const blobKey = `blobs/sha256/${hash.slice(0, 2)}/${hash}`
  await addObjectBackedCloudFile(state, '.private/blobs/dataset.bin', {
    hash,
    blobKey,
    blobProvider: 'filesystem',
    size: Buffer.byteLength(plaintext),
  })

  const output = path.join(state.root, 'hash-only-backup')
  const backup = parseLastJsonObject((await runCli('backup', [...stateArgs(state), '--output', output, '--force'])).stdout)
  assert.equal(backup.ok, true)

  const report = parseLastJsonObject((await runCli('restore', ['--from', output, '--events', state.events])).stdout)
  assert.equal(report.ok, true)
  assert.equal(report.categories.hashOnly.count, 1)
  assert.equal(report.categories.missing.count, 0)
  const hashOnlyEntry = report.categories.hashOnly.samples.find((entry) => entry.path === '.private/blobs/dataset.bin')
  assert.ok(hashOnlyEntry, 'hash-only sample should include the object-backed path')
  assert.equal(hashOnlyEntry.hash, hash)
  assert.equal(hashOnlyEntry.blobKey, blobKey)
  assert.equal(hashOnlyEntry.scope, 'owner-private')
  // restorableWithContent still covers the four inline fixture files.
  assert.equal(report.categories.restorableWithContent.count, 4)

  const target = path.join(state.root, 'hash-only-target')
  const result = parseLastJsonObject((await runCli('restore', [
    '--from',
    output,
    '--workspace',
    target,
    '--execute',
    '--events',
    state.events,
  ])).stdout)

  assert.equal(result.ok, true)
  assert.equal(result.filesWritten, 4)
  assert.equal(result.hashOnlySkipped, 1)
  assert.equal(result.hashOnlySkippedFiles[0].path, '.private/blobs/dataset.bin')
  assert.equal(result.hashOnlySkippedFiles[0].hash, hash)
  assert.equal(result.hashOnlySkippedFiles[0].blobKey, blobKey)
  // The body was never in the backup, so --execute must not have written a
  // (necessarily empty/wrong) placeholder file for it.
  assert.equal(await pathExists(path.join(target, '.private/blobs/dataset.bin')), false)
})

test('restore reports a genuinely unrecoverable object-backed entry (no blobKey) as missing, not hash-only', async () => {
  // The graph contract refuses to read an object-backed entry with no blobKey,
  // so `hop backup` can never write one; this state only arises when a backup's
  // cloud.json is corrupted after the fact. Corrupt a valid backup directly.
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))
  const plaintext = 'object-backed body\n'
  const hash = hashBuffer(Buffer.from(plaintext, 'utf8'))
  await addObjectBackedCloudFile(state, '.private/blobs/broken.bin', {
    hash,
    blobKey: `blobs/sha256/${hash.slice(0, 2)}/${hash}`,
    size: Buffer.byteLength(plaintext),
  })

  const output = path.join(state.root, 'missing-entry-backup')
  const backup = parseLastJsonObject((await runCli('backup', [...stateArgs(state), '--output', output, '--force'])).stdout)
  assert.equal(backup.ok, true)

  const backedUpCloud = await readJson(path.join(output, 'cloud.json'))
  delete backedUpCloud.files['.private/blobs/broken.bin'].blobKey
  await writeJson(path.join(output, 'cloud.json'), backedUpCloud)

  const failure = await runCliFailure('restore', ['--from', output, '--events', state.events])
  assert.equal(failure.code, 1)
  const report = parseLastJsonObject(failure.stdout)
  assert.equal(report.ok, false)
  assert.equal(report.categories.missing.count, 1)
  assert.ok(report.issues.some((issue) => /malformed file entr/.test(issue)))
})

test('restore CLI help mentions the restore command', async () => {
  const { stdout } = await runCli('help')
  assert.match(stdout, /restore\s+Verify a backup folder/)
})

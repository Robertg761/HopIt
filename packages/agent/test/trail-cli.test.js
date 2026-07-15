import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { scopeForPath } from '@hopit/core/privacy-zone'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(repoRoot, 'packages/agent/src/cli.js')

const T0 = Date.parse('2026-07-12T09:00:00.000Z')

function fileEntry(pathName, revision, content) {
  return {
    kind: 'file',
    content,
    encoding: 'utf8',
    scope: scopeForPath(pathName),
    revision,
    updatedAt: new Date(T0).toISOString(),
  }
}

function versionRow(revision, pathName, minute) {
  return {
    versionId: revision,
    codebaseId: 'trail-cli-core',
    graphRevision: revision,
    path: pathName,
    operation: revision === 1 ? 'add' : 'modify',
    deviceName: 'Laptop',
    createdAt: new Date(T0 + minute * 60000).toISOString(),
  }
}

// A minimal, contract-valid fixture cloud graph carrying a file-version history
// that clusters into a single trail episode (one device, tight timestamps).
function makeCloudGraph() {
  return {
    schemaVersion: 2,
    codebase: { id: 'trail-cli-core', name: 'Trail CLI Core', ownerId: 'user_owner' },
    main: { id: 'main', revision: 3, updatedAt: new Date(T0).toISOString(), mergedChangeSetId: null },
    selectedState: {
      type: 'active-change-set',
      id: 'cs_trail_cli',
      ownerId: 'user_owner',
      baseMainId: 'main',
      baseRevision: 3,
      revision: 3,
      visibility: 'private',
      effectiveVisibility: 'private',
      reviewState: 'not-open',
      mergeState: 'unmerged',
      conflictState: 'none',
      conflict: null,
      review: null,
      merge: null,
    },
    owner: { id: 'user_owner', name: 'Owner' },
    collaborators: [],
    session: { id: 'session_trail_cli', deviceName: 'Laptop' },
    visibility: {
      productDefault: 'private',
      globalUserDefault: null,
      codebaseOverride: null,
      changeSetOverride: null,
      effective: 'private',
    },
    revision: 3,
    files: {
      'README.md': fileEntry('README.md', 3, 'readme\n'),
      'src/a.js': fileEntry('src/a.js', 3, 'export const a = 1\n'),
      'src/b.js': fileEntry('src/b.js', 3, 'export const b = 2\n'),
    },
    fileVersions: [
      versionRow(1, 'README.md', 0),
      versionRow(2, 'src/a.js', 10),
      versionRow(3, 'src/b.js', 20),
    ],
  }
}

async function makeCloudFile() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-trail-cli-'))
  const cloudPath = path.join(root, 'cloud.json')
  await fs.writeFile(cloudPath, JSON.stringify(makeCloudGraph(), null, 2), 'utf8')
  return { root, cloudPath }
}

function baseArgs(cloudPath) {
  return ['--cloud-backend', 'local', '--cloud', cloudPath, '--codebase-id', 'trail-cli-core']
}

async function runCli(command, args = [], extraEnv = {}) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, command, ...args], {
    cwd: repoRoot,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, ...extraEnv },
  })
  return stdout
}

async function readCloud(cloudPath) {
  return JSON.parse(await fs.readFile(cloudPath, 'utf8'))
}

test('hop trail episodes clusters the version history into browsable episodes', async (t) => {
  const { root, cloudPath } = await makeCloudFile()
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const result = JSON.parse(await runCli('trail', ['episodes', ...baseArgs(cloudPath)]))
  assert.equal(result.ok, true)
  assert.equal(result.episodeCount, 1)
  assert.equal(result.episodes[0].fromRevision, 1)
  assert.equal(result.episodes[0].toRevision, 3)
  assert.equal(result.episodes[0].stepCount, 3)
  assert.equal(result.episodes[0].deviceName, 'Laptop')
  assert.equal(result.episodes[0].label, null)
})

test('hop trail summarize refuses to run while summaries are off (default)', async (t) => {
  const { root, cloudPath } = await makeCloudFile()
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const result = JSON.parse(
    await runCli('trail', ['summarize', ...baseArgs(cloudPath)], { HOPIT_SUMMARY_PROVIDER: 'stub' }),
  )
  assert.equal(result.ok, false)
  assert.equal(result.state, 'disabled')
})

test('hop trail summaries on + summarize labels episodes end to end with the stub provider', async (t) => {
  const { root, cloudPath } = await makeCloudFile()
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  const enabled = JSON.parse(await runCli('trail', ['summaries', 'on', ...baseArgs(cloudPath)]))
  assert.equal(enabled.trailSummariesEnabled, true)
  assert.equal(enabled.trailSummariesMode, 'metadata')

  const summarized = JSON.parse(
    await runCli('trail', ['summarize', ...baseArgs(cloudPath)], { HOPIT_SUMMARY_PROVIDER: 'stub' }),
  )
  assert.equal(summarized.ok, true)
  assert.equal(summarized.state, 'summarized')
  assert.equal(summarized.labeled, 1)
  assert.equal(summarized.model, 'stub')

  // Label persisted and now surfaced on the episode listing.
  const listing = JSON.parse(await runCli('trail', ['episodes', ...baseArgs(cloudPath)]))
  assert.equal(listing.episodes[0].labelModel, 'stub')
  assert.ok(listing.episodes[0].label && listing.episodes[0].label.length > 0)

  // Persisted in the cloud fixture under the additive top-level keys.
  const cloud = await readCloud(cloudPath)
  assert.equal(cloud.codebaseSettings.trailSummariesEnabled, true)
  assert.equal(cloud.trailEpisodes.length, 1)
  assert.equal(cloud.trailEpisodes[0].labelMode, 'metadata')
})

test('hop trail summarize --dry-run prints the exact metadata payload and sends nothing', async (t) => {
  const { root, cloudPath } = await makeCloudFile()
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  await runCli('trail', ['summaries', 'on', ...baseArgs(cloudPath)])
  const result = JSON.parse(
    await runCli('trail', ['summarize', '--dry-run', ...baseArgs(cloudPath)], { HOPIT_SUMMARY_PROVIDER: 'openai' }),
  )
  assert.equal(result.state, 'dry-run')
  assert.equal(result.labeled, 0)
  assert.equal(result.payloads.length, 1)
  const payload = result.payloads[0].payload
  assert.equal(payload.mode, 'metadata')
  assert.equal('diff' in payload, false)
  // No file contents in metadata mode: the payload never references file bodies.
  assert.equal(JSON.stringify(payload).includes('export const'), false)

  // Nothing was labeled or persisted.
  const cloud = await readCloud(cloudPath)
  assert.equal(cloud.trailEpisodes === undefined || cloud.trailEpisodes.length === 0, true)
})

test('hop trail summarize gives an honest missing-key error for a real provider', async (t) => {
  const { root, cloudPath } = await makeCloudFile()
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  await runCli('trail', ['summaries', 'on', ...baseArgs(cloudPath)])
  await assert.rejects(
    () =>
      runCli('trail', ['summarize', ...baseArgs(cloudPath)], {
        HOPIT_SUMMARY_PROVIDER: 'openai',
        HOPIT_SUMMARY_API_KEY: '',
        OPENAI_API_KEY: '',
      }),
    (error) => {
      assert.match(String(error.stderr ?? error.message), /HOPIT_SUMMARY_API_KEY/)
      return true
    },
  )
})

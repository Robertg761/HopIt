// GR-X1: end-to-end adversarial suite for the git-replacement invariants
// (docs/git-replacement-implementation-plan.md, Track X).
//
// Every other suite in this directory proves one task's behavior in
// isolation. This one chains them: a scenario here fails if any link in the
// pipeline -- reconnect classification (GR-A1/A2), the conflicts surface
// (GR-A3), unified startup reconciliation (GR-A4), propose and the merge
// queue (GR-B2), derived-path classification (GR-C1), the outbound secret
// scanner (GR-D1), the git mirror (GR-E1/E2), per-file refresh and
// save-clobber detection (GR-F1/F2), the large-file warning (GR-G2), or the
// cloud-unreachable envelope (decisions §12) -- regresses on its own or at a
// seam with its neighbours.
//
// The devices are separate workspaces/journals/event logs sharing one cloud
// graph, driven through the real `hop` CLI (the two-device loopback pattern
// from agent-cli.test.js / remote-push.test.js / conflicts.test.js), so the
// scenarios exercise process boundaries the way the product does. Scenario 5
// additionally runs against a live loopback D1 worker so "the cloud is
// unreachable" can be a real severed socket rather than a stubbed error.
//
// Every scenario ends by comparing content with `hashTree`, a recursive
// path -> sha256 map, across both devices, the cloud graph, and (scenario 1)
// a checkout of the git mirror -- never by spot-checking a single file.
import assert from 'node:assert/strict'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { readNdjson } from '../src/io.js'
import { createCloudGraphService } from '../src/cloud/d1-graph-service.js'
import { parseOptions } from '../src/options.js'
import { watchWorkspace } from '../src/watch.js'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(repoRoot, 'packages/agent/src/cli.js')

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex')
}

async function makeTempRoot(t, label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `hopit-x1-${label}-`))
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })
  return root
}

// Two devices, one owner, one cloud graph -- separate workspaces, journals
// and event logs, exactly like two machines belonging to the same person.
async function makeTwoDeviceState(t, label) {
  const root = await makeTempRoot(t, label)
  const cloud = path.join(root, 'cloud.json')
  const device = (name) => ({
    name,
    root,
    cloud,
    workspace: path.join(root, `${name}-workspace`),
    journal: path.join(root, `${name}-journal.ndjson`),
    events: path.join(root, `${name}-events.ndjson`),
  })
  return { root, cloud, deviceA: device('device-a'), deviceB: device('device-b') }
}

function stateArgs(state) {
  return ['--cloud', state.cloud, '--workspace', state.workspace, '--journal', state.journal, '--events', state.events]
}

async function runCli(command, args = []) {
  return execFileAsync(process.execPath, [cliPath, command, ...args], { cwd: repoRoot, encoding: 'utf8' })
}

async function initTwoDevices(state) {
  await runCli('init', [...stateArgs(state.deviceA), '--force'])
  await runCli('hydrate', stateArgs(state.deviceA))
  await runCli('hydrate', stateArgs(state.deviceB))
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

async function appendJournalEntry(state, entry) {
  await fs.appendFile(state.journal, `${JSON.stringify(entry)}\n`, 'utf8')
}

async function writeWorkspaceFile(state, relativePath, content) {
  const target = path.join(state.workspace, relativePath)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content, 'utf8')
}

async function statusOf(state) {
  return JSON.parse((await runCli('status', stateArgs(state))).stdout)
}

// `hop conflicts` and friends print one raw NDJSON agent event per line and
// then their own pretty-printed JSON summary; the summary is the only part
// that starts a line with a bare `{`. Same reader conflicts.test.js uses.
function lastJsonResult(stdout) {
  const lines = stdout.split('\n')
  const start = lines.lastIndexOf('{')
  if (start === -1) throw new Error(`No JSON summary found in stdout: ${stdout}`)
  return JSON.parse(lines.slice(start).join('\n'))
}

// ---------------------------------------------------------------------------
// Recursive hash compare -- the shared "did everything actually converge?"
// assertion. A path -> sha256 map, so a mismatch names the offending file
// instead of just saying the trees differ.
// ---------------------------------------------------------------------------

// `.hopit-agent/` is the agent's own runtime state inside the Workspace Root
// (the GR-H3 lock lives there). It is never user content and never syncs, so
// it is excluded from every content comparison by default rather than being
// remembered at each call site.
const isAgentRuntimePath = (relativePath) => relativePath === '.hopit-agent' || relativePath.startsWith('.hopit-agent/')

async function hashTree(dir, { skip = () => false } = {}) {
  const tree = new Map()
  async function walk(current, prefix) {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch((error) => {
      if (error?.code === 'ENOENT') return []
      throw error
    })
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (isAgentRuntimePath(relativePath) || skip(relativePath)) continue
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), relativePath)
      } else if (entry.isFile()) {
        tree.set(relativePath, createHash('sha256').update(await fs.readFile(path.join(current, entry.name))).digest('hex'))
      }
    }
  }
  await walk(dir, '')
  return tree
}

// The same map shape, derived from the cloud graph's stored file contents,
// so a workspace tree and the cloud graph are directly comparable.
function hashCloudTree(cloud, { skip = () => false } = {}) {
  const tree = new Map()
  for (const [relativePath, file] of Object.entries(cloud.files ?? {})) {
    if (skip(relativePath)) continue
    if (file.kind && file.kind !== 'file') continue
    const buffer = Buffer.from(file.content ?? '', file.encoding === 'base64' ? 'base64' : 'utf8')
    tree.set(relativePath, createHash('sha256').update(buffer).digest('hex'))
  }
  return tree
}

function assertTreesEqual(actual, expected, message) {
  const actualEntries = [...actual.entries()].sort(([a], [b]) => a.localeCompare(b))
  const expectedEntries = [...expected.entries()].sort(([a], [b]) => a.localeCompare(b))
  assert.deepEqual(actualEntries, expectedEntries, message)
}

const isPrivatePath = (relativePath) => relativePath.startsWith('.private/')

// ---------------------------------------------------------------------------
// git helpers (local bare repo standing in for the mirror remote)
// ---------------------------------------------------------------------------

function runGitOrThrow(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result
}

async function makeBareRemote(root, name) {
  const remotePath = path.join(root, `${name}.git`)
  runGitOrThrow(['init', '--bare', '--quiet', remotePath], root)
  return remotePath
}

function commitLog(remotePath, branch = 'main') {
  return runGitOrThrow(['log', '--format=%H', branch], remotePath).stdout.trim().split('\n').filter(Boolean)
}

async function checkoutMirror(root, remotePath, label) {
  const checkoutDir = path.join(root, `mirror-checkout-${label}`)
  runGitOrThrow(['clone', '--quiet', '--branch', 'main', remotePath, checkoutDir], root)
  return hashTree(checkoutDir, { skip: (relativePath) => relativePath === '.git' || relativePath.startsWith('.git/') })
}

// ---------------------------------------------------------------------------
// Scenario 1 -- the full pipeline, end to end
//
//   offline divergence -> reconnect classification -> `hop conflicts resolve`
//   -> `hop propose --merge` -> merge queue lands it -> `hop mirror-sync`
//   advances the bare-repo mirror by exactly one commit.
//
// This is the scenario the whole plan exists to make work: an edit made on a
// disconnected second device survives the reconnect, is resolved by the
// owner rather than by a heuristic, lands on Main through the same door a
// team proposal would, and reaches git.
// ---------------------------------------------------------------------------

test('scenario 1: offline divergence resolves, proposes, merges, and advances the mirror by exactly one commit', async (t) => {
  const state = await makeTwoDeviceState(t, 'scenario1')
  const { deviceA, deviceB } = state
  await initTwoDevices(state)
  const remote = await makeBareRemote(state.root, 'origin')

  // --- Device A, online: moves README.md forward on the cloud.
  const mainContent = '# hopit-core\n\nDevice A landed this while B was offline.\n'
  await writeWorkspaceFile(deviceA, 'README.md', mainContent)
  await runCli('sync-once', stateArgs(deviceA))
  assert.equal((await readJson(state.cloud)).files['README.md'].content, mainContent)

  // --- Device B, offline: edits the same file against a stale base revision.
  // The journal entry is written directly because there is no cloud to
  // acknowledge it to -- that is precisely what "offline" means here.
  const offlineContent = '# hopit-core\n\nDevice B wrote this on a plane.\n'
  await writeWorkspaceFile(deviceB, 'README.md', offlineContent)
  await appendJournalEntry(deviceB, {
    id: randomUUID(),
    type: 'write',
    path: 'README.md',
    scope: 'shared',
    hash: hashContent(offlineContent),
    bytes: Buffer.byteLength(offlineContent),
    createdAt: new Date().toISOString(),
    status: 'pending',
    baseRevision: 0,
  })

  // --- Reconnect: classification opens a divergence for the contested file
  // and does not clobber either side.
  const recovery = await runCli('recover', stateArgs(deviceB))
  assert.match(recovery.stdout, /"diverged":1/, 'the contested path is classified as a divergence, not replayed')
  assert.equal(
    await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8'),
    offlineContent,
    'device B local bytes untouched until the owner resolves',
  )
  assert.equal(
    (await readJson(state.cloud)).files['README.md'].content,
    mainContent,
    'the cloud side is untouched too -- nothing is silently overwritten',
  )

  const conflicts = lastJsonResult((await runCli('conflicts', [...stateArgs(deviceB), '--json'])).stdout)
  assert.equal(conflicts.count, 1)
  assert.equal(conflicts.divergences[0].path, 'README.md')

  // --- The owner resolves in favour of the offline device.
  const resolution = lastJsonResult(
    (await runCli('conflicts', ['resolve', 'README.md', '--keep', 'local', ...stateArgs(deviceB), '--json'])).stdout,
  )
  assert.equal(resolution.ok, true)
  assert.equal(resolution.keep, 'local')
  assert.deepEqual((await statusOf(deviceB)).divergences, [], 'the divergence is closed')

  await runCli('sync-once', stateArgs(deviceB))

  // --- Mirror catches up to everything that exists so far, so the commit
  // count below measures only the change that is about to be proposed.
  const mirrorBefore = lastJsonResult((await runCli('mirror-sync', [...stateArgs(deviceB), '--remote', remote])).stdout)
  assert.equal(mirrorBefore.ok, true)
  const commitsBeforeMerge = commitLog(remote)

  // --- One more edit on the reconnected device: this single change is what
  // the proposal will pin, so the mirror must grow by exactly one commit.
  const shippedContent = 'export const shipped = true\n'
  await writeWorkspaceFile(deviceB, 'src/shipped.ts', shippedContent)
  await runCli('sync-once', stateArgs(deviceB))

  // --- Propose and land through the merge queue (solo path, same door).
  const proposed = await runCli('propose', [
    ...stateArgs(deviceB),
    '--title',
    'Offline work from device B',
    '--merge',
    '--requester-id',
    'user_demo_owner',
  ])
  assert.match(proposed.stdout, /proposal\.pinned/)
  assert.match(proposed.stdout, /proposal\.approved/)
  assert.match(proposed.stdout, /proposal\.merged/)

  // --- The mirror advances by exactly one commit for that one merge.
  const mirrorAfter = lastJsonResult((await runCli('mirror-sync', [...stateArgs(deviceB), '--remote', remote])).stdout)
  assert.equal(mirrorAfter.commitsCreated, 1, 'the one landed proposal => exactly one mirror commit')
  const commitsAfterMerge = commitLog(remote)
  assert.equal(commitsAfterMerge.length, commitsBeforeMerge.length + 1)
  assert.deepEqual(commitsAfterMerge.slice(1), commitsBeforeMerge, 'the new commit sits on top of the existing history')

  // --- Convergence, by recursive hash compare across both devices, the
  // cloud graph, and the mirror.
  await runCli('refresh', stateArgs(deviceA))
  const cloud = await readJson(state.cloud)
  const cloudTree = hashCloudTree(cloud)
  assertTreesEqual(await hashTree(deviceB.workspace), cloudTree, 'device B matches the cloud graph')
  assertTreesEqual(await hashTree(deviceA.workspace), cloudTree, 'device A converged onto the same content')

  const mirrorTree = await checkoutMirror(state.root, remote, 'scenario1')
  assertTreesEqual(
    mirrorTree,
    hashCloudTree(cloud, { skip: isPrivatePath }),
    'the mirror is byte-identical to the shared half of Main',
  )
  assert.equal([...mirrorTree.keys()].some(isPrivatePath), false, 'no owner-private path ever reaches git')
  assert.equal(mirrorTree.get('README.md'), hashContent(offlineContent), 'the resolved-in-favour-of-local content is what shipped')
})

// ---------------------------------------------------------------------------
// Scenario 2 -- crash while editing
//
// A real `hop watch` process is SIGKILLed mid-session (no clean shutdown, no
// chance to flush), the workspace is edited while nothing is watching, and a
// fresh agent starts up. GR-A4's startup diff-scan has to notice every edit
// made in the dark, synthesize journal entries for them, and replay them
// cleanly -- a solo device editing its own files must never manufacture a
// divergence out of its own crash.
// ---------------------------------------------------------------------------

function spawnWatch(state, t) {
  const child = spawn(process.execPath, [cliPath, 'watch', ...stateArgs(state)], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  return { child, output: () => output, exited }
}

async function waitFor(predicate, { timeoutMs = 20000, label = 'condition' } = {}) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const result = await predicate()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.`)
}

test('scenario 2: a SIGKILLed agent plus edits made while it was down replay cleanly with no divergence', async (t) => {
  const state = await makeTwoDeviceState(t, 'scenario2')
  const { deviceA, deviceB } = state
  await initTwoDevices(state)

  // --- A live session: the agent is up and watching.
  const watcher = spawnWatch(deviceA, t)
  await waitFor(() => /watch\.started/.test(watcher.output()), { label: 'watch.started' })

  // --- Crash *while editing*: this write may or may not have been journaled
  // before the kill lands. Either way the restart must converge on it, which
  // is exactly the property the scenario is here to pin down.
  await writeWorkspaceFile(deviceA, 'src/in-flight.ts', 'export const inFlight = 1\n')
  watcher.child.kill('SIGKILL')
  const { code, signal } = await watcher.exited
  assert.equal(code, null, 'the agent was killed, not shut down cleanly')
  assert.equal(signal, 'SIGKILL')

  // --- Editing continues with nothing watching: a modified file, a brand
  // new one, and a deletion, so the diff-scan has all three shapes to find.
  await writeWorkspaceFile(deviceA, 'src/in-flight.ts', 'export const inFlight = 2 // edited after the crash\n')
  await writeWorkspaceFile(deviceA, 'README.md', '# hopit-core\n\nEdited while the agent was dead.\n')
  await writeWorkspaceFile(deviceA, 'src/created-in-the-dark.ts', 'export const createdInTheDark = true\n')
  await fs.rm(path.join(deviceA.workspace, 'package.json'))

  // --- Restart. Startup reconciliation is the only mechanism that can see
  // any of this.
  const eventsBefore = (await readNdjson(deviceA.events)).length
  const restartOptions = { ...parseOptions(stateArgs(deviceA)), quiet: true }
  const handle = await watchWorkspace(restartOptions)
  t.after(() => handle?.close())

  const newEvents = (await readNdjson(deviceA.events)).slice(eventsBefore)
  const scanned = newEvents.find((event) => event.event === 'watch.diff_scan_synthesized')
  assert.ok(scanned, 'the startup diff-scan ran and synthesized entries for the unwatched edits')
  assert.ok(scanned.detail.synthesizedCount >= 1)
  assert.equal(scanned.detail.massDeleteShaped, false, 'three edits are not mass-delete shaped')

  const recovered = newEvents.find((event) => event.event === 'journal.recovery_complete')
  assert.ok(recovered, 'the synthesized entries went through the normal recovery path')
  assert.equal(recovered.detail.diverged, 0, 'a solo device editing its own files never diverges against itself')
  assert.equal(recovered.detail.failed, 0)
  assert.ok(
    newEvents.indexOf(scanned) < newEvents.indexOf(recovered),
    'diff-scan precedes replay: reconcile the personal change set before anything else',
  )

  // --- Byte-identical convergence, by recursive hash compare.
  const cloud = await readJson(state.cloud)
  assert.equal(cloud.files['src/in-flight.ts'].content, 'export const inFlight = 2 // edited after the crash\n')
  assert.equal('package.json' in cloud.files, false, 'the offline deletion replayed as a deletion')
  assertTreesEqual(await hashTree(deviceA.workspace), hashCloudTree(cloud), 'device A is byte-identical to the cloud graph')

  await runCli('refresh', stateArgs(deviceB))
  assertTreesEqual(
    await hashTree(deviceB.workspace),
    hashCloudTree(cloud),
    'the second device converges byte-identically on the crashed device work',
  )

  const status = await statusOf(deviceA)
  assert.deepEqual(status.divergences, [], 'no divergence was manufactured by the crash')
  assert.equal(status.journal.pendingCount, 0, 'nothing left stranded in the journal')
})

// ---------------------------------------------------------------------------
// Scenario 3 -- one hostile session: derived-file storm + planted secret +
// over-threshold file, all at once
//
// A single `hop sync` has to get three independent classifications right in
// the same pass: hundreds of build-output writes are never journaled at all
// (GR-C1), a credential pasted into a source file is flagged without
// blocking the upload (GR-D1), an oversized file syncs in full but raises a
// warning (GR-G2), and none of that noise costs a single legitimate source
// file its sync.
// ---------------------------------------------------------------------------

const DERIVED_BURST_FILES = 300
// A syntactically valid AWS access key id (AKIA + 16 upper-case alphanumerics)
// that is not, and never was, a real credential -- AWS's own documentation
// example key.
const PLANTED_SECRET = 'AKIAIOSFODNN7EXAMPLE'

test('scenario 3: a derived-file storm, a planted secret and an over-threshold file in one session', async (t) => {
  const state = await makeTwoDeviceState(t, 'scenario3')
  const { deviceA, deviceB } = state
  await initTwoDevices(state)

  // Dial the large-file threshold down so an ordinary small fixture can
  // stand in for "large" -- no real gigabyte is ever written to disk.
  const options = parseOptions(stateArgs(deviceA))
  const thresholdBytes = 512
  await createCloudGraphService(options).setLargeFileThreshold(null, { thresholdBytes })

  // --- The storm: hundreds of build outputs, plus a nested one for good
  // measure, none of which is user content.
  await fs.mkdir(path.join(deviceA.workspace, 'node_modules/some-pkg/dist'), { recursive: true })
  await Promise.all(
    Array.from({ length: DERIVED_BURST_FILES }, (_, index) =>
      fs.writeFile(path.join(deviceA.workspace, `node_modules/some-pkg/dist/chunk-${index}.js`), `module.exports = ${index}\n`, 'utf8'),
    ),
  )
  // A derived path that also *looks* like a secret: it must be neither
  // journaled nor scanned, so it cannot produce a second secret event.
  await fs.writeFile(
    path.join(deviceA.workspace, 'node_modules/some-pkg/dist/bundled-config.js'),
    `exports.key = '${PLANTED_SECRET}'\n`,
    'utf8',
  )

  // --- The planted secret, in real source this time.
  const secretFileContent = `export const awsKeyId = '${PLANTED_SECRET}'\n`
  await writeWorkspaceFile(deviceA, 'src/config.ts', secretFileContent)

  // --- The over-threshold file.
  const bigContent = `${'x'.repeat(thresholdBytes * 3)}\n`
  await writeWorkspaceFile(deviceA, 'assets/big.bin', bigContent)

  // --- Legitimate source that must not be collateral damage.
  const legitimateSources = {
    'src/alpha.ts': 'export const alpha = 1\n',
    'src/beta.ts': 'export const beta = 2\n',
    'src/nested/gamma.ts': 'export const gamma = 3\n',
    'README.md': '# hopit-core\n\nStill a normal edit.\n',
  }
  for (const [relativePath, content] of Object.entries(legitimateSources)) {
    await writeWorkspaceFile(deviceA, relativePath, content)
  }

  // --- One session.
  await runCli('sync-once', stateArgs(deviceA))

  // --- Derived paths: zero journal entries, zero cloud presence.
  const journal = await readNdjson(deviceA.journal)
  const derivedEntries = journal.filter((entry) => entry.path?.startsWith('node_modules/'))
  assert.equal(derivedEntries.length, 0, `${DERIVED_BURST_FILES + 1} derived writes must journal nothing`)

  const cloud = await readJson(state.cloud)
  assert.equal(
    Object.keys(cloud.files).some((relativePath) => relativePath.startsWith('node_modules/')),
    false,
    'no derived path reaches the cloud graph',
  )

  // --- The secret: exactly one finding, for the source file, and the write
  // still went through (warn-only, never a gate).
  const events = await readNdjson(deviceA.events)
  const suspected = events.filter((event) => event.event === 'secret.suspected')
  assert.equal(suspected.length, 1, 'exactly one secret finding -- the derived look-alike is not scanned')
  assert.equal(suspected[0].detail.path, 'src/config.ts')
  assert.equal(cloud.files['src/config.ts'].content, secretFileContent, 'the upload proceeded: scanning warns, it never blocks')

  // --- The large file: exactly one warning, full content synced, no cap.
  const large = events.filter((event) => event.event === 'file.large')
  assert.equal(large.length, 1)
  assert.equal(large[0].detail.path, 'assets/big.bin')
  assert.equal(large[0].detail.thresholdBytes, thresholdBytes)
  assert.equal(cloud.files['assets/big.bin'].content, bigContent, 'over-threshold files sync in full')

  // --- Every legitimate source file made it.
  for (const [relativePath, content] of Object.entries(legitimateSources)) {
    assert.equal(cloud.files[relativePath]?.content, content, `${relativePath} synced despite the noise`)
  }

  // --- Recursive hash compare: the workspace minus its derived roots is
  // exactly the cloud graph, and the second device converges onto it.
  const isDerived = (relativePath) => relativePath === 'node_modules' || relativePath.startsWith('node_modules/')
  assertTreesEqual(
    await hashTree(deviceA.workspace, { skip: isDerived }),
    hashCloudTree(cloud),
    'the non-derived half of device A is byte-identical to the cloud graph',
  )

  await runCli('refresh', stateArgs(deviceB))
  const deviceBTree = await hashTree(deviceB.workspace)
  assertTreesEqual(deviceBTree, hashCloudTree(cloud), 'device B converged byte-identically')
  assert.equal([...deviceBTree.keys()].some(isDerived), false, 'derived output never propagates to another device')
})

// ---------------------------------------------------------------------------
// Scenario 4 -- the refresh race, attempted clobber
//
// Main moves a file forward, device B's refresh applies it to disk, but B's
// editor never saw it. B saves its stale buffer straight over the top. The
// agent cannot see editor buffers, only disk, so the protection has to be
// save-side (GR-F2): that save becomes a divergence rather than a silent
// revert of Main. The untouched file that Main also moved must still refresh
// normally in the same pass (GR-F1) -- one contested path does not freeze
// the rest of the workspace.
// ---------------------------------------------------------------------------

test('scenario 4: a stale-buffer save over a refreshed file diverges instead of silently reverting Main', async (t) => {
  const state = await makeTwoDeviceState(t, 'scenario4')
  const { deviceA, deviceB } = state
  await initTwoDevices(state)

  // --- Main moves two files forward while device B is idle.
  const mainReadme = '# hopit-core\n\nMain moved this forward while B was idle.\n'
  const mainPresence = 'export const presence = "main-updated"\n'
  await writeWorkspaceFile(deviceA, 'README.md', mainReadme)
  await writeWorkspaceFile(deviceA, 'src/presence.ts', mainPresence)
  await runCli('sync-once', stateArgs(deviceA))
  const cloudAfterMain = await readJson(state.cloud)

  // --- Device B refreshes: both files land on disk, and the writer ledger
  // now records a pending refresh for each.
  await runCli('refresh', stateArgs(deviceB))
  assert.equal(await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8'), mainReadme)
  assert.equal(
    await fs.readFile(path.join(deviceB.workspace, 'src/presence.ts'), 'utf8'),
    mainPresence,
    'the file device B never touched refreshed normally',
  )

  // --- A stale editor buffer, oblivious to the refresh, is saved over
  // README.md. It neither matches nor builds on Main's content.
  const staleBufferSave = '# hopit-core\n\nDevice B stale buffer that never saw the refresh.\n'
  await writeWorkspaceFile(deviceB, 'README.md', staleBufferSave)

  const sync = await runCli('sync-once', stateArgs(deviceB))
  assert.match(sync.stdout, /sync\.save_clobber_diverged/, 'the save is classified as a potential clobber')
  assert.match(sync.stdout, /"saveClobberDiverged":\s*1/)
  assert.match(sync.stdout, /"path":\s*"README\.md"/)

  // --- Zero silent reverts, both directions. Main keeps exactly what device
  // A committed, and device B keeps exactly the bytes it saved: the conflict
  // is surfaced, not resolved behind the user's back.
  const cloudAfterClobberAttempt = await readJson(state.cloud)
  assert.equal(
    cloudAfterClobberAttempt.files['README.md'].content,
    mainReadme,
    "Main's content is still recoverable -- the stale save never landed on it",
  )
  assert.equal(await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8'), staleBufferSave)
  assertTreesEqual(
    await hashTree(deviceA.workspace),
    hashCloudTree(cloudAfterMain),
    'device A, which was not involved, is untouched by the failed clobber',
  )

  // Both sides of the conflict exist at once: neither was discarded.
  assert.notEqual(hashContent(mainReadme), hashContent(staleBufferSave))

  // --- The divergence is surfaced on the conflicts path and resolvable.
  const conflicts = lastJsonResult((await runCli('conflicts', [...stateArgs(deviceB), '--json'])).stdout)
  assert.equal(conflicts.count, 1, 'the save-clobber divergence shows up as an open conflict')
  assert.equal(conflicts.divergences[0].path, 'README.md')

  const resolution = lastJsonResult(
    (await runCli('conflicts', ['resolve', 'README.md', '--keep', 'cloud', ...stateArgs(deviceB), '--json'])).stdout,
  )
  assert.equal(resolution.ok, true)
  assert.equal(resolution.keep, 'cloud')
  assert.deepEqual((await statusOf(deviceB)).divergences, [])

  // --- Everything converges on Main's content, by recursive hash compare.
  const finalCloud = await readJson(state.cloud)
  const finalCloudTree = hashCloudTree(finalCloud)
  assertTreesEqual(await hashTree(deviceB.workspace), finalCloudTree, 'device B converged onto Main')
  assertTreesEqual(await hashTree(deviceA.workspace), finalCloudTree, 'device A still matches Main')
  assert.equal(finalCloud.files['README.md'].content, mainReadme, 'keeping cloud kept exactly what Main had')
})

// ---------------------------------------------------------------------------
// Scenario 5 -- the cloud goes away mid-edit
//
// The other four scenarios talk to the local file-graph fixture. This one
// runs against a real loopback D1 worker so "unreachable" can be an actually
// severed socket rather than a stubbed rejection: every request is destroyed
// at the TCP level while the cut is in force, exactly as a dropped network
// looks to the agent. Editing continues throughout, `hop status` has to make
// the outage visible rather than pretending everything is fine, and
// reconnecting has to converge byte-identically with no lost writes.
//
// Worth knowing, because it is not what you would guess: against a *fully*
// unreachable cloud the journal does not accumulate. `performSyncOnce` reads
// the cloud graph before it can plan (and therefore journal) anything, so a
// hard outage fails at that read and no entry is written. What actually
// keeps the writes safe is the workspace itself plus GR-A4's startup
// diff-scan, which synthesizes the entries at reconnect -- the same path a
// crash takes in scenario 2. This scenario asserts that real behavior rather
// than the journal-first one the architecture doc's wording implies; closing
// that gap would mean restructuring the sync path and is deliberately left
// to a separate task.
// ---------------------------------------------------------------------------

// A loopback D1 API worker whose connection can be cut and restored without
// changing the port the agent is configured with.
async function startSeverableD1Server(t) {
  const { default: d1ApiWorker } = await import('../../../cloudflare/d1/api-worker.js')
  const db = new DatabaseSync(':memory:')
  const env = {
    HOPIT_D1_DB: d1Binding(db),
    HOPIT_D1_PROXY_TOKEN: 'token_test',
    HOPIT_D1_PROXY_LOG_REQUESTS: '0',
  }
  let severed = false
  const sockets = new Set()

  const server = createServer(async (request, response) => {
    if (severed) {
      request.socket.destroy()
      return
    }
    try {
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await readRequestBody(request)
      const workerRequest = new Request(`http://127.0.0.1${request.url ?? '/query'}`, {
        method: request.method,
        headers: request.headers,
        body,
      })
      const workerResponse = await d1ApiWorker.fetch(workerRequest, env)
      response.writeHead(workerResponse.status, Object.fromEntries(workerResponse.headers.entries()))
      response.end(await workerResponse.text())
    } catch (error) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        success: true,
        result: [{ success: false, results: [], error: error instanceof Error ? error.message : 'query failed' }],
      }))
    }
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => {
    for (const socket of sockets) socket.destroy()
    db.close()
    server.close()
  })
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    db,
    sever() {
      severed = true
      for (const socket of sockets) socket.destroy()
    },
    restore() {
      severed = false
    },
  }
}

function d1Binding(db) {
  return {
    prepare(sql) {
      const statement = db.prepare(sql)
      return {
        bind(...params) {
          return {
            all() {
              const isSelect = sql.trim().toLowerCase().startsWith('select')
              const result = isSelect ? null : statement.run(...params)
              const rows = isSelect ? statement.all(...params) : []
              return { results: rows, meta: { changes: result?.changes ?? 0 } }
            },
          }
        },
      }
    },
  }
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

function d1StateArgs(server, device) {
  return [
    '--cloud-backend', 'd1',
    '--codebase-id', 'hopit-core',
    '--d1-api-base-url', server.baseUrl,
    '--d1-account-id', 'account_test',
    '--d1-database-id', 'database_test',
    '--d1-api-token', 'token_test',
    '--workspace', device.workspace,
    '--journal', device.journal,
    '--events', device.events,
  ]
}

// While the cloud is severed the agent is expected to fail its sync -- that
// failure is the scenario, not a test error, so the exit status is captured
// instead of thrown.
async function runCliAllowingFailure(command, args) {
  try {
    const { stdout, stderr } = await runCli(command, args)
    return { ok: true, stdout, stderr }
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}


test('scenario 5: editing through a severed cloud loses nothing and converges byte-identically on reconnect', async (t) => {
  const server = await startSeverableD1Server(t)
  const root = await makeTempRoot(t, 'scenario5')
  const makeDevice = (name) => ({
    workspace: path.join(root, `${name}-workspace`),
    journal: path.join(root, `${name}-journal.ndjson`),
    events: path.join(root, `${name}-events.ndjson`),
  })
  const deviceA = makeDevice('device-a')
  const deviceB = makeDevice('device-b')
  const argsA = d1StateArgs(server, deviceA)
  const argsB = d1StateArgs(server, deviceB)

  await runCli('init', [...argsA, '--force'])
  await runCli('hydrate', argsA)
  await runCli('hydrate', argsB)

  // --- Online baseline.
  await writeWorkspaceFile(deviceA, 'src/online.ts', 'export const online = true\n')
  await runCli('sync-once', argsA)
  const baselineFileCount = JSON.parse((await runCli('status', argsA)).stdout).visibleFileCount

  // --- The cloud goes away mid-session, at the socket level.
  server.sever()

  const offlineWrites = {
    'src/offline-1.ts': 'export const offlineOne = 1\n',
    'src/offline-2.ts': 'export const offlineTwo = 2\n',
    'src/nested/offline-3.ts': 'export const offlineThree = 3\n',
    'README.md': '# hopit-core\n\nWritten with no cloud in sight.\n',
  }
  for (const [relativePath, content] of Object.entries(offlineWrites)) {
    await writeWorkspaceFile(deviceA, relativePath, content)
    // Each save tries to reach the cloud and cannot. The failure is the
    // scenario, so it is captured rather than thrown.
    const attempt = await runCliAllowingFailure('sync-once', argsA)
    assert.equal(attempt.ok, false, `sync of ${relativePath} could not reach the severed cloud`)
  }

  // --- The outage is surfaced, not swallowed: `hop status` still runs (it is
  // the one surface you reach for when things are broken) and it says the
  // cloud is unreachable rather than reporting a healthy workspace.
  const outageStatus = JSON.parse((await runCli('status', argsA)).stdout)
  assert.equal(outageStatus.cloudReachable, false, 'status names the outage instead of pretending the cloud is fine')
  assert.equal(outageStatus.ok, false, 'the agent does not report itself healthy while it cannot reach the cloud')
  assert.ok(outageStatus.cloudReadError, 'the transport failure is reported, not hidden')

  // --- Nothing is lost and nothing is reverted: every byte written during
  // the outage is still exactly as the user left it on disk.
  const treeDuringOutage = await hashTree(deviceA.workspace)
  for (const [relativePath, content] of Object.entries(offlineWrites)) {
    assert.equal(treeDuringOutage.get(relativePath), hashContent(content), `${relativePath} is intact on disk during the outage`)
  }

  // --- Editing keeps going after the outage is already visible.
  const lateWrite = 'export const offlineFour = 4\n'
  await writeWorkspaceFile(deviceA, 'src/offline-4.ts', lateWrite)
  await runCliAllowingFailure('sync-once', argsA)

  // --- The cloud comes back. Nothing landed on it while it was gone.
  server.restore()
  const reconnectedStatus = JSON.parse((await runCli('status', argsA)).stdout)
  assert.equal(reconnectedStatus.cloudReachable, true, 'the cloud is reachable again')
  assert.equal(
    reconnectedStatus.visibleFileCount,
    baselineFileCount,
    'the severed writes really did not reach the cloud -- convergence below is not a false positive',
  )

  // --- Restarting the agent is what drains the backlog: startup
  // reconciliation diff-scans the workspace, synthesizes a journal entry for
  // every edit made while the cloud was gone, and replays them.
  const restartOptions = { ...parseOptions(argsA), quiet: true }
  const eventsBefore = (await readNdjson(deviceA.events)).length
  const handle = await watchWorkspace(restartOptions)
  t.after(() => handle?.close())

  const newEvents = (await readNdjson(deviceA.events)).slice(eventsBefore)
  const scanned = newEvents.find((event) => event.event === 'watch.diff_scan_synthesized')
  assert.ok(scanned, 'the reconnecting agent diff-scans the workspace')
  const recovered = newEvents.find((event) => event.event === 'journal.recovery_complete')
  assert.ok(recovered, 'the synthesized backlog went through the normal recovery path')
  assert.equal(recovered.detail.diverged, 0, 'one device catching up on its own edits never diverges')
  assert.equal(recovered.detail.failed, 0)

  const allOfflineWrites = { ...offlineWrites, 'src/offline-4.ts': lateWrite }
  const journalPaths = new Set((await readNdjson(deviceA.journal)).map((entry) => entry.path))
  for (const relativePath of Object.keys(allOfflineWrites)) {
    assert.ok(journalPaths.has(relativePath), `${relativePath} is journaled once the agent is back`)
  }

  const drainedStatus = JSON.parse((await runCli('status', argsA)).stdout)
  assert.equal(drainedStatus.journal.pendingCount, 0, 'the backlog drained')
  assert.equal(drainedStatus.journal.failedCount, 0, 'nothing was left in a failed state')
  assert.deepEqual(drainedStatus.divergences, [], 'the outage manufactured no conflicts')

  // --- Byte-identical convergence with no lost writes, by recursive hash
  // compare across both devices.
  await runCli('refresh', argsB)
  const treeA = await hashTree(deviceA.workspace)
  const treeB = await hashTree(deviceB.workspace)
  for (const [relativePath, content] of Object.entries(allOfflineWrites)) {
    assert.equal(treeA.get(relativePath), hashContent(content), `${relativePath} survived the outage on device A`)
    assert.equal(treeB.get(relativePath), hashContent(content), `${relativePath} reached device B after reconnect`)
  }
  // Both devices belong to the same owner, so owner-private paths are part of
  // the comparison too -- there is no half of this tree either device may miss.
  assert.ok([...treeA.keys()].some(isPrivatePath), 'the owner-private half is in scope for this compare')
  assertTreesEqual(treeB, treeA, 'both devices converged byte-identically')
})

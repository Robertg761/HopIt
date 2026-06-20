import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(repoRoot, 'packages/agent/src/cli.js')

async function makeState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-agent-test-'))

  return {
    root,
    cloud: path.join(root, 'cloud.json'),
    workspace: path.join(root, 'workspace'),
    journal: path.join(root, 'journal.ndjson'),
    events: path.join(root, 'events.ndjson'),
  }
}

async function makeTwoSessionState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-agent-two-session-test-'))

  return {
    root,
    cloud: path.join(root, 'cloud.json'),
    deviceA: {
      root,
      cloud: path.join(root, 'cloud.json'),
      workspace: path.join(root, 'device-a-workspace'),
      journal: path.join(root, 'device-a-journal.ndjson'),
      events: path.join(root, 'device-a-events.ndjson'),
    },
    deviceB: {
      root,
      cloud: path.join(root, 'cloud.json'),
      workspace: path.join(root, 'device-b-workspace'),
      journal: path.join(root, 'device-b-journal.ndjson'),
      events: path.join(root, 'device-b-events.ndjson'),
    },
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

let refreshAvailable

async function skipUnlessRefreshAvailable(t) {
  if (refreshAvailable === undefined) {
    const probeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-agent-refresh-probe-'))
    const probeArgs = stateArgs({
      cloud: path.join(probeRoot, 'missing-cloud.json'),
      workspace: path.join(probeRoot, 'workspace'),
      journal: path.join(probeRoot, 'journal.ndjson'),
      events: path.join(probeRoot, 'events.ndjson'),
    })

    try {
      const probe = await runCli('refresh', probeArgs)
      refreshAvailable = !/Commands:/i.test(probe.stdout)
    } catch {
      refreshAvailable = true
    }
  }

  if (!refreshAvailable) {
    t.skip('refresh command is not available yet.')
    return true
  }

  return false
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function waitFor(predicate, options = {}) {
  const timeout = options.timeout ?? 15000
  const interval = options.interval ?? 50
  const startedAt = Date.now()
  let lastError

  while (Date.now() - startedAt < timeout) {
    try {
      const result = await predicate()
      if (result) return result
    } catch (error) {
      lastError = error
    }

    await delay(interval)
  }

  throw lastError ?? new Error(options.message ?? `Timed out after ${timeout}ms.`)
}

async function startWatch(state, t, options = {}) {
  const nodeArgs = []
  if (options.pollingWatch) {
    const preloadPath = await writePollingWatchPreload(state)
    nodeArgs.push('--import', pathToFileURL(preloadPath).href)
  }

  const child = spawn(process.execPath, [...nodeArgs, cliPath, 'watch', ...stateArgs(state)], {
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

  t.after(async () => {
    await stopProcess(child)
  })

  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
  }
}

async function waitForOutput(watchProcess, pattern, options = {}) {
  await waitFor(
    () => {
      const output = `${watchProcess.stdout()}\n${watchProcess.stderr()}`
      return pattern.test(output)
    },
    {
      ...options,
      message: options.message ?? `Timed out waiting for output matching ${pattern}.`,
    },
  )
}

async function waitForExit(child, options = {}) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }

  return waitFor(
    () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return { code: child.exitCode, signal: child.signalCode }
      }
      return false
    },
    {
      ...options,
      message: options.message ?? 'Timed out waiting for child process to exit.',
    },
  )
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return

  child.kill('SIGTERM')

  try {
    await waitForExit(child, { timeout: 1000 })
  } catch {
    child.kill('SIGKILL')
    await waitForExit(child, { timeout: 1000 })
  }
}

async function writePollingWatchPreload(state) {
  const preloadPath = path.join(state.root, 'polling-watch-preload.mjs')
  await fs.writeFile(
    preloadPath,
    `import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'

const originalWatch = fs.watch

async function snapshot(root) {
  const files = new Map()

  async function walk(dir) {
    let entries = []
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(absolutePath)
        continue
      }
      if (!entry.isFile()) continue

      try {
        const stat = await fsp.stat(absolutePath)
        files.set(path.relative(root, absolutePath), \`\${stat.mtimeMs}:\${stat.size}\`)
      } catch {
        // The file changed between readdir and stat; the next poll will see it.
      }
    }
  }

  await walk(root)
  return files
}

fs.watch = function watch(value, options, listener) {
  if (!options?.recursive) return originalWatch.apply(this, arguments)

  const root = String(value)
  const watcher = new EventEmitter()
  let previous = new Map()
  let ready = false

  async function poll() {
    const next = await snapshot(root)

    if (ready) {
      for (const [relativePath, marker] of next) {
        if (previous.get(relativePath) !== marker) {
          const eventType = previous.has(relativePath) ? 'change' : 'rename'
          listener?.(eventType, relativePath)
          watcher.emit('change', eventType, relativePath)
        }
      }

      for (const relativePath of previous.keys()) {
        if (!next.has(relativePath)) {
          listener?.('rename', relativePath)
          watcher.emit('change', 'rename', relativePath)
        }
      }
    }

    previous = next
    ready = true
  }

  const interval = setInterval(() => {
    poll().catch((error) => {
      watcher.emit('error', error)
    })
  }, 50)

  poll().catch((error) => {
    watcher.emit('error', error)
  })

  watcher.close = () => {
    clearInterval(interval)
  }

  return watcher
}

syncBuiltinESMExports()
`,
    'utf8',
  )
  return preloadPath
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function readNdjson(filePath) {
  const content = await fs.readFile(filePath, 'utf8')
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex')
}

async function appendJournalEntry(state, entry) {
  await fs.appendFile(state.journal, `${JSON.stringify(entry)}\n`, 'utf8')
}

async function appendEvent(state, event, detail) {
  await fs.appendFile(
    state.events,
    `${JSON.stringify({ event, detail, at: new Date().toISOString() })}\n`,
    'utf8',
  )
}

async function setChangeSetVisibility(state, visibility) {
  const cloud = await readJson(state.cloud)
  cloud.visibility.effective = visibility
  cloud.visibility.changeSetOverride = visibility
  cloud.selectedState.visibility = visibility
  cloud.selectedState.effectiveVisibility = visibility
  await writeJson(state.cloud, cloud)
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

test('CLI classifies .private files as owner-private while snapshotting and syncing them', async () => {
  const state = await makeState()

  const init = await runCli('init', [...stateArgs(state), '--force'])
  assert.match(init.stdout, /cloud\.initialized/)
  assert.match(init.stdout, /"scopeCounts":\{"shared":3,"private":1\}/)

  const initialCloud = await readJson(state.cloud)
  assert.equal(initialCloud.schemaVersion, 2)
  assert.equal(initialCloud.main.id, 'main')
  assert.equal(initialCloud.selectedState.type, 'active-change-set')
  assert.equal(initialCloud.selectedState.id, 'cs_demo_active')
  assert.equal(initialCloud.owner.id, 'user_demo_owner')
  assert.equal(initialCloud.session.id, 'session_demo_local')
  assert.equal(initialCloud.visibility.effective, 'private')
  assert.equal(initialCloud.selectedState.reviewState, 'not-open')
  assert.equal(initialCloud.selectedState.mergeState, 'unmerged')
  assert.equal(initialCloud.selectedState.conflictState, 'none')
  assert.equal(initialCloud.files['.private/agent-note.md'].scope, 'owner-private')
  assert.equal(Object.keys(initialCloud.files).length, 4)

  await runCli('hydrate', stateArgs(state))

  const privateNotePath = path.join(state.workspace, '.private/agent-note.md')
  const privateNote = await fs.readFile(privateNotePath, 'utf8')
  assert.match(privateNote, /owner-private scope metadata/)

  await fs.appendFile(path.join(state.workspace, 'README.md'), '\nShared local edit.\n', 'utf8')
  await fs.appendFile(privateNotePath, '\nPrivate local edit.\n', 'utf8')
  await fs.writeFile(path.join(state.workspace, '.private/local-secret.txt'), 'private but synced\n', 'utf8')

  const sync = await runCli('sync-once', stateArgs(state))
  assert.match(sync.stdout, /sync\.complete/)
  assert.match(sync.stdout, /"journaledScopeCounts":\{"shared":1,"private":2\}/)

  const syncedCloud = await readJson(state.cloud)
  assert.equal(syncedCloud.files['README.md'].scope, 'shared')
  assert.equal(syncedCloud.files['.private/agent-note.md'].scope, 'owner-private')
  assert.equal(syncedCloud.files['.private/local-secret.txt'].scope, 'owner-private')
  assert.match(syncedCloud.files['.private/local-secret.txt'].content, /private but synced/)
  assert.equal(syncedCloud.main.revision, 1)
  assert.equal(syncedCloud.selectedState.revision, syncedCloud.revision)
  assert.ok(syncedCloud.selectedState.revision > syncedCloud.main.revision)

  const statusResult = await runCli('status', stateArgs(state))
  const status = JSON.parse(statusResult.stdout)
  assert.deepEqual(status.cloud.scopeCounts, { shared: 3, private: 2 })
  assert.equal(status.cloud.fileCount, 5)
  assert.equal(status.cloud.service, 'fixture-json-cloud-graph')
  assert.equal(status.codebaseId, 'hopit-core')
  assert.equal(status.mainId, 'main')
  assert.equal(status.selectedStateType, 'active-change-set')
  assert.equal(status.activeChangeSetId, 'cs_demo_active')
  assert.equal(status.ownerId, 'user_demo_owner')
  assert.equal(status.sessionId, 'session_demo_local')
  assert.equal(status.requesterId, 'user_demo_owner')
  assert.equal(status.requesterSessionId, 'session_demo_local')
  assert.equal(status.requesterRole, 'owner')
  assert.equal(status.visibleFileCount, 5)
  assert.equal(status.hiddenFileCount, 0)
  assert.equal(status.effectiveChangeSetVisibility, 'private')
  assert.equal(status.journal.totalEntries, 3)
  assert.equal(status.journal.pendingCount, 0)
  assert.deepEqual(status.journal.scopeCounts, { shared: 1, private: 2 })
  assert.deepEqual(status.journal.pendingScopeCounts, { shared: 0, private: 0 })
  assert.equal(status.events.lastSync.detail.writes, 3)
  assert.deepEqual(status.events.lastSync.detail.scopeCounts, { shared: 3, private: 2 })
  assert.deepEqual(status.events.lastSync.detail.journaledScopeCounts, { shared: 1, private: 2 })

  const journal = await readNdjson(state.journal)
  assert.equal(journal.length, 3)
  assert.deepEqual(
    journal.map((entry) => [entry.path, entry.scope]).sort(),
    [
      ['.private/agent-note.md', 'owner-private'],
      ['.private/local-secret.txt', 'owner-private'],
      ['README.md', 'shared'],
    ],
  )
  assert.ok(
    journal.every(
      (entry) =>
        entry.targetStateType === 'active-change-set' &&
        entry.targetStateId === 'cs_demo_active' &&
        Number.isInteger(entry.targetStateRevision) &&
        entry.ownerId === 'user_demo_owner' &&
        entry.sessionId === 'session_demo_local' &&
        entry.effectiveChangeSetVisibility === 'private',
    ),
  )
})

test('owner sync still journals and applies owner-private deletes', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))

  await fs.rm(path.join(state.workspace, '.private/agent-note.md'), { force: true })

  const sync = await runCli('sync-once', stateArgs(state))
  assert.match(sync.stdout, /sync\.complete/)
  assert.match(sync.stdout, /"journaledScopeCounts":\{"shared":0,"private":1\}/)

  const cloud = await readJson(state.cloud)
  assert.equal(cloud.files['.private/agent-note.md'], undefined)

  const journal = await readNdjson(state.journal)
  assert.equal(journal.length, 1)
  assert.equal(journal[0].type, 'delete')
  assert.equal(journal[0].path, '.private/agent-note.md')
  assert.equal(journal[0].scope, 'owner-private')
})

test('import-local hydrates a real folder while skipping generated and sensitive files', async () => {
  const state = await makeState()
  const source = path.join(state.root, 'source-project')

  await fs.mkdir(path.join(source, 'src'), { recursive: true })
  await fs.mkdir(path.join(source, '.private'), { recursive: true })
  await fs.mkdir(path.join(source, 'node_modules/pkg'), { recursive: true })
  await fs.mkdir(path.join(source, 'mounts/demo'), { recursive: true })
  await fs.mkdir(path.join(source, '.git'), { recursive: true })

  await fs.writeFile(path.join(source, 'README.md'), '# Real project\n', 'utf8')
  await fs.writeFile(path.join(source, 'src/app.ts'), 'export const app = true\n', 'utf8')
  await fs.writeFile(path.join(source, '.private/note.md'), 'owner note\n', 'utf8')
  await fs.writeFile(path.join(source, '.env'), 'SECRET=do-not-import\n', 'utf8')
  await fs.writeFile(path.join(source, 'node_modules/pkg/index.js'), 'ignored\n', 'utf8')
  await fs.writeFile(path.join(source, 'mounts/demo/README.md'), 'ignored\n', 'utf8')
  await fs.writeFile(path.join(source, '.git/config'), 'ignored\n', 'utf8')

  const result = await runCli('import-local', [
    ...stateArgs(state),
    '--source',
    source,
    '--codebase-id',
    'real-project',
    '--codebase-name',
    'Real Project',
    '--force',
  ])
  assert.match(result.stdout, /local\.imported/)
  assert.match(result.stdout, /workspace\.ready/)

  const cloud = await readJson(state.cloud)
  assert.equal(cloud.codebase.id, 'real-project')
  assert.equal(cloud.codebase.name, 'Real Project')
  assert.equal(cloud.files['README.md'].scope, 'shared')
  assert.equal(cloud.files['src/app.ts'].scope, 'shared')
  assert.equal(cloud.files['.private/note.md'].scope, 'owner-private')
  assert.equal(cloud.files['.env'], undefined)
  assert.equal(cloud.files['node_modules/pkg/index.js'], undefined)
  assert.equal(cloud.files['mounts/demo/README.md'], undefined)
  assert.equal(cloud.files['.git/config'], undefined)

  assert.equal(await pathExists(path.join(state.workspace, 'src/app.ts')), true)
  assert.equal(await pathExists(path.join(state.workspace, '.private/note.md')), true)
  assert.equal(await pathExists(path.join(state.workspace, '.env')), false)
})

test('CLI exposes product-facing command aliases', async () => {
  const state = await makeState()
  const source = path.join(state.root, 'source-project')

  await fs.mkdir(source, { recursive: true })
  await fs.writeFile(path.join(source, 'README.md'), '# Alias project\n', 'utf8')

  const imported = await runCli('import', [
    ...stateArgs(state),
    '--source',
    source,
    '--codebase-id',
    'alias-project',
    '--force',
  ])
  assert.match(imported.stdout, /local\.imported/)

  await fs.appendFile(path.join(state.workspace, 'README.md'), '\nAlias sync edit.\n', 'utf8')
  const synced = await runCli('sync', stateArgs(state))
  assert.match(synced.stdout, /sync\.complete/)

  const reviewed = await runCli('review', stateArgs(state))
  assert.match(reviewed.stdout, /change_set\.review_opened/)
})

test('recover replays pending shared and owner-private journal entries after restart', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))

  const sharedContent = '# hopit-core\n\nRecovered shared edit.\n'
  const privateContent = '# Owner notes\n\nRecovered private edit.\n'
  const sharedPath = path.join(state.workspace, 'README.md')
  const privatePath = path.join(state.workspace, '.private/agent-note.md')

  await fs.writeFile(sharedPath, sharedContent, 'utf8')
  await fs.writeFile(privatePath, privateContent, 'utf8')

  const createdAt = new Date().toISOString()
  const sharedEntry = {
    id: randomUUID(),
    type: 'write',
    path: 'README.md',
    scope: 'shared',
    hash: hashContent(sharedContent),
    bytes: Buffer.byteLength(sharedContent),
    createdAt,
    status: 'pending',
  }
  const privateEntry = {
    id: randomUUID(),
    type: 'write',
    path: '.private/agent-note.md',
    scope: 'owner-private',
    hash: hashContent(privateContent),
    bytes: Buffer.byteLength(privateContent),
    createdAt,
    status: 'pending',
  }

  await appendJournalEntry(state, sharedEntry)
  await appendJournalEntry(state, privateEntry)

  const beforeStatus = JSON.parse((await runCli('status', stateArgs(state))).stdout)
  assert.equal(beforeStatus.journal.pendingCount, 2)
  assert.deepEqual(beforeStatus.journal.pendingScopeCounts, { shared: 1, private: 1 })
  assert.equal(beforeStatus.journal.acknowledgedCount, 0)

  const recovery = await runCli('recover', stateArgs(state))
  assert.match(recovery.stdout, /journal\.recovery_complete/)
  assert.match(recovery.stdout, /"attempted":2/)
  assert.match(recovery.stdout, /"acknowledged":2/)
  assert.match(recovery.stdout, /"failed":0/)

  const recoveredCloud = await readJson(state.cloud)
  assert.equal(recoveredCloud.files['README.md'].content, sharedContent)
  assert.equal(recoveredCloud.files['README.md'].scope, 'shared')
  assert.equal(recoveredCloud.files['.private/agent-note.md'].content, privateContent)
  assert.equal(recoveredCloud.files['.private/agent-note.md'].scope, 'owner-private')

  const afterStatus = JSON.parse((await runCli('status', stateArgs(state))).stdout)
  assert.equal(afterStatus.ok, true)
  assert.equal(afterStatus.journal.pendingCount, 0)
  assert.equal(afterStatus.journal.failedCount, 0)
  assert.equal(afterStatus.journal.acknowledgedCount, 2)
  assert.deepEqual(afterStatus.journal.acknowledgedScopeCounts, { shared: 1, private: 1 })
  assert.equal(afterStatus.events.lastRecovery.detail.attempted, 2)
  assert.equal(afterStatus.events.lastRecovery.detail.acknowledged, 2)
})

test('recover keeps unsafe pending entries failed and visible in status', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))

  await fs.writeFile(path.join(state.workspace, 'README.md'), 'local content does not match journal\n', 'utf8')

  const entry = {
    id: randomUUID(),
    type: 'write',
    path: 'README.md',
    scope: 'shared',
    hash: hashContent('different journaled content\n'),
    bytes: Buffer.byteLength('different journaled content\n'),
    createdAt: new Date().toISOString(),
    status: 'pending',
  }
  await appendJournalEntry(state, entry)

  const failure = await runCliFailure('recover', stateArgs(state))
  assert.equal(failure.code, 1)
  assert.match(failure.stdout, /journal\.recovery_failed/)
  assert.match(failure.stdout, /workspace_hash_mismatch/)
  assert.match(failure.stdout, /journal\.recovery_complete/)
  assert.match(failure.stdout, /"failed":1/)

  const status = JSON.parse((await runCli('status', stateArgs(state))).stdout)
  assert.equal(status.ok, false)
  assert.equal(status.journal.pendingCount, 0)
  assert.equal(status.journal.failedCount, 1)
  assert.equal(status.journal.acknowledgedCount, 0)
  assert.deepEqual(status.journal.failedScopeCounts, { shared: 1, private: 0 })
  assert.equal(status.events.lastRecovery.detail.failed, 1)
})

test('watch recovers pending entries before hydrate and syncs shared and owner-private edits', async (t) => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))

  const sharedRecoveredContent = '# hopit-core\n\nRecovered shared edit before hydrate.\n'
  const privateRecoveredContent = '# Owner notes\n\nRecovered private edit before hydrate.\n'
  const sharedPath = path.join(state.workspace, 'README.md')
  const privatePath = path.join(state.workspace, '.private/agent-note.md')

  await fs.writeFile(sharedPath, sharedRecoveredContent, 'utf8')
  await fs.writeFile(privatePath, privateRecoveredContent, 'utf8')

  const createdAt = new Date().toISOString()
  await appendJournalEntry(state, {
    id: randomUUID(),
    type: 'write',
    path: 'README.md',
    scope: 'shared',
    hash: hashContent(sharedRecoveredContent),
    bytes: Buffer.byteLength(sharedRecoveredContent),
    createdAt,
    status: 'pending',
  })
  await appendJournalEntry(state, {
    id: randomUUID(),
    type: 'write',
    path: '.private/agent-note.md',
    scope: 'owner-private',
    hash: hashContent(privateRecoveredContent),
    bytes: Buffer.byteLength(privateRecoveredContent),
    createdAt,
    status: 'pending',
  })

  const watchProcess = await startWatch(state, t, { pollingWatch: true })
  await waitForOutput(watchProcess, /watch\.started/)

  assert.equal(await fs.readFile(sharedPath, 'utf8'), sharedRecoveredContent)
  assert.equal(await fs.readFile(privatePath, 'utf8'), privateRecoveredContent)

  let recoveredCloud = await readJson(state.cloud)
  assert.equal(recoveredCloud.files['README.md'].content, sharedRecoveredContent)
  assert.equal(recoveredCloud.files['README.md'].scope, 'shared')
  assert.equal(recoveredCloud.files['.private/agent-note.md'].content, privateRecoveredContent)
  assert.equal(recoveredCloud.files['.private/agent-note.md'].scope, 'owner-private')

  await fs.appendFile(sharedPath, '\nWatched shared edit.\n', 'utf8')
  await fs.appendFile(privatePath, '\nWatched private edit.\n', 'utf8')

  recoveredCloud = await waitFor(async () => {
    const output = `${watchProcess.stdout()}\n${watchProcess.stderr()}`
    if (/hasUnresolvedSyncFailure|sync\.failed/.test(output)) {
      throw new Error(`watch failed while syncing:\n${output}`)
    }

    const cloud = await readJson(state.cloud)
    const sharedSynced = cloud.files['README.md'].content.includes('Watched shared edit.')
    const privateSynced = cloud.files['.private/agent-note.md'].content.includes('Watched private edit.')
    return sharedSynced && privateSynced ? cloud : false
  })

  assert.equal(recoveredCloud.files['README.md'].scope, 'shared')
  assert.equal(recoveredCloud.files['.private/agent-note.md'].scope, 'owner-private')

  const journal = await readNdjson(state.journal)
  const acknowledgedIds = new Set(
    (await readNdjson(state.events))
      .filter((event) => event.event === 'cloud.acknowledged')
      .map((event) => event.detail.id),
  )
  const writeEntries = journal.filter((entry) => entry.type === 'write')
  assert.ok(writeEntries.every((entry) => acknowledgedIds.has(entry.id)))
  assert.deepEqual(
    writeEntries.map((entry) => [entry.path, entry.scope]).sort(),
    [
      ['.private/agent-note.md', 'owner-private'],
      ['.private/agent-note.md', 'owner-private'],
      ['README.md', 'shared'],
      ['README.md', 'shared'],
    ],
  )

  const status = JSON.parse((await runCli('status', stateArgs(state))).stdout)
  assert.equal(status.ok, true)
  assert.equal(status.journal.pendingCount, 0)
  assert.equal(status.journal.failedCount, 0)
  assert.deepEqual(status.journal.acknowledgedScopeCounts, { shared: 2, private: 2 })
})

test('watch refuses unsafe recovery and exposes failed state in status', async (t) => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))

  const unsafeWorkspaceContent = 'local content does not match journal\n'
  await fs.writeFile(path.join(state.workspace, 'README.md'), unsafeWorkspaceContent, 'utf8')

  await appendJournalEntry(state, {
    id: randomUUID(),
    type: 'write',
    path: 'README.md',
    scope: 'shared',
    hash: hashContent('different journaled content\n'),
    bytes: Buffer.byteLength('different journaled content\n'),
    createdAt: new Date().toISOString(),
    status: 'pending',
  })

  const watchProcess = await startWatch(state, t)
  const exit = await waitForExit(watchProcess.child, { timeout: 15000 })
  assert.equal(exit.code, 1)

  const output = `${watchProcess.stdout()}\n${watchProcess.stderr()}`
  assert.match(output, /journal\.recovery_failed/)
  assert.match(output, /workspace_hash_mismatch/)
  assert.match(output, /journal\.recovery_complete/)
  assert.match(output, /watch\.recovery_blocked/)
  assert.doesNotMatch(output, /watch\.started/)

  assert.equal(await fs.readFile(path.join(state.workspace, 'README.md'), 'utf8'), unsafeWorkspaceContent)

  const status = JSON.parse((await runCli('status', stateArgs(state))).stdout)
  assert.equal(status.ok, false)
  assert.equal(status.journal.pendingCount, 0)
  assert.equal(status.journal.failedCount, 1)
  assert.deepEqual(status.journal.failedScopeCounts, { shared: 1, private: 0 })
  assert.equal(status.events.lastRecovery.detail.failed, 1)
})

test('refresh brings device A shared-file sync into device B managed workspace', async (t) => {
  if (await skipUnlessRefreshAvailable(t)) return

  const { deviceA, deviceB } = await makeTwoSessionState()
  await runCli('init', [...stateArgs(deviceA), '--force'])
  await runCli('hydrate', stateArgs(deviceA))
  await runCli('hydrate', stateArgs(deviceB))

  const sharedPathA = path.join(deviceA.workspace, 'README.md')
  const sharedPathB = path.join(deviceB.workspace, 'README.md')
  const sharedEdit = '\nEdited on device A, then refreshed on device B.\n'

  await fs.appendFile(sharedPathA, sharedEdit, 'utf8')
  await runCli('sync-once', stateArgs(deviceA))

  assert.doesNotMatch(await fs.readFile(sharedPathB, 'utf8'), /Edited on device A/)

  await runCli('refresh', stateArgs(deviceB))

  const refreshedContent = await fs.readFile(sharedPathB, 'utf8')
  assert.match(refreshedContent, /Edited on device A, then refreshed on device B\./)

  const cloud = await readJson(deviceA.cloud)
  assert.equal(cloud.files['README.md'].scope, 'shared')
  assert.equal(cloud.files['README.md'].content, refreshedContent)

  const remoteUpdate = (await readNdjson(deviceB.events)).findLast((event) => event.event === 'remote-update')
  assert.equal(remoteUpdate.detail.selectedStateId, 'cs_demo_active')
  assert.equal(remoteUpdate.detail.fromRevision, 1)
  assert.equal(remoteUpdate.detail.toRevision, cloud.revision)
  assert.deepEqual(remoteUpdate.detail.changedPaths, ['README.md'])
  assert.deepEqual(remoteUpdate.detail.deletedPaths, [])
  assert.deepEqual(remoteUpdate.detail.changedScopeCounts, { shared: 1, private: 0 })
  assert.deepEqual(remoteUpdate.detail.hiddenScopeCounts, { shared: 0, private: 0 })

  const status = JSON.parse((await runCli('status', stateArgs(deviceB))).stdout)
  assert.equal(status.remoteUpdate.state, 'updated')
  assert.deepEqual(status.events.lastRemoteUpdate.detail.changedPaths, ['README.md'])
})

test('refresh brings same-owner .private sync into device B managed workspace', async (t) => {
  if (await skipUnlessRefreshAvailable(t)) return

  const { deviceA, deviceB } = await makeTwoSessionState()
  await runCli('init', [...stateArgs(deviceA), '--force'])
  await runCli('hydrate', stateArgs(deviceA))
  await runCli('hydrate', stateArgs(deviceB))

  const privatePathA = path.join(deviceA.workspace, '.private/agent-note.md')
  const privatePathB = path.join(deviceB.workspace, '.private/agent-note.md')
  const privateEdit = '\nSame-owner private edit from device A.\n'

  await fs.appendFile(privatePathA, privateEdit, 'utf8')
  await runCli('sync-once', stateArgs(deviceA))

  assert.doesNotMatch(await fs.readFile(privatePathB, 'utf8'), /Same-owner private edit/)

  await runCli('refresh', stateArgs(deviceB))

  const refreshedContent = await fs.readFile(privatePathB, 'utf8')
  assert.match(refreshedContent, /Same-owner private edit from device A\./)

  const cloud = await readJson(deviceA.cloud)
  assert.equal(cloud.files['.private/agent-note.md'].scope, 'owner-private')
  assert.equal(cloud.files['.private/agent-note.md'].content, refreshedContent)

  const remoteUpdate = (await readNdjson(deviceB.events)).findLast((event) => event.event === 'remote-update')
  assert.deepEqual(remoteUpdate.detail.changedPaths, ['.private/agent-note.md'])
  assert.deepEqual(remoteUpdate.detail.changedScopeCounts, { shared: 0, private: 1 })
  assert.deepEqual(remoteUpdate.detail.hiddenScopeCounts, { shared: 0, private: 0 })
})

test('owner requester sees shared and owner-private files in a private active change set', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])

  await runCli('hydrate', [
    ...stateArgs(state),
    '--requester-id',
    'user_demo_owner',
    '--session-id',
    'session_owner_explicit',
  ])

  assert.equal(await pathExists(path.join(state.workspace, 'README.md')), true)
  assert.equal(await pathExists(path.join(state.workspace, 'package.json')), true)
  assert.equal(await pathExists(path.join(state.workspace, 'src/presence.ts')), true)
  assert.equal(await pathExists(path.join(state.workspace, '.private/agent-note.md')), true)

  const status = JSON.parse(
    (
      await runCli('status', [
        ...stateArgs(state),
        '--requester-id',
        'user_demo_owner',
        '--session-id',
        'session_owner_explicit',
      ])
    ).stdout,
  )
  assert.equal(status.requesterId, 'user_demo_owner')
  assert.equal(status.requesterSessionId, 'session_owner_explicit')
  assert.equal(status.requesterRole, 'owner')
  assert.equal(status.visibleFileCount, 4)
  assert.equal(status.hiddenFileCount, 0)
  assert.deepEqual(status.cloud.scopeCounts, { shared: 3, private: 1 })
  assert.deepEqual(status.hiddenScopeCounts, { shared: 0, private: 0 })
})

test('collaborator requester sees no active change-set files when visibility is private', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])

  await runCli('refresh', [
    ...stateArgs(state),
    '--requester-id',
    'user_demo_collaborator',
    '--session-id',
    'session_demo_collaborator',
  ])

  assert.equal(await pathExists(path.join(state.workspace, 'README.md')), false)
  assert.equal(await pathExists(path.join(state.workspace, '.private/agent-note.md')), false)

  const status = JSON.parse(
    (
      await runCli('status', [
        ...stateArgs(state),
        '--requester-id',
        'user_demo_collaborator',
        '--session-id',
        'session_demo_collaborator',
      ])
    ).stdout,
  )
  assert.equal(status.requesterId, 'user_demo_collaborator')
  assert.equal(status.requesterSessionId, 'session_demo_collaborator')
  assert.equal(status.requesterRole, 'member')
  assert.equal(status.effectiveChangeSetVisibility, 'private')
  assert.equal(status.visibleFileCount, 0)
  assert.equal(status.hiddenFileCount, 4)
  assert.deepEqual(status.cloud.scopeCounts, { shared: 0, private: 0 })
  assert.deepEqual(status.hiddenScopeCounts, { shared: 3, private: 1 })
})

test('collaborator requester sees only shared files when change set is team or review visible', async () => {
  for (const visibility of ['team-visible', 'review-visible']) {
    const state = await makeState()
    await runCli('init', [...stateArgs(state), '--force'])
    await setChangeSetVisibility(state, visibility)

    await runCli('refresh', [
      ...stateArgs(state),
      '--requester-id',
      'user_demo_collaborator',
      '--session-id',
      `session_demo_collaborator_${visibility}`,
    ])

    assert.equal(await pathExists(path.join(state.workspace, 'README.md')), true)
    assert.equal(await pathExists(path.join(state.workspace, 'package.json')), true)
    assert.equal(await pathExists(path.join(state.workspace, 'src/presence.ts')), true)
    assert.equal(await pathExists(path.join(state.workspace, '.private/agent-note.md')), false)

    const status = JSON.parse(
      (
        await runCli('status', [
          ...stateArgs(state),
          '--requester-id',
          'user_demo_collaborator',
          '--session-id',
          `session_demo_collaborator_${visibility}`,
        ])
      ).stdout,
    )
    assert.equal(status.requesterRole, 'member')
    assert.equal(status.effectiveChangeSetVisibility, visibility)
    assert.equal(status.visibleFileCount, 3)
    assert.equal(status.hiddenFileCount, 1)
    assert.deepEqual(status.cloud.scopeCounts, { shared: 3, private: 0 })
    assert.deepEqual(status.hiddenScopeCounts, { shared: 0, private: 1 })

    const remoteUpdate = (await readNdjson(state.events)).findLast((event) => event.event === 'remote-update')
    assert.deepEqual(remoteUpdate.detail.changedPaths.sort(), [
      'README.md',
      'package.json',
      'src/presence.ts',
    ])
    assert.deepEqual(remoteUpdate.detail.deletedPaths, [])
    assert.deepEqual(remoteUpdate.detail.changedScopeCounts, { shared: 3, private: 0 })
    assert.deepEqual(remoteUpdate.detail.hiddenScopeCounts, { shared: 0, private: 1 })
    assert.equal(remoteUpdate.detail.requester.role, 'member')
    assert.equal(remoteUpdate.detail.requester.effectiveChangeSetVisibility, visibility)
  }
})

test('collaborator sync preserves hidden owner-private files after filtered hydrate', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await setChangeSetVisibility(state, 'team-visible')

  await runCli('hydrate', [
    ...stateArgs(state),
    '--requester-id',
    'user_demo_collaborator',
    '--session-id',
    'session_demo_collaborator',
  ])

  assert.equal(await pathExists(path.join(state.workspace, 'README.md')), true)
  assert.equal(await pathExists(path.join(state.workspace, '.private/agent-note.md')), false)

  await fs.appendFile(path.join(state.workspace, 'README.md'), '\nCollaborator visible edit.\n', 'utf8')

  const sync = await runCli('sync-once', [
    ...stateArgs(state),
    '--requester-id',
    'user_demo_collaborator',
    '--session-id',
    'session_demo_collaborator',
  ])
  assert.match(sync.stdout, /sync\.complete/)
  assert.match(sync.stdout, /"journaledScopeCounts":\{"shared":1,"private":0\}/)

  const cloud = await readJson(state.cloud)
  assert.equal(cloud.files['.private/agent-note.md'].scope, 'owner-private')
  assert.match(cloud.files['.private/agent-note.md'].content, /owner-private scope metadata/)
  assert.match(cloud.files['README.md'].content, /Collaborator visible edit/)

  const journal = await readNdjson(state.journal)
  assert.equal(journal.length, 1)
  assert.equal(journal[0].type, 'write')
  assert.equal(journal[0].path, 'README.md')
  assert.equal(journal[0].scope, 'shared')

  const events = await readNdjson(state.events)
  const hiddenPrivateDeletes = events.filter(
    (event) =>
      event.event === 'write.journaled' &&
      event.detail.type === 'delete' &&
      event.detail.path === '.private/agent-note.md',
  )
  assert.equal(hiddenPrivateDeletes.length, 0)
})

test('collaborator refresh refuses to overwrite pending local edits', async (t) => {
  if (await skipUnlessRefreshAvailable(t)) return

  const { deviceA, deviceB } = await makeTwoSessionState()
  await runCli('init', [...stateArgs(deviceA), '--force'])
  await setChangeSetVisibility(deviceA, 'team-visible')
  await runCli('hydrate', stateArgs(deviceA))
  await runCli('refresh', [
    ...stateArgs(deviceB),
    '--requester-id',
    'user_demo_collaborator',
    '--session-id',
    'session_demo_collaborator',
  ])

  const collaboratorPath = path.join(deviceB.workspace, 'README.md')
  const collaboratorContent = '# hopit-core\n\nCollaborator pending local edit.\n'
  await fs.writeFile(collaboratorPath, collaboratorContent, 'utf8')
  await appendJournalEntry(deviceB, {
    id: randomUUID(),
    type: 'write',
    path: 'README.md',
    scope: 'shared',
    hash: hashContent(collaboratorContent),
    bytes: Buffer.byteLength(collaboratorContent),
    createdAt: new Date().toISOString(),
    status: 'pending',
    targetStateType: 'active-change-set',
    targetStateId: 'cs_demo_active',
    ownerId: 'user_demo_collaborator',
    sessionId: 'session_demo_collaborator',
    effectiveChangeSetVisibility: 'team-visible',
  })

  await fs.appendFile(path.join(deviceA.workspace, 'README.md'), '\nOwner cloud edit.\n', 'utf8')
  await runCli('sync-once', stateArgs(deviceA))

  const failure = await runCliFailure('refresh', [
    ...stateArgs(deviceB),
    '--requester-id',
    'user_demo_collaborator',
    '--session-id',
    'session_demo_collaborator',
  ])
  assert.match(failure.stdout, /refresh\.blocked/)
  assert.match(failure.stderr, /Refresh blocked/)
  assert.equal(await fs.readFile(collaboratorPath, 'utf8'), collaboratorContent)

  const status = JSON.parse(
    (
      await runCli('status', [
        ...stateArgs(deviceB),
        '--requester-id',
        'user_demo_collaborator',
        '--session-id',
        'session_demo_collaborator',
      ])
    ).stdout,
  )
  assert.equal(status.requesterRole, 'member')
  assert.equal(status.refresh.state, 'blocked')
  assert.equal(status.journal.pendingCount, 1)
  assert.equal(status.journal.failedCount, 0)
})

test('merge refuses a change set that is not open for review', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])

  const failure = await runCliFailure('merge', stateArgs(state))
  assert.equal(failure.code, 1)
  assert.match(failure.stderr, /not open for review/i)

  const cloud = await readJson(state.cloud)
  assert.equal(cloud.main.revision, 1)
  assert.equal(cloud.selectedState.mergeState, 'unmerged')
})

test('review-open and merge advance Main only after explicit merge', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))

  await fs.appendFile(path.join(state.workspace, 'README.md'), '\nReviewable change.\n', 'utf8')
  await runCli('sync-once', stateArgs(state))

  let cloud = await readJson(state.cloud)
  const selectedRevision = cloud.selectedState.revision
  assert.ok(selectedRevision > cloud.main.revision)
  assert.equal(cloud.main.revision, 1)
  assert.equal(cloud.selectedState.reviewState, 'not-open')
  assert.equal(cloud.selectedState.mergeState, 'unmerged')

  const review = await runCli('review-open', [
    ...stateArgs(state),
    '--requester-id',
    'user_demo_owner',
  ])
  assert.match(review.stdout, /change_set\.review_opened/)

  cloud = await readJson(state.cloud)
  assert.equal(cloud.main.revision, 1)
  assert.equal(cloud.selectedState.revision, selectedRevision)
  assert.equal(cloud.selectedState.reviewState, 'open')
  assert.equal(cloud.selectedState.mergeState, 'unmerged')
  assert.equal(cloud.selectedState.review.state, 'open')
  assert.equal(cloud.selectedState.review.openedBy, 'user_demo_owner')

  let status = JSON.parse((await runCli('status', stateArgs(state))).stdout)
  assert.equal(status.review.state, 'open')
  assert.equal(status.merge.state, 'unmerged')
  assert.equal(status.merge.mainRevision, 1)
  assert.equal(status.events.lastReviewOpened.detail.selectedStateId, 'cs_demo_active')

  const merge = await runCli('merge', [
    ...stateArgs(state),
    '--requester-id',
    'user_demo_owner',
  ])
  assert.match(merge.stdout, /change_set\.merged/)

  cloud = await readJson(state.cloud)
  assert.equal(cloud.main.revision, selectedRevision)
  assert.equal(cloud.main.mergedChangeSetId, 'cs_demo_active')
  assert.equal(cloud.selectedState.reviewState, 'merged')
  assert.equal(cloud.selectedState.mergeState, 'merged')
  assert.equal(cloud.selectedState.merge.state, 'merged')
  assert.equal(cloud.selectedState.merge.previousMainRevision, 1)
  assert.equal(cloud.selectedState.merge.mainRevision, selectedRevision)
  assert.equal(cloud.selectedState.merge.mergedBy, 'user_demo_owner')

  status = JSON.parse((await runCli('status', stateArgs(state))).stdout)
  assert.equal(status.review.state, 'merged')
  assert.equal(status.merge.state, 'merged')
  assert.equal(status.merge.mainRevision, selectedRevision)
  assert.equal(status.events.lastChangeSetMerged.detail.mainRevision, selectedRevision)
})

test('recover surfaces stale file revision as reviewable conflict state', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))

  const staleContent = '# hopit-core\n\nStale local write from old session.\n'
  await fs.writeFile(path.join(state.workspace, 'README.md'), staleContent, 'utf8')

  const cloud = await readJson(state.cloud)
  await appendJournalEntry(state, {
    id: randomUUID(),
    type: 'write',
    path: 'README.md',
    scope: 'shared',
    hash: hashContent(staleContent),
    bytes: Buffer.byteLength(staleContent),
    baseRevision: cloud.files['README.md'].revision - 1,
    createdAt: new Date().toISOString(),
    status: 'pending',
    targetStateType: 'active-change-set',
    targetStateId: 'cs_demo_active',
    targetStateRevision: cloud.selectedState.revision,
    ownerId: 'user_demo_owner',
    sessionId: 'session_demo_local',
    effectiveChangeSetVisibility: 'private',
  })

  const failure = await runCliFailure('recover', stateArgs(state))
  assert.equal(failure.code, 1)
  assert.match(failure.stdout, /change_set\.conflict_detected/)
  assert.match(failure.stdout, /journal\.recovery_failed/)
  assert.equal(await fs.readFile(path.join(state.workspace, 'README.md'), 'utf8'), staleContent)

  const conflictedCloud = await readJson(state.cloud)
  assert.equal(conflictedCloud.selectedState.conflictState, 'conflicted')
  assert.equal(conflictedCloud.selectedState.conflict.reason, 'base_revision_mismatch')
  assert.equal(conflictedCloud.selectedState.conflict.path, 'README.md')

  const status = JSON.parse((await runCli('status', stateArgs(state))).stdout)
  assert.equal(status.conflict.state, 'conflicted')
  assert.equal(status.conflict.detail.reason, 'base_revision_mismatch')
  assert.equal(status.journal.failedCount, 1)
  assert.equal(status.events.lastConflictDetected.detail.path, 'README.md')
})

test('recover surfaces stale selected-state revision as reviewable conflict state', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))

  const staleContent = '# hopit-core\n\nStale selected-state write.\n'
  await fs.writeFile(path.join(state.workspace, 'README.md'), staleContent, 'utf8')

  const cloud = await readJson(state.cloud)
  await appendJournalEntry(state, {
    id: randomUUID(),
    type: 'write',
    path: 'README.md',
    scope: 'shared',
    hash: hashContent(staleContent),
    bytes: Buffer.byteLength(staleContent),
    baseRevision: cloud.files['README.md'].revision,
    createdAt: new Date().toISOString(),
    status: 'pending',
    targetStateType: 'active-change-set',
    targetStateId: 'cs_demo_active',
    targetStateRevision: cloud.selectedState.revision - 1,
    ownerId: 'user_demo_owner',
    sessionId: 'session_demo_local',
    effectiveChangeSetVisibility: 'private',
  })

  const failure = await runCliFailure('recover', stateArgs(state))
  assert.equal(failure.code, 1)
  assert.match(failure.stdout, /change_set\.conflict_detected/)
  assert.equal(await fs.readFile(path.join(state.workspace, 'README.md'), 'utf8'), staleContent)

  const status = JSON.parse((await runCli('status', stateArgs(state))).stdout)
  assert.equal(status.conflict.state, 'conflicted')
  assert.equal(status.conflict.detail.reason, 'selected_state_revision_mismatch')
  assert.equal(status.conflict.detail.path, 'README.md')
  assert.equal(status.events.lastConflictDetected.detail.reason, 'selected_state_revision_mismatch')
})

test('merge surfaces stale Main revision as reviewable conflict state', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))

  await fs.appendFile(path.join(state.workspace, 'README.md'), '\nChange against older Main.\n', 'utf8')
  await runCli('sync-once', stateArgs(state))
  await runCli('review-open', stateArgs(state))

  const cloud = await readJson(state.cloud)
  cloud.main.revision += 1
  await writeJson(state.cloud, cloud)

  const failure = await runCliFailure('merge', stateArgs(state))
  assert.equal(failure.code, 1)
  assert.match(failure.stdout, /change_set\.conflict_detected/)
  assert.match(failure.stderr, /Main moved/)

  const conflictedCloud = await readJson(state.cloud)
  assert.equal(conflictedCloud.selectedState.reviewState, 'open')
  assert.equal(conflictedCloud.selectedState.mergeState, 'unmerged')
  assert.equal(conflictedCloud.selectedState.conflictState, 'conflicted')
  assert.equal(conflictedCloud.selectedState.conflict.reason, 'main_revision_mismatch')
  assert.equal(conflictedCloud.selectedState.conflict.expectedMainRevision, 1)
  assert.equal(conflictedCloud.selectedState.conflict.actualMainRevision, 2)

  const status = JSON.parse((await runCli('status', stateArgs(state))).stdout)
  assert.equal(status.review.state, 'open')
  assert.equal(status.merge.state, 'unmerged')
  assert.equal(status.conflict.state, 'conflicted')
  assert.equal(status.events.lastConflictDetected.detail.reason, 'main_revision_mismatch')
})

test('refresh refuses to overwrite device B files with pending or failed journal entries', async (t) => {
  if (await skipUnlessRefreshAvailable(t)) return

  for (const journalState of ['pending', 'failed']) {
    await t.test(`refuses with ${journalState} device B journal entry`, async () => {
      const { deviceA, deviceB } = await makeTwoSessionState()
      await runCli('init', [...stateArgs(deviceA), '--force'])
      await runCli('hydrate', stateArgs(deviceA))
      await runCli('hydrate', stateArgs(deviceB))

      const deviceBReadme = path.join(deviceB.workspace, 'README.md')
      const unsafeLocalContent = `# hopit-core\n\nDevice B unsynced ${journalState} edit.\n`
      await fs.writeFile(deviceBReadme, unsafeLocalContent, 'utf8')

      const entry = {
        id: randomUUID(),
        type: 'write',
        path: 'README.md',
        scope: 'shared',
        hash: hashContent(unsafeLocalContent),
        bytes: Buffer.byteLength(unsafeLocalContent),
        createdAt: new Date().toISOString(),
        status: 'pending',
      }
      await appendJournalEntry(deviceB, entry)

      if (journalState === 'failed') {
        await appendEvent(deviceB, 'journal.recovery_failed', {
          id: entry.id,
          type: entry.type,
          path: entry.path,
          scope: entry.scope,
          reason: 'test_failed_journal_entry',
        })
      }

      const syncedDeviceAContent = '# hopit-core\n\nDevice A cloud edit that must not overwrite B.\n'
      await fs.writeFile(path.join(deviceA.workspace, 'README.md'), syncedDeviceAContent, 'utf8')
      await runCli('sync-once', stateArgs(deviceA))

      const failure = await runCliFailure('refresh', stateArgs(deviceB))
      assert.equal(failure.code, 1)
      assert.match(`${failure.stdout}\n${failure.stderr}`, /journal|pending|failed|overwrite|unsafe/i)

      assert.equal(await fs.readFile(deviceBReadme, 'utf8'), unsafeLocalContent)

      const status = JSON.parse((await runCli('status', stateArgs(deviceB))).stdout)
      assert.equal(status.journal.pendingCount, journalState === 'pending' ? 1 : 0)
      assert.equal(status.journal.failedCount, journalState === 'failed' ? 1 : 0)
    })
  }
})

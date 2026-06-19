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
  const timeout = options.timeout ?? 5000
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

test('CLI classifies .private files as owner-private while snapshotting and syncing them', async () => {
  const state = await makeState()

  const init = await runCli('init', [...stateArgs(state), '--force'])
  assert.match(init.stdout, /cloud\.initialized/)
  assert.match(init.stdout, /"scopeCounts":\{"shared":3,"private":1\}/)

  const initialCloud = await readJson(state.cloud)
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

  const statusResult = await runCli('status', stateArgs(state))
  const status = JSON.parse(statusResult.stdout)
  assert.deepEqual(status.cloud.scopeCounts, { shared: 3, private: 2 })
  assert.equal(status.cloud.fileCount, 5)
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
  const exit = await waitForExit(watchProcess.child, { timeout: 5000 })
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

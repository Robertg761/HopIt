import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
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

async function makeProductionTwoDeviceState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-agent-production-two-device-test-'))
  const codebaseId = 'hopit-core'
  const cloud = path.join(root, 'fixture-cloud.json')

  function makeDevice(name, sessionId, deviceName) {
    const stateRoot = path.join(root, `${name}-state`)
    const workspaceRoot = path.join(root, `${name}-workspaces`)

    return {
      root,
      cloud,
      codebaseId,
      stateRoot,
      workspaceRoot,
      workspace: path.join(workspaceRoot, codebaseId),
      journal: path.join(stateRoot, 'journal', `${codebaseId}.ndjson`),
      events: path.join(stateRoot, 'events', `${codebaseId}.ndjson`),
      sessionId,
      deviceName,
    }
  }

  return {
    root,
    cloud,
    codebaseId,
    deviceA: makeDevice('device-a', 'session_prod_device_a', 'Production Device A'),
    deviceB: makeDevice('device-b', 'session_prod_device_b', 'Production Device B'),
  }
}

async function getAvailablePort(t) {
  const reserved = await reserveLoopbackPort(t)
  if (!reserved) return null
  await reserved.close()
  return reserved.port
}

async function reserveLoopbackPort(t) {
  const server = createNetServer()
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip(`local loopback listen is unavailable in this environment: ${error.message}`)
      return null
    }
    throw error
  }
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : null
  if (!port) throw new Error('Unable to reserve an available port.')
  return {
    port,
    server,
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    },
  }
}

async function reserveLoopbackHttpPort(t) {
  const server = createHttpServer((_request, response) => {
    response.writeHead(409, { 'content-type': 'application/json' })
    response.end('{"error":"occupied"}')
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip(`local loopback listen is unavailable in this environment: ${error.message}`)
      return null
    }
    throw error
  }
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : null
  if (!port) throw new Error('Unable to reserve an available HTTP port.')
  return {
    port,
    server,
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
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

function productionProfileArgs(device, extraArgs = []) {
  return [
    '--profile',
    'production',
    '--codebase-id',
    device.codebaseId,
    '--state-root',
    device.stateRoot,
    '--workspace-root',
    device.workspaceRoot,
    '--cloud',
    device.cloud,
    '--allow-local-cloud',
    '--session-id',
    device.sessionId,
    '--device-name',
    device.deviceName,
    ...extraArgs,
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

let gitAvailable

async function skipUnlessGitAvailable(t) {
  if (gitAvailable === undefined) {
    try {
      await execFileAsync('git', ['--version'], { encoding: 'utf8' })
      gitAvailable = true
    } catch {
      gitAvailable = false
    }
  }

  if (!gitAvailable) t.skip('git is not available in this environment')
}

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

  const child = spawn(process.execPath, [
    ...nodeArgs,
    cliPath,
    'watch',
    ...stateArgs(state),
    ...(options.extraArgs ?? []),
  ], {
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

function parseLastJsonObject(stdout) {
  const trimmed = stdout.trim()
  const start = trimmed.lastIndexOf('\n{')
  return JSON.parse(start === -1 ? trimmed : trimmed.slice(start + 1))
}

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex')
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
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

async function touchLocalActivityMarker(state) {
  await fs.writeFile(path.join(state.workspace, '.DS_Store'), `hopit local activity ${randomUUID()}\n`, 'utf8')
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
  assert.match(sync.stdout, /"journaledScopeCounts":\{"shared":0,"private":2\}/)

  const cloud = await readJson(state.cloud)
  assert.equal(cloud.files['.private/agent-note.md'], undefined)
  assert.equal(cloud.files['.private'].kind, 'directory')

  const journal = await readNdjson(state.journal)
  assert.equal(journal.length, 2)
  assert.deepEqual(
    journal.map((entry) => [entry.type, entry.path, entry.kind, entry.scope]).sort(),
    [
      ['create', '.private', 'directory', 'owner-private'],
      ['delete', '.private/agent-note.md', 'file', 'owner-private'],
    ],
  )
})

test('sync and hydrate round-trip binary files, symlinks, empty directories, and .git scope', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))

  const binary = Buffer.from([0, 1, 2, 255, 42, 10])
  await fs.writeFile(path.join(state.workspace, 'binary.bin'), binary)
  await fs.mkdir(path.join(state.workspace, 'empty-dir'), { recursive: true })
  await fs.symlink('README.md', path.join(state.workspace, 'readme-link'))
  await fs.mkdir(path.join(state.workspace, '.git'), { recursive: true })
  await fs.writeFile(path.join(state.workspace, '.git/config'), '[core]\nrepositoryformatversion = 0\n', 'utf8')

  await runCli('sync-once', stateArgs(state))
  const cloud = await readJson(state.cloud)

  assert.equal(cloud.files['binary.bin'].kind, 'file')
  assert.equal(cloud.files['binary.bin'].encoding, 'base64')
  assert.equal(cloud.files['binary.bin'].hash, hashBuffer(binary))
  assert.equal(cloud.files['empty-dir'].kind, 'directory')
  assert.equal(cloud.files['readme-link'].kind, 'symlink')
  assert.equal(cloud.files['readme-link'].target, 'README.md')
  assert.equal(cloud.files['.git/config'].scope, 'owner-private')

  await fs.rm(state.workspace, { recursive: true, force: true })
  await runCli('hydrate', stateArgs(state))

  assert.deepEqual(await fs.readFile(path.join(state.workspace, 'binary.bin')), binary)
  assert.equal(await pathExists(path.join(state.workspace, 'empty-dir')), true)
  assert.equal(await fs.readlink(path.join(state.workspace, 'readme-link')), 'README.md')
  assert.match(await fs.readFile(path.join(state.workspace, '.git/config'), 'utf8'), /repositoryformatversion/)
})

test('object blob provider stores file bodies outside the cloud graph and hydrates by hash', async () => {
  const state = await makeState()
  const blobRoot = path.join(state.root, 'blob-store')
  const blobArgs = ['--blob-provider', 'filesystem', '--blob-root', blobRoot]
  await runCli('init', [...stateArgs(state), ...blobArgs, '--force'])
  await runCli('hydrate', [...stateArgs(state), ...blobArgs])

  const content = Buffer.from('object-backed sync body\n', 'utf8')
  const binary = Buffer.from([0, 1, 255, 64, 10])
  await fs.writeFile(path.join(state.workspace, 'object-backed.txt'), content)
  await fs.writeFile(path.join(state.workspace, 'object-backed.bin'), binary)

  await runCli('sync-once', [...stateArgs(state), ...blobArgs])
  const cloud = await readJson(state.cloud)
  const textEntry = cloud.files['object-backed.txt']
  const binaryEntry = cloud.files['object-backed.bin']

  assert.equal(textEntry.contentStorage, 'object-blob')
  assert.equal(textEntry.blobProvider, 'filesystem')
  assert.equal(textEntry.content, '')
  assert.equal(textEntry.hash, hashBuffer(content))
  assert.equal(textEntry.blobHash, hashBuffer(content))
  assert.ok(textEntry.blobKey.includes(textEntry.hash))
  assert.deepEqual(await fs.readFile(path.join(blobRoot, textEntry.blobKey)), content)

  assert.equal(binaryEntry.contentStorage, 'object-blob')
  assert.equal(binaryEntry.encoding, 'base64')
  assert.equal(binaryEntry.content, '')
  assert.deepEqual(await fs.readFile(path.join(blobRoot, binaryEntry.blobKey)), binary)

  await fs.rm(state.workspace, { recursive: true, force: true })
  await runCli('hydrate', [...stateArgs(state), ...blobArgs])

  assert.deepEqual(await fs.readFile(path.join(state.workspace, 'object-backed.txt')), content)
  assert.deepEqual(await fs.readFile(path.join(state.workspace, 'object-backed.bin')), binary)
})

test('client-encrypted secret sync stores routed env bytes only as encrypted object blobs', async () => {
  const state = await makeState()
  const blobRoot = path.join(state.root, 'blob-store')
  const key = Buffer.alloc(32, 7).toString('base64')
  const blobArgs = [
    '--blob-provider',
    'filesystem',
    '--blob-root',
    blobRoot,
    '--client-encryption-key',
    `base64:${key}`,
  ]

  await runCli('init', [...stateArgs(state), ...blobArgs, '--force'])
  await runCli('hydrate', [...stateArgs(state), ...blobArgs])

  const secretPath = path.join(state.workspace, '.private/env/repo-root/.env.local')
  await fs.mkdir(path.dirname(secretPath), { recursive: true })
  await fs.writeFile(secretPath, 'SECRET=encrypted\n', 'utf8')

  await runCli('sync-once', [...stateArgs(state), ...blobArgs])
  const cloud = await readJson(state.cloud)
  const entry = cloud.files['.private/env/repo-root/.env.local']

  assert.equal(entry.scope, 'owner-private')
  assert.equal(entry.contentStorage, 'object-blob')
  assert.equal(entry.content, '')
  assert.equal(entry.hash, hashBuffer('SECRET=encrypted\n'))
  assert.notEqual(entry.blobHash, entry.hash)
  assert.equal(entry.clientEncryption.state, 'client-encrypted')
  assert.equal(entry.clientEncryption.algorithm, 'aes-256-gcm')
  assert.equal(entry.clientEncryption.plaintextHash, entry.hash)
  assert.equal(entry.clientEncryption.plaintextSize, Buffer.byteLength('SECRET=encrypted\n'))
  assert.equal((await fs.readFile(path.join(blobRoot, entry.blobKey), 'utf8')).includes('SECRET=encrypted'), false)

  await fs.rm(state.workspace, { recursive: true, force: true })
  await runCli('hydrate', [...stateArgs(state), ...blobArgs])
  assert.equal(await fs.readFile(secretPath, 'utf8'), 'SECRET=encrypted\n')

  const wrongKey = Buffer.alloc(32, 8).toString('base64')
  await fs.rm(state.workspace, { recursive: true, force: true })
  const failure = await runCliFailure('hydrate', [
    ...stateArgs(state),
    '--blob-provider',
    'filesystem',
    '--blob-root',
    blobRoot,
    '--client-encryption-key',
    `base64:${wrongKey}`,
  ])
  assert.match(failure.stderr, /client_encryption_key_mismatch|Unsupported state or unable to authenticate data/)
})

test('object blob budget guard blocks upload before cloud metadata changes', async () => {
  const state = await makeState()
  const blobRoot = path.join(state.root, 'blob-store')
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))

  await fs.writeFile(path.join(state.workspace, 'too-large.txt'), 'this should not upload\n', 'utf8')
  const result = await runCliFailure('sync-once', [
    ...stateArgs(state),
    '--blob-provider',
    'filesystem',
    '--blob-root',
    blobRoot,
    '--blob-storage-budget-bytes',
    '1',
  ])

  assert.match(result.stdout, /sync\.failed/)
  assert.match(result.stdout, /object_blob_budget_exceeded/)
  const cloud = await readJson(state.cloud)
  assert.equal(cloud.files['too-large.txt'], undefined)
})

test('mirror routes root env secrets into .private and skips cloud sync when over budget', async () => {
  const state = await makeState()
  const source = path.join(state.root, 'source-project')
  await fs.mkdir(path.join(source, '.git'), { recursive: true })
  await fs.writeFile(path.join(source, 'README.md'), '# Literal mirror\n', 'utf8')
  await fs.writeFile(path.join(source, '.env.local'), 'SECRET=route-me\n', 'utf8')
  await fs.writeFile(path.join(source, '.env.example'), 'SECRET=\n', 'utf8')
  await fs.writeFile(
    path.join(source, '.git/config'),
    '[core]\nrepositoryformatversion = 0\n[remote "origin"]\n\turl = https://token@github.com/org/repo.git\n',
    'utf8',
  )
  await fs.mkdir(state.workspace, { recursive: true })
  await fs.writeFile(path.join(state.workspace, 'old.txt'), 'old workspace\n', 'utf8')

  const result = parseLastJsonObject((await runCli('mirror', [
    ...stateArgs(state),
    '--source',
    source,
    '--storage-budget-bytes',
    '1',
    '--skip-service-control',
  ])).stdout)

  assert.equal(result.ok, true)
  assert.equal(result.sync.skipped, true)
  assert.equal(result.sync.reason, 'storage_budget_exceeded')
  assert.equal(result.secrets.rootEnvExists, false)
  assert.equal(result.secrets.routedEnvExists, true)
  assert.equal(await pathExists(path.join(state.workspace, 'old.txt')), false)
  assert.equal(await pathExists(path.join(state.workspace, '.env.local')), false)
  assert.match(await fs.readFile(path.join(state.workspace, '.private/env/repo-root/.env.local'), 'utf8'), /SECRET=route-me/)
  assert.match(await fs.readFile(path.join(state.workspace, '.git/config'), 'utf8'), /repositoryformatversion/)
  assert.equal(await pathExists(result.backup.manifest), true)

  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('sync-once', stateArgs(state))
  const cloud = await readJson(state.cloud)
  assert.equal(cloud.files['.private/env/repo-root/.env.local'], undefined)
  assert.equal(cloud.files['.private/env'], undefined)
  assert.equal(cloud.files['.git/config'].scope, 'owner-private')
  assert.equal(cloud.files['.env.example'].scope, 'shared')
})

test('import-git production-safe mirror skips cloud sync when routed secrets are not encrypted', async () => {
  const state = await makeState()
  const source = path.join(state.root, 'git-source')
  await fs.mkdir(path.join(source, '.git'), { recursive: true })
  await fs.writeFile(path.join(source, 'README.md'), '# Git source\n', 'utf8')
  await fs.writeFile(path.join(source, '.env.local'), 'SECRET=local-only\n', 'utf8')
  await fs.writeFile(
    path.join(source, '.git/config'),
    '[core]\nrepositoryformatversion = 0\n[remote "origin"]\n\turl = https://token@github.com/org/repo.git\n',
    'utf8',
  )
  await runCli('init', [...stateArgs(state), '--force'])

  const result = parseLastJsonObject((await runCli('import-git', [
    ...stateArgs(state),
    '--source',
    source,
    '--skip-service-control',
  ])).stdout)

  assert.equal(result.action, 'import-git')
  assert.equal(result.ok, true)
  assert.equal(result.secrets.routedEnvExists, true)
  assert.equal(result.secrets.encryptedSyncEnabled, false)
  assert.equal(result.sync.skipped, true)
  assert.equal(result.sync.reason, 'client_encryption_key_missing')

  const cloud = await readJson(state.cloud)
  assert.equal(cloud.files['README.md'].content.includes('Git source'), false)
  assert.equal(cloud.files['.git/config'], undefined)
  assert.equal(cloud.files['.private/env/repo-root/.env.local'], undefined)
  assert.equal(await fs.readFile(path.join(state.workspace, '.private/env/repo-root/.env.local'), 'utf8'), 'SECRET=local-only\n')
})

test('import-git with client encryption syncs literal repo, .git metadata, and routed secrets', async () => {
  const state = await makeState()
  const source = path.join(state.root, 'git-source-encrypted')
  const blobRoot = path.join(state.root, 'blob-store')
  const key = Buffer.alloc(32, 11).toString('base64')
  const blobArgs = [
    '--blob-provider',
    'filesystem',
    '--blob-root',
    blobRoot,
    '--client-encryption-key',
    `base64:${key}`,
  ]

  await fs.mkdir(path.join(source, '.git'), { recursive: true })
  await fs.writeFile(path.join(source, 'README.md'), '# Git source encrypted\n', 'utf8')
  await fs.writeFile(path.join(source, '.env.local'), 'SECRET=encrypted-import\n', 'utf8')
  await fs.writeFile(
    path.join(source, '.git/config'),
    '[core]\nrepositoryformatversion = 0\n[remote "origin"]\n\turl = https://token@github.com/org/repo.git\n',
    'utf8',
  )
  await runCli('init', [...stateArgs(state), ...blobArgs, '--force'])

  const result = parseLastJsonObject((await runCli('import-git', [
    ...stateArgs(state),
    ...blobArgs,
    '--source',
    source,
    '--skip-service-control',
  ])).stdout)

  assert.equal(result.action, 'import-git')
  assert.equal(result.sync.skipped, false)
  assert.equal(result.secrets.encryptedSyncEnabled, true)

  const cloud = await readJson(state.cloud)
  const secretEntry = cloud.files['.private/env/repo-root/.env.local']
  assert.equal(cloud.files['README.md'].content, '')
  assert.equal(cloud.files['README.md'].contentStorage, 'object-blob')
  assert.equal(cloud.files['.git/config'].scope, 'owner-private')
  assert.equal(secretEntry.scope, 'owner-private')
  assert.equal(secretEntry.contentStorage, 'object-blob')
  assert.equal(secretEntry.clientEncryption.state, 'client-encrypted')
  assert.equal(secretEntry.hash, hashBuffer('SECRET=encrypted-import\n'))
  assert.notEqual(secretEntry.blobHash, secretEntry.hash)
  assert.equal((await fs.readFile(path.join(blobRoot, secretEntry.blobKey), 'utf8')).includes('encrypted-import'), false)

  await fs.rm(state.workspace, { recursive: true, force: true })
  await runCli('hydrate', [...stateArgs(state), ...blobArgs])
  assert.equal(await fs.readFile(path.join(state.workspace, 'README.md'), 'utf8'), '# Git source encrypted\n')
  assert.equal(await fs.readFile(path.join(state.workspace, '.private/env/repo-root/.env.local'), 'utf8'), 'SECRET=encrypted-import\n')
  const gitConfig = await fs.readFile(path.join(state.workspace, '.git/config'), 'utf8')
  assert.match(gitConfig, /repositoryformatversion/)
  assert.match(gitConfig, /https:\/\/github\.com\/org\/repo\.git/)
  assert.equal(gitConfig.includes('token@'), false)
})

test('import-git routes secret-looking and gitignored files into encrypted private env storage', async (t) => {
  await skipUnlessGitAvailable(t)

  const state = await makeState()
  const source = path.join(state.root, 'git-source-routed-secrets')
  const blobRoot = path.join(state.root, 'blob-store')
  const key = Buffer.alloc(32, 19).toString('base64')
  const blobArgs = [
    '--blob-provider',
    'filesystem',
    '--blob-root',
    blobRoot,
    '--client-encryption-key',
    `base64:${key}`,
  ]

  await fs.mkdir(source, { recursive: true })
  await execFileAsync('git', ['-C', source, 'init'], { encoding: 'utf8' })
  await execFileAsync('git', ['-C', source, 'config', 'user.email', 'test@hopit.dev'], { encoding: 'utf8' })
  await execFileAsync('git', ['-C', source, 'config', 'user.name', 'HopIt Test'], { encoding: 'utf8' })
  await fs.mkdir(path.join(source, 'ignored-dir'), { recursive: true })
  await fs.writeFile(path.join(source, 'README.md'), '# Routed secret import\n', 'utf8')
  await fs.writeFile(path.join(source, '.gitignore'), 'ignored-secret.json\nignored-dir/\n', 'utf8')
  await fs.writeFile(path.join(source, '.env'), 'ROOT_SECRET=route-env\n', 'utf8')
  await fs.writeFile(path.join(source, '.env.example'), 'ROOT_SECRET=\n', 'utf8')
  await fs.writeFile(path.join(source, '.npmrc'), '//registry.npmjs.org/:_authToken=npm-secret\n', 'utf8')
  await fs.writeFile(path.join(source, 'ignored-secret.json'), '{"secret":true}\n', 'utf8')
  await fs.writeFile(path.join(source, 'ignored-dir/cache.txt'), 'ignored cache\n', 'utf8')
  await execFileAsync('git', ['-C', source, 'add', 'README.md', '.gitignore', '.env.example'], { encoding: 'utf8' })
  await execFileAsync('git', ['-C', source, 'commit', '-m', 'Initial routed secret fixture'], { encoding: 'utf8' })
  await runCli('init', [...stateArgs(state), ...blobArgs, '--force'])

  const result = parseLastJsonObject((await runCli('import-git', [
    ...stateArgs(state),
    ...blobArgs,
    '--source',
    source,
    '--skip-service-control',
  ])).stdout)

  assert.equal(result.sync.skipped, false)
  assert.equal(result.secrets.routedSecretCount, 4)
  assert.equal(await pathExists(path.join(state.workspace, '.env')), false)
  assert.equal(await pathExists(path.join(state.workspace, '.npmrc')), false)
  assert.equal(await pathExists(path.join(state.workspace, 'ignored-secret.json')), false)
  assert.equal(await pathExists(path.join(state.workspace, 'ignored-dir/cache.txt')), false)
  assert.equal(await fs.readFile(path.join(state.workspace, '.private/env/repo-root/.env'), 'utf8'), 'ROOT_SECRET=route-env\n')
  assert.equal(
    await fs.readFile(path.join(state.workspace, '.private/env/repo-root/.npmrc'), 'utf8'),
    '//registry.npmjs.org/:_authToken=npm-secret\n',
  )
  assert.equal(
    await fs.readFile(path.join(state.workspace, '.private/env/gitignored/ignored-secret.json'), 'utf8'),
    '{"secret":true}\n',
  )
  assert.equal(await fs.readFile(path.join(state.workspace, '.private/env/gitignored/ignored-dir/cache.txt'), 'utf8'), 'ignored cache\n')

  const cloud = await readJson(state.cloud)
  assert.equal(cloud.files['.env'], undefined)
  assert.equal(cloud.files['.npmrc'], undefined)
  assert.equal(cloud.files['ignored-secret.json'], undefined)
  assert.equal(cloud.files['ignored-dir/cache.txt'], undefined)
  assert.equal(cloud.files['.env.example'].scope, 'shared')
  for (const routedPath of [
    '.private/env/repo-root/.env',
    '.private/env/repo-root/.npmrc',
    '.private/env/gitignored/ignored-secret.json',
    '.private/env/gitignored/ignored-dir/cache.txt',
  ]) {
    assert.equal(cloud.files[routedPath].scope, 'owner-private')
    assert.equal(cloud.files[routedPath].contentStorage, 'object-blob')
    assert.equal(cloud.files[routedPath].clientEncryption.state, 'client-encrypted')
  }
})

test('import-git-url clones a remote repository before production-safe import', async (t) => {
  await skipUnlessGitAvailable(t)

  const state = await makeState()
  const remoteSource = path.join(state.root, 'remote-source')
  const blobRoot = path.join(state.root, 'blob-store')
  const key = Buffer.alloc(32, 17).toString('base64')
  const blobArgs = [
    '--blob-provider',
    'filesystem',
    '--blob-root',
    blobRoot,
    '--client-encryption-key',
    `base64:${key}`,
  ]

  await fs.mkdir(remoteSource, { recursive: true })
  await execFileAsync('git', ['-C', remoteSource, 'init'], { encoding: 'utf8' })
  await execFileAsync('git', ['-C', remoteSource, 'config', 'user.email', 'test@hopit.dev'], { encoding: 'utf8' })
  await execFileAsync('git', ['-C', remoteSource, 'config', 'user.name', 'HopIt Test'], { encoding: 'utf8' })
  await fs.writeFile(path.join(remoteSource, 'README.md'), '# Remote Git source\n', 'utf8')
  await fs.writeFile(path.join(remoteSource, '.env.local'), 'SECRET=remote-import\n', 'utf8')
  await execFileAsync('git', ['-C', remoteSource, 'add', '.'], { encoding: 'utf8' })
  await execFileAsync('git', ['-C', remoteSource, 'commit', '-m', 'Initial remote import fixture'], { encoding: 'utf8' })
  await runCli('init', [...stateArgs(state), ...blobArgs, '--force'])

  const remoteUrl = pathToFileURL(remoteSource).href
  const result = parseLastJsonObject((await runCli('import-git-url', [
    ...stateArgs(state),
    ...blobArgs,
    '--url',
    remoteUrl,
    '--skip-service-control',
  ])).stdout)

  assert.equal(result.action, 'import-git-url')
  assert.equal(result.remoteGit.url, remoteUrl)
  assert.equal(result.sync.skipped, false)

  const cloud = await readJson(state.cloud)
  const secretEntry = cloud.files['.private/env/repo-root/.env.local']
  assert.equal(cloud.files['README.md'].contentStorage, 'object-blob')
  assert.equal(cloud.files['.git/config'].scope, 'owner-private')
  assert.equal(secretEntry.clientEncryption.state, 'client-encrypted')

  await fs.rm(state.workspace, { recursive: true, force: true })
  await runCli('hydrate', [...stateArgs(state), ...blobArgs])
  assert.equal(await fs.readFile(path.join(state.workspace, 'README.md'), 'utf8'), '# Remote Git source\n')
  assert.equal(await fs.readFile(path.join(state.workspace, '.private/env/repo-root/.env.local'), 'utf8'), 'SECRET=remote-import\n')
  assert.match(await fs.readFile(path.join(state.workspace, '.git/config'), 'utf8'), /repositoryformatversion/)
})

test('storage gc dry-runs and deletes only orphaned managed filesystem blobs with execute', async () => {
  const state = await makeState()
  const blobRoot = path.join(state.root, 'blob-store')
  const blobArgs = ['--blob-provider', 'filesystem', '--blob-root', blobRoot]
  await runCli('init', [...stateArgs(state), ...blobArgs, '--force'])
  await runCli('hydrate', [...stateArgs(state), ...blobArgs])
  await fs.writeFile(path.join(state.workspace, 'kept.txt'), 'kept blob\n', 'utf8')
  await runCli('sync-once', [...stateArgs(state), ...blobArgs])
  const cloud = await readJson(state.cloud)
  const keptKey = cloud.files['kept.txt'].blobKey
  const orphanHash = createHash('sha256').update('orphan blob\n').digest('hex')
  const orphanKey = ['codebases', cloud.codebase.id, 'blobs', 'sha256', orphanHash.slice(0, 2), orphanHash].join('/')
  await fs.mkdir(path.dirname(path.join(blobRoot, orphanKey)), { recursive: true })
  await fs.writeFile(path.join(blobRoot, orphanKey), 'orphan blob\n', 'utf8')

  const planned = parseLastJsonObject((await runCli('storage', [
    'gc',
    ...stateArgs(state),
    ...blobArgs,
  ])).stdout)
  assert.equal(planned.mode, 'dry-run')
  assert.equal(planned.orphanedObjects, 1)
  assert.equal(planned.deletedObjects, 0)
  assert.equal(await pathExists(path.join(blobRoot, orphanKey)), true)

  const executed = parseLastJsonObject((await runCli('storage', [
    'gc',
    ...stateArgs(state),
    ...blobArgs,
    '--execute',
  ])).stdout)
  assert.equal(executed.mode, 'execute')
  assert.equal(executed.deletedObjects, 1)
  assert.equal(await pathExists(path.join(blobRoot, orphanKey)), false)
  assert.equal(await pathExists(path.join(blobRoot, keptKey)), true)
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

test('import-local refuses to use the source folder as the managed workspace', async () => {
  const state = await makeState()
  const source = path.join(state.root, 'source-project')
  await fs.mkdir(source, { recursive: true })
  await fs.writeFile(path.join(source, 'README.md'), '# Unsafe import\n', 'utf8')

  const failure = await runCliFailure('import-local', [
    '--cloud',
    state.cloud,
    '--workspace',
    source,
    '--journal',
    state.journal,
    '--events',
    state.events,
    '--source',
    source,
    '--force',
  ])

  assert.match(failure.stderr, /Refusing workspace\/source overlap/)
})

test('production profile derives agent state and workspace paths outside the checkout', async () => {
  const state = await makeState()
  const stateRoot = path.join(state.root, 'agent-state')
  const workspaceRoot = path.join(state.root, 'managed-workspaces')

  const result = await runCli('status', [
    '--profile',
    'production',
    '--codebase-id',
    'prod-demo',
    '--state-root',
    stateRoot,
    '--workspace-root',
    workspaceRoot,
    '--allow-local-cloud',
  ])
  const status = JSON.parse(result.stdout)

  assert.equal(status.ok, false)
  assert.equal(status.readiness, 'not_initialized')
  assert.equal(status.cloud.path, path.join(stateRoot, 'cloud', 'prod-demo.json'))
  assert.equal(status.workspace.path, path.join(workspaceRoot, 'prod-demo'))
  assert.equal(status.journal.path, path.join(stateRoot, 'journal', 'prod-demo.ndjson'))
  assert.equal(status.events.path, path.join(stateRoot, 'events', 'prod-demo.ndjson'))
})

test('workspace command reports and prepares the configured workspace root', async () => {
  const state = await makeState()
  const workspaceRoot = path.join(state.root, 'HopIt Workspaces')
  const workspace = path.join(workspaceRoot, 'demo-codebase')
  const args = [
    '--cloud',
    state.cloud,
    '--workspace',
    workspace,
    '--journal',
    state.journal,
    '--events',
    state.events,
    '--workspace-root',
    workspaceRoot,
    '--codebase-id',
    'demo-codebase',
  ]

  const before = JSON.parse((await runCli('workspace', ['status', ...args])).stdout)
  assert.equal(before.ok, true)
  assert.equal(before.action, 'status')
  assert.equal(before.root.path, workspaceRoot)
  assert.equal(before.root.exists, false)
  assert.equal(before.root.adapter, 'managed-folder')
  assert.equal(before.root.virtualized, false)
  assert.equal(before.root.index.exists, false)
  assert.equal(before.current.id, 'demo-codebase')
  assert.equal(before.current.initialized, false)
  assert.equal(before.current.materialization, 'managed-folder')
  assert.equal(before.current.hydration.state, 'not_initialized')
  assert.equal(before.current.virtualized, false)

  const ensured = JSON.parse((await runCli('workspace', ['ensure', ...args])).stdout)
  assert.equal(ensured.action, 'ensure')
  assert.equal(ensured.root.exists, true)
  assert.equal(ensured.root.index.exists, true)
  assert.equal(ensured.root.index.codebaseCount, 1)
  assert.equal(ensured.current.workspace.path, workspace)
  assert.equal(await pathExists(workspaceRoot), true)
  assert.equal(await pathExists(workspace), true)
  const index = await readJson(path.join(state.root, 'workspaces.json'))
  assert.equal(index.schemaVersion, 1)
  assert.equal(index.codebases[0].id, 'demo-codebase')
  assert.equal(index.codebases[0].workspace.path, workspace)

  const listed = JSON.parse((await runCli('workspaces', ['list', ...args])).stdout)
  assert.equal(listed.action, 'list')
  assert.equal(listed.codebases.length, 1)
  assert.equal(listed.codebases[0].id, 'demo-codebase')
})

test('workspace discover and attach bind a cloud codebase without hydrating file bodies', async () => {
  const state = await makeState()
  const workspaceRoot = path.join(state.root, 'HopIt Workspaces')
  const workspace = path.join(workspaceRoot, 'hopit-core')
  const args = [
    '--cloud',
    state.cloud,
    '--workspace',
    workspace,
    '--journal',
    state.journal,
    '--events',
    state.events,
    '--workspace-root',
    workspaceRoot,
  ]

  await runCli('init', [...args, '--force'])

  const discovered = JSON.parse((await runCli('workspace', ['discover', ...args])).stdout)
  assert.equal(discovered.ok, true)
  assert.equal(discovered.action, 'discover')
  assert.equal(discovered.cloud.exists, true)
  assert.equal(discovered.cloud.discovery, 'configured-codebase')
  assert.equal(discovered.root.exists, false)
  assert.equal(discovered.codebases.length, 1)
  assert.equal(discovered.codebases[0].id, 'hopit-core')
  assert.equal(discovered.codebases[0].attached, false)
  assert.equal(discovered.codebases[0].available, true)
  assert.equal(discovered.codebases[0].workspace.path, workspace)
  assert.equal(discovered.codebases[0].workspace.hydration.state, 'not_attached')

  const attached = parseLastJsonObject((await runCli('workspace', ['attach', ...args])).stdout)
  assert.equal(attached.ok, true)
  assert.equal(attached.action, 'attach')
  assert.equal(attached.workspace, workspace)
  assert.equal(attached.files.visible, 4)
  assert.equal(attached.files.hydrated, 0)
  assert.equal(attached.files.materialization, 'metadata-only')
  assert.equal(attached.codebase.hydration.state, 'metadata-only')
  assert.equal(attached.codebase.contentManifest.fileCount, 0)
  assert.equal(await pathExists(path.join(workspace, '.hopit', 'metadata.json')), true)
  assert.equal(await pathExists(path.join(workspace, 'README.md')), false)

  const status = JSON.parse((await runCli('status', args)).stdout)
  assert.equal(status.ok, true)
  assert.equal(status.readiness, 'attached')
  assert.equal(status.workspace.hydration.state, 'metadata-only')
  assert.equal(status.workspace.localChanges.state, 'clean')

  const listed = JSON.parse((await runCli('workspace', ['files', ...args])).stdout)
  assert.equal(listed.summary.visibleFiles, 4)
  assert.equal(listed.summary.hydratedFiles, 0)
  assert.equal(listed.summary.materialization, 'metadata-only')
  assert.equal(listed.current.initialized, true)
  assert.equal(listed.current.hydration.state, 'metadata-only')

  const hydrated = parseLastJsonObject((await runCli('workspace', [
    'hydrate-file',
    ...args,
    '--path',
    'README.md',
  ])).stdout)
  assert.equal(hydrated.ok, true)
  assert.equal(hydrated.action, 'hydrate-file')
  assert.equal(hydrated.hydration.state, 'partial')
  assert.equal(await pathExists(path.join(workspace, 'README.md')), true)
  assert.equal(await pathExists(path.join(workspace, 'src/presence.ts')), false)
})

test('workspace attach refuses non-empty unmanaged folders', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await fs.mkdir(state.workspace, { recursive: true })
  await fs.writeFile(path.join(state.workspace, 'README.md'), '# unmanaged\n', 'utf8')

  const failure = await runCliFailure('workspace', ['attach', ...stateArgs(state)])
  assert.match(failure.stderr, /non-empty unmanaged folder/)
})

test('hydrate records a workspace index cursor for the materialized revision', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))

  const index = await readJson(path.join(state.root, 'workspaces.json'))
  assert.equal(index.root.path, state.root)
  assert.equal(index.codebases.length, 1)
  assert.equal(index.codebases[0].id, 'hopit-core')
  assert.equal(index.codebases[0].hydration.state, 'materialized')
  assert.equal(index.codebases[0].hydration.lastMaterializedRevision, 1)
  assert.equal(index.codebases[0].contentManifest.fileCount, 4)
  assert.equal(index.codebases[0].contentManifest.files['README.md'].scope, 'shared')
  assert.equal(index.codebases[0].remoteCursor.materializedRevision, 1)

  const status = JSON.parse((await runCli('status', stateArgs(state))).stdout)
  assert.equal(status.workspace.hydration.state, 'materialized')
  assert.equal(status.workspace.hydration.lastMaterializedRevision, 1)
  assert.equal(status.workspace.localChanges.state, 'clean')
  assert.equal(status.workspace.contentManifest.fileCount, 4)
  assert.equal(status.remotePull.cursor.materializedRevision, 1)
  assert.equal(status.remotePull.cursor.graphRevision, 1)
  assert.equal(status.workspace.index.exists, true)
})

test('status reports unjournaled local workspace drift from the materialized manifest', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))

  await fs.writeFile(path.join(state.workspace, 'README.md'), '# hopit-core\n\nUnsynced local draft.\n', 'utf8')

  const status = JSON.parse((await runCli('status', stateArgs(state))).stdout)
  assert.equal(status.ok, false)
  assert.equal(status.workspace.localChanges.state, 'dirty')
  assert.equal(status.workspace.localChanges.reason, 'workspace_has_unjournaled_changes')
  assert.equal(status.workspace.localChanges.modifiedCount, 1)
  assert.deepEqual(status.workspace.localChanges.samplePaths, ['README.md'])
})

test('status reports added workspace drift without reading untracked file bytes', async (t) => {
  if (process.platform === 'win32') {
    t.skip('mode-based unreadable file assertion is POSIX-specific')
    return
  }

  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))

  const untrackedDir = path.join(state.workspace, 'untracked')
  await fs.mkdir(untrackedDir, { recursive: true })
  for (let index = 0; index < 30; index += 1) {
    await fs.writeFile(path.join(untrackedDir, `file-${String(index).padStart(2, '0')}.txt`), 'untracked\n', 'utf8')
  }

  const unreadablePath = path.join(untrackedDir, 'secret.bin')
  await fs.writeFile(unreadablePath, 'this added file should not be read by status\n', 'utf8')
  await fs.chmod(unreadablePath, 0o000)
  t.after(async () => {
    await fs.chmod(unreadablePath, 0o600).catch(() => {})
  })

  const status = JSON.parse((await runCli('status', stateArgs(state))).stdout)
  assert.equal(status.ok, false)
  assert.equal(status.workspace.localChanges.state, 'dirty')
  assert.equal(status.workspace.localChanges.reason, 'workspace_has_unjournaled_changes')
  assert.equal(status.workspace.localChanges.addedCount, 31)
  assert.equal(status.workspace.localChanges.modifiedCount, 0)
  assert.equal(status.workspace.localChanges.deletedCount, 0)
  assert.equal(status.workspace.localChanges.samplePaths.length, 10)
  assert.equal(status.workspace.localChanges.samplePaths[0], 'untracked/file-00.txt')
})

test('workspace ensure does not mark a cloud-backed empty folder as materialized', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])

  const ensured = JSON.parse((await runCli('workspace', ['ensure', ...stateArgs(state)])).stdout)
  assert.equal(ensured.ok, true)
  assert.equal(ensured.current.initialized, false)
  assert.equal(ensured.current.hydration.state, 'not_materialized')
  assert.equal(ensured.current.hydration.lastMaterializedRevision, null)
  assert.equal(ensured.current.remoteCursor.materializedRevision, null)

  const index = await readJson(path.join(state.root, 'workspaces.json'))
  assert.equal(index.codebases[0].hydration.state, 'not_materialized')
  assert.equal(index.codebases[0].hydration.lastMaterializedRevision, null)
  assert.equal(index.codebases[0].remoteCursor.materializedRevision, null)

  const status = JSON.parse((await runCli('status', stateArgs(state))).stdout)
  assert.equal(status.ok, false)
  assert.equal(status.readiness, 'not_initialized')
  assert.equal(status.workspace.hydration.state, 'not_materialized')
})

test('refresh can safely materialize an empty ensured workspace without a manifest', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('workspace', ['ensure', ...stateArgs(state)])

  assert.equal(await pathExists(path.join(state.workspace, 'README.md')), false)

  await runCli('refresh', stateArgs(state))

  const status = JSON.parse((await runCli('status', stateArgs(state))).stdout)
  assert.equal(status.ok, true)
  assert.equal(status.readiness, 'ready')
  assert.equal(status.workspace.hydration.state, 'materialized')
  assert.equal(status.workspace.localChanges.state, 'clean')
  assert.equal(await pathExists(path.join(state.workspace, 'README.md')), true)
})

test('metadata-only workspaces do not treat unhydrated missing files as deletes on sync', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))
  await runCli('workspace', ['dehydrate', ...stateArgs(state), '--force'])

  assert.equal(await pathExists(path.join(state.workspace, 'README.md')), false)
  await fs.writeFile(path.join(state.workspace, 'scratch.md'), 'new partial workspace file\n', 'utf8')

  await runCli('sync-once', stateArgs(state))

  const cloud = await readJson(state.cloud)
  assert.ok(cloud.files['README.md'])
  assert.ok(cloud.files['src/presence.ts'])
  assert.equal(cloud.files['scratch.md'].content, 'new partial workspace file\n')

  const status = JSON.parse((await runCli('status', stateArgs(state))).stdout)
  assert.equal(status.workspace.hydration.state, 'partial')
  assert.equal(status.workspace.hydration.hydratedPathCount, 1)
  assert.equal(status.workspace.localChanges.state, 'clean')
  assert.equal(status.workspace.contentManifest.fileCount, 1)
})

test('workspace files and hydrate-file expose cloud metadata and materialize one path', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])

  const listedBefore = JSON.parse((await runCli('workspace', ['files', ...stateArgs(state), '--json'])).stdout)
  assert.equal(listedBefore.ok, true)
  assert.equal(listedBefore.action, 'files')
  assert.equal(listedBefore.summary.visibleFiles, 4)
  assert.equal(listedBefore.summary.hydratedFiles, 0)
  assert.equal(listedBefore.files.find((file) => file.path === 'README.md').local.exists, false)

  const hydrated = parseLastJsonObject((await runCli('workspace', [
    'hydrate-file',
    ...stateArgs(state),
    '--path',
    'README.md',
  ])).stdout)
  assert.equal(hydrated.ok, true)
  assert.equal(hydrated.action, 'hydrate-file')
  assert.equal(hydrated.path, 'README.md')
  assert.equal(await pathExists(path.join(state.workspace, 'README.md')), true)
  assert.equal(await pathExists(path.join(state.workspace, 'src/presence.ts')), false)

  const listedAfter = JSON.parse((await runCli('workspace', ['files', ...stateArgs(state)])).stdout)
  assert.equal(listedAfter.summary.hydratedFiles, 1)
  assert.equal(listedAfter.files.find((file) => file.path === 'README.md').local.hydrated, true)

  const status = JSON.parse((await runCli('status', stateArgs(state))).stdout)
  assert.equal(status.ok, true)
  assert.equal(status.readiness, 'ready')
  assert.equal(status.workspace.hydration.state, 'partial')
  assert.equal(status.workspace.hydration.hydratedPathCount, 1)
  assert.equal(status.workspace.contentManifest.fileCount, 1)
})

test('production-profile same-Mac dogfood simulation covers lazy hydration remote-pull handoff and dirty blocking', async () => {
  const { deviceA, deviceB } = await makeProductionTwoDeviceState()
  const deviceAArgs = productionProfileArgs(deviceA)
  const deviceBArgs = productionProfileArgs(deviceB)

  await runCli('init', [...deviceAArgs, '--force'])
  await runCli('hydrate', deviceAArgs)

  const listedBefore = JSON.parse((await runCli('workspace', ['files', ...deviceBArgs, '--json'])).stdout)
  assert.equal(listedBefore.ok, true)
  assert.equal(listedBefore.action, 'files')
  assert.equal(listedBefore.summary.visibleFiles, 4)
  assert.equal(listedBefore.summary.hydratedFiles, 0)
  assert.equal(listedBefore.files.find((file) => file.path === 'README.md').local.exists, false)

  const hydrated = parseLastJsonObject((await runCli('workspace', [
    'hydrate-file',
    ...deviceBArgs,
    '--path',
    'README.md',
  ])).stdout)
  assert.equal(hydrated.ok, true)
  assert.equal(hydrated.action, 'hydrate-file')
  assert.equal(hydrated.index.path, path.join(deviceB.stateRoot, 'workspaces.json'))
  assert.equal(await pathExists(path.join(deviceB.workspace, 'README.md')), true)
  assert.equal(await pathExists(path.join(deviceB.workspace, 'src/presence.ts')), false)

  let deviceBStatus = JSON.parse((await runCli('status', deviceBArgs)).stdout)
  assert.equal(deviceBStatus.workspace.hydration.state, 'partial')
  assert.equal(deviceBStatus.workspace.localChanges.state, 'clean')
  assert.equal(deviceBStatus.workspace.contentManifest.fileCount, 1)

  const dehydrated = parseLastJsonObject((await runCli('workspace', [
    'dehydrate',
    ...deviceBArgs,
    '--force',
  ])).stdout)
  assert.equal(dehydrated.ok, true)
  assert.equal(dehydrated.action, 'dehydrate')
  assert.equal(dehydrated.removed, 1)
  assert.equal(await pathExists(path.join(deviceB.workspace, 'README.md')), false)
  assert.equal(await pathExists(path.join(deviceB.workspace, '.hopit', 'metadata.json')), true)

  deviceBStatus = JSON.parse((await runCli('status', deviceBArgs)).stdout)
  assert.equal(deviceBStatus.workspace.hydration.state, 'metadata-only')
  assert.equal(deviceBStatus.workspace.localChanges.state, 'clean')
  assert.equal(deviceBStatus.workspace.contentManifest.fileCount, 0)

  const firstHandoff = '# hopit-core\n\nProduction-profile handoff from device A.\n'
  await fs.writeFile(path.join(deviceA.workspace, 'README.md'), firstHandoff, 'utf8')
  await runCli('sync-once', deviceAArgs)

  const metadataOnlyRemotePull = parseLastJsonObject((await runCli('remote-pull', deviceBArgs)).stdout)
  assert.equal(metadataOnlyRemotePull.ok, true)
  assert.equal(metadataOnlyRemotePull.state, 'skipped')
  assert.equal(metadataOnlyRemotePull.reason, 'workspace_not_fully_materialized')
  assert.equal(await pathExists(path.join(deviceB.workspace, 'README.md')), false)

  await runCli('refresh', deviceBArgs)
  assert.equal(await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8'), firstHandoff)
  assert.equal(await pathExists(path.join(deviceB.workspace, 'src/presence.ts')), true)

  const secondHandoff = '# hopit-core\n\nRemote-pull one-shot handoff from device A.\n'
  await fs.writeFile(path.join(deviceA.workspace, 'README.md'), secondHandoff, 'utf8')
  await runCli('sync-once', deviceAArgs)

  const appliedRemotePull = parseLastJsonObject((await runCli('remote-pull', deviceBArgs)).stdout)
  assert.equal(appliedRemotePull.ok, true)
  assert.equal(appliedRemotePull.state, 'applied')
  assert.equal(appliedRemotePull.fromRevision, 2)
  assert.equal(appliedRemotePull.toRevision, 3)
  assert.equal(await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8'), secondHandoff)

  deviceBStatus = JSON.parse((await runCli('status', [...deviceBArgs, '--remote-pull'])).stdout)
  assert.equal(deviceBStatus.remotePull.enabled, true)
  assert.equal(deviceBStatus.remotePull.state, 'enabled')
  assert.equal(deviceBStatus.remotePull.lastApplied.detail.toRevision, 3)
  assert.equal(deviceBStatus.remoteUpdate.state, 'updated')
  assert.deepEqual(deviceBStatus.events.lastRemoteUpdate.detail.changedPaths, ['README.md'])

  const unsafeDeviceBContent = '# hopit-core\n\nUnsynced local draft on device B.\n'
  await fs.writeFile(path.join(deviceB.workspace, 'README.md'), unsafeDeviceBContent, 'utf8')

  deviceBStatus = JSON.parse((await runCli('status', deviceBArgs)).stdout)
  assert.equal(deviceBStatus.ok, false)
  assert.equal(deviceBStatus.workspace.localChanges.state, 'dirty')
  assert.equal(deviceBStatus.workspace.localChanges.reason, 'workspace_has_unjournaled_changes')
  assert.equal(deviceBStatus.workspace.localChanges.modifiedCount, 1)
  assert.deepEqual(deviceBStatus.workspace.localChanges.samplePaths, ['README.md'])

  const unchangedRemotePull = parseLastJsonObject((await runCli('remote-pull', deviceBArgs)).stdout)
  assert.equal(unchangedRemotePull.ok, true)
  assert.equal(unchangedRemotePull.state, 'up-to-date')
  assert.equal(unchangedRemotePull.reason, null)
  assert.equal(await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8'), unsafeDeviceBContent)

  const thirdHandoff = '# hopit-core\n\nRemote update that must not overwrite dirty device B.\n'
  await fs.writeFile(path.join(deviceA.workspace, 'README.md'), thirdHandoff, 'utf8')
  await runCli('sync-once', deviceAArgs)

  const blockedRemotePull = parseLastJsonObject((await runCli('remote-pull', deviceBArgs)).stdout)
  assert.equal(blockedRemotePull.ok, true)
  assert.equal(blockedRemotePull.state, 'skipped')
  assert.equal(blockedRemotePull.reason, 'workspace_has_unjournaled_changes')
  assert.equal(blockedRemotePull.detail.localChanges.modifiedCount, 1)
  assert.equal(await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8'), unsafeDeviceBContent)

  deviceBStatus = JSON.parse((await runCli('status', [...deviceBArgs, '--remote-pull'])).stdout)
  assert.equal(deviceBStatus.remotePull.state, 'skipped')
  assert.equal(deviceBStatus.remotePull.lastSkipped.detail.reason, 'workspace_has_unjournaled_changes')
  assert.equal(deviceBStatus.remotePull.lastSkipped.detail.localChanges.modifiedCount, 1)
  assert.equal(deviceBStatus.remotePull.cursor.behindByRevisions, 1)
})

test('backup writes restorable cloud status events journal and manifest files', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))
  const output = path.join(state.root, 'backup')

  const backup = JSON.parse((await runCli('backup', [
    ...stateArgs(state),
    '--output',
    output,
    '--force',
  ])).stdout)
  assert.equal(backup.ok, true)
  assert.equal(backup.output, output)
  assert.equal(await pathExists(path.join(output, 'cloud.json')), true)
  assert.equal(await pathExists(path.join(output, 'status.json')), true)
  assert.equal(await pathExists(path.join(output, 'events.ndjson')), true)
  assert.equal(await pathExists(path.join(output, 'workspaces.json')), true)

  const manifest = await readJson(path.join(output, 'manifest.json'))
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.codebaseId, 'hopit-core')
  assert.equal(manifest.cloud.fileCount, 4)
  assert.ok(manifest.files.find((file) => file.path === 'cloud.json')?.sha256)
})

test('install prepares production-style state, workspace, index, and env template', async () => {
  const state = await makeState()
  const stateRoot = path.join(state.root, 'agent-state')
  const workspaceRoot = path.join(state.root, 'HopIt Workspaces')
  const workspace = path.join(workspaceRoot, 'prod-demo')

  const installed = JSON.parse((await runCli('install', [
    '--profile',
    'production',
    '--codebase-id',
    'prod-demo',
    '--state-root',
    stateRoot,
    '--workspace-root',
    workspaceRoot,
    '--workspace',
    workspace,
    '--allow-local-cloud',
    '--write-env',
  ])).stdout)

  assert.equal(installed.ok, true)
  assert.equal(installed.codebaseId, 'prod-demo')
  assert.equal(await pathExists(path.join(stateRoot, 'run')), true)
  assert.equal(await pathExists(workspace), true)
  assert.equal(await pathExists(path.join(stateRoot, 'hopit.env.example')), true)
  const index = await readJson(path.join(stateRoot, 'workspaces.json'))
  assert.equal(index.codebases[0].id, 'prod-demo')
  assert.equal(index.codebases[0].hydration.state, 'metadata-only')
})

test('doctor reports failed checks without hiding the JSON status payload', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))

  const failure = await runCliFailure('doctor', stateArgs(state))
  assert.equal(failure.code, 1)
  const doctor = JSON.parse(failure.stdout)
  assert.equal(doctor.ok, false)
  assert.equal(doctor.status.readiness, 'ready')
  assert.equal(doctor.checks.find((check) => check.name === 'cloud').ok, true)
  assert.equal(doctor.checks.find((check) => check.name === 'service').ok, false)
})

test('device status reports configured session identity and token source', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])

  const status = JSON.parse((await runCli('device', [
    'status',
    ...stateArgs(state),
    '--session-id',
    'session_test_device',
    '--device-name',
    'Test Device',
    '--session-token',
    'hst_test_token',
  ])).stdout)

  assert.equal(status.ok, true)
  assert.equal(status.action, 'status')
  assert.equal(status.session.id, 'session_test_device')
  assert.equal(status.session.deviceName, 'Test Device')
  assert.equal(status.credentials.sessionTokenConfigured, true)
})

test('keys init-device writes a redacted local device keyring with secure permissions', async () => {
  const state = await makeState()
  const secretSessionToken = 'hst_local_secret_token'
  const result = JSON.parse((await runCli('keys', [
    'init-device',
    ...stateArgs(state),
    '--codebase-id',
    'hopit-core',
    '--session-id',
    'session_test_device',
    '--device-name',
    'Test Device',
    '--session-token',
    secretSessionToken,
    '--skip-cloud-registration',
  ])).stdout)

  assert.equal(result.ok, true)
  assert.equal(result.created, true)
  assert.equal(result.keyring.exists, true)
  assert.equal(result.keyring.deviceId.startsWith('dev_'), true)
  assert.equal(result.keyring.device.sessionId, 'session_test_device')
  assert.equal(result.keyring.device.sessionTokenConfigured, true)
  assert.equal(result.keyring.clientEncryption.source, 'user-vault')
  assert.equal(result.keyring.clientEncryption.configured, true)
  assert.equal(result.cloudRegistration, null)
  assert.equal(result.keyring.mode, process.platform === 'win32' ? result.keyring.mode : '0600')
  assert.equal(result.keyring.path.endsWith(path.join('keys', 'hopit-core.device.json')), true)

  const stdout = JSON.stringify(result)
  assert.equal(stdout.includes(secretSessionToken), false)
  assert.equal(stdout.includes('PRIVATE KEY'), false)
  assert.equal(stdout.includes('wrappedKey'), false)

  const keyring = await readJson(result.keyring.path)
  assert.equal(keyring.kind, 'hopit-local-device-keyring')
  assert.equal(keyring.codebaseId, 'hopit-core')
  assert.equal(keyring.credentials.agentSessionToken, secretSessionToken)
  assert.equal(keyring.userVault.wrappedKey.algorithm, 'x25519-aes-256-gcm')
  assert.equal(Object.hasOwn(keyring.userVault, 'key'), false)
  if (process.platform !== 'win32') {
    const mode = (await fs.stat(result.keyring.path)).mode & 0o777
    assert.equal(mode, 0o600)
  }
})

test('local device keyring supplies session and encryption fallback for existing commands', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('keys', [
    'init-device',
    ...stateArgs(state),
    '--codebase-id',
    'hopit-core',
    '--session-id',
    'session_test_device',
    '--device-name',
    'Test Device',
    '--session-token',
    'hst_local_secret_token',
    '--skip-cloud-registration',
  ])

  const keyStatus = JSON.parse((await runCli('keys', [
    'status',
    ...stateArgs(state),
    '--codebase-id',
    'hopit-core',
  ])).stdout)
  assert.equal(keyStatus.ok, true)
  assert.equal(keyStatus.keyring.device.sessionTokenConfigured, true)
  assert.equal(keyStatus.keyring.clientEncryption.configured, true)

  const deviceStatus = JSON.parse((await runCli('device', [
    'status',
    ...stateArgs(state),
    '--codebase-id',
    'hopit-core',
  ])).stdout)
  assert.equal(deviceStatus.session.id, 'session_test_device')
  assert.equal(deviceStatus.session.deviceName, 'Test Device')
  assert.equal(deviceStatus.credentials.sessionTokenConfigured, true)
})

test('keys export-recovery writes an encrypted recovery file and updates keyring status', async () => {
  const state = await makeState()
  await runCli('keys', [
    'init-device',
    ...stateArgs(state),
    '--codebase-id',
    'hopit-core',
    '--skip-cloud-registration',
  ])
  const output = path.join(state.root, 'recovery', 'hopit-recovery.json')
  const passphrase = 'correct horse battery staple'
  const result = JSON.parse((await runCli('keys', [
    'export-recovery',
    ...stateArgs(state),
    '--codebase-id',
    'hopit-core',
    '--output',
    output,
    '--recovery-passphrase',
    passphrase,
  ])).stdout)

  assert.equal(result.ok, true)
  assert.equal(result.recovery.encrypted, true)
  assert.equal(result.keyring.userVault.recoveryConfigured, true)
  assert.equal(JSON.stringify(result).includes(passphrase), false)

  const recovery = await readJson(output)
  assert.equal(recovery.kind, 'hopit-recovery-key')
  assert.equal(recovery.recovery.algorithm, 'pbkdf2-sha256-aes-256-gcm')
  assert.equal(JSON.stringify(recovery).includes(passphrase), false)
  if (process.platform !== 'win32') {
    const mode = (await fs.stat(output)).mode & 0o777
    assert.equal(mode, 0o600)
  }

  const keyring = await readJson(path.join(state.root, 'keys', 'hopit-core.device.json'))
  assert.equal(keyring.userVault.recoveryConfigured, true)
})

test('remote-pull applied event clears a previous skipped health state', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))

  await appendEvent(state, 'remote-pull.skipped', {
    state: 'skipped',
    reason: 'journal_has_unresolved_entries',
  })
  let status = JSON.parse((await runCli('status', [...stateArgs(state), '--remote-pull'])).stdout)
  assert.equal(status.remotePull.state, 'skipped')

  await appendEvent(state, 'remote-pull.applied', {
    state: 'applied',
    fromRevision: 1,
    toRevision: 2,
  })
  status = JSON.parse((await runCli('status', [...stateArgs(state), '--remote-pull'])).stdout)
  assert.equal(status.remotePull.state, 'enabled')
  assert.equal(status.remotePull.lastApplied.detail.toRevision, 2)
})

test('remote-pull default cooldown is five minutes', async () => {
  const state = await makeState()
  await runCli('init', [...stateArgs(state), '--force'])
  await runCli('hydrate', stateArgs(state))

  const status = JSON.parse((await runCli('status', [...stateArgs(state), '--remote-pull'])).stdout)
  assert.equal(status.remotePull.enabled, true)
  assert.equal(status.remotePull.intervalMs, 300000)
})

test('production profile refuses local JSON cloud unless an explicit cloud backend is configured or local dry-run is allowed', async () => {
  const state = await makeState()
  const failure = await runCliFailure('status', [
    '--profile',
    'production',
    '--codebase-id',
    'prod-demo',
    '--state-root',
    path.join(state.root, 'agent-state'),
    '--workspace-root',
    path.join(state.root, 'managed-workspaces'),
  ])

  assert.match(failure.stderr, /Production profile requires Cloudflare D1 or Convex backend configuration/)
})

test('service start exposes status and service stop cleans up the pid file', async (t) => {
  const state = await makeState()
  const pid = path.join(state.root, 'run', 'hopit.pid')
  const port = await getAvailablePort(t)
  if (!port) return
  const serviceArgs = [
    ...stateArgs(state),
    '--pid',
    pid,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ]

  const started = await runCli('service', ['start', ...serviceArgs])
  const startRecord = JSON.parse(started.stdout)
  assert.equal(startRecord.ok, true)
  assert.equal(startRecord.pidPath, pid)
  assert.equal(startRecord.statusUrl, `http://127.0.0.1:${port}/status`)
  assert.equal(typeof startRecord.pid, 'number')
  assert.equal(startRecord.service.ok, true)
  assert.equal(startRecord.service.running, true)
  assert.equal(startRecord.service.agent.readiness, 'ready')
  assert.equal(startRecord.service.agent.watch.state, 'watching')

  t.after(async () => {
    try {
      await runCli('service', ['stop', ...serviceArgs])
    } catch {
      // The test may already have stopped the service.
    }
  })

  const statusResult = await runCli('service', ['status', ...serviceArgs])
  const running = JSON.parse(statusResult.stdout)

  assert.equal(running.pid, startRecord.pid)
  assert.equal(running.ok, true)
  assert.equal(running.agent.readiness, 'ready')
  assert.equal(running.agent.watch.state, 'watching')
  assert.equal(running.agent.cloud.service, 'fixture-json-cloud-graph')

  const stopped = await runCli('service', ['stop', ...serviceArgs])
  const stopRecord = JSON.parse(stopped.stdout)
  assert.equal(stopRecord.ok, true)
  assert.equal(stopRecord.stoppedPid, startRecord.pid)
  assert.equal(await pathExists(pid), false)

  const afterStop = await runCli('service', ['status', ...serviceArgs])
  const stoppedStatus = JSON.parse(afterStop.stdout)
  assert.equal(stoppedStatus.running, false)
  assert.equal(stoppedStatus.ok, false)
})

test('service start fails cleanly when the status port is already occupied', async (t) => {
  const state = await makeState()
  const pid = path.join(state.root, 'run', 'hopit.pid')
  const reserved = await reserveLoopbackHttpPort(t)
  if (!reserved) return
  t.after(async () => {
    await reserved.close()
  })

  const failure = await runCliFailure('service', [
    'start',
    ...stateArgs(state),
    '--pid',
    pid,
    '--host',
    '127.0.0.1',
    '--port',
    String(reserved.port),
  ])

  assert.equal(failure.code, 1)
  assert.match(failure.stderr, /service (exited|stopped|did not become ready)|service log/i)
  assert.equal(await pathExists(pid), false)
})

test('production service start fails cleanly when Convex is not configured', async (t) => {
  const state = await makeState()
  const stateRoot = path.join(state.root, 'agent-state')
  const workspaceRoot = path.join(state.root, 'managed-workspaces')
  const pid = path.join(stateRoot, 'run', 'prod-demo.pid')
  const port = await getAvailablePort(t)
  if (!port) return

  const failure = await runCliFailure('service', [
    'start',
    '--profile',
    'production',
    '--codebase-id',
    'prod-demo',
    '--state-root',
    stateRoot,
    '--workspace-root',
    workspaceRoot,
    '--pid',
    pid,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ])

  assert.equal(failure.code, 1)
  assert.match(failure.stderr, /service (exited|stopped|did not become ready)|service log/i)
  assert.equal(await pathExists(pid), false)
})

test('two services sync local edits and hand off through explicit refresh', async (t) => {
  const { deviceA, deviceB } = await makeTwoSessionState()
  const portA = await getAvailablePort(t)
  if (!portA) return
  const portB = await getAvailablePort(t)
  if (!portB) return

  const serviceAArgs = [
    ...stateArgs(deviceA),
    '--pid',
    path.join(deviceA.root, 'device-a.pid'),
    '--host',
    '127.0.0.1',
    '--port',
    String(portA),
  ]
  const serviceBArgs = [
    ...stateArgs(deviceB),
    '--pid',
    path.join(deviceB.root, 'device-b.pid'),
    '--host',
    '127.0.0.1',
    '--port',
    String(portB),
  ]

  await runCli('init', [...stateArgs(deviceA), '--force'])
  await runCli('service', ['start', ...serviceAArgs])
  await runCli('service', ['start', ...serviceBArgs])

  t.after(async () => {
    for (const args of [serviceAArgs, serviceBArgs]) {
      try {
        await runCli('service', ['stop', ...args])
      } catch {
        // The test may already have stopped the service.
      }
    }
  })

  await waitFor(async () => {
    const result = await runCli('service', ['status', ...serviceAArgs])
    const status = JSON.parse(result.stdout)
    return status.ok && status.agent?.readiness === 'ready'
  })
  await waitFor(async () => {
    const result = await runCli('service', ['status', ...serviceBArgs])
    const status = JSON.parse(result.stdout)
    return status.ok && status.agent?.readiness === 'ready'
  })

  const initialDeviceBReadme = await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8')
  const deviceAContent = '# hopit-core\n\nLive service handoff edit from device A.\n'
  await fs.writeFile(path.join(deviceA.workspace, 'README.md'), deviceAContent, 'utf8')

  await waitFor(
    async () => {
      const cloud = await readJson(deviceA.cloud)
      return cloud.files['README.md']?.content === deviceAContent
    },
    {
      timeout: 5000,
      message: 'Timed out waiting for device A service watcher to sync.',
    },
  )

  assert.equal(await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8'), initialDeviceBReadme)

  await runCli('refresh', stateArgs(deviceB))
  assert.equal(await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8'), deviceAContent)

  const deviceBStatus = JSON.parse((await runCli('service', ['status', ...serviceBArgs])).stdout)
  assert.equal(deviceBStatus.agent.remoteUpdate.state, 'updated')
  assert.deepEqual(deviceBStatus.agent.events.lastRemoteUpdate.detail.changedPaths, ['README.md'])
})

test('remote-pull service option refreshes a clean second device automatically', async (t) => {
  const { deviceA, deviceB } = await makeTwoSessionState()
  const portA = await getAvailablePort(t)
  if (!portA) return
  const portB = await getAvailablePort(t)
  if (!portB) return

  const serviceAArgs = [
    ...stateArgs(deviceA),
    '--pid',
    path.join(deviceA.root, 'device-a-auto.pid'),
    '--host',
    '127.0.0.1',
    '--port',
    String(portA),
  ]
  const serviceBArgs = [
    ...stateArgs(deviceB),
    '--pid',
    path.join(deviceB.root, 'device-b-auto.pid'),
    '--host',
    '127.0.0.1',
    '--port',
    String(portB),
    '--remote-pull',
    '--remote-refresh-interval-ms',
    '100',
  ]

  await runCli('init', [...stateArgs(deviceA), '--force'])
  await runCli('service', ['start', ...serviceAArgs])
  await runCli('service', ['start', ...serviceBArgs])

  t.after(async () => {
    for (const args of [serviceAArgs, serviceBArgs]) {
      try {
        await runCli('service', ['stop', ...args])
      } catch {
        // The test may already have stopped the service.
      }
    }
  })

  await waitFor(async () => {
    const status = JSON.parse((await runCli('service', ['status', ...serviceBArgs])).stdout)
    return status.ok && status.agent?.remotePull?.enabled === true
  })

  const deviceAContent = '# hopit-core\n\nAutomatic remote pull edit from device A.\n'
  await fs.writeFile(path.join(deviceA.workspace, 'README.md'), deviceAContent, 'utf8')

  await waitFor(
    async () => {
      const cloud = await readJson(deviceA.cloud)
      return cloud.files['README.md']?.content === deviceAContent
    },
    {
      timeout: 5000,
      message: 'Timed out waiting for device A service watcher to sync.',
    },
  )

  await touchLocalActivityMarker(deviceB)

  await waitFor(
    async () => {
      const content = await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8')
      return content === deviceAContent
    },
    {
      timeout: 5000,
      message: 'Timed out waiting for device B remote-pull refresh.',
    },
  )

  const deviceBStatus = JSON.parse((await runCli('service', ['status', ...serviceBArgs])).stdout)
  assert.equal(deviceBStatus.agent.remotePull.enabled, true)
  assert.equal(deviceBStatus.agent.remotePull.intervalMs, 100)
  assert.equal(deviceBStatus.agent.remoteUpdate.state, 'updated')
  assert.deepEqual(deviceBStatus.agent.events.lastRemoteUpdate.detail.changedPaths, ['README.md'])
  assert.equal(deviceBStatus.agent.journal.pendingCount, 0)
  assert.equal(deviceBStatus.agent.journal.failedCount, 0)
  const cloud = await readJson(deviceA.cloud)
  assert.equal(cloud.files['.DS_Store'], undefined)
})

test('remote-pull service option skips refresh while the local journal is unresolved', async (t) => {
  const { deviceA, deviceB } = await makeTwoSessionState()
  const portA = await getAvailablePort(t)
  if (!portA) return
  const portB = await getAvailablePort(t)
  if (!portB) return

  const serviceAArgs = [
    ...stateArgs(deviceA),
    '--pid',
    path.join(deviceA.root, 'device-a-skip.pid'),
    '--host',
    '127.0.0.1',
    '--port',
    String(portA),
  ]
  const serviceBArgs = [
    ...stateArgs(deviceB),
    '--pid',
    path.join(deviceB.root, 'device-b-skip.pid'),
    '--host',
    '127.0.0.1',
    '--port',
    String(portB),
    '--remote-pull',
    '--remote-refresh-interval-ms',
    '100',
  ]

  await runCli('init', [...stateArgs(deviceA), '--force'])
  await runCli('service', ['start', ...serviceAArgs])
  await runCli('service', ['start', ...serviceBArgs])

  t.after(async () => {
    for (const args of [serviceAArgs, serviceBArgs]) {
      try {
        await runCli('service', ['stop', ...args])
      } catch {
        // The test may already have stopped the service.
      }
    }
  })

  const initialDeviceBReadme = await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8')
  await appendJournalEntry(deviceB, {
    id: randomUUID(),
    type: 'write',
    path: 'README.md',
    scope: 'shared',
    hash: hashContent('unresolved local edit\n'),
    bytes: Buffer.byteLength('unresolved local edit\n'),
    createdAt: new Date().toISOString(),
    status: 'pending',
  })

  const deviceAContent = '# hopit-core\n\nRemote pull should skip this while B is unsafe.\n'
  await fs.writeFile(path.join(deviceA.workspace, 'README.md'), deviceAContent, 'utf8')

  await waitFor(
    async () => {
      const cloud = await readJson(deviceA.cloud)
      return cloud.files['README.md']?.content === deviceAContent
    },
    {
      timeout: 5000,
      message: 'Timed out waiting for device A service watcher to sync.',
    },
  )

  await touchLocalActivityMarker(deviceB)

  const skippedStatus = await waitFor(
    async () => {
      const status = JSON.parse((await runCli('service', ['status', ...serviceBArgs])).stdout)
      return status.agent?.remotePull?.lastSkipped?.detail?.reason === 'journal_has_unresolved_entries'
        ? status
        : false
    },
    {
      timeout: 5000,
      message: 'Timed out waiting for device B remote-pull safety skip.',
    },
  )

  assert.equal(skippedStatus.agent.remotePull.state, 'skipped')
  assert.equal(skippedStatus.agent.journal.pendingCount, 1)
  assert.equal(await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8'), initialDeviceBReadme)
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

test('watch remote-pull refreshes device B when device A syncs acknowledged changes', async (t) => {
  if (await skipUnlessRefreshAvailable(t)) return

  const { deviceA, deviceB } = await makeTwoSessionState()
  await runCli('init', [...stateArgs(deviceA), '--force'])
  await runCli('hydrate', stateArgs(deviceA))

  const watchProcess = await startWatch(deviceB, t, {
    pollingWatch: true,
    extraArgs: ['--remote-pull', '--remote-refresh-interval-ms', '150'],
  })
  await waitForOutput(watchProcess, /remote-pull\.started/)
  await waitForOutput(watchProcess, /watch\.started/)

  const deviceBReadme = path.join(deviceB.workspace, 'README.md')
  const remoteContent = '# hopit-core\n\nRemote-pull edit from device A.\n'
  await fs.writeFile(path.join(deviceA.workspace, 'README.md'), remoteContent, 'utf8')
  await runCli('sync-once', stateArgs(deviceA))
  await touchLocalActivityMarker(deviceB)

  await waitFor(
    async () => {
      const content = await fs.readFile(deviceBReadme, 'utf8')
      return content === remoteContent
    },
    {
      timeout: 7000,
      message: 'Timed out waiting for device B remote-pull refresh.',
    },
  )

  const status = JSON.parse((await runCli('status', stateArgs(deviceB))).stdout)
  assert.equal(status.remoteUpdate.state, 'updated')
  assert.equal(status.refresh.state, 'healthy')
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

test('export writes a clean Git repo and omits owner-private files by default', async () => {
  const state = await makeState()
  await runCli('init', stateArgs(state))
  const output = path.join(state.root, 'git-export')

  const result = await runCli('export', [...stateArgs(state), '--output', output])
  assert.match(result.stdout, /git\.exported/)

  assert.equal(await pathExists(path.join(output, 'README.md')), true)
  assert.equal(await pathExists(path.join(output, '.private/agent-note.md')), false)
  assert.equal(await pathExists(path.join(output, '.git')), true)
  const commit = await execFileAsync('git', ['-C', output, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  assert.match(commit.stdout.trim(), /^[a-f0-9]{40}$/)
})

test('export can include owner-private files only when explicitly requested', async () => {
  const state = await makeState()
  await runCli('init', stateArgs(state))
  const output = path.join(state.root, 'private-git-export')

  await runCli('export', [...stateArgs(state), '--output', output, '--include-private'])

  assert.equal(await pathExists(path.join(output, '.private/agent-note.md')), true)
})

test('publish requires a merged change set and still omits owner-private files', async () => {
  const state = await makeState()
  await runCli('init', stateArgs(state))
  const unmergedOutput = path.join(state.root, 'unmerged-publish')

  const failure = await runCliFailure('publish', [...stateArgs(state), '--output', unmergedOutput])
  assert.match(failure.stderr, /requires the selected active change set/)

  await runCli('review-open', stateArgs(state))
  await runCli('merge', stateArgs(state))
  const output = path.join(state.root, 'merged-publish')
  await runCli('publish', [...stateArgs(state), '--output', output])

  assert.equal(await pathExists(path.join(output, 'README.md')), true)
  assert.equal(await pathExists(path.join(output, '.private/agent-note.md')), false)
})

test('export refuses to write inside the managed workspace', async () => {
  const state = await makeState()
  await runCli('init', stateArgs(state))
  await runCli('hydrate', stateArgs(state))

  const failure = await runCliFailure('export', [
    ...stateArgs(state),
    '--output',
    path.join(state.workspace, 'git-export'),
  ])

  assert.match(failure.stderr, /managed workspace/)
})

test('validate rejects graph scope mismatches that could leak .private files', async () => {
  const state = await makeState()
  await runCli('init', stateArgs(state))
  const cloud = await readJson(state.cloud)
  cloud.files['.private/agent-note.md'].scope = 'shared'
  await writeJson(state.cloud, cloud)

  const failure = await runCliFailure('validate', stateArgs(state))
  assert.match(failure.stderr, /scope mismatch/)
})

test('validate rejects plaintext secret-zone files', async () => {
  const state = await makeState()
  await runCli('init', stateArgs(state))
  const cloud = await readJson(state.cloud)
  cloud.files['.private/env/repo-root/.env.local'] = {
    kind: 'file',
    content: 'SECRET=plaintext\n',
    encoding: 'utf8',
    hash: hashBuffer('SECRET=plaintext\n'),
    size: Buffer.byteLength('SECRET=plaintext\n'),
    scope: 'owner-private',
    privacyZone: 'secrets',
    revision: 1,
    updatedAt: new Date().toISOString(),
  }
  await writeJson(state.cloud, cloud)

  const failure = await runCliFailure('validate', stateArgs(state))
  assert.match(failure.stderr, /encrypted object-backed content/)
})

test('validate rejects graph privacy zone mismatches', async () => {
  const state = await makeState()
  await runCli('init', stateArgs(state))
  const cloud = await readJson(state.cloud)
  cloud.files['.private/agent-note.md'].privacyZone = 'repo-content'
  await writeJson(state.cloud, cloud)

  const failure = await runCliFailure('validate', stateArgs(state))
  assert.match(failure.stderr, /privacy zone mismatch/)
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

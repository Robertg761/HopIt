import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { refreshWorkspace } from '../src/commands/sync.js'
import { createRemotePushClient } from '../src/remote-push.js'
import { remoteRefreshDecision } from '../src/watch.js'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(repoRoot, 'packages/agent/src/cli.js')

async function makeRemotePushState(deviceNames = ['deviceA', 'deviceB']) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-agent-remote-push-test-'))
  const cloud = path.join(root, 'cloud.json')
  const states = { root, cloud }
  for (const name of deviceNames) {
    states[name] = {
      root,
      cloud,
      workspace: path.join(root, `${name}-workspace`),
      journal: path.join(root, `${name}-journal.ndjson`),
      events: path.join(root, `${name}-events.ndjson`),
    }
  }
  return states
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

async function startWatch(state, t, extraArgs = []) {
  const child = spawn(process.execPath, [cliPath, 'watch', ...stateArgs(state), ...extraArgs], {
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
    output: () => `${stdout}\n${stderr}`,
  }
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  try {
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, { timeout: 1000 })
  } catch {
    child.kill('SIGKILL')
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, { timeout: 1000 })
  }
}

async function startPushClient(state, t, hub, extraArgs = []) {
  const options = optionsFromArgs([
    ...stateArgs(state),
    '--remote-push',
    '--remote-push-url',
    hub.url,
    ...extraArgs,
  ])
  const client = await createRemotePushClient(options, {
    localSyncIdle: () => true,
    remoteRefreshDecision,
    refreshWorkspace,
    minBackoffMs: 50,
    maxBackoffMs: 250,
  })
  t.after(() => {
    client?.close()
  })
  return client
}

function optionsFromArgs(args) {
  const options = {}
  const booleans = new Set(['remote-push', 'allow-unsafe-workspace'])
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    if (booleans.has(key)) {
      options[key] = true
      continue
    }
    options[key] = args[index + 1]
    index += 1
  }
  return options
}

async function startFakePushHub(t) {
  const connections = new Set()
  let totalConnections = 0
  let accepting = true
  const server = createServer((request, response) => {
    if (request.socket.remoteAddress !== '127.0.0.1' && request.socket.remoteAddress !== '::ffff:127.0.0.1') {
      response.writeHead(403)
      response.end()
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/events') {
      response.writeHead(404)
      response.end()
      return
    }
    if (!accepting) {
      response.writeHead(503)
      response.end()
      return
    }
    response.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    const connection = {
      response,
      query: Object.fromEntries(url.searchParams.entries()),
    }
    connections.add(connection)
    totalConnections += 1
    response.write(`${JSON.stringify({ type: 'hub.ready' })}\n`)
    request.on('close', () => {
      connections.delete(connection)
    })
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

  t.after(async () => {
    for (const connection of connections) connection.response.end()
    await new Promise((resolve) => server.close(resolve))
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : null
  assert.ok(port)

  return {
    url: `http://127.0.0.1:${port}/events`,
    publish(envelope) {
      for (const connection of connections) {
        connection.response.write(`${JSON.stringify(envelope)}\n`)
      }
    },
    disconnectAll() {
      for (const connection of [...connections]) {
        connection.response.end()
      }
    },
    connectionCount: () => totalConnections,
    activeConnectionCount: () => connections.size,
    latestQuery: () => [...connections].at(-1)?.query ?? null,
    setAccepting(value) {
      accepting = Boolean(value)
    },
    waitForConnections(count) {
      return waitFor(() => totalConnections >= count)
    },
  }
}

async function startFakeWebSocketPushHub(t) {
  if (typeof WebSocket !== 'function') {
    t.skip('global WebSocket is unavailable in this Node runtime')
    return null
  }

  const connections = new Set()
  let totalConnections = 0
  let accepting = true
  const server = createServer((request, response) => {
    response.writeHead(404)
    response.end()
  })

  server.on('upgrade', (request, socket) => {
    if (request.socket.remoteAddress !== '127.0.0.1' && request.socket.remoteAddress !== '::ffff:127.0.0.1') {
      socket.destroy()
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/events' || !accepting) {
      socket.destroy()
      return
    }
    const key = String(request.headers['sec-websocket-key'] ?? '')
    if (!key) {
      socket.destroy()
      return
    }
    const acceptKey = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '',
      '',
    ].join('\r\n'))

    const connection = {
      socket,
      query: Object.fromEntries(url.searchParams.entries()),
    }
    connections.add(connection)
    totalConnections += 1
    writeWebSocketText(socket, JSON.stringify({ type: 'hub.ready' }))
    socket.on('close', () => {
      connections.delete(connection)
    })
    socket.on('error', () => {
      connections.delete(connection)
    })
    socket.on('data', (chunk) => {
      if ((chunk[0] & 0x0f) === 0x08) socket.end()
    })
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

  t.after(async () => {
    for (const connection of connections) connection.socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : null
  assert.ok(port)

  return {
    url: `ws://127.0.0.1:${port}/events`,
    publish(envelope) {
      for (const connection of connections) {
        writeWebSocketText(connection.socket, JSON.stringify(envelope))
      }
    },
    disconnectAll() {
      for (const connection of [...connections]) {
        connection.socket.destroy()
      }
    },
    connectionCount: () => totalConnections,
    activeConnectionCount: () => connections.size,
    latestQuery: () => [...connections].at(-1)?.query ?? null,
    setAccepting(value) {
      accepting = Boolean(value)
    },
    waitForConnections(count) {
      return waitFor(() => totalConnections >= count)
    },
  }
}

function writeWebSocketText(socket, text) {
  const payload = Buffer.from(text)
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length])
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    throw new Error('Test WebSocket frame is too large.')
  }
  socket.write(Buffer.concat([header, payload]))
}

async function initAndHydratePair(deviceA, deviceB) {
  await runCli('init', [...stateArgs(deviceA), '--force'])
  await runCli('hydrate', stateArgs(deviceA))
  await runCli('hydrate', stateArgs(deviceB))
}

async function syncDeviceA(deviceA, relativePath, content) {
  const absolutePath = path.join(deviceA.workspace, relativePath)
  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  await fs.writeFile(absolutePath, content, 'utf8')
  await runCli('sync-once', stateArgs(deviceA))
  return readJson(deviceA.cloud)
}

function envelopeFromCloud(cloud, eventId = randomUUID(), changedPaths = ['README.md']) {
  return {
    type: 'codebase.remote_update',
    codebaseId: cloud.codebase.id,
    selectedStateId: cloud.selectedState.id,
    revision: cloud.revision,
    eventId,
    changedPaths,
    scopeCounts: scopeCountsForPaths(changedPaths),
  }
}

function scopeCountsForPaths(paths) {
  return {
    shared: paths.filter((entry) => !entry.startsWith('.private/')).length,
    private: paths.filter((entry) => entry.startsWith('.private/')).length,
  }
}

async function waitForOutput(watchProcess, pattern) {
  await waitFor(() => pattern.test(watchProcess.output()), {
    message: `Timed out waiting for output matching ${pattern}.`,
  })
}

async function waitFor(predicate, options = {}) {
  const timeout = options.timeout ?? 7000
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
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw lastError ?? new Error(options.message ?? `Timed out after ${timeout}ms.`)
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function readNdjson(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8')
    return content
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function appendJournalEntry(state, entry) {
  await fs.appendFile(state.journal, `${JSON.stringify(entry)}\n`, 'utf8')
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

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex')
}

test('remote-push clean device applies a pushed revision within the wait window', async (t) => {
  const hub = await startFakePushHub(t)
  if (!hub) return
  const { deviceA, deviceB } = await makeRemotePushState()
  await runCli('init', [...stateArgs(deviceA), '--force'])
  await runCli('hydrate', stateArgs(deviceA))

  const watchProcess = await startWatch(deviceB, t, ['--remote-push', '--remote-push-url', hub.url])
  await waitForOutput(watchProcess, /remote-push\.connected/)
  await hub.waitForConnections(1)
  assert.equal(hub.latestQuery()?.codebaseId, 'hopit-core')
  assert.equal(hub.latestQuery()?.selectedStateId, 'cs_demo_active')

  const remoteContent = '# hopit-core\n\nPushed remote edit from device A.\n'
  const cloud = await syncDeviceA(deviceA, 'README.md', remoteContent)
  hub.publish(envelopeFromCloud(cloud))

  await waitFor(async () => {
    return (await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8')) === remoteContent
  })

  const status = JSON.parse((await runCli('status', [...stateArgs(deviceB), '--remote-push'])).stdout)
  assert.equal(status.remotePush.state, 'push-applied')
  assert.equal(status.remotePush.lastPushedRevision, cloud.revision)
  assert.equal(status.remotePush.lastAppliedRevision, cloud.revision)
})

test('remote-push watcher periodically reconciles an idle clean device after a missed push', async (t) => {
  const hub = await startFakePushHub(t)
  if (!hub) return
  const { deviceA, deviceB } = await makeRemotePushState()
  await initAndHydratePair(deviceA, deviceB)

  const watchProcess = await startWatch(deviceB, t, [
    '--remote-push',
    '--remote-push-url',
    hub.url,
    '--remote-refresh-interval-ms',
    '100',
  ])
  await waitForOutput(watchProcess, /remote-push\.connected/)
  await waitForOutput(watchProcess, /periodic-head-reconciliation/)
  await hub.waitForConnections(1)

  const missedContent = '# hopit-core\n\nMissed push recovered by an idle safety check.\n'
  const cloud = await syncDeviceA(deviceA, 'README.md', missedContent)
  // Deliberately do not publish an envelope and do not touch device B.

  await waitFor(async () => {
    return (await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8')) === missedContent
  })

  const events = await readNdjson(deviceB.events)
  const reconciliation = events.findLast((event) => event.event === 'remote-pull.applied')
  assert.equal(reconciliation.detail.trigger, 'periodic-head-reconciliation')
  assert.equal(reconciliation.detail.toRevision, cloud.revision)
  assert.equal(events.some((event) => event.event === 'remote-push.applied'), false)

  const status = JSON.parse((await runCli('status', [
    ...stateArgs(deviceB),
    '--remote-push',
    '--remote-push-url',
    hub.url,
    '--remote-refresh-interval-ms',
    '100',
  ])).stdout)
  assert.equal(status.remotePull.enabled, true)
  assert.equal(status.remotePull.pushReconciliationEnabled, true)
  assert.equal(status.remotePush.connectionState, 'connected')
  assert.equal(status.remotePush.lastAppliedRevision, cloud.revision)
})

test('remote-push skips a pending-journal device without changing disk files', async (t) => {
  const hub = await startFakePushHub(t)
  if (!hub) return
  const { deviceA, deviceB } = await makeRemotePushState()
  await initAndHydratePair(deviceA, deviceB)
  await startPushClient(deviceB, t, hub)
  await hub.waitForConnections(1)

  const original = await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8')
  await appendJournalEntry(deviceB, {
    id: randomUUID(),
    type: 'write',
    path: 'README.md',
    scope: 'shared',
    hash: hashContent('pending local edit\n'),
    bytes: Buffer.byteLength('pending local edit\n'),
    createdAt: new Date().toISOString(),
    status: 'pending',
  })

  const cloud = await syncDeviceA(deviceA, 'README.md', '# hopit-core\n\nShould not overwrite pending journal.\n')
  hub.publish(envelopeFromCloud(cloud))

  const skipped = await waitFor(async () => {
    const events = await readNdjson(deviceB.events)
    return events.findLast((event) => event.event === 'remote-push.skipped')
  })
  assert.equal(skipped.detail.reason, 'journal_has_unresolved_entries')
  assert.equal(await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8'), original)
  const status = JSON.parse((await runCli('status', [...stateArgs(deviceB), '--remote-push'])).stdout)
  assert.equal(status.remotePush.connectionState, 'connected')
  assert.equal(status.remotePush.lastSkippedReason, 'journal_has_unresolved_entries')
  assert.equal(status.remotePush.lastError, 'journal_has_unresolved_entries')
})

test('remote-push skips manifest drift without changing disk files', async (t) => {
  const hub = await startFakePushHub(t)
  if (!hub) return
  const { deviceA, deviceB } = await makeRemotePushState()
  await initAndHydratePair(deviceA, deviceB)

  const localDraft = '# hopit-core\n\nLocal drift that must survive.\n'
  await fs.writeFile(path.join(deviceB.workspace, 'README.md'), localDraft, 'utf8')
  await startPushClient(deviceB, t, hub)
  await hub.waitForConnections(1)

  const cloud = await syncDeviceA(deviceA, 'README.md', '# hopit-core\n\nRemote drift test update.\n')
  hub.publish(envelopeFromCloud(cloud))

  const skipped = await waitFor(async () => {
    const events = await readNdjson(deviceB.events)
    return events.findLast((event) => event.event === 'remote-push.skipped')
  })
  assert.equal(skipped.detail.reason, 'workspace_has_unjournaled_changes')
  assert.equal(await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8'), localDraft)
  const status = JSON.parse((await runCli('status', [...stateArgs(deviceB), '--remote-push'])).stdout)
  assert.equal(status.remotePush.lastSkippedReason, 'workspace_has_unjournaled_changes')
})

test('remote-push duplicate envelope for one revision is idempotent', async (t) => {
  const hub = await startFakePushHub(t)
  if (!hub) return
  const { deviceA, deviceB } = await makeRemotePushState()
  await initAndHydratePair(deviceA, deviceB)
  await startPushClient(deviceB, t, hub)
  await hub.waitForConnections(1)

  const remoteContent = '# hopit-core\n\nDuplicate event should apply once.\n'
  const cloud = await syncDeviceA(deviceA, 'README.md', remoteContent)
  const envelope = envelopeFromCloud(cloud, 'evt_duplicate_revision')
  hub.publish(envelope)
  hub.publish(envelope)

  await waitFor(async () => {
    return (await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8')) === remoteContent
  })
  await new Promise((resolve) => setTimeout(resolve, 150))
  const appliedEvents = (await readNdjson(deviceB.events)).filter((event) => event.event === 'remote-push.applied')
  assert.equal(appliedEvents.length, 1)
})

test('remote-push out-of-order revision hints converge to the newest graph state', async (t) => {
  const hub = await startFakePushHub(t)
  if (!hub) return
  const { deviceA, deviceB } = await makeRemotePushState()
  await initAndHydratePair(deviceA, deviceB)
  await startPushClient(deviceB, t, hub)
  await hub.waitForConnections(1)

  const olderContent = '# hopit-core\n\nOlder pushed revision.\n'
  const olderCloud = await syncDeviceA(deviceA, 'README.md', olderContent)
  const olderEnvelope = envelopeFromCloud(olderCloud, 'evt_revision_older')
  const newerContent = '# hopit-core\n\nNewest pushed revision wins.\n'
  const newerCloud = await syncDeviceA(deviceA, 'README.md', newerContent)
  const newerEnvelope = envelopeFromCloud(newerCloud, 'evt_revision_newer')

  hub.publish(newerEnvelope)
  hub.publish(olderEnvelope)

  await waitFor(async () => {
    return (await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8')) === newerContent
  })
  const status = JSON.parse((await runCli('status', [...stateArgs(deviceB), '--remote-push'])).stdout)
  assert.equal(status.workspace.hydration.lastMaterializedRevision, newerCloud.revision)
  assert.equal(status.remotePush.lastAppliedRevision, newerCloud.revision)
})

test('remote-push reconnect runs fallback head poll and catches a missed revision', async (t) => {
  const hub = await startFakePushHub(t)
  if (!hub) return
  const { deviceA, deviceB } = await makeRemotePushState()
  await initAndHydratePair(deviceA, deviceB)
  await startPushClient(deviceB, t, hub)
  await hub.waitForConnections(1)
  hub.setAccepting(false)
  hub.disconnectAll()

  const missedContent = '# hopit-core\n\nMissed while disconnected, caught by fallback.\n'
  await syncDeviceA(deviceA, 'README.md', missedContent)
  hub.setAccepting(true)

  await hub.waitForConnections(2)
  await waitFor(async () => {
    return (await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8')) === missedContent
  })
  const applied = await waitFor(async () => {
    const events = await readNdjson(deviceB.events)
    return events.findLast((event) => event.event === 'remote-push.applied')
  })
  const events = await readNdjson(deviceB.events)
  assert.ok(events.find((event) => event.event === 'remote-push.fallback_polling'))
  assert.equal(applied.detail.trigger, 'remote-push-fallback')
})

test('remote-push WebSocket transport applies a pushed revision', async (t) => {
  const hub = await startFakeWebSocketPushHub(t)
  if (!hub) return
  const { deviceA, deviceB } = await makeRemotePushState()
  await initAndHydratePair(deviceA, deviceB)
  await startPushClient(deviceB, t, hub)
  await hub.waitForConnections(1)
  assert.equal(hub.latestQuery()?.codebaseId, 'hopit-core')
  assert.equal(hub.latestQuery()?.selectedStateId, 'cs_demo_active')

  const remoteContent = '# hopit-core\n\nWebSocket pushed remote edit.\n'
  const cloud = await syncDeviceA(deviceA, 'README.md', remoteContent)
  hub.publish(envelopeFromCloud(cloud, 'evt_websocket_apply'))

  await waitFor(async () => {
    return (await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8')) === remoteContent
  })
  const status = JSON.parse((await runCli('status', [...stateArgs(deviceB), '--remote-push'])).stdout)
  assert.equal(status.remotePush.state, 'push-applied')
  assert.equal(status.remotePush.lastPushedRevision, cloud.revision)
})

test('remote-push WebSocket reconnect runs fallback head poll after a missed revision', async (t) => {
  const hub = await startFakeWebSocketPushHub(t)
  if (!hub) return
  const { deviceA, deviceB } = await makeRemotePushState()
  await initAndHydratePair(deviceA, deviceB)
  await startPushClient(deviceB, t, hub)
  await hub.waitForConnections(1)
  hub.setAccepting(false)
  hub.disconnectAll()

  const missedContent = '# hopit-core\n\nWebSocket missed while disconnected, caught by fallback.\n'
  await syncDeviceA(deviceA, 'README.md', missedContent)
  hub.setAccepting(true)

  await hub.waitForConnections(2)
  await waitFor(async () => {
    return (await fs.readFile(path.join(deviceB.workspace, 'README.md'), 'utf8')) === missedContent
  })
  const applied = await waitFor(async () => {
    const events = await readNdjson(deviceB.events)
    return events.findLast((event) => event.event === 'remote-push.applied')
  })
  assert.equal(applied.detail.trigger, 'remote-push-fallback')
})

test('remote-push metadata-only device records pushed revision without hydrating bodies', async (t) => {
  const hub = await startFakePushHub(t)
  if (!hub) return
  const { deviceA, deviceB } = await makeRemotePushState()
  await initAndHydratePair(deviceA, deviceB)
  await runCli('workspace', ['dehydrate', ...stateArgs(deviceB), '--force'])
  assert.equal(await pathExists(path.join(deviceB.workspace, 'README.md')), false)
  await startPushClient(deviceB, t, hub)
  await hub.waitForConnections(1)

  const cloud = await syncDeviceA(deviceA, 'README.md', '# hopit-core\n\nMetadata-only push hint.\n')
  hub.publish(envelopeFromCloud(cloud))

  await waitFor(async () => {
    const status = JSON.parse((await runCli('status', [...stateArgs(deviceB), '--remote-push'])).stdout)
    return status.remotePush.lastPushedRevision === cloud.revision ? status : false
  })
  const status = JSON.parse((await runCli('status', [...stateArgs(deviceB), '--remote-push'])).stdout)
  assert.equal(status.remotePush.state, 'push-skipped')
  assert.equal(status.remotePush.lastError, 'workspace_not_fully_materialized')
  assert.equal(status.remotePush.lastPushedRevision, cloud.revision)
  assert.equal(status.workspace.hydration.state, 'metadata-only')
  assert.equal(await pathExists(path.join(deviceB.workspace, 'README.md')), false)
})

test('remote-push applies same-owner private updates and keeps them hidden from collaborator requester', async (t) => {
  const hub = await startFakePushHub(t)
  if (!hub) return
  const { deviceA, ownerDeviceB, collaboratorDeviceC } = await makeRemotePushState([
    'deviceA',
    'ownerDeviceB',
    'collaboratorDeviceC',
  ])
  await runCli('init', [...stateArgs(deviceA), '--force'])
  await setChangeSetVisibility(deviceA, 'team-visible')
  await runCli('hydrate', stateArgs(deviceA))
  await runCli('hydrate', stateArgs(ownerDeviceB))
  const collaboratorArgs = [
    ...stateArgs(collaboratorDeviceC),
    '--requester-id',
    'user_demo_collaborator',
    '--session-id',
    'session_demo_collaborator',
  ]
  await runCli('hydrate', collaboratorArgs)
  assert.equal(await pathExists(path.join(collaboratorDeviceC.workspace, '.private/agent-note.md')), false)

  await startPushClient(ownerDeviceB, t, hub)
  await startPushClient(collaboratorDeviceC, t, hub, [
    '--requester-id',
    'user_demo_collaborator',
    '--session-id',
    'session_demo_collaborator',
  ])
  await hub.waitForConnections(2)

  const privateContent = '# Owner notes\n\nPrivate pushed owner update.\n'
  const cloud = await syncDeviceA(deviceA, '.private/agent-note.md', privateContent)
  hub.publish(envelopeFromCloud(cloud, randomUUID(), ['.private/agent-note.md']))

  await waitFor(async () => {
    return (await fs.readFile(path.join(ownerDeviceB.workspace, '.private/agent-note.md'), 'utf8')) === privateContent
  })
  await waitFor(async () => {
    const status = JSON.parse((await runCli('status', [...collaboratorArgs, '--remote-push'])).stdout)
    return status.remotePush.lastAppliedRevision === cloud.revision ? status : false
  })

  assert.equal(await pathExists(path.join(collaboratorDeviceC.workspace, '.private/agent-note.md')), false)
  const collaboratorStatus = JSON.parse((await runCli('status', [...collaboratorArgs, '--remote-push'])).stdout)
  assert.equal(collaboratorStatus.requesterRole, 'member')
  assert.deepEqual(collaboratorStatus.hiddenScopeCounts, { shared: 0, private: 1 })
  assert.equal(collaboratorStatus.remotePush.state, 'push-applied')
})

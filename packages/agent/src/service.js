// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import { serviceReadyTimeoutMs, serviceStatusFetchTimeoutMs } from './constants.js'
import { agentSessionTokenFromOptions, readJson, sendJson, writeJson } from './io.js'
import { assertWorkspacePathSafe, remotePullEnabled, remotePushEnabled } from './paths.js'
import { readAgentCloudEndpoint, readAgentEventsEndpoint, readAgentJournalEndpoint, readAgentStatusEndpoint } from './status-endpoints.js'
import { watchWorkspace } from './watch.js'
import { spawn } from 'node:child_process'
import { existsSync, watch } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const defaultCliEntrypoint = fileURLToPath(new URL('./cli.js', import.meta.url))

export async function serveStatus(options) {
  const host = options.host
  const port = Number(options.port)

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port value: ${options.port}`)
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host ?? `${host}:${port}`}`)

      if (url.pathname === '/' || url.pathname === '/status') {
        sendJson(response, 200, await readAgentStatusEndpoint(options))
        return
      }

      if (url.pathname === '/events') {
        sendJson(response, 200, await readAgentEventsEndpoint(options))
        return
      }

      if (url.pathname === '/journal') {
        sendJson(response, 200, await readAgentJournalEndpoint(options))
        return
      }

      if (url.pathname === '/cloud') {
        sendJson(response, 200, await readAgentCloudEndpoint(options))
        return
      }

      sendJson(response, 404, {
        error: 'not_found',
        endpoints: ['/', '/status', '/events', '/journal', '/cloud'],
      })
    } catch (error) {
      sendJson(response, 500, {
        error: 'status_server_error',
        message: error.message,
      })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  console.log(`HopIt agent status server listening on http://${host}:${port}`)
  console.log('Endpoints: /status, /events, /journal, /cloud')

  return server
}

export async function runServiceCommand(action, options) {
  if (action === 'start') {
    await startService(options)
    return
  }
  if (action === 'stop') {
    await stopService(options)
    return
  }
  if (action === 'restart') {
    await stopService(options, { missingOk: true })
    await startService(options)
    return
  }
  if (action === 'run') {
    await runServiceProcess(options)
    return
  }
  if (action === 'status') {
    console.log(JSON.stringify(await serviceStatus(options), null, 2))
    return
  }

  throw new Error(`Unknown service action: ${action}`)
}

export async function runServiceProcess(options) {
  let statusServer = null
  let watchHandle = null
  let resolveShutdown = null
  const shutdown = new Promise((resolve) => {
    resolveShutdown = resolve
  })
  const requestShutdown = () => {
    resolveShutdown?.()
  }

  try {
    statusServer = await serveStatus(options)
    watchHandle = await watchWorkspace(options)
    process.once('SIGTERM', requestShutdown)
    process.once('SIGINT', requestShutdown)
    await shutdown
  } catch (error) {
    throw error
  } finally {
    process.off('SIGTERM', requestShutdown)
    process.off('SIGINT', requestShutdown)
    watchHandle?.close()
    statusServer?.close()
  }
}

export async function startService(options) {
  await assertWorkspacePathSafe(options)
  const existing = await serviceStatus(options)
  if (existing.running) {
    throw new Error(`HopIt service is already running with pid ${existing.pid}.`)
  }

  const pidPath = path.resolve(options.pid)
  await fs.mkdir(path.dirname(pidPath), { recursive: true })
  const logPath = path.join(path.dirname(pidPath), `${options['codebase-id'] ?? 'hopit'}.log`)
  const logStartOffset = existsSync(logPath) ? (await fs.stat(logPath)).size : 0
  const logHandle = await fs.open(logPath, 'a')
  const childEnv = {
    ...process.env,
  }
  if (options['cloud-backend']) childEnv.HOPIT_CLOUD_BACKEND = options['cloud-backend']
  if (options['d1-api-base-url']) childEnv.HOPIT_D1_API_BASE_URL = options['d1-api-base-url']
  if (options['codebase-id']) childEnv.HOPIT_CODEBASE_ID = options['codebase-id']
  if (options['workspace-root']) childEnv.HOPIT_WORKSPACE_ROOT = options['workspace-root']
  if (options['workspace-index']) childEnv.HOPIT_WORKSPACE_INDEX = options['workspace-index']
  if (options['state-root']) childEnv.HOPIT_AGENT_STATE_ROOT = options['state-root']
  if (options['device-keys']) childEnv.HOPIT_DEVICE_KEYS_PATH = options['device-keys']
  const sessionToken = agentSessionTokenFromOptions(options)
  if (sessionToken) childEnv.HOPIT_AGENT_SESSION_TOKEN = sessionToken
  if (options['session-id']) childEnv.HOPIT_SESSION_ID = options['session-id']
  if (options['device-name']) childEnv.HOPIT_DEVICE_NAME = options['device-name']
  if (options.capabilities) childEnv.HOPIT_AGENT_SESSION_CAPABILITIES = options.capabilities

  const child = spawn(process.execPath, [serviceEntrypoint(), 'service-run', ...runtimeArgsFromOptions(options)], {
    cwd: process.cwd(),
    detached: true,
    env: childEnv,
    stdio: ['ignore', logHandle.fd, logHandle.fd],
  })
  child.unref()
  await logHandle.close()

  const record = {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    codebaseId: options['codebase-id'] ?? null,
    workspace: path.resolve(options.workspace),
    statusUrl: `http://${options.host}:${options.port}/status`,
    logPath,
    logStartOffset,
  }
  await writeJson(pidPath, record)
  try {
    const status = await waitForServiceReady(options, {
      child,
      logPath,
      pidPath,
      startedAt: record.startedAt,
    })
    const result = { ok: true, ...record, pidPath, service: status }
    if (!options.quiet) console.log(JSON.stringify(result, null, 2))
    return result
  } catch (error) {
    if (typeof child.pid === 'number' && isProcessRunning(child.pid)) {
      process.kill(child.pid, 'SIGTERM')
      await waitForProcessExit(child.pid, 2500)
    }
    await fs.rm(pidPath, { force: true })
    throw error
  }
}

export function serviceEntrypoint() {
  return process.argv[1] ? path.resolve(process.argv[1]) : defaultCliEntrypoint
}

export async function waitForServiceReady(options, waitOptions) {
  const timeoutMs = waitOptions.timeoutMs ?? serviceReadyTimeoutMs
  const startedAt = Date.now()
  let lastStatus = null

  while (Date.now() - startedAt < timeoutMs) {
    if (waitOptions.child.exitCode !== null || waitOptions.child.signalCode !== null) {
      throw new Error(
        `HopIt service exited before it became ready. Check the service log at ${waitOptions.logPath}.`,
      )
    }

    lastStatus = await serviceStatus(options)
    if (
      lastStatus.ok &&
      lastStatus.running &&
      lastStatus.agent?.ok === true &&
      lastStatus.agent?.readiness === 'ready' &&
      serviceWatchReady(lastStatus.agent?.watch?.state) &&
      agentWatchStartedAfter(lastStatus.agent, waitOptions.startedAt)
    ) {
      return lastStatus
    }

    if (lastStatus.pid && !lastStatus.running) {
      throw new Error(
        `HopIt service stopped before it became ready. Check the service log at ${waitOptions.logPath}.`,
      )
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error(
    `HopIt service did not become ready within ${timeoutMs}ms. Check the service log at ${
      waitOptions.logPath
    }. Last status: ${JSON.stringify(lastStatus)}`,
  )
}

export function serviceWatchReady(state) {
  return state === 'watching' || state === 'polling-degraded'
}

export async function stopService(options, stopOptions = {}) {
  const pidPath = path.resolve(options.pid)
  const record = await readServiceRecord(pidPath)
  if (!record?.pid) {
    if (stopOptions.missingOk) return
    throw new Error(`No HopIt service pid file found at ${pidPath}.`)
  }

  if (isProcessRunning(record.pid)) {
    process.kill(record.pid, 'SIGTERM')
    await waitForProcessExit(record.pid, 2500)
  }
  await fs.rm(pidPath, { force: true })
  console.log(JSON.stringify({ ok: true, stoppedPid: record.pid, pidPath }, null, 2))
}

export async function serviceStatus(options) {
  const pidPath = path.resolve(options.pid)
  const record = await readServiceRecord(pidPath)
  const pid = record?.pid ?? null
  const processRunning = typeof pid === 'number' && isProcessRunning(pid)
  let agent = null
  let error = null
  let fresh = false
  let endpointReachable = false

  let timeout
  try {
    const controller = new AbortController()
    timeout = setTimeout(() => controller.abort(), serviceStatusFetchTimeoutMs)
    const response = await fetch(`http://${options.host}:${options.port}/status`, {
      cache: 'no-store',
      signal: controller.signal,
    })
    endpointReachable = response.ok
    agent = response.ok ? await response.json() : null
    if (!response.ok) error = `status endpoint returned ${response.status}`
    fresh = record?.startedAt ? agentWatchStartedAfter(agent, record.startedAt) : true
    if (agent && !fresh) error = 'status endpoint has not observed this service start yet'
    const expectedCodebaseId = options['codebase-id'] ?? null
    if (agent && expectedCodebaseId && agent.codebaseId !== expectedCodebaseId) {
      error = `status endpoint is serving codebase ${agent.codebaseId ?? '(unknown)'}, expected ${expectedCodebaseId}`
    }
  } catch (statusError) {
    if (processRunning) {
      error = statusError instanceof Error ? statusError.message : 'status endpoint unavailable'
    }
  } finally {
    if (timeout) clearTimeout(timeout)
  }

  if (processRunning && (!agent || error || !fresh)) {
    const logAgent = await readServiceLogAgent(record)
    if (logAgent) {
      agent = agent ? { ...logAgent, ...agent, watch: agent.watch ?? logAgent.watch } : logAgent
      error = null
      fresh = true
    }
  }

  // A healthy loopback /status response proves the service is alive even when
  // no pid file exists (e.g. launchd owns the `service run` process directly).
  // Only trust the probe when we can positively confirm it serves the expected
  // codebase, so an unrelated service on the same host:port cannot masquerade as
  // this one. The production profile always sets a codebase-id, so the launchd
  // path is covered; without an expected codebase-id we fall back to the pid
  // file rather than guessing.
  const expectedCodebaseId = options['codebase-id'] ?? null
  const probeHealthy =
    endpointReachable &&
    agent?.ok !== false &&
    !error &&
    fresh &&
    Boolean(expectedCodebaseId) &&
    agent?.codebaseId === expectedCodebaseId
  const running = processRunning || probeHealthy
  const source = processRunning ? 'pid-file' : probeHealthy ? 'health-probe' : null
  return {
    ok: running && !error && fresh && agent?.ok !== false,
    running,
    source,
    pid,
    pidPath,
    statusUrl: `http://${options.host}:${options.port}/status`,
    record,
    agent,
    error,
  }
}

export async function readServiceLogAgent(record) {
  if (!record?.logPath || typeof record.pid !== 'number') return null

  let content
  try {
    content = await fs.readFile(record.logPath, 'utf8')
  } catch {
    return null
  }

  const offset = Number.isSafeInteger(record.logStartOffset) ? record.logStartOffset : 0
  const serviceLog = content.slice(offset)
  const hasWatchStarted = serviceLog
    .split(/\n/)
    .some((line) => line.startsWith('watch.started '))
  if (!hasWatchStarted) return null

  return {
    ok: true,
    readiness: 'ready',
    codebaseId: record.codebaseId ?? null,
    workspace: {
      path: record.workspace ?? null,
    },
    watch: {
      state: 'watching',
      lastStarted: {
        at: record.startedAt ?? null,
        source: 'service-log',
      },
    },
    statusSource: 'service-log',
  }
}

export function agentWatchStartedAfter(agent, startedAt) {
  if (!startedAt) return true
  const watchStartedAt = agent?.events?.lastWatchStarted?.at ?? agent?.watch?.lastStarted?.at
  if (!watchStartedAt) return false
  return isTimestampAtOrAfter(watchStartedAt, startedAt)
}

export function isTimestampAtOrAfter(value, reference) {
  const time = Date.parse(value)
  const referenceTime = Date.parse(reference)
  if (Number.isNaN(time) || Number.isNaN(referenceTime)) return false
  return time >= referenceTime
}

export async function readServiceRecord(pidPath) {
  if (!existsSync(pidPath)) return null
  return readJson(pidPath)
}

export function isProcessRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function waitForProcessExit(pid, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessRunning(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

export function runtimeArgsFromOptions(options) {
  const entries = [
    ['--profile', options.profile],
    ['--codebase-id', options['codebase-id']],
    ['--cloud', options.cloud],
    ['--workspace', options.workspace],
    ['--journal', options.journal],
    ['--events', options.events],
    ['--pid', options.pid],
    ['--host', options.host],
    ['--port', options.port],
    ['--state-root', options['state-root']],
    ['--workspace-root', options['workspace-root']],
    ['--workspace-index', options['workspace-index']],
    ['--requester-id', options['requester-id']],
    ['--session-id', options['session-id']],
    ['--device-name', options['device-name']],
  ]
  const args = []
  for (const [name, value] of entries) {
    if (!value) continue
    args.push(name, value)
  }
  if (remotePullEnabled(options)) {
    args.push('--remote-pull')
  }
  if (remotePushEnabled(options)) {
    args.push('--remote-push')
  }
  if (options['remote-push-url']) {
    args.push('--remote-push-url', options['remote-push-url'])
  }
  if (options['auto-prune']) {
    args.push('--auto-prune')
  }
  if (options['auto-prune-interval-ms']) {
    args.push('--auto-prune-interval-ms', options['auto-prune-interval-ms'])
  }
  if (options['auto-prune-inactive-ms']) {
    args.push('--auto-prune-inactive-ms', options['auto-prune-inactive-ms'])
  }
  if (options['remote-pull-cooldown-ms']) {
    args.push('--remote-pull-cooldown-ms', options['remote-pull-cooldown-ms'])
  } else if (options['remote-refresh-interval-ms']) {
    args.push('--remote-refresh-interval-ms', options['remote-refresh-interval-ms'])
  }
  if (options['allow-local-cloud']) {
    args.push('--allow-local-cloud')
  }
  if (options['allow-unsafe-workspace']) {
    args.push('--allow-unsafe-workspace')
  }
  return args
}

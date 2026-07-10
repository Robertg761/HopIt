import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { serviceStatus } from '../src/service.js'

/**
 * Starts a loopback /status endpoint that answers with the supplied agent
 * payload, mimicking a live `service run` process. Returns the bound port and a
 * closer.
 */
async function startStatusEndpoint(agentPayload) {
  const server = createServer((request, response) => {
    if (request.url === '/status' || request.url === '/') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(agentPayload))
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { port } = server.address()
  return {
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function healthyAgent(overrides = {}) {
  return {
    ok: true,
    readiness: 'ready',
    codebaseId: 'hopit-core',
    watch: { state: 'watching', lastStarted: { at: new Date().toISOString() } },
    ...overrides,
  }
}

async function makePidPath() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-service-status-test-'))
  return path.join(root, 'hopit.pid')
}

test('serviceStatus reports running via the pid file when the process is alive', async (t) => {
  const endpoint = await startStatusEndpoint(healthyAgent())
  t.after(() => endpoint.close())

  const pidPath = await makePidPath()
  await fs.writeFile(
    pidPath,
    JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 1000).toISOString() }),
  )

  const status = await serviceStatus({ host: '127.0.0.1', port: String(endpoint.port), pid: pidPath })

  assert.equal(status.running, true)
  assert.equal(status.source, 'pid-file')
  assert.equal(status.pid, process.pid)
  assert.equal(status.ok, true)
})

test('serviceStatus reports running via the health probe when launchd owns the process (no pid file)', async (t) => {
  const endpoint = await startStatusEndpoint(healthyAgent())
  t.after(() => endpoint.close())

  // No pid file is written: this models launchd starting `service run` directly.
  // The production profile always resolves a codebase-id, which lets the probe
  // confirm the endpoint is serving this service.
  const pidPath = await makePidPath()

  const status = await serviceStatus({
    host: '127.0.0.1',
    port: String(endpoint.port),
    pid: pidPath,
    'codebase-id': 'hopit-core',
  })

  assert.equal(status.running, true)
  assert.equal(status.source, 'health-probe')
  assert.equal(status.pid, null)
  assert.equal(status.ok, true)
})

test('serviceStatus does not trust a probe it cannot identify (no expected codebase-id)', async (t) => {
  const endpoint = await startStatusEndpoint(healthyAgent())
  t.after(() => endpoint.close())

  const pidPath = await makePidPath()

  // Without an expected codebase-id we cannot confirm the endpoint is ours, so
  // we fall back to the pid file rather than reporting a foreign service.
  const status = await serviceStatus({ host: '127.0.0.1', port: String(endpoint.port), pid: pidPath })

  assert.equal(status.running, false)
  assert.equal(status.source, null)
})

test('serviceStatus reports not running when there is no pid file and the probe is unreachable', async (t) => {
  // Bind and immediately release a port so nothing is listening on it.
  const endpoint = await startStatusEndpoint(healthyAgent())
  const deadPort = endpoint.port
  await endpoint.close()

  const pidPath = await makePidPath()

  const status = await serviceStatus({ host: '127.0.0.1', port: String(deadPort), pid: pidPath })

  assert.equal(status.running, false)
  assert.equal(status.source, null)
  assert.equal(status.pid, null)
  assert.equal(status.ok, false)
})

test('serviceStatus ignores a probe that serves a different codebase (no false positive)', async (t) => {
  const endpoint = await startStatusEndpoint(healthyAgent({ codebaseId: 'other-codebase' }))
  t.after(() => endpoint.close())

  const pidPath = await makePidPath()

  const status = await serviceStatus({
    host: '127.0.0.1',
    port: String(endpoint.port),
    pid: pidPath,
    'codebase-id': 'expected-codebase',
  })

  assert.equal(status.running, false)
  assert.equal(status.source, null)
  assert.ok(status.error)
})

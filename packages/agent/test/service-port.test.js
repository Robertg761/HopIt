import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { writeLaunchAgent } from '../src/commands/install.js'
import { baseServicePort, deriveServicePort, parseOptions } from '../src/options.js'

/**
 * Runs a synchronous body with the port/codebase env overrides cleared so the
 * derivation is exercised deterministically regardless of the caller's shell.
 */
function withCleanEnv(run) {
  const keys = ['HOPIT_CODEBASE_ID', 'HOPIT_AGENT_PORT', 'HOPIT_PORT', 'HOPIT_PROFILE']
  const saved = new Map()
  for (const key of keys) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  try {
    return run()
  } finally {
    for (const key of keys) {
      const value = saved.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('deriveServicePort keeps the base 4785 port for the default hopit codebase', () => {
  assert.equal(baseServicePort, 4785)
  assert.equal(deriveServicePort('hopit'), 4785)
  assert.equal(deriveServicePort(null), 4785)
  assert.equal(deriveServicePort(undefined), 4785)
})

test('deriveServicePort is stable and differs from 4785 for a non-default codebase', () => {
  const first = deriveServicePort('Projects')
  const second = deriveServicePort('Projects')
  assert.equal(first, second, 'expected the same codebase id to resolve the same port')
  assert.notEqual(first, baseServicePort, 'expected a non-default codebase to avoid the base port')
  assert.ok(
    first > baseServicePort && first <= baseServicePort + 1000,
    `expected derived port ${first} within (${baseServicePort}, ${baseServicePort + 1000}]`,
  )
  assert.notEqual(
    deriveServicePort('Projects'),
    deriveServicePort('hopit'),
    'expected a non-default codebase to diverge from the default codebase port',
  )
})

test('parseOptions derives a non-default port for a non-default codebase', () => {
  withCleanEnv(() => {
    const options = parseOptions(['--codebase-id', 'Projects'])
    assert.equal(options.port, String(deriveServicePort('Projects')))
    assert.notEqual(options.port, '4785')
  })
})

test('parseOptions keeps 4785 for the default codebase', () => {
  withCleanEnv(() => {
    const options = parseOptions([])
    assert.equal(options.port, '4785')
  })
})

test('explicit --port overrides the derived per-codebase port', () => {
  withCleanEnv(() => {
    const options = parseOptions(['--codebase-id', 'Projects', '--port', '5999'])
    assert.equal(options.port, '5999')
  })
})

test('HOPIT_AGENT_PORT env overrides the derived port when --port is absent', () => {
  withCleanEnv(() => {
    process.env.HOPIT_AGENT_PORT = '6100'
    const options = parseOptions(['--codebase-id', 'Projects'])
    assert.equal(options.port, '6100')
  })
})

test('writeLaunchAgent embeds the resolved --port in the plist arguments', {
  skip: process.platform !== 'darwin' ? 'writeLaunchAgent supports macOS launchd only' : false,
}, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-launch-agent-test-'))
  const originalHome = process.env.HOME
  const originalAgentPort = process.env.HOPIT_AGENT_PORT
  process.env.HOME = home
  delete process.env.HOPIT_AGENT_PORT
  t.after(async () => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalAgentPort === undefined) delete process.env.HOPIT_AGENT_PORT
    else process.env.HOPIT_AGENT_PORT = originalAgentPort
    await fs.rm(home, { recursive: true, force: true })
  })

  const options = parseOptions([
    '--profile', 'production',
    '--codebase-id', 'Projects',
    '--state-root', path.join(home, 'state'),
    '--workspace-root', path.join(home, 'workspaces'),
  ])
  const expectedPort = String(deriveServicePort('Projects'))
  assert.equal(options.port, expectedPort)

  const result = await writeLaunchAgent(options)
  const plist = await fs.readFile(result.plistPath, 'utf8')
  assert.ok(plist.includes('--port'), 'expected the plist to include a --port argument')
  assert.ok(plist.includes(expectedPort), `expected the plist to embed the derived port ${expectedPort}`)
  assert.ok(plist.includes('com.hopit.agent.Projects'), 'expected the codebase-scoped launchd label')
})

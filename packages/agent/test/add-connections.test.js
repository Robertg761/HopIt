import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

let gitAvailable
async function skipUnlessGit(t) {
  if (gitAvailable === undefined) {
    try {
      await execFileAsync('git', ['--version'])
      gitAvailable = true
    } catch {
      gitAvailable = false
    }
  }
  if (!gitAvailable) t.skip('git is not available in this environment')
  return !gitAvailable
}

import { parseOptions, deriveServicePort } from '../src/options.js'
import { writeLaunchAgent } from '../src/commands/install.js'
import {
  applyConnectionStore,
  connectionEntryPath,
  listConnectionCodebaseIds,
  readConnectionEntry,
  writeConnectionEntry,
} from '../src/connections.js'
import { addRuntimeOptions, deriveCodebaseId, runAdd } from '../src/commands/add.js'
import { initCloud } from '../src/commands/import.js'

async function makeRoot(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

function withEnv(overrides, run) {
  const keys = Object.keys(overrides)
  const saved = new Map(keys.map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const key of keys) {
        const value = saved.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    })
}

test('connection store round-trips a scoped entry with 0600 permissions', async () => {
  const root = await makeRoot('hopit-connections-roundtrip-')
  const options = { 'state-root': path.join(root, 'state') }

  const written = await writeConnectionEntry(options, {
    codebaseId: 'project-beta',
    sessionId: 'session_beta',
    sessionToken: 'hst_beta_token',
    requesterId: 'user_beta',
    apiBaseUrl: 'https://agent-api.example.test',
    remotePushUrl: 'wss://agent-api.example.test/events',
  })

  const entry = await readConnectionEntry(options, 'project-beta')
  assert.equal(entry.codebaseId, 'project-beta')
  assert.equal(entry.sessionId, 'session_beta')
  assert.equal(entry.sessionToken, 'hst_beta_token')
  assert.equal(entry.requesterId, 'user_beta')
  assert.equal(entry.apiBaseUrl, 'https://agent-api.example.test')
  assert.equal(entry.remotePushUrl, 'wss://agent-api.example.test/events')
  assert.ok(entry.createdAt)

  assert.equal(written.path, connectionEntryPath(options, 'project-beta'))
  if (process.platform !== 'win32') {
    const stat = await fs.stat(written.path)
    assert.equal(stat.mode & 0o777, 0o600)
  }

  const ids = await listConnectionCodebaseIds(options)
  assert.deepEqual(ids, ['project-beta'])

  assert.equal(await readConnectionEntry(options, 'missing-codebase'), null)
})

test('connection store rejects unsafe codebase ids for the entry filename', async () => {
  const root = await makeRoot('hopit-connections-unsafe-')
  const options = { 'state-root': path.join(root, 'state') }
  await assert.rejects(
    () => writeConnectionEntry(options, { codebaseId: '../escape', sessionToken: 'hst_x' }),
    /Unsafe codebase id/,
  )
})

test('option resolution loads the store token for a non-env codebase and keeps env wins for the env codebase', async () => {
  const root = await makeRoot('hopit-connections-resolve-')
  const stateRoot = path.join(root, 'state')
  await writeConnectionEntry({ 'state-root': stateRoot }, {
    codebaseId: 'project-beta',
    sessionId: 'session_beta',
    sessionToken: 'hst_beta_token',
    requesterId: 'user_beta',
    apiBaseUrl: 'https://beta-api.example.test',
    remotePushUrl: 'wss://beta-api.example.test/events',
  })

  await withEnv(
    {
      HOPIT_CODEBASE_ID: 'hopit',
      HOPIT_AGENT_SESSION_TOKEN: 'hst_env_hopit',
      HOPIT_REQUESTER_ID: 'user_env',
      HOPIT_SESSION_ID: 'session_env',
    },
    async () => {
      // A command targeting a different codebase must pick up the scoped store
      // token instead of the env token, which is scoped to the env codebase.
      const betaOptions = parseOptions(['--codebase-id', 'project-beta', '--state-root', stateRoot])
      assert.equal(betaOptions['session-token'], 'hst_env_hopit')
      const beta = await applyConnectionStore(betaOptions)
      assert.equal(beta['session-token'], 'hst_beta_token')
      assert.equal(beta['session-id'], 'session_beta')
      assert.equal(beta['requester-id'], 'user_beta')
      assert.equal(beta['d1-api-base-url'], 'https://beta-api.example.test')
      assert.equal(beta['remote-push-url'], 'wss://beta-api.example.test/events')

      // The primary env codebase keeps its env-provided token untouched.
      const hopitOptions = parseOptions(['--codebase-id', 'hopit', '--state-root', stateRoot])
      const hopit = await applyConnectionStore(hopitOptions)
      assert.equal(hopit['session-token'], 'hst_env_hopit')
      assert.equal(hopit['requester-id'], 'user_env')

      // An explicit flag always wins over the store.
      const flagOptions = parseOptions([
        '--codebase-id', 'project-beta', '--state-root', stateRoot, '--session-token', 'hst_explicit',
      ])
      const flagged = await applyConnectionStore(flagOptions)
      assert.equal(flagged['session-token'], 'hst_explicit')
      assert.equal(flagged['requester-id'], 'user_beta')
    },
  )
})

test('deriveCodebaseId slugifies, suffixes collisions, and rejects taken explicit ids', () => {
  assert.equal(deriveCodebaseId({ explicitId: null, codebaseName: 'My Project', takenIds: [] }), 'my-project')
  assert.equal(
    deriveCodebaseId({ explicitId: null, codebaseName: 'My Project', takenIds: ['my-project'] }),
    'my-project-2',
  )
  assert.equal(
    deriveCodebaseId({ explicitId: null, codebaseName: 'My Project', takenIds: ['my-project', 'my-project-2'] }),
    'my-project-3',
  )
  assert.equal(deriveCodebaseId({ explicitId: 'Explicit ID', codebaseName: 'ignored', takenIds: [] }), 'explicit-id')
  assert.throws(
    () => deriveCodebaseId({ explicitId: 'taken', codebaseName: 'ignored', takenIds: ['taken'] }),
    /already connected/,
  )
})

test('hop add connects a folder end-to-end with a stubbed browser authorization', async () => {
  const root = await makeRoot('hopit-add-e2e-')
  const source = path.join(root, 'source-project')
  await fs.mkdir(path.join(source, 'src'), { recursive: true })
  await fs.writeFile(path.join(source, 'README.md'), '# Added project\n', 'utf8')
  await fs.writeFile(path.join(source, 'src', 'index.js'), 'export const value = 1\n', 'utf8')

  const stateRoot = path.join(root, 'state')
  const workspaceRoot = path.join(root, 'workspaces')
  const envFile = path.join(root, 'config', 'production.env')

  const base = parseOptions([
    '--source', source,
    '--codebase-name', 'My Project',
    '--state-root', stateRoot,
    '--workspace-root', workspaceRoot,
    '--env-path', envFile,
    '--cloud-backend', 'local',
    '--allow-local-cloud',
  ])

  let authorizeCalls = 0
  const authorize = async ({ keyring, requestedCodebaseId, requestedCodebaseName }) => {
    authorizeCalls += 1
    assert.ok(keyring, 'expected a device keyring to be passed to the authorizer')
    assert.equal(requestedCodebaseId, 'my-project')
    assert.equal(requestedCodebaseName, 'My Project')
    return {
      codebaseId: requestedCodebaseId,
      requesterId: 'user_add_owner',
      sessionId: 'session_add_device',
      sessionToken: 'hst_add_session_token',
      apiBaseUrl: 'https://agent-api.example.test',
      remotePushUrl: 'wss://agent-api.example.test/events',
      authorizationId: 'dau_add_test',
    }
  }

  const result = await runAdd(base, { authorize })

  assert.equal(authorizeCalls, 1)
  assert.equal(result.ok, true)
  assert.equal(result.action, 'add')
  assert.equal(result.codebaseId, 'my-project')
  assert.equal(result.requestedCodebaseId, 'my-project')
  assert.equal(result.import.mode, 'import-local')
  assert.equal(result.connection.status, 'connected')
  assert.equal(result.launchAgent.installed, false)
  assert.ok(Array.isArray(result.nextSteps) && result.nextSteps.some((step) => /--service/.test(step)))

  // The scoped connection is stored 0600 with the returned token.
  const entry = await readConnectionEntry({ 'state-root': stateRoot }, 'my-project')
  assert.equal(entry.sessionToken, 'hst_add_session_token')
  assert.equal(entry.requesterId, 'user_add_owner')
  assert.equal(entry.remotePushUrl, 'wss://agent-api.example.test/events')
  if (process.platform !== 'win32') {
    const stat = await fs.stat(connectionEntryPath({ 'state-root': stateRoot }, 'my-project'))
    assert.equal(stat.mode & 0o777, 0o600)
  }

  // The folder was materialized under the workspace root.
  assert.equal(await fs.readFile(path.join(workspaceRoot, 'my-project', 'README.md'), 'utf8'), '# Added project\n')
  assert.equal(
    await fs.readFile(path.join(workspaceRoot, 'my-project', 'src', 'index.js'), 'utf8'),
    'export const value = 1\n',
  )

  // The device keyring is shared and does not carry the scoped session token.
  const keyring = JSON.parse(await fs.readFile(path.join(stateRoot, 'keys', 'device.json'), 'utf8'))
  assert.notEqual(keyring.credentials?.agentSessionToken, 'hst_add_session_token')
})

test('hop add uses the production-safe import-git path when the source is a Git checkout', async (t) => {
  if (await skipUnlessGit(t)) return

  const root = await makeRoot('hopit-add-git-')
  const source = path.join(root, 'git-project')
  await fs.mkdir(source, { recursive: true })
  await execFileAsync('git', ['-C', source, 'init'])
  await execFileAsync('git', ['-C', source, 'config', 'user.email', 'test@hopit.dev'])
  await execFileAsync('git', ['-C', source, 'config', 'user.name', 'HopIt Test'])
  await fs.writeFile(path.join(source, 'README.md'), '# Git added project\n', 'utf8')
  await execFileAsync('git', ['-C', source, 'add', '.'])
  await execFileAsync('git', ['-C', source, 'commit', '-m', 'initial'])

  const stateRoot = path.join(root, 'state')
  const workspaceRoot = path.join(root, 'workspaces')
  const base = parseOptions([
    '--source', source,
    '--codebase-id', 'git-added',
    '--state-root', stateRoot,
    '--workspace-root', workspaceRoot,
    '--env-path', path.join(root, 'config', 'production.env'),
    '--cloud-backend', 'local',
    '--allow-local-cloud',
  ])

  // The production-safe Git import syncs into the codebase graph that browser
  // approval already created in the cloud. Seed the local fixture cloud to
  // stand in for that approved-and-created codebase.
  await initCloud({ ...base, cloud: path.join(stateRoot, 'cloud', 'git-added.json'), 'codebase-id': 'git-added' })

  const authorize = async ({ requestedCodebaseId }) => ({
    codebaseId: requestedCodebaseId,
    requesterId: 'user_git_owner',
    sessionId: 'session_git_device',
    sessionToken: 'hst_git_session_token',
    apiBaseUrl: 'https://agent-api.example.test',
    remotePushUrl: 'wss://agent-api.example.test/events',
    authorizationId: 'dau_git_test',
  })

  const result = await runAdd(base, { authorize })
  assert.equal(result.ok, true)
  assert.equal(result.codebaseId, 'git-added')
  assert.equal(result.import.mode, 'import-git')

  const entry = await readConnectionEntry({ 'state-root': stateRoot }, 'git-added')
  assert.equal(entry.sessionToken, 'hst_git_session_token')
  assert.equal(
    await fs.readFile(path.join(workspaceRoot, 'git-added', 'README.md'), 'utf8'),
    '# Git added project\n',
  )
})

test('hop add service options embed the derived per-codebase port', {
  skip: process.platform !== 'darwin' ? 'writeLaunchAgent supports macOS launchd only' : false,
}, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-add-service-'))
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

  const base = parseOptions([
    '--codebase-id', 'my-second-project',
    '--state-root', path.join(home, 'state'),
    '--workspace-root', path.join(home, 'workspaces'),
  ])
  const installOptions = addRuntimeOptions(base, {
    stateRoot: path.join(home, 'state'),
    workspaceRoot: path.join(home, 'workspaces'),
    codebaseId: 'my-second-project',
    deviceKeysPath: path.join(home, 'state', 'keys', 'device.json'),
    envFilePath: path.join(home, 'config', 'production.env'),
  })

  const expectedPort = String(deriveServicePort('my-second-project'))
  assert.notEqual(expectedPort, '4785')
  assert.equal(installOptions.port, expectedPort)

  const launchAgent = await writeLaunchAgent(installOptions)
  const plist = await fs.readFile(launchAgent.plistPath, 'utf8')
  assert.ok(plist.includes('--port'), 'expected the plist to include a --port argument')
  assert.ok(plist.includes(expectedPort), `expected the plist to embed the derived port ${expectedPort}`)
  assert.ok(plist.includes('com.hopit.agent.my-second-project'), 'expected the codebase-scoped launchd label')
})

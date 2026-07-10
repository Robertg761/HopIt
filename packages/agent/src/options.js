// @ts-check
import os from 'node:os'
import path from 'node:path'
import { defaultOptions } from './constants.js'
import { isTruthyEnv } from './paths.js'

export function normalizeCommand(command) {
  const aliases = {
    '-h': 'help',
    '--help': 'help',
    import: 'import-local',
    mirror: 'mirror-local',
    'git-import': 'import-git',
    'git-url-import': 'import-git-url',
    'import-remote-git': 'import-git-url',
    sync: 'sync-once',
    review: 'review-open',
    export: 'export-git',
    serve: 'status-server',
    server: 'status-server',
    workspaces: 'workspace',
    device: 'session',
    devices: 'session',
    key: 'keys',
    keyring: 'keys',
    sessions: 'session',
  }

  return aliases[command] ?? command
}

export function parseOptions(args) {
  const options = { ...defaultOptions }
  const provided = new Set()
  const booleanOptions = new Set([
    'force',
    'allow-unsafe-workspace',
    'allow-local-cloud',
    'include-private',
    'remote-pull',
    'remote-push',
    'auto-refresh',
    'json',
    'start-service',
    'write-env',
    'launch-agent',
    'skip-service-control',
    'production-safe',
    'execute',
    'recursive',
    'with-siblings',
    'skip-cloud-registration',
    'yes',
    'interactive',
    'advanced',
    'force-env',
    'connect',
  ])

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg.startsWith('--')) continue

    const key = arg.slice(2)
    if (key.startsWith('no-') && booleanOptions.has(key.slice(3))) {
      const negated = key.slice(3)
      options[negated] = false
      provided.add(negated)
      continue
    }
    if (booleanOptions.has(key)) {
      options[key] = true
      provided.add(key)
      continue
    }

    const value = args[i + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`)
    }
    options[key] = value
    provided.add(key)
    i += 1
  }

  options._provided = provided
  return applyRuntimeDefaults(options, provided)
}

export function applyRuntimeDefaults(options, provided) {
  const profile = options.profile ?? process.env.HOPIT_PROFILE ?? 'development'
  const codebaseId = options['codebase-id'] ?? process.env.HOPIT_CODEBASE_ID ?? 'hopit'
  const productionProfile = profile === 'production'

  options.profile = profile
  if (!provided.has('codebase-id') && process.env.HOPIT_CODEBASE_ID) {
    options['codebase-id'] = process.env.HOPIT_CODEBASE_ID
  }
  if (!provided.has('remote-pull') && isTruthyEnv(process.env.HOPIT_REMOTE_PULL)) {
    options['remote-pull'] = true
  }
  if (!provided.has('remote-push') && isTruthyEnv(process.env.HOPIT_REMOTE_PUSH)) {
    options['remote-push'] = true
  }
  if (!provided.has('remote-push-url') && process.env.HOPIT_REMOTE_PUSH_URL) {
    options['remote-push-url'] = process.env.HOPIT_REMOTE_PUSH_URL
  }
  if (!provided.has('auto-refresh') && isTruthyEnv(process.env.HOPIT_AUTO_REFRESH)) {
    options['auto-refresh'] = true
  }
  const providedRemotePullCooldown = provided.has('remote-pull-cooldown-ms') || provided.has('remote-refresh-interval-ms')
  if (!providedRemotePullCooldown && process.env.HOPIT_REMOTE_PULL_COOLDOWN_MS) {
    options['remote-pull-cooldown-ms'] = process.env.HOPIT_REMOTE_PULL_COOLDOWN_MS
  }
  if (!providedRemotePullCooldown && !process.env.HOPIT_REMOTE_PULL_COOLDOWN_MS && process.env.HOPIT_REMOTE_REFRESH_INTERVAL_MS) {
    options['remote-refresh-interval-ms'] = process.env.HOPIT_REMOTE_REFRESH_INTERVAL_MS
  }
  if (!provided.has('session-id') && process.env.HOPIT_SESSION_ID) {
    options['session-id'] = process.env.HOPIT_SESSION_ID
  }
  if (!provided.has('device-name') && process.env.HOPIT_DEVICE_NAME) {
    options['device-name'] = process.env.HOPIT_DEVICE_NAME
  }
  if (!provided.has('session-token') && process.env.HOPIT_AGENT_SESSION_TOKEN) {
    options['session-token'] = process.env.HOPIT_AGENT_SESSION_TOKEN
  }
  if (!provided.has('workspace-index') && process.env.HOPIT_WORKSPACE_INDEX) {
    options['workspace-index'] = process.env.HOPIT_WORKSPACE_INDEX
  }
  if (!provided.has('workspace-root') && process.env.HOPIT_WORKSPACE_ROOT) {
    options['workspace-root'] = process.env.HOPIT_WORKSPACE_ROOT
  }
  if (!provided.has('workspace') && options['workspace-root']) {
    options.workspace = path.join(options['workspace-root'], codebaseId)
  }

  if (productionProfile) {
    options['codebase-id'] = codebaseId
    const stateRoot = options['state-root'] ?? process.env.HOPIT_AGENT_STATE_ROOT ?? defaultAgentStateRoot()
    const workspaceRoot = options['workspace-root'] ?? process.env.HOPIT_WORKSPACE_ROOT ?? defaultWorkspaceRoot()
    options['state-root'] = stateRoot
    options['workspace-root'] = workspaceRoot

    if (!provided.has('cloud')) {
      options.cloud = path.join(stateRoot, 'cloud', `${codebaseId}.json`)
    }
    if (!provided.has('workspace')) {
      options.workspace = path.join(workspaceRoot, codebaseId)
    }
    if (!provided.has('journal')) {
      options.journal = path.join(stateRoot, 'journal', `${codebaseId}.ndjson`)
    }
    if (!provided.has('events')) {
      options.events = path.join(stateRoot, 'events', `${codebaseId}.ndjson`)
    }
    if (!provided.has('pid')) {
      options.pid = path.join(stateRoot, 'run', `${codebaseId}.pid`)
    }
  }

  return options
}

export function defaultAgentStateRoot() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'HopIt', 'Agent')
  }

  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'HopIt', 'Agent')
  }

  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'hopit', 'agent')
}

export function defaultWorkspaceRoot() {
  return path.join(os.homedir(), 'HopIt Workspaces')
}

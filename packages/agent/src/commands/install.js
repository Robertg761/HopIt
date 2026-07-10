// @ts-check
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { __filename, workspaceMode } from '../constants.js'
import { assertWorkspacePathSafe, cloudLocationFromOptions, cloudServiceTypeFromOptions, remotePullEnabled } from '../paths.js'
import { startService } from '../service.js'
import { workspaceRootFromOptions } from '../status-state.js'
import { agentStateRootFromOptions, readWorkspaceIndex, upsertWorkspaceIndex, workspaceIndexPath, workspaceIndexSummary } from '../workspace-index.js'

export async function ensureAgentDirectories({ stateRoot, workspaceRoot, workspace }) {
  const directories = [
    path.join(stateRoot, 'cloud'),
    path.join(stateRoot, 'journal'),
    path.join(stateRoot, 'events'),
    path.join(stateRoot, 'run'),
    path.join(stateRoot, 'backups'),
    workspaceRoot,
    workspace,
  ]
  const created = []
  for (const directory of directories) {
    if (!existsSync(directory)) created.push(directory)
    await fs.mkdir(directory, { recursive: true })
  }
  return created
}

export async function ensureWorkspaceIndexEntry(options, { codebaseId, workspaceRoot }) {
  const existing = await readWorkspaceIndex(options)
  if (existing) return existing

  return upsertWorkspaceIndex(options, {
    id: codebaseId,
    name: codebaseId,
    initialized: false,
    workspace: {
      root: workspaceRoot,
      path: path.resolve(options.workspace),
      exists: true,
      adapter: workspaceMode.adapter,
      cacheMode: workspaceMode.cacheMode,
      virtualized: false,
    },
    cloud: {
      path: cloudLocationFromOptions(options, codebaseId),
      service: cloudServiceTypeFromOptions(options),
      exists: false,
    },
    materialization: 'metadata-only',
    hydration: {
      state: 'metadata-only',
      lastMaterializedAt: null,
      lastMaterializedRevision: null,
      selectedStateRevision: null,
      source: 'install',
      lastEvent: null,
      hydratedPathCount: 0,
    },
    hydratedPaths: [],
    remoteCursor: {
      graphRevision: null,
      selectedStateRevision: null,
      materializedRevision: null,
      lastMaterializedAt: null,
    },
    virtualized: false,
    updatedAt: new Date().toISOString(),
  })
}

export async function installAgent(options) {
  await assertWorkspacePathSafe(options)
  const stateRoot = path.resolve(agentStateRootFromOptions(options))
  const workspaceRoot = path.resolve(workspaceRootFromOptions(options))
  const codebaseId = options['codebase-id'] ?? path.basename(path.resolve(options.workspace))

  await ensureAgentDirectories({ stateRoot, workspaceRoot, workspace: options.workspace })

  const index = await ensureWorkspaceIndexEntry(options, { codebaseId, workspaceRoot })

  const envExamplePath = path.join(stateRoot, 'hopit.env.example')
  if (options['write-env']) {
    await fs.writeFile(envExamplePath, productionEnvTemplate(options), 'utf8')
  }

  let launchAgent = null
  if (options['launch-agent']) {
    launchAgent = await writeLaunchAgent(options)
  }

  if (options['start-service']) {
    await startService(options)
  }

  console.log(JSON.stringify({
    ok: true,
    action: 'install',
    codebaseId,
    stateRoot,
    workspaceRoot,
    workspace: path.resolve(options.workspace),
    workspaceIndex: workspaceIndexSummary(options, index),
    envExample: options['write-env'] ? envExamplePath : null,
    launchAgent,
    serviceStarted: Boolean(options['start-service']),
  }, null, 2))
}


export function productionEnvTemplate(options) {
  const codebaseId = options['codebase-id'] ?? 'hopit'
  return `# HopIt production agent environment
HOPIT_PROFILE=production
HOPIT_CODEBASE_ID=${codebaseId}
HOPIT_CLOUD_BACKEND=d1
HOPIT_D1_ACCOUNT_ID=${options['d1-account-id'] ?? 'replace-with-cloudflare-account-id'}
HOPIT_D1_DATABASE_ID=${options['d1-database-id'] ?? 'replace-with-d1-database-id'}
HOPIT_D1_API_TOKEN=replace-with-cloudflare-d1-api-token-or-hopit-d1-proxy-token
HOPIT_D1_API_BASE_URL=${options['d1-api-base-url'] ?? 'https://hopit-d1-api.<account-subdomain>.workers.dev'}
HOPIT_AGENT_STATE_ROOT=${JSON.stringify(path.resolve(agentStateRootFromOptions(options)))}
HOPIT_WORKSPACE_ROOT=${JSON.stringify(path.resolve(workspaceRootFromOptions(options)))}
HOPIT_WORKSPACE_INDEX=${JSON.stringify(path.resolve(workspaceIndexPath(options)))}
HOPIT_SESSION_ID=${options['session-id'] ?? `session_${codebaseId}_${os.hostname().replace(/[^a-zA-Z0-9]+/g, '_')}`}
HOPIT_DEVICE_NAME=${JSON.stringify(options['device-name'] ?? os.hostname() ?? 'local-device')}
HOPIT_AGENT_SESSION_TOKEN=replace-after-hop-session-register
HOPIT_REMOTE_PULL=1
HOPIT_REMOTE_PULL_COOLDOWN_MS=${options['remote-pull-cooldown-ms'] ?? options['remote-refresh-interval-ms'] ?? '300000'}
`
}

export async function writeLaunchAgent(options) {
  if (process.platform !== 'darwin') {
    throw new Error('--launch-agent currently supports macOS launchd only.')
  }
  const codebaseId = options['codebase-id'] ?? 'hopit'
  const label = `com.hopit.agent.${codebaseId}`
  const launchAgentsRoot = path.join(os.homedir(), 'Library', 'LaunchAgents')
  const plistPath = path.join(launchAgentsRoot, `${label}.plist`)
  const hopBin = options['hop-bin'] ?? process.argv[1] ?? __filename
  const envFilePath = options['env-path']
  const serviceArguments = [
    process.execPath,
    hopBin,
    'service',
    'start',
    '--profile',
    'production',
    '--codebase-id',
    codebaseId,
  ]
  if (remotePullEnabled(options)) {
    serviceArguments.push('--remote-pull')
  }
  if (options['remote-pull-cooldown-ms']) {
    serviceArguments.push('--remote-pull-cooldown-ms', options['remote-pull-cooldown-ms'])
  } else if (options['remote-refresh-interval-ms']) {
    serviceArguments.push('--remote-refresh-interval-ms', options['remote-refresh-interval-ms'])
  }
  const programArguments = [
    '/bin/sh',
    '-lc',
    envFilePath
      ? `set -a; . ${shellQuote(path.resolve(envFilePath))}; set +a; exec ${serviceArguments.map(shellQuote).join(' ')}`
      : `exec ${serviceArguments.map(shellQuote).join(' ')}`,
  ]

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlist(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((argument) => `    <string>${escapePlist(argument)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${escapePlist(path.join(agentStateRootFromOptions(options), 'run', `${codebaseId}.launchd.out.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlist(path.join(agentStateRootFromOptions(options), 'run', `${codebaseId}.launchd.err.log`))}</string>
</dict>
</plist>
`

  await fs.mkdir(launchAgentsRoot, { recursive: true })
  await fs.writeFile(plistPath, plist, 'utf8')
  return {
    label,
    plistPath,
    loadCommand: `launchctl bootstrap gui/$(id -u) ${plistPath}`,
  }
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

export function escapePlist(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

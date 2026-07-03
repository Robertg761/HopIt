#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { existsSync, watch } from 'node:fs'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CloudflareD1HopBackend,
  d1CloudServiceType,
  d1ConfigFromOptions,
  isD1Configured,
} from '../../../src/lib/d1-backend.js'
import {
  clientEncryptionConfigFromOptions,
  clientEncryptionScopeFromOptions,
  clientEncryptionScopes,
  createDeviceKeyMaterial,
  encryptRecoveryPayload,
  hasPrivatePrivacyZone,
  isLocalOnlySecretPath,
  normalizeClientEncryptionMetadata,
  prepareBlobPayload,
  privacyZoneForPath,
  publicDeviceKeyDescriptor,
  rawClientEncryptionKey,
  shouldEncryptWithConfig,
  unwrapUserVaultKey,
  unwrapBlobPayload,
  validateClientEncryptionMetadata,
} from './crypto.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.resolve(__dirname, '../fixtures/demo-cloud.json')

const defaultOptions = {
  cloud: '.hopit-agent/cloud.json',
  workspace: '.hopit-agent/workspaces/hopit-core',
  journal: '.hopit-agent/journal.ndjson',
  events: '.hopit-agent/events.ndjson',
  pid: '.hopit-agent/hopit.pid',
  host: '127.0.0.1',
  port: '4785',
}

const workspaceMode = {
  adapter: 'managed-folder',
  cacheMode: 'local-cache',
  sourceOfTruth: 'cloud',
  materializationPolicy: 'metadata-first',
  hydrationPolicy: 'explicit-refresh-or-file',
  remoteUpdatePolicy: 'materialized-clean-only',
}

const workspaceIndexVersion = 1
const localCacheSchemaVersion = 1
const cloudServiceType = 'fixture-json-cloud-graph'

const fileScope = {
  shared: 'shared',
  ownerPrivate: 'owner-private',
}

const entryKind = {
  file: 'file',
  symlink: 'symlink',
  directory: 'directory',
}

const entryEncoding = {
  utf8: 'utf8',
  base64: 'base64',
}

const contentStorageMode = {
  inline: 'inline',
  objectBlob: 'object-blob',
}

const objectBlobProvider = {
  filesystem: 'filesystem',
  r2: 'r2',
  s3: 's3',
  b2: 'b2',
}

const defaultFileStorageBudgetBytes = 1_000_000_000
const r2FreeStorageTierBytes = 10_000_000_000
const r2DefaultFreeOnlyBudgetBytes = 8_000_000_000
const serviceReadyTimeoutMs = 60_000
const serviceStatusFetchTimeoutMs = 5_000
const defaultMirrorSecretRoutes = new Map([
  ['.env.local', '.private/env/repo-root/.env.local'],
])
const mirrorSecretFileNames = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  '.netrc',
  'id_rsa',
  'id_ed25519',
])
const mirrorNonSecretEnvSuffixes = new Set([
  'example',
  'sample',
  'template',
  'dist',
  'default',
])
const defaultLaunchAgentLabelPrefix = 'com.hopit.agent'

class ConflictError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'ConflictError'
    this.detail = detail
  }
}

async function main() {
  const [rawCommand = 'help', ...rawArgs] = process.argv.slice(2)
  const command = normalizeCommand(rawCommand)
  const args = [...rawArgs]
  const serviceAction =
    command === 'service' && args[0] && !args[0].startsWith('--') ? args.shift() : 'status'
  const workspaceAction =
    command === 'workspace' && args[0] && !args[0].startsWith('--') ? args.shift() : 'status'
  const sessionAction =
    command === 'session' && args[0] && !args[0].startsWith('--') ? args.shift() : 'status'
  const keysAction =
    command === 'keys' && args[0] && !args[0].startsWith('--') ? args.shift() : 'status'
  const parsedOptions = parseOptions(args)
  const options = command === 'keys' ? parsedOptions : await applyLocalDeviceKeyring(parsedOptions)

  if (command === 'init') {
    await initCloud(options)
    return
  }

  if (command === 'import-local') {
    await importLocalProject(options)
    return
  }

  if (command === 'mirror-local') {
    await mirrorLocalProject(options)
    return
  }

  if (command === 'import-git') {
    await importGitProject(options)
    return
  }

  if (command === 'import-git-url') {
    await importRemoteGitProject(options)
    return
  }

  if (command === 'storage') {
    await manageStorage(options, args)
    return
  }

  if (command === 'hydrate') {
    await hydrateWorkspace(options)
    return
  }

  if (command === 'refresh') {
    await refreshWorkspace(options)
    return
  }

  if (command === 'remote-pull') {
    await remotePullOnce(options)
    return
  }

  if (command === 'sync-once') {
    await syncOnce(options)
    return
  }

  if (command === 'recover') {
    const recovery = await recoverJournal(options)
    if (recovery.failed > 0) process.exitCode = 1
    return
  }

  if (command === 'review-open') {
    await openChangeSetReview(options)
    return
  }

  if (command === 'merge') {
    await mergeChangeSet(options)
    return
  }

  if (command === 'export-git') {
    await exportGitSnapshot(options, { requireMerged: false })
    return
  }

  if (command === 'publish') {
    await exportGitSnapshot(options, { requireMerged: true })
    return
  }

  if (command === 'validate') {
    await validateCloud(options)
    return
  }

  if (command === 'doctor') {
    await runDoctor(options)
    return
  }

  if (command === 'backup') {
    await backupAgentState(options)
    return
  }

  if (command === 'install') {
    await installAgent(options)
    return
  }

  if (command === 'workspace') {
    await runWorkspaceCommand(workspaceAction, options)
    return
  }

  if (command === 'session') {
    await runSessionCommand(sessionAction, options)
    return
  }

  if (command === 'keys') {
    await runKeysCommand(keysAction, options)
    return
  }

  if (command === 'service') {
    await runServiceCommand(serviceAction, options)
    return
  }

  if (command === 'service-run') {
    await runServiceProcess(options)
    return
  }

  if (command === 'watch') {
    await watchWorkspace(options)
    return
  }

  if (command === 'status') {
    const state = await readAgentState(options)
    console.log(JSON.stringify(state.status, null, 2))
    return
  }

  if (command === 'status-server') {
    await serveStatus(options)
    return
  }

  if (command === 'demo') {
    await runDemo(options)
    return
  }

  printHelp()
}

function normalizeCommand(command) {
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

function parseOptions(args) {
  const options = { ...defaultOptions }
  const provided = new Set()
  const booleanOptions = new Set([
    'force',
    'allow-unsafe-workspace',
    'allow-local-cloud',
    'include-private',
    'remote-pull',
    'auto-refresh',
    'json',
    'start-service',
    'write-env',
    'launch-agent',
    'skip-service-control',
    'production-safe',
    'execute',
    'recursive',
    'skip-cloud-registration',
  ])

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg.startsWith('--')) continue

    const key = arg.slice(2)
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

function applyRuntimeDefaults(options, provided) {
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

function defaultAgentStateRoot() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'HopIt', 'Agent')
  }

  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'HopIt', 'Agent')
  }

  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'hopit', 'agent')
}

function defaultWorkspaceRoot() {
  return path.join(os.homedir(), 'HopIt Workspaces')
}

async function initCloud(options) {
  const cloudService = createCloudGraphService(options)
  if ((await cloudService.exists()) && !options.force) {
    await emit(options, 'cloud.exists', { cloud: options.cloud })
    return
  }

  const fixture = await readJson(fixturePath)
  const cloud = await cloudService.initialize(fixture)
  await emit(options, 'cloud.initialized', {
    cloud: options.cloud,
    service: cloudService.type,
    files: Object.keys(fixture.files).length,
    contract: summarizeGraphContract(cloud),
    scopeCounts: countCloudScopes(cloud),
  })
}

async function importLocalProject(options) {
  if (!options.source) {
    throw new Error('Missing --source <path> for import.')
  }

  const source = path.resolve(options.source)
  const stat = await fs.stat(source)
  if (!stat.isDirectory()) {
    throw new Error(`Import source is not a directory: ${source}`)
  }
  await assertWorkspacePathSafe(options, { source })

  const cloudService = createCloudGraphService(options)
  if ((await cloudService.exists()) && !options.force) {
    await emit(options, 'import.exists', {
      cloud: options.cloud,
      source,
      reason: 'Use --force to replace the current local HopIt graph.',
    })
    return
  }

  const now = new Date().toISOString()
  const codebaseName = options['codebase-name'] ?? path.basename(source)
  const codebaseId = options['codebase-id'] ?? slugify(codebaseName)
  const importResult = await readImportableProjectFiles(source)
  const files = importResult.files
  const graph = {
    schemaVersion: 2,
    codebase: {
      id: codebaseId,
      name: codebaseName,
      ownerId: options['owner-id'] ?? 'local-owner',
    },
    main: {
      id: 'main',
      revision: 1,
      updatedAt: now,
      mergedChangeSetId: null,
    },
    selectedState: {
      type: 'active-change-set',
      id: `cs_${codebaseId}_local`,
      ownerId: options['owner-id'] ?? 'local-owner',
      baseMainId: 'main',
      baseRevision: 1,
      revision: 1,
      visibility: options.visibility ?? 'private',
      effectiveVisibility: options.visibility ?? 'private',
      reviewState: 'not-open',
      mergeState: 'unmerged',
      conflictState: 'none',
      conflict: null,
      review: null,
      merge: null,
    },
    owner: {
      id: options['owner-id'] ?? 'local-owner',
    },
    collaborators: [],
    session: {
      id: options['session-id'] ?? 'session_local',
      deviceName: options['device-name'] ?? 'local-device',
    },
    visibility: {
      productDefault: 'private',
      globalUserDefault: null,
      codebaseOverride: null,
      changeSetOverride: null,
      effective: options.visibility ?? 'private',
    },
    revision: 1,
    files,
  }

  const cloud = await cloudService.initialize(graph)
  await fs.rm(options.workspace, { recursive: true, force: true })
  await fs.rm(options.journal, { force: true })
  await fs.rm(options.events, { force: true })
  await emit(options, 'local.imported', {
    source,
    cloud: options.cloud,
    workspace: options.workspace,
    files: Object.keys(files).length,
    skipped: importResult.skipped,
    contract: summarizeGraphContract(cloud),
    scopeCounts: countCloudScopes(cloud),
  })
  await hydrateWorkspace(options)
}

async function mirrorLocalProject(options, context = {}) {
  if (!options.source) {
    throw new Error('Missing --source <path> for mirror.')
  }

  const source = path.resolve(options.source)
  const workspace = path.resolve(options.workspace)
  const sourceStat = await fs.stat(source)
  if (!sourceStat.isDirectory()) {
    throw new Error(`Mirror source is not a directory: ${source}`)
  }
  await assertWorkspacePathSafe(options, { source })

  const storageBudgetBytes = Number(options['storage-budget-bytes'] ?? process.env.HOPIT_STORAGE_BUDGET_BYTES ?? defaultFileStorageBudgetBytes)
  if (!Number.isFinite(storageBudgetBytes) || storageBudgetBytes < 0) {
    throw new Error(`Invalid --storage-budget-bytes value: ${options['storage-budget-bytes']}`)
  }

  const codebaseId = options['codebase-id'] ?? path.basename(workspace)
  const launchAgentLabel = options['launch-agent-label'] ?? `${defaultLaunchAgentLabelPrefix}.${codebaseId}`
  const routes = await mirrorSecretRoutesFromOptions(source, options)
  const secretSync = secretSyncStatus(options)
  const startedAt = new Date().toISOString()
  const stoppedService = options['skip-service-control']
    ? { skipped: true, reason: 'skip-service-control' }
    : await stopMirrorService(launchAgentLabel)

  const backup = await backupWorkspaceForMirror(options, startedAt)
  await fs.rm(workspace, { recursive: true, force: true })
  await fs.mkdir(workspace, { recursive: true })

  const copyResult = await copyLiteralMirrorSource(source, workspace, routes)
  const sourceManifest = await buildLiteralMirrorManifest(source, { routes })
  const destinationManifest = await buildLiteralMirrorManifest(workspace)
  const diff = diffLiteralManifests(sourceManifest, destinationManifest)
  const rootEnvExists = existsSync(path.join(workspace, '.env.local'))
  const routedSecretCount = countLocalOnlySecretManifestEntries(destinationManifest)
  const routedSecretExists = routedSecretCount > 0
  const budget = storageBudgetReport(destinationManifest, storageBudgetBytes)

  const result = {
    ok: diff.clean && !rootEnvExists,
    action: context.action ?? 'mirror-local',
    source,
    workspace,
    codebaseId,
    startedAt,
    completedAt: new Date().toISOString(),
    service: stoppedService,
    backup,
    copied: copyResult,
    routes: [...routes.entries()].map(([from, to]) => ({ from, to })),
    remoteGit: context.remoteGit ?? null,
    manifest: {
      source: literalManifestSummary(sourceManifest),
      destination: literalManifestSummary(destinationManifest),
      diff,
    },
    secrets: {
      rootEnvExists,
      routedEnvExists: routedSecretExists,
      routedSecretCount,
      encryptedSyncEnabled: secretSync.enabled,
      encryptedSyncReason: secretSync.reason,
      encryptionScope: secretSync.scope,
    },
    storageBudget: budget,
    sync: {
      attempted: false,
      skipped: true,
      reason: budget.withinBudget ? null : 'storage_budget_exceeded',
    },
  }

  if (!diff.clean) {
    await emit(options, 'mirror.failed', {
      reason: 'manifest_mismatch',
      diff,
      backup: backup.output,
    })
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = 1
    return
  }

  if (rootEnvExists) {
    await emit(options, 'mirror.failed', {
      reason: 'root_env_local_present',
      backup: backup.output,
    })
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = 1
    return
  }

  if (!budget.withinBudget) {
    await emit(options, 'mirror.sync_skipped', {
      reason: 'storage_budget_exceeded',
      storageBudget: budget,
      backup: backup.output,
      service: stoppedService,
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (options['production-safe'] && routedSecretExists && !secretSync.enabled) {
    result.sync.reason = secretSync.reason
    await emit(options, 'mirror.sync_skipped', {
      reason: secretSync.reason,
      detail: 'Production-safe mirror kept routed secrets local because client-side encrypted secret sync is not configured.',
      backup: backup.output,
      service: stoppedService,
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }

  const syncResult = await syncOnce(options, { trigger: 'literal-mirror' })
  result.sync = {
    attempted: true,
    skipped: false,
    reason: null,
    result: syncResult,
  }

  if (!options['skip-service-control']) {
    result.service.restart = await startMirrorService(launchAgentLabel)
  }

  await emit(options, 'mirror.complete', {
    storageBudget: budget,
    backup: backup.output,
    sync: result.sync,
  })
  console.log(JSON.stringify(result, null, 2))
}

async function importGitProject(options) {
  if (options.url || options['git-url']) {
    await importRemoteGitProject(options)
    return
  }

  if (!options.source) {
    throw new Error('Missing --source <path> for import-git.')
  }

  const source = path.resolve(options.source)
  const gitPath = path.join(source, '.git')
  if (!existsSync(gitPath)) {
    throw new Error(`import-git requires a Git checkout with a .git entry: ${source}`)
  }

  const nextOptions = {
    ...options,
    'production-safe': true,
  }
  await mirrorLocalProject(nextOptions, { action: 'import-git', requireGit: true })
}

async function importRemoteGitProject(options) {
  const remoteUrl = options.url ?? options['git-url']
  if (!remoteUrl) {
    throw new Error('Missing --url <git-url> for import-git-url.')
  }

  validateGitRemoteUrl(remoteUrl)

  const cloneRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hopit-git-import-'))
  const clonePath = path.join(cloneRoot, 'repo')
  const cloneStartedAt = new Date().toISOString()

  try {
    const cloneResult = await cloneGitRepository(remoteUrl, clonePath, options)
    await emit(options, 'git.clone_complete', {
      url: redactGitRemoteUrl(remoteUrl),
      source: clonePath,
      elapsedMs: cloneResult.elapsedMs,
    })

    const nextOptions = {
      ...options,
      source: clonePath,
      'production-safe': true,
    }
    await mirrorLocalProject(nextOptions, {
      action: 'import-git-url',
      requireGit: true,
      remoteGit: {
        url: redactGitRemoteUrl(remoteUrl),
        branch: options.branch ?? null,
        clonedAt: cloneStartedAt,
      },
    })
  } finally {
    await fs.rm(cloneRoot, { recursive: true, force: true })
  }
}

async function cloneGitRepository(remoteUrl, outputPath, options) {
  const args = ['clone']
  if (options.branch) {
    assertSafeGitOptionValue(options.branch, '--branch')
    args.push('--branch', options.branch)
  }
  if (options.depth) {
    const depth = Number(options.depth)
    if (!Number.isInteger(depth) || depth < 1) {
      throw new Error(`Invalid --depth value: ${options.depth}`)
    }
    args.push('--depth', String(depth))
  }
  args.push('--', remoteUrl, outputPath)

  const timeoutMs = Number(options['git-timeout-ms'] ?? 10 * 60 * 1000)
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    throw new Error(`Invalid --git-timeout-ms value: ${options['git-timeout-ms']}`)
  }

  const startedAt = Date.now()
  const result = await runProcess('git', args, { timeoutMs })
  if (result.exitCode !== 0) {
    const detail = result.stderr || result.stdout || 'git clone failed.'
    throw new Error(`Unable to clone Git repository: ${detail}`)
  }
  return {
    ...result,
    elapsedMs: Date.now() - startedAt,
  }
}

function validateGitRemoteUrl(remoteUrl) {
  if (typeof remoteUrl !== 'string' || remoteUrl.trim() !== remoteUrl || remoteUrl.length === 0) {
    throw new Error('Git URL must be a non-empty string without leading or trailing whitespace.')
  }
  if (remoteUrl.includes('\0') || remoteUrl.includes('\n') || remoteUrl.includes('\r')) {
    throw new Error('Git URL contains unsupported control characters.')
  }
  if (remoteUrl.startsWith('-')) {
    throw new Error('Git URL cannot start with a dash.')
  }
}

function assertSafeGitOptionValue(value, optionName) {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('-')) {
    throw new Error(`${optionName} must be a non-empty value and cannot start with a dash.`)
  }
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error(`${optionName} contains unsupported control characters.`)
  }
}

function redactGitRemoteUrl(remoteUrl) {
  try {
    const parsed = new URL(remoteUrl)
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? '***' : ''
      parsed.password = parsed.password ? '***' : ''
    }
    return parsed.toString()
  } catch {
    return remoteUrl.replace(/^(ssh:\/\/)?([^@\s]+)@/, '$1***@')
  }
}

function runProcess(command, args, { timeoutMs = 60_000, cwd = process.cwd(), input = null, outputLimit = 16_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`${command} timed out.`))
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout = capText(stdout + chunk, outputLimit)
    })
    child.stderr.on('data', (chunk) => {
      stderr = capText(stderr + chunk, outputLimit)
    })
    if (input !== null) {
      child.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') reject(error)
      })
      child.stdin.end(input)
    }
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (exitCode) => {
      clearTimeout(timeout)
      resolve({
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      })
    })
  })
}

function capText(output, limit = 16_000) {
  return output.length > limit ? output.slice(-limit) : output
}

async function manageStorage(options, args = []) {
  const action = args.find((arg) => !arg.startsWith('--')) ?? 'status'
  if (action === 'status') {
    await storageStatus(options)
    return
  }
  if (action === 'gc') {
    await storageGc(options)
    return
  }
  throw new Error(`Unknown storage action: ${action}`)
}

async function storageStatus(options) {
  const cloudService = createCloudGraphService(options)
  if (!cloudService.blobStore) {
    throw new Error('storage status requires --blob-provider or HOPIT_BLOB_PROVIDER.')
  }
  const usage = await cloudService.blobStore.readUsage()
  const cloud = await cloudService.readGraph()
  const reachableKeys = reachableBlobKeysForCloud(cloud)
  const result = {
    ok: true,
    action: 'storage.status',
    provider: cloudService.blobStore.provider,
    location: cloudService.blobStore.location,
    codebaseId: cloud.codebase?.id ?? options['codebase-id'] ?? null,
    usage,
    reachableObjects: reachableKeys.size,
  }
  await emit(options, 'storage.status', result)
  console.log(JSON.stringify(result, null, 2))
}

async function storageGc(options) {
  const cloudService = createCloudGraphService(options)
  if (!cloudService.blobStore) {
    throw new Error('storage gc requires --blob-provider or HOPIT_BLOB_PROVIDER.')
  }
  if (!cloudService.blobStore.listBlobs || !cloudService.blobStore.deleteBlob) {
    throw new Error(`storage gc is not supported by blob provider ${cloudService.blobStore.provider}.`)
  }

  const cloud = await cloudService.readGraph()
  const codebaseId = cloud.codebase?.id ?? options['codebase-id'] ?? 'hopit'
  const reachableKeys = reachableBlobKeysForCloud(cloud)
  const listed = await cloudService.blobStore.listBlobs({ codebaseId })
  const retentionMs = storageRetentionMsFromOptions(options)
  const now = Date.now()
  const orphaned = listed
    .filter((blob) => !reachableKeys.has(blob.key))
    .filter((blob) => {
      if (!retentionMs) return true
      if (!blob.lastModified) return false
      return now - new Date(blob.lastModified).getTime() >= retentionMs
    })
  const execute = Boolean(options.execute)
  let deleted = 0
  let deletedBytes = 0

  if (execute) {
    for (const blob of orphaned) {
      await cloudService.blobStore.deleteBlob(blob.key, { codebaseId })
      deleted += 1
      deletedBytes += blob.size ?? 0
    }
  }

  const result = {
    ok: true,
    action: 'storage.gc',
    mode: execute ? 'execute' : 'dry-run',
    provider: cloudService.blobStore.provider,
    location: cloudService.blobStore.location,
    codebaseId,
    listedObjects: listed.length,
    listedBytes: listed.reduce((sum, blob) => sum + (blob.size ?? 0), 0),
    reachableObjects: reachableKeys.size,
    orphanedObjects: orphaned.length,
    orphanedBytes: orphaned.reduce((sum, blob) => sum + (blob.size ?? 0), 0),
    deletedObjects: deleted,
    deletedBytes,
    retentionMs,
    sampleOrphans: orphaned.slice(0, 20).map((blob) => ({
      key: blob.key,
      size: blob.size ?? null,
      lastModified: blob.lastModified ?? null,
    })),
  }
  await emit(options, execute ? 'storage.gc.deleted' : 'storage.gc.planned', result)
  console.log(JSON.stringify(result, null, 2))
}

async function hydrateWorkspace(options) {
  await assertWorkspacePathSafe(options)
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readVisibleGraph(visibilityRequestFromOptions(options))
  const requester = summarizeRequester(cloud.visibilityContext)
  await fs.mkdir(options.workspace, { recursive: true })

  for (const [relativePath, file] of Object.entries(cloud.files)) {
    const scope = scopeForPath(relativePath)
    const entry = normalizeCloudFileEntry(relativePath, file)
    await materializeCloudEntry(options.workspace, relativePath, entry, cloudService, {
      codebaseId: cloud.codebase?.id ?? options['codebase-id'] ?? 'hopit',
    })
    await emit(options, 'file.hydrated', {
      path: relativePath,
      scope,
      privacyZone: entry.privacyZone ?? privacyZoneForPath(relativePath),
      kind: entry.kind,
      bytes: entry.size,
      revision: entry.revision,
    })
  }

  await emit(options, 'workspace.ready', {
    workspace: options.workspace,
    revision: cloud.revision,
    service: cloudService.type,
    contract: summarizeGraphContract(cloud),
    requester,
    adapter: workspaceMode.adapter,
    cacheMode: workspaceMode.cacheMode,
    scopeCounts: countCloudScopes(cloud),
    hiddenScopeCounts: cloud.visibilityContext?.hiddenScopeCounts ?? { shared: 0, private: 0 },
  })
  await upsertWorkspaceIndexFromCloud(options, cloud, {
    reason: 'hydrate',
    lastEvent: 'workspace.ready',
    hydrationState: 'materialized',
    hydratedPaths: Object.keys(cloud.files ?? {}),
  })
}

async function hydrateWorkspaceFile(options) {
  await hydrateWorkspacePaths(options, {
    action: 'hydrate-file',
    reason: 'lazy-hydrate',
    event: 'file.lazy_hydrated',
    recursive: false,
  })
}

async function hydrateWorkspacePath(options) {
  await hydrateWorkspacePaths(options, {
    action: 'hydrate-path',
    reason: 'hydrate-path',
    event: 'file.lazy_hydrated',
    recursive: Boolean(options.recursive),
  })
}

async function hydrateWorkspacePaths(options, command) {
  const requestedPath = options.path ?? options.file
  if (!requestedPath) {
    throw new Error(`workspace ${command.action} requires --path <cloud-path>.`)
  }
  await assertWorkspacePathSafe(options)
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readVisibleGraph(visibilityRequestFromOptions(options))
  const paths = selectedCloudPaths(cloud, requestedPath, { recursive: command.recursive })
  const hydratedFiles = []

  for (const relativePath of paths) {
    const file = cloud.files?.[relativePath]
    if (!file) continue
    const entry = normalizeCloudFileEntry(relativePath, file)
    await materializeCloudEntry(options.workspace, relativePath, entry, cloudService, {
      codebaseId: cloud.codebase?.id ?? options['codebase-id'] ?? 'hopit',
    })
    hydratedFiles.push({
      path: relativePath,
      file,
      entry,
    })
  }

  const now = new Date().toISOString()
  const hydratedPaths = await hydratedPathUnion(options, cloud.codebase?.id, hydratedFiles.map((file) => file.path))

  await emit(options, command.event, {
    path: hydratedFiles.length === 1 ? hydratedFiles[0].path : null,
    paths: hydratedFiles.map((file) => file.path),
    recursive: command.recursive,
    scope: hydratedFiles.length === 1 ? scopeForPath(hydratedFiles[0].path) : null,
    scopeCounts: countPathScopes(hydratedFiles.map((file) => file.path)),
    bytes: hydratedFiles.reduce((sum, file) => sum + (file.entry.size ?? 0), 0),
    workspace: options.workspace,
    service: cloudService.type,
    contract: summarizeGraphContract(cloud),
    hydratedPathCount: hydratedPaths.length,
  })
  const index = await upsertWorkspaceIndexFromCloud(options, cloud, {
    reason: command.reason,
    lastEvent: command.event,
    hydrationState: 'partial',
    hydratedPaths,
    materialization: 'partial-managed-folder',
    localCache: localCachePatchForPaths(cloud, hydratedFiles.map((file) => file.path), {
      now,
      state: 'hydrated',
      lastHydratedAt: now,
    }),
  })

  console.log(JSON.stringify({
    ok: true,
    action: command.action,
    path: hydratedFiles.length === 1 ? hydratedFiles[0].path : null,
    paths: hydratedFiles.map((file) => file.path),
    recursive: command.recursive,
    hydrated: hydratedFiles.length,
    workspace: path.resolve(options.workspace),
    file: hydratedFiles.length === 1
      ? workspaceFileMetadata(options, hydratedFiles[0].path, hydratedFiles[0].file, {
        forceExists: true,
        indexedCodebase: findIndexedCodebase(index, cloud.codebase?.id ?? options['codebase-id'], options.workspace),
      })
      : null,
    files: hydratedFiles.map(({ path: relativePath, file }) =>
      workspaceFileMetadata(options, relativePath, file, {
        forceExists: true,
        indexedCodebase: findIndexedCodebase(index, cloud.codebase?.id ?? options['codebase-id'], options.workspace),
      }),
    ),
    index: workspaceIndexSummary(options, index),
    hydration: findIndexedCodebase(index, cloud.codebase?.id ?? options['codebase-id'], options.workspace)?.hydration ?? null,
  }, null, 2))
}

async function dehydrateWorkspace(options) {
  if (!options.force) {
    throw new Error('workspace dehydrate requires --force because it removes local cached file contents.')
  }
  await assertWorkspacePathSafe(options)
  const journalSafety = await readJournalSafety(options)
  if (!journalSafety.safe) {
    throw new Error('Cannot dehydrate while the local journal has pending or failed entries.')
  }

  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readVisibleGraph(visibilityRequestFromOptions(options))
  const removedPaths = []
  for (const relativePath of sortPathsDeepestFirst(Object.keys(cloud.files ?? {}))) {
    const absolutePath = workspaceFilePath(options.workspace, relativePath)
    if (!existsSync(absolutePath)) continue
    await fs.rm(absolutePath, { recursive: true, force: true })
    await removeEmptyAncestorDirectories(options.workspace, path.dirname(relativePath))
    removedPaths.push(relativePath)
  }

  await writeWorkspaceMetadataManifest(options, cloud, {
    materialization: 'metadata-only',
    removedPaths,
  })
  await emit(options, 'workspace.dehydrated', {
    workspace: options.workspace,
    removed: removedPaths.length,
    removedScopeCounts: countPathScopes(removedPaths),
    revision: cloud.revision,
    service: cloudService.type,
    contract: summarizeGraphContract(cloud),
  })
  const index = await upsertWorkspaceIndexFromCloud(options, cloud, {
    reason: 'dehydrate',
    lastEvent: 'workspace.dehydrated',
    hydrationState: 'metadata-only',
    hydratedPaths: [],
    materialization: 'metadata-only',
  })

  console.log(JSON.stringify({
    ok: true,
    action: 'dehydrate',
    removed: removedPaths.length,
    removedScopeCounts: countPathScopes(removedPaths),
    workspace: path.resolve(options.workspace),
    index: workspaceIndexSummary(options, index),
  }, null, 2))
}

async function pruneWorkspaceCache(options) {
  await assertWorkspacePathSafe(options)
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readVisibleGraph(visibilityRequestFromOptions(options))
  const target = options.path ?? 'all'
  const targetPaths = selectedCloudPaths(cloud, target, { recursive: target === 'all' || Boolean(options.recursive) })
  const [workspaceIndex, diskEntries, journalEntries, eventEntries] = await Promise.all([
    readWorkspaceIndex(options),
    readWorkspaceFiles(options.workspace, options),
    readNdjson(options.journal),
    readNdjson(options.events),
  ])
  const journalState = classifyJournalEntries(journalEntries, eventEntries)
  const indexedCodebase = findIndexedCodebase(workspaceIndex, cloud.codebase?.id ?? options['codebase-id'], options.workspace)
  const inactiveMs = parseNonNegativeIntegerOption(options['inactive-ms'], 0)
  const now = new Date().toISOString()
  const nowMs = Date.now()
  const candidates = []
  const skipped = []

  for (const relativePath of targetPaths) {
    const diskEntry = diskEntries[relativePath]
    const cached = indexedCodebase?.localCache?.files?.[relativePath] ?? {}
    const manifestEntry = indexedCodebase?.contentManifest?.files?.[relativePath] ?? null
    const pathJournalEntries = journalState.entries.filter((entry) => entry.path === relativePath)
    const unresolved = pathJournalEntries.find((entry) => entry.recoveryStatus === 'pending' || entry.recoveryStatus === 'failed')

    if (!diskEntry) {
      skipped.push({ path: relativePath, reason: 'not_hydrated' })
      continue
    }
    if (cached.pinned) {
      skipped.push({ path: relativePath, reason: 'pinned' })
      continue
    }
    if (unresolved) {
      skipped.push({ path: relativePath, reason: `journal_${unresolved.recoveryStatus}` })
      continue
    }
    if (!manifestEntry) {
      skipped.push({ path: relativePath, reason: 'not_acknowledged_in_manifest' })
      continue
    }
    if (manifestEntryChanged(manifestEntry, normalizeCloudFileEntry(relativePath, diskEntry))) {
      skipped.push({ path: relativePath, reason: 'dirty' })
      continue
    }
    if (inactiveMs > 0) {
      const lastActiveAt = latestIsoTimestamp([
        cached.lastSyncedAt,
        cached.lastHydratedAt,
        cached.lastEditedAt,
      ])
      if (lastActiveAt && nowMs - new Date(lastActiveAt).getTime() < inactiveMs) {
        skipped.push({ path: relativePath, reason: 'recently_active', lastActiveAt })
        continue
      }
    }

    candidates.push({
      path: relativePath,
      size: Number.isInteger(diskEntry.size) ? diskEntry.size : manifestEntry.size ?? null,
      revision: manifestEntry.revision ?? null,
    })
  }

  const execute = Boolean(options.execute)
  const removedPaths = []
  if (execute) {
    for (const candidate of candidates) {
      await fs.rm(workspaceFilePath(options.workspace, candidate.path), { recursive: true, force: true })
      await removeEmptyAncestorDirectories(options.workspace, path.dirname(candidate.path))
      removedPaths.push(candidate.path)
    }
  }

  let index = workspaceIndex
  if (execute && removedPaths.length > 0) {
    const visiblePaths = Object.keys(cloud.files ?? {})
    const hydratedPaths = hydratedPathsAfterPrune(indexedCodebase, visiblePaths, removedPaths)
    const hydrationState = hydrationStateForHydratedPaths(hydratedPaths, visiblePaths)
    index = await upsertWorkspaceIndexFromCloud(options, cloud, {
      reason: 'prune',
      lastEvent: 'cache.evicted',
      hydrationState,
      hydratedPaths,
      materialization: materializationForHydrationState(hydrationState),
      prunedPaths: removedPaths,
      localCache: localCachePatchForPaths(cloud, removedPaths, {
        now,
        state: 'cloud-only',
        lastPrunedAt: now,
        bytesOnDisk: null,
      }),
    })
  }

  const result = {
    ok: true,
    action: 'prune',
    mode: execute ? 'execute' : 'dry-run',
    target,
    recursive: target === 'all' || Boolean(options.recursive),
    inactiveMs,
    workspace: path.resolve(options.workspace),
    candidates,
    candidateCount: candidates.length,
    candidateBytes: candidates.reduce((sum, candidate) => sum + (candidate.size ?? 0), 0),
    removed: removedPaths.length,
    removedPaths,
    skipped,
    skippedCount: skipped.length,
    index: workspaceIndexSummary(options, index),
    hydration: findIndexedCodebase(index, cloud.codebase?.id ?? options['codebase-id'], options.workspace)?.hydration ?? null,
  }
  await emit(options, execute ? 'cache.evicted' : 'cache.prune_planned', result)
  console.log(JSON.stringify(result, null, 2))
}

async function setWorkspaceCachePin(options, pinned) {
  const requestedPath = options.path ?? options.file
  if (!requestedPath) {
    throw new Error(`workspace ${pinned ? 'pin' : 'unpin'} requires --path <cloud-path>.`)
  }

  await assertWorkspacePathSafe(options)
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readVisibleGraph(visibilityRequestFromOptions(options))
  const paths = selectedCloudPaths(cloud, requestedPath, { recursive: Boolean(options.recursive) })
  const now = new Date().toISOString()
  const workspaceIndex = await readWorkspaceIndex(options)
  const indexedCodebase =
    findIndexedCodebase(workspaceIndex, cloud.codebase?.id ?? options['codebase-id'], options.workspace) ??
    workspaceIndexEntryFromCloud(options, cloud, {
      reason: 'attach',
      lastEvent: null,
      hydrationState: 'metadata-only',
      hydratedPaths: [],
      materialization: 'metadata-only',
      now,
    })
  const files = {}
  for (const relativePath of paths) {
    const exists = existsSync(workspaceFilePath(options.workspace, relativePath))
    files[relativePath] = {
      pinned,
      state: pinned ? 'pinned' : exists ? 'hydrated' : 'cloud-only',
    }
  }
  const localCache = {
    schemaVersion: localCacheSchemaVersion,
    updatedAt: now,
    files,
  }
  const index = await upsertWorkspaceIndex(options, {
    ...indexedCodebase,
    localCache,
    updatedAt: now,
  })

  const result = {
    ok: true,
    action: pinned ? 'pin' : 'unpin',
    path: paths.length === 1 ? paths[0] : null,
    paths,
    recursive: Boolean(options.recursive),
    workspace: path.resolve(options.workspace),
    index: workspaceIndexSummary(options, index),
    cache: findIndexedCodebase(index, cloud.codebase?.id ?? options['codebase-id'], options.workspace)?.localCache?.summary ?? null,
  }
  await emit(options, pinned ? 'cache.pinned' : 'cache.unpinned', result)
  console.log(JSON.stringify(result, null, 2))
}

async function discoverWorkspaces(options, discoverOptions = {}) {
  const action = discoverOptions.action ?? 'discover'
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readOptionalVisibleGraph(visibilityRequestFromOptions(options))
  const cloudDiscovery = await discoverCloudCodebases(options, cloudService, cloud)
  const index = await readWorkspaceIndex(options)
  const rootPath = path.resolve(workspaceRootFromOptions(options))
  const codebases = []

  if (cloudDiscovery.discovery.startsWith('configured-codebase') && cloud?.codebase) {
    codebases.push(discoveredCloudCodebase(options, cloud, index, cloudService))
  } else if (cloudDiscovery.codebases.length > 0) {
    for (const cloudCodebase of cloudDiscovery.codebases) {
      codebases.push(discoveredCloudCodebaseHead(options, cloudCodebase, index, cloudService))
    }
  } else if (cloud?.codebase) {
    codebases.push(discoveredCloudCodebase(options, cloud, index, cloudService))
  }

  const discoveredKeys = new Set(codebases.map((entry) => workspaceIndexEntryKey(entry)))
  for (const indexedCodebase of index?.codebases ?? []) {
    const key = workspaceIndexEntryKey(indexedCodebase)
    if (discoveredKeys.has(key)) continue
    codebases.push({
      ...indexedCodebase,
      source: 'workspace-index',
      attached: true,
      available: false,
    })
  }

  console.log(JSON.stringify({
    ok: true,
    action,
    root: {
      path: rootPath,
      exists: existsSync(rootPath),
      adapter: workspaceMode.adapter,
      cacheMode: workspaceMode.cacheMode,
      sourceOfTruth: workspaceMode.sourceOfTruth,
      virtualized: false,
      index: workspaceIndexSummary(options, index),
    },
    cloud: {
      service: cloudService.type,
      path: cloudService.location ?? cloudLocationFromOptions(options),
      exists: Boolean(cloud),
      discovery: cloudDiscovery.discovery,
      error: cloudDiscovery.error,
    },
    codebases,
  }, null, 2))
}

async function discoverCloudCodebases(options, cloudService, configuredCloud) {
  if (typeof cloudService.listCodebases !== 'function') {
    return {
      discovery: 'configured-codebase',
      codebases: configuredCloud?.codebase ? [graphHeadFromGraph(configuredCloud)] : [],
      error: null,
    }
  }

  try {
    const codebases = (await cloudService.listCodebases(visibilityRequestFromOptions(options)))
      .map(normalizeCloudGraphHead)
      .filter((codebase) => codebase?.codebase?.id)
    return {
      discovery: codebases.length > 0 ? 'account-codebases' : 'account-codebases-empty',
      codebases,
      error: null,
    }
  } catch (error) {
    return {
      discovery: 'configured-codebase-fallback',
      codebases: configuredCloud?.codebase ? [graphHeadFromGraph(configuredCloud)] : [],
      error: error instanceof Error ? error.message : 'Account-wide codebase discovery failed.',
    }
  }
}

async function attachWorkspace(options) {
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readVisibleGraph(visibilityRequestFromOptions(options))
  const attachOptions = workspaceOptionsForCloudCodebase(options, cloud)
  await assertWorkspacePathSafe(attachOptions)
  const index = await readWorkspaceIndex(attachOptions)
  const existing = findIndexedCodebase(
    index,
    cloud.codebase?.id ?? attachOptions['codebase-id'],
    attachOptions.workspace,
  )

  if (existing && existing.hydration?.state !== 'metadata-only' && !options.force) {
    console.log(JSON.stringify({
      ok: true,
      action: 'attach',
      alreadyAttached: true,
      root: workspaceIndexRoot(attachOptions),
      workspace: path.resolve(attachOptions.workspace),
      codebase: existing,
      files: {
        visible: existing.visibleFileCount ?? Object.keys(cloud.files ?? {}).length,
        hydrated: existing.hydration?.hydratedPathCount ?? null,
        materialization: existing.materialization ?? null,
      },
      index: workspaceIndexSummary(attachOptions, index),
      note: 'Existing attached workspace was left unchanged. Use hydrate-file, hydrate, or refresh for materialization changes.',
    }, null, 2))
    return
  }

  await assertAttachWorkspaceSafe(attachOptions, cloud, index)

  await fs.mkdir(workspaceRootFromOptions(attachOptions), { recursive: true })
  await fs.mkdir(attachOptions.workspace, { recursive: true })
  await writeWorkspaceMetadataManifest(attachOptions, cloud, {
    materialization: 'metadata-only',
    attached: true,
  })

  await emit(attachOptions, 'workspace.attached', {
    workspace: attachOptions.workspace,
    codebaseId: cloud.codebase?.id ?? attachOptions['codebase-id'] ?? null,
    codebaseName: cloud.codebase?.name ?? null,
    revision: cloud.revision,
    service: cloudService.type,
    contract: summarizeGraphContract(cloud),
    requester: summarizeRequester(cloud.visibilityContext),
    adapter: workspaceMode.adapter,
    cacheMode: workspaceMode.cacheMode,
    materialization: 'metadata-only',
    visibleFileCount: Object.keys(cloud.files ?? {}).length,
    scopeCounts: countCloudScopes(cloud),
    hiddenScopeCounts: cloud.visibilityContext?.hiddenScopeCounts ?? { shared: 0, private: 0 },
  })

  const attachedIndex = await upsertWorkspaceIndexFromCloud(attachOptions, cloud, {
    reason: 'attach',
    lastEvent: 'workspace.attached',
    hydrationState: 'metadata-only',
    hydratedPaths: [],
    materialization: 'metadata-only',
  })
  const indexedCodebase = findIndexedCodebase(
    attachedIndex,
    cloud.codebase?.id ?? attachOptions['codebase-id'],
    attachOptions.workspace,
  )

  console.log(JSON.stringify({
    ok: true,
    action: 'attach',
    alreadyAttached: Boolean(existing),
    root: workspaceIndexRoot(attachOptions),
    workspace: path.resolve(attachOptions.workspace),
    codebase: indexedCodebase,
    files: {
      visible: Object.keys(cloud.files ?? {}).length,
      hydrated: 0,
      materialization: 'metadata-only',
    },
    index: workspaceIndexSummary(attachOptions, attachedIndex),
  }, null, 2))
}

async function refreshWorkspace(options) {
  await assertWorkspacePathSafe(options)
  const cloudService = createCloudGraphService(options)
  const visibilityRequest = visibilityRequestFromOptions(options)
  const cloud = await cloudService.readVisibleGraph(visibilityRequest)
  const eventEntries = await readNdjson(options.events)
  const lastVisibleWorkspaceEvent = findLastEventOf(eventEntries, [
    'workspace.ready',
    'refresh.complete',
    'remote-update',
  ])
  const journalSafety = await readJournalSafety(options)
  const startedDetail = {
    workspace: options.workspace,
    revision: cloud.revision,
    service: cloudService.type,
    contract: summarizeGraphContract(cloud),
    requester: summarizeRequester(cloud.visibilityContext),
    adapter: workspaceMode.adapter,
    cacheMode: workspaceMode.cacheMode,
    scopeCounts: countCloudScopes(cloud),
    hiddenScopeCounts: cloud.visibilityContext?.hiddenScopeCounts ?? { shared: 0, private: 0 },
    journal: journalSafety.summary,
  }

  await emit(options, 'refresh.started', startedDetail)

  if (!journalSafety.safe) {
    const blockedDetail = {
      ...startedDetail,
      state: 'blocked',
      reason: 'journal_has_unresolved_entries',
      pendingCount: journalSafety.pendingEntries.length,
      failedCount: journalSafety.failedEntries.length,
      pendingScopeCounts: countEntryScopes(journalSafety.pendingEntries),
      failedScopeCounts: countEntryScopes(journalSafety.failedEntries),
    }
    await emit(options, 'refresh.blocked', blockedDetail)
    throw new Error('Refresh blocked because the local journal has pending or failed entries.')
  }

  const workspaceIndex = await readWorkspaceIndex(options)
  const indexedCodebase = findIndexedCodebase(workspaceIndex, cloud.codebase?.id ?? options['codebase-id'], options.workspace)
  const localChanges = existsSync(options.workspace)
    ? await workspaceLocalChanges(options, indexedCodebase)
    : { safe: true, state: 'missing', reason: null }
  if (!localChanges.safe) {
    const blockedDetail = {
      ...startedDetail,
      state: 'blocked',
      reason: localChanges.reason,
      localChanges,
    }
    await emit(options, 'refresh.blocked', blockedDetail)
    throw new Error('Refresh blocked because the local workspace has unjournaled changes.')
  }

  const result = await materializeCloudToWorkspace(options, cloud, cloudService)
  if (result.written > 0 || result.deleted > 0) {
    await emit(options, 'remote-update', {
      workspace: options.workspace,
      service: cloudService.type,
      contract: summarizeGraphContract(cloud),
      requester: summarizeRequester(cloud.visibilityContext),
      selectedStateId: cloud.selectedState?.id ?? null,
      selectedStateType: cloud.selectedState?.type ?? null,
      fromRevision: visibleRevisionFromEvent(lastVisibleWorkspaceEvent),
      toRevision: cloud.revision,
      changedPaths: result.changedPaths,
      deletedPaths: result.deletedPaths,
      changedScopeCounts: countPathScopes(result.changedPaths),
      deletedScopeCounts: countPathScopes(result.deletedPaths),
      scopeCounts: countPathScopes([...result.changedPaths, ...result.deletedPaths]),
      hiddenScopeCounts: cloud.visibilityContext?.hiddenScopeCounts ?? { shared: 0, private: 0 },
    })
  }
  await emit(options, 'refresh.complete', {
    ...startedDetail,
    ...result,
  })
  await upsertWorkspaceIndexFromCloud(options, cloud, {
    reason: 'refresh',
    lastEvent: 'refresh.complete',
    hydrationState: 'materialized',
    hydratedPaths: Object.keys(cloud.files ?? {}),
  })
}

async function materializeCloudToWorkspace(options, cloud, cloudService = null) {
  await fs.mkdir(options.workspace, { recursive: true })

  const diskEntries = await readWorkspaceFiles(options.workspace, options)
  const cloudPaths = new Set(Object.keys(cloud.files ?? {}))
  const changedPaths = []
  const deletedPaths = []
  let written = 0
  let deleted = 0
  let unchanged = 0

  for (const [relativePath, file] of Object.entries(cloud.files ?? {})) {
    const entry = normalizeCloudFileEntry(relativePath, file)
    const diskEntry = diskEntries[relativePath] ? normalizeCloudFileEntry(relativePath, diskEntries[relativePath]) : null
    if (diskEntry && cloudEntryEquals(diskEntry, entry)) {
      unchanged += 1
      continue
    }

    await materializeCloudEntry(options.workspace, relativePath, entry, cloudService)
    changedPaths.push(relativePath)
    written += 1
  }

  for (const relativePath of sortPathsDeepestFirst(Object.keys(diskEntries))) {
    if (cloudPaths.has(relativePath)) continue

    await fs.rm(workspaceFilePath(options.workspace, relativePath), { recursive: true, force: true })
    await removeEmptyAncestorDirectories(options.workspace, path.dirname(relativePath))
    deletedPaths.push(relativePath)
    deleted += 1
  }

  return {
    workspace: options.workspace,
    revision: cloud.revision,
    written,
    deleted,
    unchanged,
    changedPaths,
    deletedPaths,
    fileCount: cloudPaths.size,
    scopeCounts: countCloudScopes(cloud),
    hiddenScopeCounts: cloud.visibilityContext?.hiddenScopeCounts ?? { shared: 0, private: 0 },
  }
}

async function materializeCloudEntry(root, relativePath, file, cloudService = null, context = {}) {
  const entry = normalizeCloudFileEntry(relativePath, file)
  const absolutePath = workspaceFilePath(root, relativePath)

  await fs.mkdir(path.dirname(absolutePath), { recursive: true })

  if (entry.kind === entryKind.directory) {
    await replacePathIfWrongType(absolutePath, 'directory')
    await fs.mkdir(absolutePath, { recursive: true })
    return
  }

  if (entry.kind === entryKind.symlink) {
    await fs.rm(absolutePath, { recursive: true, force: true })
    await fs.symlink(entry.target, absolutePath)
    return
  }

  await replacePathIfWrongType(absolutePath, 'file')
  await fs.writeFile(absolutePath, await bufferFromCloudFileEntry(entry, cloudService, {
    ...context,
    relativePath,
  }))
}

async function replacePathIfWrongType(absolutePath, expectedType) {
  if (!existsSync(absolutePath)) return

  const stat = await fs.lstat(absolutePath)
  const matches =
    (expectedType === 'file' && stat.isFile()) ||
    (expectedType === 'directory' && stat.isDirectory() && !stat.isSymbolicLink())

  if (!matches) {
    await fs.rm(absolutePath, { recursive: true, force: true })
  }
}

function sortPathsDeepestFirst(paths) {
  return [...paths].sort((a, b) => {
    const depth = b.split('/').length - a.split('/').length
    return depth || b.localeCompare(a)
  })
}

async function syncOnce(options, context = {}) {
  const unresolvedFailure = await hasUnresolvedSyncFailure(options)
  const contextDetail = syncContextDetail(context)

  await emit(options, 'sync.started', contextDetail)

  try {
    const result = await performSyncOnce(options, contextDetail)
    if (unresolvedFailure) {
      await emit(options, 'sync.recovered', {
        ...contextDetail,
        lastFailedSync: unresolvedFailure,
        lastSuccessfulSync: result,
      })
    }
    return result
  } catch (error) {
    await emit(options, 'sync.failed', {
      ...contextDetail,
      reason: error.message,
    })
    throw error
  }
}

async function performSyncOnce(options, contextDetail = {}) {
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()
  const diskEntries = await readWorkspaceFiles(options.workspace, options)
  const visibilityContext = visibilityContextForGraph(cloud, visibilityRequestFromOptions(options))
  const visibleCloudPaths = Object.keys(cloud.files).filter((relativePath) =>
    canRequesterSeePath(visibilityContext, relativePath),
  )
  const workspaceIndex = await readWorkspaceIndex(options)
  const indexedCodebase = findIndexedCodebase(
    workspaceIndex,
    cloud.codebase?.id ?? options['codebase-id'],
    options.workspace,
  )
  const deleteCandidatePaths = deletableCloudPathsForWorkspace(indexedCodebase, visibleCloudPaths)
  const cloudPaths = new Set(
    Object.keys(cloud.files).filter((relativePath) => canRequesterSeePath(visibilityContext, relativePath)),
  )
  const writeEvents = []
  const now = new Date().toISOString()

  for (const [relativePath, rawEntry] of Object.entries(diskEntries)) {
    if (!canRequesterSeePath(visibilityContext, relativePath)) continue

    const entryPayload = normalizeCloudFileEntry(relativePath, rawEntry)
    const current = cloud.files[relativePath]
      ? normalizeCloudFileEntry(relativePath, cloud.files[relativePath])
      : null
    const scope = scopeForPath(relativePath)
    cloudPaths.delete(relativePath)

    if (current && cloudEntryEquals(current, entryPayload)) continue

    const entry = {
      id: randomUUID(),
      type: current ? 'write' : 'create',
      path: relativePath,
      kind: entryPayload.kind,
      scope,
      privacyZone: privacyZoneForPath(relativePath),
      hash: entryPayload.hash,
      bytes: entryPayload.size,
      encoding: entryPayload.encoding,
      target: entryPayload.target ?? null,
      baseRevision: current?.revision ?? null,
      createdAt: now,
      status: 'pending',
      ...journalContextForCloud(cloud),
    }

    await appendNdjson(options.journal, entry)
    await emit(options, 'write.journaled', entry)

    const acknowledgement = await cloudService.commitJournalEntry(cloud, entry, {
      entry: entryPayload,
      now,
    })
    await emit(options, 'cloud.acknowledged', acknowledgement)

    writeEvents.push(entry)
  }

  for (const relativePath of cloudPaths) {
    if (!deleteCandidatePaths.has(relativePath)) continue

    const scope = scopeForPath(relativePath)
    const entry = {
      id: randomUUID(),
      type: 'delete',
      path: relativePath,
      kind: cloud.files[relativePath]?.kind ?? entryKind.file,
      scope,
      privacyZone: privacyZoneForPath(relativePath),
      baseRevision: cloud.files[relativePath]?.revision ?? null,
      createdAt: now,
      status: 'pending',
      ...journalContextForCloud(cloud),
    }

    await appendNdjson(options.journal, entry)
    await emit(options, 'write.journaled', entry)

    const acknowledgement = await cloudService.commitJournalEntry(cloud, entry, { now })
    await emit(options, 'cloud.acknowledged', acknowledgement)

    writeEvents.push(entry)
  }

  if (!cloudService.usesAtomicFileMutations) {
    await cloudService.writeGraph(cloud)
  }
  const result = {
    ...contextDetail,
    writes: writeEvents.length,
    revision: cloud.revision,
    service: cloudService.type,
    contract: summarizeGraphContract(cloud),
    scopeCounts: countCloudScopes(cloud),
    journaledScopeCounts: countEntryScopes(writeEvents),
  }
  await emit(options, 'sync.complete', result)
  const visibleCloud = filterVisibleGraphForRequester(cloud, visibilityRequestFromOptions(options))
  await upsertWorkspaceIndexFromCloud(options, visibleCloud, {
    reason: 'sync',
    lastEvent: 'sync.complete',
    hydrationState: workspaceIndexHydrationStateForSync(indexedCodebase),
    hydratedPaths: hydratedPathsAfterSync(indexedCodebase, Object.keys(diskEntries), Object.keys(visibleCloud.files ?? {})),
    syncedPaths: writeEvents.map((entry) => entry.path).filter(Boolean),
  })
  return result
}

async function recoverJournal(options) {
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()

  const journalEntries = await readNdjson(options.journal)
  const eventEntries = await readNdjson(options.events)
  const journalState = classifyJournalEntries(journalEntries, eventEntries)
  const candidates = journalState.entries.filter((entry) => entry.recoveryStatus !== 'acknowledged')
  const recoveredPaths = []
  const result = {
    totalJournalEntries: journalEntries.length,
    attempted: 0,
    acknowledged: 0,
    failed: 0,
    skipped: journalEntries.length - candidates.length,
  }

  for (const entry of candidates) {
    result.attempted += 1
    const now = new Date().toISOString()

    try {
      const recovery = await prepareRecovery(cloud, entry, options.workspace)
      const acknowledgement = await cloudService.commitJournalEntry(cloud, entry, {
        entry: recovery.entry,
        now,
      })
      await emit(options, 'cloud.acknowledged', {
        ...acknowledgement,
        recovered: true,
        recoveryReason: recovery.reason,
      })
      result.acknowledged += 1
      if (entry.path) recoveredPaths.push(entry.path)
    } catch (error) {
      result.failed += 1
      if (error instanceof ConflictError) {
        const conflict = recordChangeSetConflict(cloud, {
          ...error.detail,
          detectedAt: new Date().toISOString(),
        })
        await cloudService.writeGraph(cloud)
        await emit(options, 'change_set.conflict_detected', conflict)
      }
      await emit(options, 'journal.recovery_failed', {
        id: entry.id,
        type: entry.type,
        path: entry.path,
        scope: entry.scope ?? scopeForPath(entry.path ?? ''),
        reason: error.message,
      })
    }
  }

  await emit(options, 'journal.recovery_complete', {
    ...result,
    revision: cloud.revision,
    service: cloudService.type,
    contract: summarizeGraphContract(cloud),
    scopeCounts: countCloudScopes(cloud),
  })

  if (result.acknowledged > 0 && result.failed === 0) {
    const workspaceIndex = await readWorkspaceIndex(options)
    const indexedCodebase = findIndexedCodebase(
      workspaceIndex,
      cloud.codebase?.id ?? options['codebase-id'],
      options.workspace,
    )
    const diskEntries = await readWorkspaceFiles(options.workspace, options)
    const hydrationState = workspaceIndexHydrationStateForSync(indexedCodebase)
    const visibleCloud = filterVisibleGraphForRequester(cloud, visibilityRequestFromOptions(options))
    await upsertWorkspaceIndexFromCloud(options, visibleCloud, {
      reason: 'recover',
      lastEvent: 'journal.recovery_complete',
      hydrationState,
      hydratedPaths: hydratedPathsAfterSync(indexedCodebase, Object.keys(diskEntries), Object.keys(visibleCloud.files ?? {})),
      materialization: hydrationState === 'materialized' ? 'managed-folder' : 'partial-managed-folder',
      syncedPaths: recoveredPaths,
    })
  }

  return result
}

async function openChangeSetReview(options) {
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()
  const now = new Date().toISOString()
  const actorId = actorIdFromOptions(options, cloud)

  ensureActiveChangeSet(cloud)

  if (cloud.selectedState.mergeState === 'merged') {
    throw new Error('Cannot open review because the selected change set is already merged.')
  }

  cloud.selectedState.reviewState = 'open'
  cloud.selectedState.review = {
    state: 'open',
    openedAt: cloud.selectedState.review?.openedAt ?? now,
    openedBy: cloud.selectedState.review?.openedBy ?? actorId,
  }

  await cloudService.writeGraph(cloud)
  await emit(options, 'change_set.review_opened', {
    selectedStateId: cloud.selectedState.id,
    selectedStateType: cloud.selectedState.type,
    selectedStateRevision: cloud.selectedState.revision,
    mainId: cloud.main.id,
    mainRevision: cloud.main.revision,
    reviewState: cloud.selectedState.reviewState,
    openedAt: cloud.selectedState.review.openedAt,
    openedBy: cloud.selectedState.review.openedBy,
  })
}

async function mergeChangeSet(options) {
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()
  const now = new Date().toISOString()
  const actorId = actorIdFromOptions(options, cloud)

  ensureActiveChangeSet(cloud)

  if (cloud.selectedState.reviewState !== 'open') {
    throw new Error('Cannot merge because the selected change set is not open for review.')
  }

  if (cloud.selectedState.baseRevision !== cloud.main.revision) {
    const conflict = recordChangeSetConflict(cloud, {
      reason: 'main_revision_mismatch',
      expectedMainRevision: cloud.selectedState.baseRevision,
      actualMainRevision: cloud.main.revision,
      selectedStateId: cloud.selectedState.id,
      selectedStateRevision: cloud.selectedState.revision,
      detectedAt: now,
    })
    await cloudService.writeGraph(cloud)
    await emit(options, 'change_set.conflict_detected', conflict)
    throw new Error(
      `Cannot merge because Main moved from revision ${cloud.selectedState.baseRevision} to ${cloud.main.revision}.`,
    )
  }

  const previousMainRevision = cloud.main.revision
  cloud.main.revision = cloud.selectedState.revision
  cloud.main.mergedChangeSetId = cloud.selectedState.id
  cloud.main.updatedAt = now
  cloud.selectedState.reviewState = 'merged'
  cloud.selectedState.mergeState = 'merged'
  cloud.selectedState.merge = {
    state: 'merged',
    mergedAt: cloud.selectedState.merge?.mergedAt ?? now,
    mergedBy: cloud.selectedState.merge?.mergedBy ?? actorId,
    mainId: cloud.main.id,
    mainRevision: cloud.main.revision,
    previousMainRevision,
  }

  await cloudService.writeGraph(cloud)
  await emit(options, 'change_set.merged', {
    selectedStateId: cloud.selectedState.id,
    selectedStateType: cloud.selectedState.type,
    selectedStateRevision: cloud.selectedState.revision,
    mainId: cloud.main.id,
    mainRevision: cloud.main.revision,
    previousMainRevision,
    mergedAt: cloud.selectedState.merge.mergedAt,
    mergedBy: cloud.selectedState.merge.mergedBy,
    reviewState: cloud.selectedState.reviewState,
    mergeState: cloud.selectedState.mergeState,
  })
}

async function watchWorkspace(options) {
  await assertWorkspacePathSafe(options)
  const cloudService = createCloudGraphService(options)
  if (!(await cloudService.exists())) await initCloud(options)
  const recovery = await recoverJournal(options)
  if (recovery.failed > 0) {
    await emit(options, 'watch.recovery_blocked', {
      state: 'blocked',
      failed: recovery.failed,
      attempted: recovery.attempted,
      reason: 'pending journal entries could not be recovered',
    })
    throw new Error('Watch startup blocked because pending journal entries could not be recovered.')
  }
  await hydrateWorkspace(options)
  await emit(options, 'watch.started', {
    state: 'watching',
    workspace: options.workspace,
    adapter: workspaceMode.adapter,
    cacheMode: workspaceMode.cacheMode,
  })

  let watcher
  let poller = null
  let remotePuller = null
  const scheduleSync = createWatchSyncScheduler(options, {
    afterDrain: async (detail) => {
      await remotePuller?.schedule('local-change', detail)
    },
  })
  const degradeToPolling = async (error) => {
    if (!poller) {
      poller = await createWorkspacePoller(options.workspace, scheduleSync, { agentOptions: options })
    }
    await emit(options, 'watch.degraded', {
      state: 'polling',
      workspace: options.workspace,
      reason: error.message,
    })
  }

  try {
    watcher = watch(options.workspace, { recursive: true }, (eventType, filename) => {
      scheduleSync(eventType, normalizeWatchFilename(filename))
    })
  } catch (error) {
    try {
      await degradeToPolling(error)
    } catch (pollError) {
      await emit(options, 'watch.degraded', {
        state: 'unavailable',
        workspace: options.workspace,
        reason: `${error.message}; polling fallback failed: ${pollError.message}`,
      })
      throw pollError
    }
  }

  watcher?.on('error', (error) => {
    try {
      watcher.close()
    } catch {
      // The watcher may already be closed by the time Node surfaces the error.
    }
    watcher = null
    degradeToPolling(error).catch((emitError) => {
      console.error(emitError)
    })
  })

  remotePuller = await createRemoteRefreshScheduler(options, {
    localSyncIdle: () => scheduleSync.isIdle?.() ?? true,
  })

  console.log(`HopIt agent watching ${options.workspace}`)
  console.log('Press Ctrl+C to stop.')

  return {
    close() {
      try {
        watcher?.close()
      } catch {
        // Watchers may already be closed by an error handler.
      }
      poller?.close()
      remotePuller?.close()
    },
  }
}

function createWatchSyncScheduler(options, schedulerOptions = {}) {
  const debounceMs = schedulerOptions.debounceMs ?? 250
  let timer = null
  let running = false
  let queued = false
  let queuedEvents = 0
  let queuedSyncEvents = 0
  let lastEvent = null

  const drain = async () => {
    if (running) return
    running = true

    try {
      while (queued) {
        const coalescedEvents = queuedEvents
        const syncableEvents = queuedSyncEvents
        const triggeringEvent = lastEvent
        queued = false
        queuedEvents = 0
        queuedSyncEvents = 0
        lastEvent = null

        if (syncableEvents > 0) {
          try {
            await syncOnce(options, {
              trigger: 'watch',
              coalescedEvents,
              eventType: triggeringEvent?.eventType ?? null,
              path: triggeringEvent?.path ?? null,
            })
          } catch (error) {
            console.error(error)
          }
        }

        if (schedulerOptions.afterDrain) {
          try {
            await schedulerOptions.afterDrain({
              trigger: 'watch',
              coalescedEvents,
              eventType: triggeringEvent?.eventType ?? null,
              path: triggeringEvent?.path ?? null,
            })
          } catch (error) {
            console.error(error)
          }
        }
      }
    } finally {
      running = false
    }
  }

  const schedule = (eventType, filename) => {
    queued = true
    queuedEvents += 1
    if (!isLocalActivityMarkerPath(filename)) {
      queuedSyncEvents += 1
    }
    lastEvent = {
      eventType,
      path: filename,
    }

    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      drain().catch((error) => {
        console.error(error)
      })
    }, debounceMs)
  }

  schedule.isIdle = () => !running && !queued && timer === null
  return schedule
}

async function createWorkspacePoller(workspace, onChange, pollerOptions = {}) {
  const intervalMs = pollerOptions.intervalMs ?? 1000
  const agentOptions = pollerOptions.agentOptions ?? {}
  const snapshotOptions = {
    ...agentOptions,
    includeLocalActivityMarkers: true,
  }
  let previousSnapshot = await snapshotWorkspace(workspace, snapshotOptions)
  let running = false

  const interval = setInterval(() => {
    if (running) return
    running = true

    snapshotWorkspace(workspace, snapshotOptions)
      .then((nextSnapshot) => {
        if (nextSnapshot !== previousSnapshot) {
          const changedPath = firstChangedSnapshotPath(previousSnapshot, nextSnapshot)
          previousSnapshot = nextSnapshot
          onChange('poll', changedPath)
        }
      })
      .catch((error) => {
        console.error(error)
      })
      .finally(() => {
        running = false
      })
  }, intervalMs)

  return {
    close() {
      clearInterval(interval)
    },
  }
}

function firstChangedSnapshotPath(previousSnapshot, nextSnapshot) {
  const previous = snapshotLineMap(previousSnapshot)
  const next = snapshotLineMap(nextSnapshot)
  for (const [relativePath, line] of next) {
    if (previous.get(relativePath) !== line) return relativePath
  }
  for (const relativePath of previous.keys()) {
    if (!next.has(relativePath)) return relativePath
  }
  return null
}

function snapshotLineMap(snapshot) {
  const result = new Map()
  for (const line of snapshot.split('\n')) {
    if (!line) continue
    const separator = line.indexOf(':')
    const relativePath = separator === -1 ? line : line.slice(0, separator)
    result.set(relativePath, line)
  }
  return result
}

async function snapshotWorkspace(root, options = {}) {
  const files = []

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    let includedChildren = 0

    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name)
      const relativePath = toCloudPath(path.relative(root, absolutePath))
      if (
        shouldSkipWorkspacePath(relativePath, entry, options) &&
        !(options.includeLocalActivityMarkers && shouldTrackLocalActivityPath(relativePath, entry))
      ) {
        continue
      }

      if (entry.isSymbolicLink()) {
        const target = await fs.readlink(absolutePath)
        const stat = await fs.lstat(absolutePath)
        files.push(`${relativePath}:symlink:${target}:${stat.mtimeMs}`)
        includedChildren += 1
        continue
      }

      if (entry.isDirectory()) {
        const childCount = await walk(absolutePath)
        if (childCount === 0) {
          const stat = await fs.lstat(absolutePath)
          files.push(`${relativePath}:directory:0:${stat.mtimeMs}`)
          includedChildren += 1
        } else {
          includedChildren += childCount
        }
        continue
      }
      if (!entry.isFile()) continue

      const stat = await fs.lstat(absolutePath)
      files.push(`${relativePath}:file:${stat.size}:${stat.mtimeMs}`)
      includedChildren += 1
    }

    return includedChildren
  }

  await walk(root)
  files.sort()
  return files.join('\n')
}

async function createRemoteRefreshScheduler(options, schedulerOptions = {}) {
  if (!remotePullEnabled(options)) return null

  const cooldownMs = remoteRefreshIntervalMs(options)
  const localSyncIdle = schedulerOptions.localSyncIdle ?? (() => true)
  let closed = false
  let running = false
  let timer = null
  let queued = false
  let queuedTrigger = null
  let queuedDetail = null
  let lastRunAt = 0

  await emit(options, 'remote-pull.started', {
    state: 'activity-gated',
    mode: 'local-change-cooldown',
    workspace: options.workspace,
    intervalMs: cooldownMs,
    cooldownMs,
    adapter: workspaceMode.adapter,
    cacheMode: workspaceMode.cacheMode,
    safeRefreshOnly: true,
  })

  const run = async (trigger, detail = null) => {
    if (closed || running) return
    running = true

    try {
      const decision = await remoteRefreshDecision(options, {
        trigger,
        localSyncIdle,
      })

      if (decision.state === 'skip') {
        if (decision.emit) {
          await emit(options, 'remote-pull.skipped', decision.detail)
        }
        return
      }

      await refreshWorkspace(options)
      await emit(options, 'remote-pull.applied', {
        state: 'applied',
        trigger,
        activity: remotePullActivitySummary(detail),
        workspace: options.workspace,
        fromRevision: decision.fromRevision,
        toRevision: decision.toRevision,
        intervalMs: cooldownMs,
        cooldownMs,
        safeRefreshOnly: true,
      })
    } catch (error) {
      await emit(options, 'remote-pull.failed', {
        state: 'failed',
        trigger,
        activity: remotePullActivitySummary(detail),
        workspace: options.workspace,
        reason: error.message,
      })
    } finally {
      lastRunAt = Date.now()
      running = false
      if (queued && !closed) {
        const nextTrigger = queuedTrigger ?? 'local-change'
        const nextDetail = queuedDetail
        queued = false
        queuedTrigger = null
        queuedDetail = null
        await schedule(nextTrigger, nextDetail)
      }
    }
  }

  const schedule = async (trigger = 'local-change', detail = null) => {
    if (closed) return
    queued = true
    queuedTrigger = trigger
    queuedDetail = detail
    if (running || timer) return

    const elapsedMs = lastRunAt > 0 ? Date.now() - lastRunAt : cooldownMs
    const waitMs = Math.max(0, cooldownMs - elapsedMs)
    timer = setTimeout(() => {
      timer = null
      const nextTrigger = queuedTrigger ?? trigger
      const nextDetail = queuedDetail
      queued = false
      queuedTrigger = null
      queuedDetail = null
      run(nextTrigger, nextDetail).catch((error) => {
        console.error(error)
      })
    }, waitMs)
  }

  return {
    schedule,
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}

function remotePullActivitySummary(detail) {
  if (!detail || typeof detail !== 'object') return null
  return {
    trigger: detail.trigger ?? null,
    eventType: detail.eventType ?? null,
    path: detail.path ?? null,
    coalescedEvents: detail.coalescedEvents ?? null,
  }
}

async function remotePullOnce(options) {
  const trigger = options.trigger ?? 'manual'
  const intervalMs = remoteRefreshIntervalMs(options)
  await emit(options, 'remote-pull.started', {
    state: 'enabled',
    trigger,
    mode: 'once',
    workspace: options.workspace,
    intervalMs,
    adapter: workspaceMode.adapter,
    cacheMode: workspaceMode.cacheMode,
    safeRefreshOnly: true,
  })

  try {
    const decision = await remoteRefreshDecision(options, {
      trigger,
      localSyncIdle: () => true,
    })

    if (decision.state === 'skip') {
      if (decision.emit) {
        await emit(options, 'remote-pull.skipped', decision.detail)
      }

      const result = {
        ok: true,
        action: 'remote-pull',
        state: decision.emit ? 'skipped' : 'up-to-date',
        trigger,
        workspace: options.workspace,
        reason: decision.detail?.reason ?? null,
        detail: decision.detail ?? null,
      }
      console.log(JSON.stringify(result, null, 2))
      return result
    }

    await refreshWorkspace(options)
    const applied = {
      state: 'applied',
      trigger,
      workspace: options.workspace,
      fromRevision: decision.fromRevision,
      toRevision: decision.toRevision,
      intervalMs,
      safeRefreshOnly: true,
    }
    await emit(options, 'remote-pull.applied', applied)

    const result = {
      ok: true,
      action: 'remote-pull',
      ...applied,
    }
    console.log(JSON.stringify(result, null, 2))
    return result
  } catch (error) {
    await emit(options, 'remote-pull.failed', {
      state: 'failed',
      trigger,
      workspace: options.workspace,
      reason: error.message,
    })
    throw error
  }
}

async function remoteRefreshDecision(options, context) {
  if (!context.localSyncIdle()) {
    return {
      state: 'skip',
      emit: true,
      detail: {
        state: 'skipped',
        trigger: context.trigger,
        workspace: options.workspace,
        reason: 'local_sync_pending',
      },
    }
  }

  const journalSafety = await readJournalSafety(options)
  if (!journalSafety.safe) {
    return {
      state: 'skip',
      emit: true,
      detail: {
        state: 'skipped',
        trigger: context.trigger,
        workspace: options.workspace,
        reason: 'journal_has_unresolved_entries',
        journal: journalSafety.summary,
      },
    }
  }

  const cloudService = createCloudGraphService(options)
  const cloudHead = await cloudService.readGraphHead()
  if (!cloudHead?.exists) {
    return {
      state: 'skip',
      emit: true,
      detail: {
        state: 'skipped',
        trigger: context.trigger,
        workspace: options.workspace,
        reason: 'cloud_missing',
        service: cloudService.type,
      },
    }
  }

  if (!Number.isInteger(cloudHead.revision)) {
    return {
      state: 'skip',
      emit: true,
      detail: {
        state: 'skipped',
        trigger: context.trigger,
        workspace: options.workspace,
        reason: 'cloud_revision_missing',
        service: cloudService.type,
      },
    }
  }

  const eventEntries = await readNdjson(options.events)
  const lastVisibleWorkspaceEvent = findLastEventOf(eventEntries, [
    'workspace.ready',
    'refresh.complete',
    'remote-update',
  ])
  const workspaceIndex = await readWorkspaceIndex(options)
  const indexedCodebase = findIndexedCodebase(workspaceIndex, cloudHead.codebase?.id ?? options['codebase-id'], options.workspace)
  if (indexedCodebase?.hydration?.state && indexedCodebase.hydration.state !== 'materialized') {
    return {
      state: 'skip',
      emit: true,
      detail: {
        state: 'skipped',
        trigger: context.trigger,
        workspace: options.workspace,
        reason: 'workspace_not_fully_materialized',
        hydration: indexedCodebase.hydration,
      },
    }
  }

  const indexedRevision = indexedCodebase?.hydration?.lastMaterializedRevision
  const visibleRevision = Number.isInteger(indexedRevision)
    ? indexedRevision
    : visibleRevisionFromEvent(lastVisibleWorkspaceEvent)
  if (visibleRevision === cloudHead.revision) {
    return {
      state: 'skip',
      emit: false,
    }
  }

  const localChanges = await workspaceLocalChanges(options, indexedCodebase)
  if (!localChanges.safe) {
    return {
      state: 'skip',
      emit: true,
      detail: {
        state: 'skipped',
        trigger: context.trigger,
        workspace: options.workspace,
        reason: localChanges.reason,
        localChanges,
      },
    }
  }

  return {
    state: 'refresh',
    fromRevision: visibleRevision,
    toRevision: cloudHead.revision,
  }
}

async function serveStatus(options) {
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

async function runServiceCommand(action, options) {
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

async function runServiceProcess(options) {
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

async function startService(options) {
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
  const sessionToken = agentSessionTokenFromOptions(options)
  if (sessionToken) childEnv.HOPIT_AGENT_SESSION_TOKEN = sessionToken
  if (options['session-id']) childEnv.HOPIT_SESSION_ID = options['session-id']
  if (options['device-name']) childEnv.HOPIT_DEVICE_NAME = options['device-name']
  if (options.capabilities) childEnv.HOPIT_AGENT_SESSION_CAPABILITIES = options.capabilities

  const child = spawn(process.execPath, [__filename, 'service-run', ...runtimeArgsFromOptions(options)], {
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
    console.log(JSON.stringify({ ok: true, ...record, pidPath, service: status }, null, 2))
  } catch (error) {
    if (typeof child.pid === 'number' && isProcessRunning(child.pid)) {
      process.kill(child.pid, 'SIGTERM')
      await waitForProcessExit(child.pid, 2500)
    }
    await fs.rm(pidPath, { force: true })
    throw error
  }
}

async function waitForServiceReady(options, waitOptions) {
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
      lastStatus.agent?.watch?.state === 'watching' &&
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

async function stopService(options, stopOptions = {}) {
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

async function serviceStatus(options) {
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

  const running = processRunning || (Boolean(record?.pid) && endpointReachable && agent?.ok !== false)
  return {
    ok: running && !error && fresh && agent?.ok !== false,
    running,
    pid,
    pidPath,
    statusUrl: `http://${options.host}:${options.port}/status`,
    record,
    agent,
    error,
  }
}

async function readServiceLogAgent(record) {
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

function agentWatchStartedAfter(agent, startedAt) {
  if (!startedAt) return true
  const watchStartedAt = agent?.events?.lastWatchStarted?.at ?? agent?.watch?.lastStarted?.at
  if (!watchStartedAt) return false
  return isTimestampAtOrAfter(watchStartedAt, startedAt)
}

function isTimestampAtOrAfter(value, reference) {
  const time = Date.parse(value)
  const referenceTime = Date.parse(reference)
  if (Number.isNaN(time) || Number.isNaN(referenceTime)) return false
  return time >= referenceTime
}

async function readServiceRecord(pidPath) {
  if (!existsSync(pidPath)) return null
  return readJson(pidPath)
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessRunning(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function runtimeArgsFromOptions(options) {
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

async function runDemo(options) {
  const demoOptions = {
    ...options,
    cloud: options.cloud === defaultOptions.cloud ? '.hopit-agent/demo/cloud.json' : options.cloud,
    workspace:
      options.workspace === defaultOptions.workspace
        ? '.hopit-agent/demo/workspaces/hopit-core'
        : options.workspace,
    journal: options.journal === defaultOptions.journal ? '.hopit-agent/demo/journal.ndjson' : options.journal,
    events: options.events === defaultOptions.events ? '.hopit-agent/demo/events.ndjson' : options.events,
    force: true,
  }

  await initCloud(demoOptions)
  await hydrateWorkspace(demoOptions)

  const readmePath = path.join(demoOptions.workspace, 'README.md')
  await fs.appendFile(readmePath, '\nEdited through the HopIt managed workspace folder.\n', 'utf8')
  await emit(demoOptions, 'demo.editor_saved', { path: 'README.md', scope: scopeForPath('README.md') })

  const privatePath = '.private/agent-note.md'
  const privateAbsolutePath = path.join(demoOptions.workspace, privatePath)
  await fs.appendFile(privateAbsolutePath, '\nOwner-only demo snapshot.\n', 'utf8')
  await emit(demoOptions, 'demo.editor_saved', { path: privatePath, scope: scopeForPath(privatePath) })

  await syncOnce(demoOptions)

  const demoCloudService = createCloudGraphService(demoOptions)
  const cloud = await demoCloudService.readGraph()
  const readmeContent = await cloudFileTextForVerification(cloud.files['README.md'], demoCloudService)
  const privateContent = await cloudFileTextForVerification(cloud.files[privatePath], demoCloudService)
  const saved = readmeContent.includes('managed workspace folder')
  const privateSaved =
    cloud.files[privatePath]?.scope === fileScope.ownerPrivate &&
    privateContent.includes('Owner-only demo snapshot.')

  await emit(demoOptions, 'demo.verified', {
    cloud: demoOptions.cloud,
    workspace: demoOptions.workspace,
    journal: demoOptions.journal,
    saved,
    privateSaved,
    scopeCounts: countCloudScopes(cloud),
  })

  if (!saved || !privateSaved) {
    throw new Error('Demo verification failed: cloud did not receive the shared and private edits.')
  }
}

async function exportGitSnapshot(options, exportOptions) {
  if (!options.output) {
    throw new Error('Missing --output <path> for Git export/publish.')
  }

  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()
  validateCloudGraphContract(cloud)

  if (exportOptions.requireMerged && cloud.selectedState?.mergeState !== 'merged') {
    throw new Error('Publish requires the selected active change set to be reviewed and merged first.')
  }
  if (cloud.selectedState?.conflictState === 'conflicted') {
    throw new Error('Cannot export or publish a conflicted change set.')
  }

  const output = path.resolve(options.output)
  await assertExportOutputSafe(output, options)

  const files = {}
  const omittedPaths = []
  for (const [relativePath, file] of Object.entries(cloud.files ?? {})) {
    assertSafeCloudPath(relativePath)
    const isOwnerPrivate = scopeForPath(relativePath) === fileScope.ownerPrivate || file.scope === fileScope.ownerPrivate
    if (isOwnerPrivate && (exportOptions.requireMerged || !options['include-private'])) {
      omittedPaths.push(relativePath)
      continue
    }
    files[relativePath] = file
  }

  await prepareCleanOutputDirectory(output, options)
  for (const [relativePath, file] of Object.entries(files)) {
    await materializeCloudEntry(output, relativePath, normalizeCloudFileEntry(relativePath, file), cloudService)
  }

  runGit(['init'], output)
  runGit(['config', 'user.name', 'HopIt'], output)
  runGit(['config', 'user.email', 'agent@hopit.local'], output)
  runGit(['add', '.'], output)
  const message =
    options.message ??
    `${exportOptions.requireMerged ? 'Publish' : 'Export'} ${cloud.codebase?.name ?? cloud.codebase?.id ?? 'HopIt'} revision ${cloud.revision}`
  runGit(['commit', '--allow-empty', '-m', message], output)
  const commit = runGit(['rev-parse', 'HEAD'], output).stdout.trim()

  const result = {
    ok: true,
    command: exportOptions.requireMerged ? 'publish' : 'export',
    output,
    commit,
    files: Object.keys(files).length,
    omittedScopeCounts: countPathScopes(omittedPaths),
    omittedPrivatePaths: omittedPaths.length,
    codebaseId: cloud.codebase?.id ?? null,
    revision: cloud.revision,
    mainRevision: cloud.main?.revision ?? null,
    selectedStateId: cloud.selectedState?.id ?? null,
    selectedStateRevision: cloud.selectedState?.revision ?? null,
  }

  await emit(options, exportOptions.requireMerged ? 'git.published' : 'git.exported', result)
  console.log(JSON.stringify(result, null, 2))
}

async function validateCloud(options) {
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()
  validateCloudGraphContract(cloud)
  const result = {
    ok: true,
    service: cloudService.type,
    location: cloudService.location,
    contract: summarizeGraphContract(cloud),
    fileCount: Object.keys(cloud.files ?? {}).length,
    scopeCounts: countCloudScopes(cloud),
  }
  console.log(JSON.stringify(result, null, 2))
}

async function runDoctor(options) {
  let state = null
  let service = null
  const checks = []

  try {
    state = await readAgentState(options)
    checks.push(checkResult('cloud', state.status.cloud.exists, state.status.cloud.exists ? 'Cloud graph is reachable.' : 'Cloud graph is missing.'))
    checks.push(checkResult('workspace', state.status.workspace.exists, state.status.workspace.exists ? 'Workspace path exists.' : 'Workspace path is not created.'))
    checks.push(checkResult(
      'hydration',
      ['materialized', 'partial'].includes(state.status.workspace.hydration.state),
      `Workspace hydration is ${state.status.workspace.hydration.state}.`,
    ))
    checks.push(checkResult(
      'journal',
      state.status.journal.pendingCount === 0 && state.status.journal.failedCount === 0,
      `Journal pending=${state.status.journal.pendingCount}, failed=${state.status.journal.failedCount}.`,
    ))
    checks.push(checkResult(
      'remote-cursor',
      (state.status.remotePull.cursor.behindByRevisions ?? 0) === 0,
      `Workspace is ${state.status.remotePull.cursor.behindByRevisions ?? 'unknown'} revisions behind cloud.`,
    ))
  } catch (error) {
    checks.push(checkResult('agent-state', false, error.message))
  }

  try {
    service = await serviceStatus(options)
    checks.push(checkResult(
      'service',
      service.running && service.ok,
      service.running ? (service.ok ? 'Service is running and reachable.' : `Service is running but unhealthy: ${service.error}`) : 'Service is not running.',
    ))
  } catch (error) {
    checks.push(checkResult('service', false, error.message))
  }

  const failed = checks.filter((check) => !check.ok)
  const result = {
    ok: failed.length === 0,
    checkedAt: new Date().toISOString(),
    profile: options.profile,
    codebaseId: options['codebase-id'] ?? state?.status.codebaseId ?? null,
    checks,
    service: service
      ? {
          running: service.running,
          pid: service.pid,
          statusUrl: service.statusUrl,
          error: service.error,
        }
      : null,
    status: state?.status
      ? {
          readiness: state.status.readiness,
          hydration: state.status.workspace.hydration,
          pendingWrites: state.status.journal.pendingCount,
          failedWrites: state.status.journal.failedCount,
          remoteBehindByRevisions: state.status.remotePull.cursor.behindByRevisions,
          remotePull: state.status.remotePull.state,
          watch: state.status.watch.state,
        }
      : null,
  }

  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}

function checkResult(name, ok, detail) {
  return {
    name,
    ok: Boolean(ok),
    detail,
  }
}

async function backupAgentState(options) {
  const output = path.resolve(options.output ?? path.join(agentStateRootFromOptions(options), 'backups', backupDirectoryName(options)))
  await assertBackupOutputSafe(output, options)
  await prepareCleanOutputDirectory(output, options)

  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()
  const state = await readAgentState(options)
  const files = []

  await writeBackupFile(output, files, 'cloud.json', cloud)
  await writeBackupFile(output, files, 'status.json', state.status)
  await copyBackupFileIfExists(output, files, 'events.ndjson', options.events)
  await copyBackupFileIfExists(output, files, 'journal.ndjson', options.journal)
  await copyBackupFileIfExists(output, files, 'workspaces.json', workspaceIndexPath(options))

  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    codebaseId: cloud.codebase?.id ?? options['codebase-id'] ?? null,
    cloud: {
      service: cloudService.type,
      location: cloudService.location,
      revision: cloud.revision,
      fileCount: Object.keys(cloud.files ?? {}).length,
      scopeCounts: countCloudScopes(cloud),
    },
    workspace: {
      path: path.resolve(options.workspace),
      hydration: state.status.workspace.hydration,
    },
    files,
  }
  await writeBackupFile(output, files, 'manifest.json', manifest)

  console.log(JSON.stringify({
    ok: true,
    output,
    codebaseId: manifest.codebaseId,
    revision: manifest.cloud.revision,
    files: files.length,
    manifest: path.join(output, 'manifest.json'),
  }, null, 2))
}

async function mirrorSecretRoutesFromOptions(source, _options) {
  const routes = new Map()
  const sourcePaths = await listLiteralMirrorSourcePaths(source)
  const ignoredPaths = await listGitIgnoredMirrorPaths(source, sourcePaths)

  for (const [from, to] of defaultMirrorSecretRoutes) {
    if (sourcePaths.has(from)) {
      addMirrorSecretRoute(routes, sourcePaths, from, to)
    }
  }

  for (const relativePath of sourcePaths) {
    if (routes.has(relativePath) || relativePath.startsWith('.git/')) continue
    if (isMirrorSecretPath(relativePath)) {
      addMirrorSecretRoute(routes, sourcePaths, relativePath, `.private/env/repo-root/${relativePath}`)
    }
  }

  for (const relativePath of ignoredPaths) {
    if (routes.has(relativePath) || relativePath.startsWith('.git/')) continue
    addMirrorSecretRoute(routes, sourcePaths, relativePath, `.private/env/gitignored/${relativePath}`)
  }

  return routes
}

async function listLiteralMirrorSourcePaths(source) {
  const paths = new Set()

  async function walk(dir, relativeDir = '') {
    const entries = await sortedDirEntries(dir)
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      if (shouldSkipLiteralMirrorPath(relativePath, entry)) continue
      const absolutePath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath)
        continue
      }
      if (entry.isFile() || entry.isSymbolicLink()) paths.add(relativePath)
    }
  }

  await walk(source)
  return paths
}

async function listGitIgnoredMirrorPaths(source, sourcePaths) {
  if (!existsSync(path.join(source, '.git')) || sourcePaths.size === 0) return new Set()
  if (!(await isGitWorkTree(source))) return new Set()

  const input = `${[...sourcePaths].join('\0')}\0`
  const result = await runProcess('git', ['check-ignore', '-z', '--stdin', '--no-index'], {
    cwd: source,
    input,
    outputLimit: 1_000_000,
  })
  if (result.exitCode === 1) return new Set()
  if (result.exitCode !== 0) return new Set()

  return new Set(result.stdout.split('\0').filter(Boolean).map(toCloudPath))
}

async function isGitWorkTree(source) {
  const result = await runProcess('git', ['-C', source, 'rev-parse', '--is-inside-work-tree'])
  return result.exitCode === 0 && result.stdout === 'true'
}

function addMirrorSecretRoute(routes, sourcePaths, from, desiredTo) {
  if (from.startsWith('.private/env/')) return

  let to = assertSafeCloudPath(desiredTo)
  if (to === from) return

  const routeTargets = new Set(routes.values())
  if (sourcePaths.has(to) || routeTargets.has(to)) {
    const ext = path.posix.extname(to)
    const stem = ext ? to.slice(0, -ext.length) : to
    const hash = hashContent(from).slice(0, 8)
    to = `${stem}.${hash}${ext}`
  }

  routes.set(from, to)
}

function isMirrorSecretPath(relativePath) {
  const basename = relativePath.split('/').at(-1) ?? relativePath
  if (mirrorSecretFileNames.has(basename)) return true
  if (basename.startsWith('.env.')) {
    const suffixes = basename.slice('.env.'.length).split('.')
    return !suffixes.some((suffix) => mirrorNonSecretEnvSuffixes.has(suffix))
  }
  if (basename.endsWith('.pem') || basename.endsWith('.key')) return true
  return false
}

async function backupWorkspaceForMirror(options, startedAt) {
  const workspace = path.resolve(options.workspace)
  const output = path.resolve(path.join(
    agentStateRootFromOptions(options),
    'backups',
    `workspace-mirror-${backupDirectoryName(options)}`,
  ))
  await assertBackupOutputSafe(output, options)
  await fs.mkdir(path.dirname(output), { recursive: true })
  await fs.rm(output, { recursive: true, force: true })
  await fs.mkdir(output, { recursive: true })

  const workspaceBackup = path.join(output, 'workspace')
  if (existsSync(workspace)) {
    await copyLiteralMirrorSource(workspace, workspaceBackup, new Map())
  } else {
    await fs.mkdir(workspaceBackup, { recursive: true })
  }

  const manifest = {
    schemaVersion: 1,
    createdAt: startedAt,
    workspace,
    backup: workspaceBackup,
  }
  await writeJson(path.join(output, 'manifest.json'), manifest)
  return {
    output,
    workspace: workspaceBackup,
    manifest: path.join(output, 'manifest.json'),
  }
}

async function copyLiteralMirrorSource(source, destination, routes = new Map()) {
  const result = {
    files: 0,
    symlinks: 0,
    directories: 0,
    routedSecrets: 0,
    bytes: 0,
  }

  async function copyEntry(sourcePath, relativePath) {
    const routedPath = routes.get(relativePath)
    const targetRelativePath = routedPath ?? relativePath
    const destinationPath = path.join(destination, ...targetRelativePath.split('/'))
    const stat = await fs.lstat(sourcePath)

    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(sourcePath)
      await fs.mkdir(path.dirname(destinationPath), { recursive: true })
      await fs.rm(destinationPath, { recursive: true, force: true })
      await fs.symlink(target, destinationPath)
      result.symlinks += 1
      if (routedPath) result.routedSecrets += 1
      return
    }

    if (stat.isDirectory()) {
      if (routedPath) {
        throw new Error(`Secret route source must be a file or symlink, got directory: ${relativePath}`)
      }
      await fs.mkdir(destinationPath, { recursive: true })
      result.directories += 1
      const entries = await fs.readdir(sourcePath, { withFileTypes: true })
      let consideredChildren = 0
      for (const entry of entries) {
        const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name
        if (shouldSkipLiteralMirrorPath(childRelativePath, entry)) continue
        consideredChildren += 1
        await copyEntry(path.join(sourcePath, entry.name), childRelativePath)
      }
      if (consideredChildren > 0 && await isDirectoryEmpty(destinationPath)) {
        await fs.rmdir(destinationPath)
        result.directories -= 1
        return
      }
      await fs.chmod(destinationPath, stat.mode)
      await fs.utimes(destinationPath, stat.atime, stat.mtime)
      return
    }

    if (!stat.isFile()) return

    await fs.mkdir(path.dirname(destinationPath), { recursive: true })
    const buffer = await readLiteralMirrorFileBuffer(sourcePath, relativePath)
    await fs.writeFile(destinationPath, buffer)
    await fs.chmod(destinationPath, stat.mode)
    await fs.utimes(destinationPath, stat.atime, stat.mtime)
    result.files += 1
    result.bytes += stat.size
    if (routedPath) result.routedSecrets += 1
  }

  await fs.mkdir(destination, { recursive: true })
  const entries = await fs.readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    if (shouldSkipLiteralMirrorPath(entry.name, entry)) continue
    await copyEntry(path.join(source, entry.name), entry.name)
  }

  return result
}

async function buildLiteralMirrorManifest(root, options = {}) {
  const routes = options.routes ?? new Map()
  const entries = {}
  const largestEntries = []

  function addEntry(relativePath, entry) {
    const normalizedPath = assertSafeCloudPath(relativePath)
    if (entries[normalizedPath]) {
      throw new Error(`Mirror manifest has duplicate routed path: ${normalizedPath}`)
    }
    entries[normalizedPath] = entry
    largestEntries.push({ path: normalizedPath, kind: entry.kind, size: entry.size })
    largestEntries.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path))
    largestEntries.splice(20)
  }

  async function walk(dir, relativeDir = '') {
    const children = await fs.readdir(dir, { withFileTypes: true })
    let includedChildren = 0

    for (const child of children) {
      const relativePath = relativeDir ? `${relativeDir}/${child.name}` : child.name
      if (shouldSkipLiteralMirrorPath(relativePath, child)) continue
      const routedPath = routes.get(relativePath)
      const manifestPath = routedPath ?? relativePath
      const absolutePath = path.join(dir, child.name)
      const stat = await fs.lstat(absolutePath)

      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(absolutePath)
        addEntry(manifestPath, {
          kind: entryKind.symlink,
          hash: hashSymlinkTarget(target),
          size: Buffer.byteLength(target),
          encodedBytes: Buffer.byteLength(target),
          scope: scopeForPath(manifestPath),
          privacyZone: privacyZoneForPath(manifestPath),
          target,
        })
        includedChildren += 1
        continue
      }

      if (stat.isDirectory()) {
        if (routedPath) {
          throw new Error(`Secret route source must be a file or symlink, got directory: ${relativePath}`)
        }
        const childCount = await walk(absolutePath, relativePath)
        if (childCount === 0) {
          addEntry(relativePath, {
            kind: entryKind.directory,
            hash: hashDirectoryEntry(relativePath),
            size: 0,
            encodedBytes: 0,
            scope: scopeForPath(relativePath),
            privacyZone: privacyZoneForPath(relativePath),
            target: null,
          })
          includedChildren += 1
        } else {
          includedChildren += childCount
        }
        continue
      }

      if (!stat.isFile()) continue

      const buffer = await readLiteralMirrorFileBuffer(absolutePath, relativePath)
      addEntry(manifestPath, {
        kind: entryKind.file,
        hash: hashBuffer(buffer),
        size: buffer.byteLength,
        encodedBytes: base64EncodedLength(buffer.byteLength),
        scope: scopeForPath(manifestPath),
        privacyZone: privacyZoneForPath(manifestPath),
        target: null,
      })
      includedChildren += 1
    }

    return includedChildren
  }

  await walk(root)
  const scopeCounts = countPathScopes(Object.keys(entries))
  return {
    schemaVersion: 1,
    root: path.resolve(root),
    entryCount: Object.keys(entries).length,
    scopeCounts,
    entries,
    largestEntries,
  }
}

async function isDirectoryEmpty(dir) {
  return (await fs.readdir(dir)).length === 0
}

async function readLiteralMirrorFileBuffer(absolutePath, relativePath) {
  const buffer = await fs.readFile(absolutePath)
  if (relativePath !== '.git/config') return buffer

  return Buffer.from(sanitizeGitConfigContent(buffer.toString('utf8')), 'utf8')
}

function sanitizeGitConfigContent(content) {
  return content.replace(
    /^(\s*(?:url|pushurl)\s*=\s*)(\S+)(.*)$/gim,
    (_match, prefix, url, suffix) => `${prefix}${stripGitRemoteCredentials(url)}${suffix}`,
  )
}

function stripGitRemoteCredentials(remoteUrl) {
  try {
    const parsed = new URL(remoteUrl)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      parsed.username = ''
      parsed.password = ''
      return parsed.toString()
    }
    if (parsed.password) {
      parsed.password = ''
      return parsed.toString()
    }
    return remoteUrl
  } catch {
    return remoteUrl
  }
}

function diffLiteralManifests(expected, actual) {
  const addedPaths = []
  const modifiedPaths = []
  const deletedPaths = []

  for (const relativePath of Object.keys(actual.entries).sort()) {
    const expectedEntry = expected.entries[relativePath]
    const actualEntry = actual.entries[relativePath]
    if (!expectedEntry) {
      addedPaths.push(relativePath)
      continue
    }
    if (
      expectedEntry.kind !== actualEntry.kind ||
      expectedEntry.hash !== actualEntry.hash ||
      expectedEntry.size !== actualEntry.size ||
      expectedEntry.scope !== actualEntry.scope ||
      (expectedEntry.target ?? null) !== (actualEntry.target ?? null)
    ) {
      modifiedPaths.push(relativePath)
    }
  }

  for (const relativePath of Object.keys(expected.entries).sort()) {
    if (!actual.entries[relativePath]) deletedPaths.push(relativePath)
  }

  return {
    clean: addedPaths.length === 0 && modifiedPaths.length === 0 && deletedPaths.length === 0,
    addedCount: addedPaths.length,
    modifiedCount: modifiedPaths.length,
    deletedCount: deletedPaths.length,
    samplePaths: [...addedPaths, ...modifiedPaths, ...deletedPaths].slice(0, 20),
  }
}

function literalManifestSummary(manifest) {
  return {
    root: manifest.root,
    entryCount: manifest.entryCount,
    scopeCounts: manifest.scopeCounts,
    largestEntries: manifest.largestEntries.slice(0, 10),
  }
}

function countLocalOnlySecretManifestEntries(manifest) {
  return Object.keys(manifest.entries ?? {}).filter((relativePath) => isLocalOnlySecretPath(relativePath)).length
}

function storageBudgetReport(manifest, budgetBytes) {
  const uniquePayloads = new Map()
  let totalRawBytes = 0
  let totalEncodedBytes = 0

  for (const entry of Object.values(manifest.entries)) {
    if (entry.kind === entryKind.directory) continue
    totalRawBytes += entry.size
    totalEncodedBytes += entry.encodedBytes
    if (!uniquePayloads.has(entry.hash)) {
      uniquePayloads.set(entry.hash, {
        rawBytes: entry.size,
        encodedBytes: entry.encodedBytes,
      })
    }
  }

  let uniqueRawBytes = 0
  let uniqueEncodedBytes = 0
  for (const payload of uniquePayloads.values()) {
    uniqueRawBytes += payload.rawBytes
    uniqueEncodedBytes += payload.encodedBytes
  }

  return {
    budgetBytes,
    withinBudget: uniqueEncodedBytes <= budgetBytes,
    totalRawBytes,
    totalEncodedBytes,
    uniqueRawBytes,
    uniqueEncodedBytes,
    uniquePayloads: uniquePayloads.size,
    overByBytes: Math.max(0, uniqueEncodedBytes - budgetBytes),
  }
}

function base64EncodedLength(byteLength) {
  return Math.ceil(byteLength / 3) * 4
}

async function stopMirrorService(label) {
  if (process.platform !== 'darwin') {
    return { skipped: true, reason: 'launch-agent-only-on-darwin' }
  }

  const target = launchAgentTarget(label)
  const result = spawnSync('launchctl', ['bootout', target], { encoding: 'utf8' })
  if (result.status === 0) {
    return { skipped: false, stopped: true, label, target }
  }

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (/No such process|Could not find specified service|service already unloaded/i.test(output)) {
    return { skipped: false, stopped: false, alreadyStopped: true, label, target }
  }

  return {
    skipped: false,
    stopped: false,
    label,
    target,
    status: result.status,
    error: output.trim() || 'launchctl bootout failed',
  }
}

async function startMirrorService(label) {
  if (process.platform !== 'darwin') {
    return { skipped: true, reason: 'launch-agent-only-on-darwin' }
  }

  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
  if (!existsSync(plistPath)) {
    return { skipped: true, reason: 'launch-agent-plist-missing', label, plistPath }
  }

  const domain = launchAgentDomain()
  const bootstrap = spawnSync('launchctl', ['bootstrap', domain, plistPath], { encoding: 'utf8' })
  const bootstrapOutput = `${bootstrap.stdout ?? ''}${bootstrap.stderr ?? ''}`
  if (bootstrap.status !== 0 && !/service already loaded|already exists/i.test(bootstrapOutput)) {
    return {
      skipped: false,
      started: false,
      label,
      plistPath,
      status: bootstrap.status,
      error: bootstrapOutput.trim() || 'launchctl bootstrap failed',
    }
  }

  const kickstart = spawnSync('launchctl', ['kickstart', '-k', launchAgentTarget(label)], { encoding: 'utf8' })
  return {
    skipped: false,
    started: kickstart.status === 0,
    label,
    plistPath,
    bootstrapStatus: bootstrap.status,
    kickstartStatus: kickstart.status,
    error: kickstart.status === 0 ? null : `${kickstart.stdout ?? ''}${kickstart.stderr ?? ''}`.trim(),
  }
}

function launchAgentTarget(label) {
  return `${launchAgentDomain()}/${label}`
}

function launchAgentDomain() {
  return `gui/${typeof process.getuid === 'function' ? process.getuid() : 501}`
}

async function installAgent(options) {
  await assertWorkspacePathSafe(options)
  const stateRoot = path.resolve(agentStateRootFromOptions(options))
  const workspaceRoot = path.resolve(workspaceRootFromOptions(options))
  const codebaseId = options['codebase-id'] ?? path.basename(path.resolve(options.workspace))

  await fs.mkdir(path.join(stateRoot, 'cloud'), { recursive: true })
  await fs.mkdir(path.join(stateRoot, 'journal'), { recursive: true })
  await fs.mkdir(path.join(stateRoot, 'events'), { recursive: true })
  await fs.mkdir(path.join(stateRoot, 'run'), { recursive: true })
  await fs.mkdir(path.join(stateRoot, 'backups'), { recursive: true })
  await fs.mkdir(workspaceRoot, { recursive: true })
  await fs.mkdir(options.workspace, { recursive: true })

  let index = await readWorkspaceIndex(options)
  if (!index) {
    index = await upsertWorkspaceIndex(options, {
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

async function runWorkspaceCommand(action, options) {
  const allowedActions = new Set([
    'status',
    'list',
    'discover',
    'ensure',
    'attach',
    'files',
    'hydrate-file',
    'hydrate-path',
    'prune',
    'pin',
    'unpin',
    'dehydrate',
  ])
  if (!allowedActions.has(action)) {
    throw new Error(`Unknown workspace action: ${action}`)
  }

  if (action === 'discover' || action === 'list') {
    await discoverWorkspaces(options, { action })
    return
  }

  if (action === 'attach') {
    await attachWorkspace(options)
    return
  }

  if (action === 'hydrate-file') {
    if (!options.path && !options.file) {
      throw new Error('workspace hydrate-file requires --path <cloud-path>.')
    }
    await hydrateWorkspaceFile(options)
    return
  }

  if (action === 'hydrate-path') {
    if (!options.path && !options.file) {
      throw new Error('workspace hydrate-path requires --path <cloud-path>.')
    }
    await hydrateWorkspacePath(options)
    return
  }

  if (action === 'prune') {
    await pruneWorkspaceCache(options)
    return
  }

  if (action === 'pin') {
    await setWorkspaceCachePin(options, true)
    return
  }

  if (action === 'unpin') {
    await setWorkspaceCachePin(options, false)
    return
  }

  if (action === 'dehydrate') {
    await dehydrateWorkspace(options)
    return
  }

  if (action === 'ensure') {
    await assertWorkspacePathSafe(options)
    createCloudGraphService(options)
    await fs.mkdir(workspaceRootFromOptions(options), { recursive: true })
    await fs.mkdir(options.workspace, { recursive: true })
  }

  const state = await readAgentState(options)
  const rootPath = path.resolve(workspaceRootFromOptions(options))
  let current = workspaceCodebaseSummary(options, state)
  const index = action === 'ensure'
    ? await upsertWorkspaceIndex(options, current)
    : await readWorkspaceIndex(options)
  const cloud = state.cloud.graph
  if (current) {
    current = {
      ...current,
      workspace: {
        ...current.workspace,
        index: workspaceIndexSummary(options, index),
      },
    }
  }
  const indexedCodebases = mergeIndexedCodebases(index?.codebases ?? [], current)
  const result = {
    ok: true,
    action,
    root: {
      path: rootPath,
      exists: existsSync(rootPath),
      adapter: workspaceMode.adapter,
      cacheMode: workspaceMode.cacheMode,
      sourceOfTruth: workspaceMode.sourceOfTruth,
      materializationPolicy: workspaceMode.materializationPolicy,
      hydrationPolicy: workspaceMode.hydrationPolicy,
      remoteUpdatePolicy: workspaceMode.remoteUpdatePolicy,
      virtualized: false,
      index: workspaceIndexSummary(options, index),
      note: 'HopIt currently uses managed folders under this root, not a FUSE or OS filesystem provider.',
    },
    current,
    codebases: indexedCodebases,
  }

  if (action === 'files') {
    const [diskEntries, journalEntries, eventEntries] = await Promise.all([
      readWorkspaceFiles(options.workspace, options),
      readNdjson(options.journal),
      readNdjson(options.events),
    ])
    const journalState = classifyJournalEntries(journalEntries, eventEntries)
    const indexedCodebase = findIndexedCodebase(index, cloud?.codebase?.id ?? options['codebase-id'], options.workspace)
    result.files = cloud
      ? Object.entries(cloud.files ?? {}).map(([relativePath, file]) =>
          workspaceFileMetadata(options, relativePath, file, {
            diskEntries,
            journalState,
            indexedCodebase,
          }),
        )
      : []
    result.summary = {
      visibleFiles: result.files.length,
      hydratedFiles: result.files.filter((file) => file.local.exists).length,
      dirtyFiles: result.files.filter((file) => file.local.dirty).length,
      pendingFiles: result.files.filter((file) => file.local.pending).length,
      pinnedFiles: result.files.filter((file) => file.local.pinned).length,
      prunableFiles: result.files.filter((file) => file.local.prunable).length,
      materialization: current?.materialization ?? 'unknown',
      hydration: current?.hydration ?? null,
      cache: localCacheSummary({
        files: Object.fromEntries(result.files.map((file) => [file.path, file.local])),
      }),
    }
  }

  console.log(JSON.stringify(result, null, 2))
}

function workspaceCodebaseSummary(options, state) {
  const status = state.status
  const codebaseId = status.codebaseId ?? options['codebase-id'] ?? path.basename(path.resolve(options.workspace))
  const hydrationState = status.workspace.hydration?.state ?? null
  const materialization =
    hydrationState === 'metadata-only'
      ? 'metadata-only'
      : hydrationState === 'partial'
        ? 'partial-managed-folder'
        : 'managed-folder'

  return {
    id: codebaseId,
    name: status.codebaseName ?? codebaseId,
    initialized: status.readiness !== 'not_initialized',
    workspace: status.workspace,
    workspaceMode,
    cloud: {
      path: status.cloud.path,
      service: status.cloud.service,
      exists: status.cloud.exists,
    },
    activeChangeSetId: status.activeChangeSetId,
    mainId: status.mainId,
    visibleFileCount: status.visibleFileCount,
    hiddenFileCount: status.hiddenFileCount,
    materialization,
    hydration: status.workspace.hydration,
    localChanges: status.workspace.localChanges,
    contentManifest: status.workspace.contentManifest,
    remoteCursor: status.remotePull.cursor,
    virtualized: false,
  }
}

function discoveredCloudCodebase(options, cloud, index, cloudService) {
  const codebaseId = cloud.codebase?.id ?? options['codebase-id'] ?? path.basename(path.resolve(options.workspace))
  const codebaseOptions = workspaceOptionsForCloudCodebase(options, cloud)
  const indexedCodebase =
    findIndexedCodebase(index, codebaseId, codebaseOptions.workspace) ??
    findIndexedCodebase(index, codebaseId)
  const workspacePath = path.resolve(indexedCodebase?.workspace?.path ?? codebaseOptions.workspace)
  const workspaceRoot = path.resolve(indexedCodebase?.workspace?.root ?? workspaceRootFromOptions(codebaseOptions))

  return {
    id: codebaseId,
    name: cloud.codebase?.name ?? codebaseId,
    source: 'configured-cloud',
    attached: Boolean(indexedCodebase),
    available: true,
    initialized: true,
    workspace: {
      root: workspaceRoot,
      path: workspacePath,
      exists: existsSync(workspacePath),
      adapter: workspaceMode.adapter,
      cacheMode: workspaceMode.cacheMode,
      materializationPolicy: workspaceMode.materializationPolicy,
      hydrationPolicy: workspaceMode.hydrationPolicy,
      virtualized: false,
      hydration: indexedCodebase?.hydration ?? { state: 'not_attached' },
    },
    cloud: {
      path: cloudLocationFromOptions(options, codebaseId),
      service: cloudService.type,
      exists: true,
    },
    ownerId: cloud.codebase?.ownerId ?? cloud.owner?.id ?? null,
    activeChangeSetId: cloud.selectedState?.type === 'active-change-set' ? cloud.selectedState.id : null,
    mainId: cloud.main?.id ?? null,
    selectedState: {
      type: cloud.selectedState?.type ?? null,
      id: cloud.selectedState?.id ?? null,
      revision: cloud.selectedState?.revision ?? null,
      visibility: cloud.selectedState?.effectiveVisibility ?? cloud.visibility?.effective ?? null,
    },
    visibleFileCount: Object.keys(cloud.files ?? {}).length,
    hiddenFileCount: cloud.visibilityContext?.hiddenFileCount ?? null,
    scopeCounts: countCloudScopes(cloud),
    hiddenScopeCounts: cloud.visibilityContext?.hiddenScopeCounts ?? null,
    materialization: indexedCodebase?.materialization ?? 'not-attached',
    remoteCursor: discoveryRemoteCursor(indexedCodebase, graphHeadFromGraph(cloud)),
    remoteUpdate: discoveryRemoteUpdate(indexedCodebase, graphHeadFromGraph(cloud)),
    virtualized: false,
    updatedAt: cloud.updatedAt ?? null,
  }
}

function discoveredCloudCodebaseHead(options, head, index, cloudService) {
  const codebaseId = head.codebase?.id ?? options['codebase-id'] ?? path.basename(path.resolve(options.workspace))
  const codebaseOptions = workspaceOptionsForCodebaseId(options, codebaseId)
  const indexedCodebase =
    findIndexedCodebase(index, codebaseId, codebaseOptions.workspace) ??
    findIndexedCodebase(index, codebaseId)
  const workspacePath = path.resolve(indexedCodebase?.workspace?.path ?? codebaseOptions.workspace)
  const workspaceRoot = path.resolve(indexedCodebase?.workspace?.root ?? workspaceRootFromOptions(codebaseOptions))
  const remoteCursor = discoveryRemoteCursor(indexedCodebase, head)
  const fileCount = head.access?.visibleFileCount ?? head.fileCount ?? 0
  const privateFileCount = head.privateFileCount ?? 0

  return {
    id: codebaseId,
    name: head.codebase?.name ?? codebaseId,
    source: 'account-cloud',
    attached: Boolean(indexedCodebase),
    available: head.exists !== false,
    initialized: head.exists !== false,
    workspace: {
      root: workspaceRoot,
      path: workspacePath,
      exists: existsSync(workspacePath),
      adapter: workspaceMode.adapter,
      cacheMode: workspaceMode.cacheMode,
      materializationPolicy: workspaceMode.materializationPolicy,
      hydrationPolicy: workspaceMode.hydrationPolicy,
      virtualized: false,
      hydration: indexedCodebase?.hydration ?? { state: 'not_attached' },
    },
    cloud: {
      path: cloudLocationFromOptions(options, codebaseId),
      service: cloudService.type,
      exists: head.exists !== false,
    },
    ownerId: head.codebase?.ownerId ?? head.owner?.id ?? null,
    activeChangeSetId: head.selectedState?.type === 'active-change-set' ? head.selectedState.id : null,
    mainId: head.main?.id ?? null,
    selectedState: {
      type: head.selectedState?.type ?? null,
      id: head.selectedState?.id ?? null,
      revision: head.selectedState?.revision ?? null,
      visibility: head.selectedState?.effectiveVisibility ?? head.visibility?.effective ?? null,
      reviewState: head.selectedState?.reviewState ?? null,
      mergeState: head.selectedState?.mergeState ?? null,
      conflictState: head.selectedState?.conflictState ?? null,
    },
    access: head.access ?? null,
    visibleFileCount: fileCount,
    hiddenFileCount: head.access?.hiddenFileCount ?? null,
    privateFileCount,
    memberCount: head.memberCount ?? null,
    scopeCounts: {
      shared: Math.max(0, (head.fileCount ?? fileCount) - privateFileCount),
      private: privateFileCount,
    },
    hiddenScopeCounts: head.access?.hiddenScopeCounts ?? null,
    materialization: indexedCodebase?.materialization ?? 'not-attached',
    remoteCursor,
    remoteUpdate: discoveryRemoteUpdate(indexedCodebase, head, remoteCursor),
    virtualized: false,
    updatedAt: head.updatedAt ?? head.remoteUpdate?.updatedAt ?? null,
  }
}

function workspaceOptionsForCloudCodebase(options, cloud) {
  const codebaseId = cloud.codebase?.id ?? options['codebase-id'] ?? path.basename(path.resolve(options.workspace))
  return workspaceOptionsForCodebaseId(options, codebaseId)
}

function workspaceOptionsForCodebaseId(options, codebaseId) {
  const next = {
    ...options,
    'codebase-id': codebaseId,
  }

  if (!options._provided?.has('workspace')) {
    next.workspace = path.join(workspaceRootFromOptions(options), workspaceFolderNameForCodebase(codebaseId))
  }

  return next
}

function discoveryRemoteCursor(indexedCodebase, head) {
  const graphRevision = head.remoteUpdate?.graphRevision ?? head.revision ?? null
  const materializedRevision =
    indexedCodebase?.remoteCursor?.materializedRevision ??
    indexedCodebase?.hydration?.lastMaterializedRevision ??
    null
  return {
    graphRevision,
    selectedStateId: head.selectedState?.id ?? null,
    selectedStateType: head.selectedState?.type ?? null,
    selectedStateRevision: head.selectedState?.revision ?? head.remoteUpdate?.selectedStateRevision ?? null,
    materializedRevision,
    lastMaterializedAt:
      indexedCodebase?.remoteCursor?.lastMaterializedAt ??
      indexedCodebase?.hydration?.lastMaterializedAt ??
      null,
    behindByRevisions:
      Number.isInteger(graphRevision) && Number.isInteger(materializedRevision)
        ? Math.max(0, graphRevision - materializedRevision)
        : null,
  }
}

function discoveryRemoteUpdate(indexedCodebase, head, cursor = discoveryRemoteCursor(indexedCodebase, head)) {
  const hydrationState = indexedCodebase?.hydration?.state ?? 'not_attached'
  const behindByRevisions = cursor.behindByRevisions
  const state = !indexedCodebase
    ? 'not-attached'
    : hydrationState === 'metadata-only' || hydrationState === 'partial'
      ? 'needs-hydration'
      : behindByRevisions === null
        ? 'unknown'
        : behindByRevisions > 0
          ? 'behind'
          : 'ready'

  return {
    state,
    delivery: head.remoteUpdate?.delivery ?? 'manual-or-activity-gated',
    graphRevision: cursor.graphRevision,
    materializedRevision: cursor.materializedRevision,
    selectedStateRevision: cursor.selectedStateRevision,
    behindByRevisions,
    safeRefreshOnly: true,
    localHydrationState: hydrationState,
    updatedAt: head.updatedAt ?? head.remoteUpdate?.updatedAt ?? null,
  }
}

function workspaceFolderNameForCodebase(codebaseId) {
  return String(codebaseId ?? 'codebase')
    .replace(/[\\/]+/g, '-')
    .replace(/^\.+$/, 'codebase')
}

async function assertAttachWorkspaceSafe(options, cloud, index) {
  if (options.force) return
  if (!existsSync(options.workspace)) return

  const codebaseId = cloud.codebase?.id ?? options['codebase-id']
  if (findIndexedCodebase(index, codebaseId, options.workspace)) return

  const unmanagedFiles = await readWorkspaceFiles(options.workspace, options)
  if (Object.keys(unmanagedFiles).length === 0) return

  throw new Error(
    'workspace attach refuses to bind a non-empty unmanaged folder. Choose an empty workspace folder or use the existing indexed workspace.',
  )
}

function workspaceFileMetadata(options, relativePath, file, context = {}) {
  const metadataContext = typeof context === 'boolean' ? { forceExists: context } : context
  const absolutePath = workspaceFilePath(options.workspace, relativePath)
  const entry = normalizeCloudFileEntry(relativePath, file)
  const local = workspaceFileLocalState(options, relativePath, file, metadataContext)
  return {
    path: relativePath,
    kind: entry.kind,
    scope: entry.scope,
    privacyZone: entry.privacyZone ?? privacyZoneForPath(relativePath),
    revision: entry.revision ?? null,
    size: entry.size,
    hash: entry.hash,
    encoding: entry.kind === entryKind.file ? entry.encoding : null,
    target: entry.target ?? null,
    local: {
      path: absolutePath,
      ...local,
    },
  }
}

function workspaceFileLocalState(options, relativePath, file, context = {}) {
  const absolutePath = workspaceFilePath(options.workspace, relativePath)
  const cached = context.indexedCodebase?.localCache?.files?.[relativePath] ?? {}
  const diskEntry = context.diskEntries?.[relativePath] ?? null
  const shouldCheckDisk = context.scanDisk !== false
  const cachedHydrated = cached.state && cached.state !== 'cloud-only'
  const exists = Boolean(context.forceExists || diskEntry || (shouldCheckDisk ? existsSync(absolutePath) : cachedHydrated))
  const effectiveDiskEntry = diskEntry ?? (context.forceExists ? normalizeCloudFileEntry(relativePath, file) : null)
  const manifestEntry = context.indexedCodebase?.contentManifest?.files?.[relativePath] ?? null
  const pathJournalEntries = (context.journalState?.entries ?? []).filter((entry) => entry.path === relativePath)
  const pending = pathJournalEntries.some((entry) => entry.recoveryStatus === 'pending')
  const failed = pathJournalEntries.some((entry) => entry.recoveryStatus === 'failed')
  const dirty = Boolean(
    exists &&
      effectiveDiskEntry &&
      (!manifestEntry || manifestEntryChanged(manifestEntry, normalizeCloudFileEntry(relativePath, effectiveDiskEntry))),
  )
  const pinned = Boolean(cached.pinned)
  let state = cached.state ?? (exists ? 'hydrated' : 'cloud-only')

  if (failed) state = 'blocked'
  else if (pending) state = 'pending-upload'
  else if (dirty) state = 'dirty'
  else if (!exists) state = 'cloud-only'
  else if (pinned) state = 'pinned'
  else if (cached.lastSyncedAt || cached.state === 'uploaded') state = 'uploaded'
  else state = 'hydrated'

  const hydrated = exists && state !== 'cloud-only'
  const clean = hydrated && !dirty && !pending && !failed
  const prunable = clean && !pinned
  const bytesOnDisk = exists
    ? Number.isInteger(effectiveDiskEntry?.size)
      ? effectiveDiskEntry.size
      : Number.isInteger(cached.bytesOnDisk)
        ? cached.bytesOnDisk
        : null
    : null

  return {
    exists,
    hydrated,
    state,
    pinned,
    dirty,
    pending,
    blocked: failed,
    prunable,
    bytesOnDisk,
    lastHydratedAt: cached.lastHydratedAt ?? null,
    lastEditedAt: cached.lastEditedAt ?? null,
    lastSyncedAt: cached.lastSyncedAt ?? null,
    lastPrunedAt: cached.lastPrunedAt ?? null,
  }
}

async function writeWorkspaceMetadataManifest(options, cloud, detail = {}) {
  await fs.mkdir(path.join(options.workspace, '.hopit'), { recursive: true })
  const files = Object.entries(cloud.files ?? {}).map(([relativePath, file]) => {
    const entry = normalizeCloudFileEntry(relativePath, file)
    return {
      path: relativePath,
      kind: entry.kind,
      scope: entry.scope,
      privacyZone: entry.privacyZone ?? privacyZoneForPath(relativePath),
      revision: entry.revision ?? null,
      size: entry.size,
      hash: entry.hash,
      target: entry.target ?? null,
    }
  })
  await writeJson(path.join(options.workspace, '.hopit', 'metadata.json'), {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    codebase: cloud.codebase,
    main: cloud.main,
    selectedState: {
      type: cloud.selectedState?.type ?? null,
      id: cloud.selectedState?.id ?? null,
      revision: cloud.selectedState?.revision ?? null,
      visibility: cloud.selectedState?.effectiveVisibility ?? cloud.visibility?.effective ?? null,
    },
    materialization: detail.materialization ?? 'metadata-only',
    fileCount: files.length,
    files,
  })
}

async function runSessionCommand(action, options) {
  const allowedActions = new Set(['status', 'register', 'list', 'touch', 'revoke'])
  if (!allowedActions.has(action)) {
    throw new Error(`Unknown session action: ${action}`)
  }

  if (action === 'status') {
    const state = await readAgentState(options)
    const sessionId = options['session-id'] ?? state.status.sessionId ?? null
    const deviceName = options['device-name'] ?? state.cloud.graph?.session?.deviceName ?? os.hostname() ?? null
    console.log(JSON.stringify({
      ok: true,
      action,
      codebaseId: state.status.codebaseId ?? options['codebase-id'] ?? null,
      session: {
        id: sessionId,
        deviceName,
        cloudSessionId: state.status.sessionId,
      },
      credentials: {
        sessionTokenConfigured: Boolean(agentSessionTokenFromOptions(options)),
      },
      cloud: {
        service: state.status.cloud.service,
        path: state.status.cloud.path,
        exists: state.status.cloud.exists,
      },
    }, null, 2))
    return
  }

  const cloudService = createCloudGraphService(options)
  if (!supportsAgentSessions(cloudService)) {
    throw new Error(`Session ${action} requires a cloud backend with scoped session support. Configure Cloudflare D1.`)
  }

  if (action === 'register') {
    const result = await cloudService.registerAgentSession({
      sessionId: options['session-id'],
      deviceName: options['device-name'] ?? os.hostname() ?? 'local-device',
      capabilities: sessionCapabilitiesFromOptions(options),
      expiresAt: options['expires-at'],
    })
    console.log(JSON.stringify({
      ok: true,
      action,
      ...result,
      note: 'Store sessionToken as HOPIT_AGENT_SESSION_TOKEN on this device. It is only returned once.',
    }, null, 2))
    return
  }

  if (action === 'list') {
    const result = await cloudService.listAgentSessions({ status: options.status })
    console.log(JSON.stringify({
      ok: true,
      action,
      codebaseId: cloudService.codebaseId,
      sessions: result,
    }, null, 2))
    return
  }

  const sessionId = options['session-id']
  if (!sessionId) {
    throw new Error(`Session ${action} requires --session-id.`)
  }

  if (action === 'touch') {
    const result = await cloudService.touchAgentSession({ sessionId })
    console.log(JSON.stringify({
      ok: true,
      action,
      session: result,
    }, null, 2))
    return
  }

  if (action === 'revoke') {
    const result = await cloudService.revokeAgentSession({ sessionId })
    console.log(JSON.stringify({
      ok: true,
      action,
      session: result,
    }, null, 2))
  }
}

async function runKeysCommand(action, options) {
  const normalizedAction = action === 'init' ? 'init-device' : action === 'recovery' ? 'export-recovery' : action
  const allowedActions = new Set(['status', 'init-device', 'export-recovery'])
  if (!allowedActions.has(normalizedAction)) {
    throw new Error(`Unknown keys action: ${action}`)
  }

  if (normalizedAction === 'status') {
    const keyring = await readLocalDeviceKeyring(options)
    console.log(JSON.stringify({
      ok: true,
      action: normalizedAction,
      keyring: await summarizeLocalDeviceKeyring(options, keyring),
    }, null, 2))
    return
  }

  if (normalizedAction === 'init-device') {
    const initialized = await initializeLocalDeviceKeyring(options)
    let cloudRegistration = null
    let keyring = initialized.keyring

    if (!options['skip-cloud-registration']) {
      cloudRegistration = await registerLocalDeviceKeyringWithCloud(options, keyring)
      if (cloudRegistration?.registered) {
        keyring = {
          ...keyring,
          updatedAt: new Date().toISOString(),
          cloud: {
            ...(keyring.cloud ?? {}),
            registeredAt: cloudRegistration.registeredAt,
            deviceKey: cloudRegistration.deviceKey,
            userKeyring: cloudRegistration.userKeyring,
            userVaultWrap: cloudRegistration.userVaultWrap,
          },
        }
        await writeLocalDeviceKeyring(options, keyring)
      }
    }

    console.log(JSON.stringify({
      ok: true,
      action: normalizedAction,
      created: initialized.created,
      keyring: await summarizeLocalDeviceKeyring(options, keyring),
      cloudRegistration: summarizeKeyCloudRegistration(cloudRegistration),
    }, null, 2))
    return
  }

  if (normalizedAction === 'export-recovery') {
    const keyring = await requireLocalDeviceKeyring(options)
    const output = options.output
    if (!output) throw new Error('keys export-recovery requires --output.')
    if (!options.force && existsSync(output)) {
      throw new Error(`Recovery export already exists at ${output}. Use --force to overwrite.`)
    }

    const passphrase = options['recovery-passphrase'] ?? process.env.HOPIT_RECOVERY_PASSPHRASE
    const userVaultKey = unwrapUserVaultKey(keyring)
    const now = new Date().toISOString()
    const recovery = {
      schemaVersion: 1,
      kind: 'hopit-recovery-key',
      codebaseId: keyring.codebaseId ?? codebaseIdFromOptions(options),
      deviceId: keyring.deviceId,
      userVaultKeyId: keyring.userVault.keyId,
      currentVersion: keyring.userVault.currentVersion,
      createdAt: now,
      recovery: encryptRecoveryPayload({
        key: userVaultKey,
        passphrase,
        context: recoveryContextForKeyring(keyring),
      }),
    }
    await writeSecureJson(output, recovery)

    const updatedKeyring = {
      ...keyring,
      updatedAt: now,
      userVault: {
        ...keyring.userVault,
        recoveryConfigured: true,
        recoveryExportedAt: now,
      },
    }
    await writeLocalDeviceKeyring(options, updatedKeyring)

    console.log(JSON.stringify({
      ok: true,
      action: normalizedAction,
      output: path.resolve(output),
      keyring: await summarizeLocalDeviceKeyring(options, updatedKeyring),
      recovery: {
        kind: recovery.kind,
        userVaultKeyId: recovery.userVaultKeyId,
        currentVersion: recovery.currentVersion,
        createdAt: recovery.createdAt,
        encrypted: true,
      },
    }, null, 2))
  }
}

function summarizeKeyCloudRegistration(registration) {
  if (!registration) return null
  if (!registration.registered) return registration
  return {
    registered: true,
    registeredAt: registration.registeredAt,
    deviceKey: {
      deviceId: registration.deviceKey?.deviceId ?? null,
      status: registration.deviceKey?.status ?? null,
      userId: registration.deviceKey?.userId ?? null,
    },
    userKeyring: {
      userId: registration.userKeyring?.userId ?? null,
      vaultKeyId: registration.userKeyring?.vaultKeyId ?? null,
      currentVersion: registration.userKeyring?.currentVersion ?? null,
      status: registration.userKeyring?.status ?? null,
      recoveryConfigured: Boolean(registration.userKeyring?.recoveryConfigured),
    },
    userVaultWrap: {
      wrapId: registration.userVaultWrap?.wrapId ?? null,
      wrappedKeyId: registration.userVaultWrap?.wrappedKeyId ?? null,
      recipientType: registration.userVaultWrap?.recipientType ?? null,
      recipientId: registration.userVaultWrap?.recipientId ?? null,
      status: registration.userVaultWrap?.status ?? null,
    },
  }
}

async function applyLocalDeviceKeyring(options) {
  const keyring = await readLocalDeviceKeyring(options)
  if (!keyring) return options

  const next = {
    ...options,
    _localDeviceKeyring: keyring,
  }
  const provided = options._provided ?? new Set()

  if (!provided.has('device-id') && !process.env.HOPIT_DEVICE_ID && keyring.deviceId) {
    next['device-id'] = keyring.deviceId
  }
  if (!provided.has('device-name') && !process.env.HOPIT_DEVICE_NAME && keyring.deviceName) {
    next['device-name'] = keyring.deviceName
  }
  if (!provided.has('session-id') && !process.env.HOPIT_SESSION_ID && keyring.device?.sessionId) {
    next['session-id'] = keyring.device.sessionId
  }
  if (!provided.has('session-token') && !process.env.HOPIT_AGENT_SESSION_TOKEN && keyring.credentials?.agentSessionToken) {
    next['session-token'] = keyring.credentials.agentSessionToken
  }
  if (!rawClientEncryptionKey(options)) {
    const userVaultKey = unwrapUserVaultKey(keyring)
    next['client-encryption-key'] = `base64:${userVaultKey.toString('base64')}`
    next['client-encryption-key-id'] = keyring.userVault.keyId
  }
  if (!provided.has('client-encryption-scope') && !process.env.HOPIT_CLIENT_ENCRYPTION_SCOPE) {
    next['client-encryption-scope'] = keyring.clientEncryption?.scope ?? clientEncryptionScopes.secrets
  }

  return next
}

async function initializeLocalDeviceKeyring(options) {
  const existing = await readLocalDeviceKeyring(options)
  if (existing && !options.force) {
    const next = mergeExistingLocalDeviceKeyring(existing, options)
    if (JSON.stringify(next) !== JSON.stringify(existing)) {
      await writeLocalDeviceKeyring(options, next)
    }
    return { created: false, keyring: next }
  }

  const keyring = buildLocalDeviceKeyringDocument(createDeviceKeyMaterial({
    deviceId: options['device-id'] ?? `dev_${randomUUID()}`,
    deviceName: options['device-name'] ?? os.hostname() ?? 'local-device',
    platform: `${process.platform}-${process.arch}`,
  }), options)
  await writeLocalDeviceKeyring(options, keyring)
  return { created: true, keyring }
}

function buildLocalDeviceKeyringDocument(material, options) {
  const now = material.createdAt ?? new Date().toISOString()
  const sessionId = options['session-id'] ?? process.env.HOPIT_SESSION_ID ?? undefined
  const sessionToken = agentSessionTokenFromOptions(options) ?? undefined
  const clientEncryptionScope =
    options['client-encryption-scope'] ?? process.env.HOPIT_CLIENT_ENCRYPTION_SCOPE ?? clientEncryptionScopes.secrets

  const document = {
    ...material,
    kind: 'hopit-local-device-keyring',
    profile: options.profile,
    codebaseId: codebaseIdFromOptions(options),
    updatedAt: material.updatedAt ?? now,
    device: {
      deviceId: material.deviceId,
      deviceName: material.deviceName,
    },
    credentials: {},
    clientEncryption: {
      source: 'user-vault',
      keyId: material.userVault.keyId,
      scope: clientEncryptionScope,
    },
  }
  if (sessionId) document.device.sessionId = sessionId
  if (sessionToken) document.credentials.agentSessionToken = sessionToken
  return document
}

function mergeExistingLocalDeviceKeyring(keyring, options) {
  const now = new Date().toISOString()
  const next = {
    ...keyring,
    kind: keyring.kind ?? 'hopit-local-device-keyring',
    profile: keyring.profile ?? options.profile,
    codebaseId: keyring.codebaseId ?? codebaseIdFromOptions(options),
    updatedAt: now,
    device: {
      ...(keyring.device ?? {}),
      deviceId: keyring.device?.deviceId ?? keyring.deviceId,
      deviceName: options['device-name'] ?? keyring.device?.deviceName ?? keyring.deviceName,
    },
    credentials: {
      ...(keyring.credentials ?? {}),
    },
    clientEncryption: {
      source: 'user-vault',
      keyId: keyring.userVault.keyId,
      scope: keyring.clientEncryption?.scope ?? clientEncryptionScopes.secrets,
      ...(keyring.clientEncryption ?? {}),
    },
  }
  if (options['session-id']) next.device.sessionId = options['session-id']
  const sessionToken = options._provided?.has('session-token') || process.env.HOPIT_AGENT_SESSION_TOKEN
    ? agentSessionTokenFromOptions(options)
    : null
  if (sessionToken) next.credentials.agentSessionToken = sessionToken
  return next
}

async function registerLocalDeviceKeyringWithCloud(options, keyring) {
  const cloudOptions = {
    ...options,
  }
  if (!agentSessionTokenFromOptions(cloudOptions) && keyring.credentials?.agentSessionToken) {
    cloudOptions['session-token'] = keyring.credentials.agentSessionToken
  }
  const cloudService = createCloudGraphService(cloudOptions)
  if (!supportsKeyRegistration(cloudService)) {
    return { registered: false, reason: 'cloud_key_registration_not_configured' }
  }

  const registeredAt = new Date().toISOString()
  const deviceKey = await cloudService.registerDeviceKey(publicDeviceKeyDescriptor(keyring))
  const userKeyring = await cloudService.ensureUserKeyring({
    vaultKeyId: keyring.userVault.keyId,
    currentVersion: keyring.userVault.currentVersion,
    recoveryConfigured: Boolean(keyring.userVault.recoveryConfigured),
  })
  const userVaultWrap = await cloudService.createWrappedKey({
    wrapId: stableWrapId({
      codebaseId: keyring.codebaseId ?? codebaseIdFromOptions(options),
      wrappedKeyId: keyring.userVault.keyId,
      keyVersion: keyring.userVault.currentVersion,
      recipientType: 'device',
      recipientId: keyring.deviceId,
    }),
    wrappedKeyId: keyring.userVault.keyId,
    wrappedKeyType: 'user-vault',
    keyVersion: keyring.userVault.currentVersion,
    recipientType: 'device',
    recipientId: keyring.deviceId,
    wrappingPublicKeyId: keyring.deviceId,
    algorithm: keyring.userVault.wrappedKey.algorithm,
    ciphertext: JSON.stringify(keyring.userVault.wrappedKey),
    createdByDeviceId: keyring.deviceId,
  })

  return {
    registered: true,
    registeredAt,
    deviceKey,
    userKeyring,
    userVaultWrap,
  }
}

async function readLocalDeviceKeyring(options) {
  const keyringPath = localDeviceKeyringPath(options)
  try {
    return await readJson(keyringPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function requireLocalDeviceKeyring(options) {
  const keyring = await readLocalDeviceKeyring(options)
  if (!keyring) throw new Error(`No local HopIt device keyring found at ${localDeviceKeyringPath(options)}. Run: hop keys init-device`)
  return keyring
}

async function writeLocalDeviceKeyring(options, keyring) {
  await writeSecureJson(localDeviceKeyringPath(options), keyring)
}

function localDeviceKeyringPath(options) {
  const override = options['device-keys'] ?? options.keyring ?? process.env.HOPIT_DEVICE_KEYS_PATH
  if (override) return path.resolve(override)
  return path.join(agentStateRootFromOptions(options), 'keys', `${codebaseIdFromOptions(options)}.device.json`)
}

async function summarizeLocalDeviceKeyring(options, keyring) {
  const keyringPath = localDeviceKeyringPath(options)
  const mode = await secureFileMode(keyringPath)
  if (!keyring) {
    return {
      path: path.resolve(keyringPath),
      exists: false,
      mode,
      deviceConfigured: false,
      clientEncryptionConfigured: false,
      sessionTokenConfigured: false,
    }
  }

  return {
    path: path.resolve(keyringPath),
    exists: true,
    mode,
    schemaVersion: keyring.schemaVersion ?? null,
    kind: keyring.kind ?? null,
    profile: keyring.profile ?? null,
    codebaseId: keyring.codebaseId ?? codebaseIdFromOptions(options),
    deviceId: keyring.deviceId ?? null,
    deviceName: keyring.deviceName ?? null,
    platform: keyring.platform ?? null,
    encryption: {
      algorithm: keyring.encryption?.algorithm ?? null,
      publicKeyEncoding: keyring.encryption?.publicKeyEncoding ?? null,
      publicKeyFingerprint: keyring.encryption?.publicKeyPem ? fingerprintText(keyring.encryption.publicKeyPem) : null,
    },
    signing: {
      algorithm: keyring.signing?.algorithm ?? null,
      publicKeyEncoding: keyring.signing?.publicKeyEncoding ?? null,
      publicKeyFingerprint: keyring.signing?.publicKeyPem ? fingerprintText(keyring.signing.publicKeyPem) : null,
    },
    userVault: {
      keyId: keyring.userVault?.keyId ?? null,
      currentVersion: keyring.userVault?.currentVersion ?? null,
      recoveryConfigured: Boolean(keyring.userVault?.recoveryConfigured),
    },
    device: {
      sessionId: keyring.device?.sessionId ?? null,
      sessionTokenConfigured: Boolean(keyring.credentials?.agentSessionToken),
    },
    clientEncryption: {
      source: keyring.clientEncryption?.source ?? 'user-vault',
      keyId: keyring.clientEncryption?.keyId ?? keyring.userVault?.keyId ?? null,
      scope: keyring.clientEncryption?.scope ?? clientEncryptionScopes.secrets,
      configured: Boolean(keyring.userVault?.wrappedKey && keyring.encryption?.privateKeyPem),
    },
    cloud: keyring.cloud ? {
      registeredAt: keyring.cloud.registeredAt ?? null,
      deviceKeyStatus: keyring.cloud.deviceKey?.status ?? null,
      userKeyringStatus: keyring.cloud.userKeyring?.status ?? null,
      userVaultWrapStatus: keyring.cloud.userVaultWrap?.status ?? null,
    } : null,
  }
}

async function secureFileMode(filePath) {
  try {
    const stats = await fs.stat(filePath)
    return `0${(stats.mode & 0o777).toString(8)}`
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function codebaseIdFromOptions(options) {
  return options['codebase-id'] ?? process.env.HOPIT_CODEBASE_ID ?? 'hopit'
}

function stableWrapId({ codebaseId, wrappedKeyId, keyVersion, recipientType, recipientId }) {
  const hash = hashContent(`${codebaseId}:${wrappedKeyId}:${keyVersion}:${recipientType}:${recipientId}`).slice(0, 40)
  return `wrap_${hash}`
}

function recoveryContextForKeyring(keyring) {
  return `user-vault:${keyring.userVault.keyId}:device:${keyring.deviceId}`
}

function fingerprintText(value) {
  return createHash('sha256').update(String(value)).digest('base64url').slice(0, 22)
}

async function readWorkspaceIndex(options) {
  const indexPath = workspaceIndexPath(options)
  try {
    return normalizeWorkspaceIndex(await readJson(indexPath), options)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function writeWorkspaceIndex(options, index) {
  const indexPath = workspaceIndexPath(options)
  await fs.mkdir(path.dirname(indexPath), { recursive: true })
  await writeJson(indexPath, normalizeWorkspaceIndex(index, options))
}

async function upsertWorkspaceIndex(options, current) {
  const now = new Date().toISOString()
  const existing = (await readWorkspaceIndex(options)) ?? emptyWorkspaceIndex(options)
  const next = {
    ...existing,
    schemaVersion: workspaceIndexVersion,
    updatedAt: now,
    root: workspaceIndexRoot(options),
    codebases: mergeIndexedCodebases(existing.codebases, current ? storableWorkspaceIndexEntry({
      ...current,
      updatedAt: now,
    }) : null),
  }
  await writeWorkspaceIndex(options, next)
  return next
}

async function upsertWorkspaceIndexFromCloud(options, cloud, metadata = {}) {
  return upsertWorkspaceIndex(options, workspaceIndexEntryFromCloud(options, cloud, metadata))
}

async function hydratedPathUnion(options, codebaseId, nextPaths) {
  const index = await readWorkspaceIndex(options)
  const indexedCodebase = findIndexedCodebase(index, codebaseId, options.workspace)
  return uniqueCloudPaths([...(indexedCodebase?.hydratedPaths ?? []), ...nextPaths])
}

function uniqueCloudPaths(paths) {
  return Array.from(new Set(paths.map((value) => assertSafeCloudPath(value)))).sort()
}

function selectedCloudPaths(cloud, targetPath, options = {}) {
  const target = targetPath === 'all' ? 'all' : assertSafeCloudPath(String(targetPath ?? ''))
  const cloudPaths = uniqueCloudPaths(Object.keys(cloud.files ?? {}))
  if (target === 'all') return cloudPaths

  const normalizedTarget = target.replace(/\/+$/g, '')
  if (cloud.files?.[normalizedTarget]) return [normalizedTarget]

  const prefixMatches = cloudPaths.filter((relativePath) => cloudPathMatchesPrefix(relativePath, normalizedTarget))
  if (prefixMatches.length === 0) {
    throw new Error(`No visible cloud file matches: ${normalizedTarget}`)
  }
  if (!options.recursive) {
    throw new Error(`Path is a folder prefix with ${prefixMatches.length} visible file${prefixMatches.length === 1 ? '' : 's'}: ${normalizedTarget}. Pass --recursive to include it.`)
  }

  return prefixMatches
}

function cloudPathMatchesPrefix(relativePath, prefix) {
  return relativePath === prefix || relativePath.startsWith(`${prefix}/`)
}

function parseNonNegativeIntegerOption(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, got: ${value}`)
  }
  return parsed
}

function localCachePatchForPaths(cloud, paths, detail = {}) {
  const now = detail.now ?? new Date().toISOString()
  const files = {}
  for (const relativePath of uniqueCloudPaths(paths)) {
    const cloudEntry = cloud.files?.[relativePath] ? normalizeCloudFileEntry(relativePath, cloud.files[relativePath]) : null
    files[relativePath] = compactObject({
      state: detail.state,
      pinned: detail.pinned,
      lastHydratedAt: detail.lastHydratedAt,
      lastEditedAt: detail.lastEditedAt,
      lastSyncedAt: detail.lastSyncedAt,
      lastPrunedAt: detail.lastPrunedAt,
      bytesOnDisk: detail.bytesOnDisk ?? cloudEntry?.size ?? null,
    })
  }

  return {
    schemaVersion: localCacheSchemaVersion,
    updatedAt: now,
    files,
  }
}

function localCachePatchFromCloudMetadata(cloud, metadata, now) {
  if (metadata.localCache) return metadata.localCache
  const visiblePaths = Object.keys(cloud.files ?? {})
  if (metadata.reason === 'attach') {
    return localCachePatchForPaths(cloud, visiblePaths, {
      now,
      state: 'cloud-only',
      bytesOnDisk: null,
    })
  }
  if (metadata.reason === 'dehydrate') {
    return localCachePatchForPaths(cloud, visiblePaths, {
      now,
      state: 'cloud-only',
      lastPrunedAt: now,
      bytesOnDisk: null,
    })
  }
  if (Array.isArray(metadata.prunedPaths) && metadata.prunedPaths.length > 0) {
    return localCachePatchForPaths(cloud, metadata.prunedPaths, {
      now,
      state: 'cloud-only',
      lastPrunedAt: now,
      bytesOnDisk: null,
    })
  }
  if (Array.isArray(metadata.syncedPaths) && metadata.syncedPaths.length > 0) {
    return localCachePatchForPaths(cloud, metadata.syncedPaths, {
      now,
      state: 'uploaded',
      lastEditedAt: now,
      lastSyncedAt: now,
    })
  }
  if (Array.isArray(metadata.hydratedPaths) && metadata.hydratedPaths.length > 0) {
    const hydratedState = metadata.reason === 'sync' || metadata.reason === 'recover'
      ? 'uploaded'
      : 'hydrated'
    return localCachePatchForPaths(cloud, metadata.hydratedPaths, {
      now,
      state: hydratedState,
      lastHydratedAt: hydratedState === 'hydrated' ? now : undefined,
      lastSyncedAt: hydratedState === 'uploaded' ? now : undefined,
    })
  }
  return null
}

function mergeLocalCache(existing, incoming) {
  if (!existing && !incoming) return null
  const files = { ...(existing?.files ?? {}) }
  for (const [relativePath, patch] of Object.entries(incoming?.files ?? {})) {
    const previous = files[relativePath] ?? {}
    files[relativePath] = compactObject({
      ...previous,
      ...patch,
      pinned: patch.pinned === undefined ? Boolean(previous.pinned) : Boolean(patch.pinned),
    })
  }

  return {
    schemaVersion: localCacheSchemaVersion,
    updatedAt: incoming?.updatedAt ?? existing?.updatedAt ?? null,
    files,
    summary: localCacheSummary({ files }),
  }
}

function localCacheSnapshotForCloud(options, cloud, indexedCodebase) {
  const files = {}
  if (cloud?.files) {
    for (const [relativePath, file] of Object.entries(cloud.files ?? {})) {
      files[relativePath] = workspaceFileLocalState(options, relativePath, file, {
        indexedCodebase,
        forceExists: false,
        scanDisk: false,
      })
    }
  } else {
    for (const [relativePath, entry] of Object.entries(indexedCodebase?.localCache?.files ?? {})) {
      files[relativePath] = normalizePersistedLocalCacheEntry(entry)
    }
  }

  return {
    schemaVersion: localCacheSchemaVersion,
    updatedAt: indexedCodebase?.localCache?.updatedAt ?? null,
    files,
    summary: localCacheSummary({ files }),
  }
}

function normalizePersistedLocalCacheEntry(entry = {}) {
  const state = entry.state ?? 'cloud-only'
  const hydrated = state !== 'cloud-only'
  const pinned = Boolean(entry.pinned)
  const pending = state === 'pending-upload'
  const blocked = state === 'blocked'
  const dirty = state === 'dirty'
  const prunable = hydrated && !pinned && !pending && !blocked && !dirty

  return {
    exists: hydrated,
    hydrated,
    state,
    pinned,
    dirty,
    pending,
    blocked,
    prunable,
    bytesOnDisk: Number.isInteger(entry.bytesOnDisk) ? entry.bytesOnDisk : null,
    lastHydratedAt: entry.lastHydratedAt ?? null,
    lastEditedAt: entry.lastEditedAt ?? null,
    lastSyncedAt: entry.lastSyncedAt ?? null,
    lastPrunedAt: entry.lastPrunedAt ?? null,
  }
}

function localCacheSummary(cache) {
  const counts = {}
  let pinnedFiles = 0
  let hydratedFiles = 0
  let prunableFiles = 0
  let bytesOnDisk = 0

  for (const entry of Object.values(cache?.files ?? {})) {
    const state = entry?.state ?? 'cloud-only'
    const pinned = Boolean(entry?.pinned)
    const pending = state === 'pending-upload' || Boolean(entry?.pending)
    const blocked = state === 'blocked' || Boolean(entry?.blocked)
    const dirty = state === 'dirty' || Boolean(entry?.dirty)
    const hydrated = Boolean(entry?.hydrated) || state !== 'cloud-only'
    const prunable = Boolean(entry?.prunable) || (hydrated && !pinned && !pending && !blocked && !dirty)
    counts[state] = (counts[state] ?? 0) + 1
    if (pinned) pinnedFiles += 1
    if (hydrated) hydratedFiles += 1
    if (prunable) prunableFiles += 1
    if (Number.isInteger(entry?.bytesOnDisk)) bytesOnDisk += entry.bytesOnDisk
  }

  return {
    fileCount: Object.keys(cache?.files ?? {}).length,
    hydratedFiles,
    pinnedFiles,
    prunableFiles,
    bytesOnDisk,
    states: counts,
  }
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}

function deletableCloudPathsForWorkspace(indexedCodebase, visibleCloudPaths) {
  const visible = uniqueCloudPaths(visibleCloudPaths)
  if (!indexedCodebase || indexedCodebase.hydration?.state === 'materialized') {
    return new Set(visible)
  }

  return new Set(uniqueCloudPaths(indexedCodebase.hydratedPaths ?? []).filter((relativePath) =>
    visible.includes(relativePath),
  ))
}

function workspaceIndexHydrationStateForSync(indexedCodebase) {
  if (!indexedCodebase) return 'materialized'
  if (indexedCodebase.hydration?.state === 'metadata-only') return 'partial'
  if (indexedCodebase.hydration?.state === 'partial') return 'partial'
  return 'materialized'
}

function hydratedPathsAfterSync(indexedCodebase, diskPaths, cloudPaths) {
  const existing =
    indexedCodebase?.hydration?.state === 'partial' || indexedCodebase?.hydration?.state === 'metadata-only'
      ? indexedCodebase.hydratedPaths ?? []
      : cloudPaths
  return uniqueCloudPaths([...existing, ...diskPaths])
}

function hydratedPathsAfterPrune(indexedCodebase, visibleCloudPaths, prunedPaths) {
  const pruned = new Set(uniqueCloudPaths(prunedPaths))
  const existing =
    indexedCodebase?.hydration?.state === 'partial' || indexedCodebase?.hydration?.state === 'metadata-only'
      ? indexedCodebase.hydratedPaths ?? []
      : visibleCloudPaths
  return uniqueCloudPaths(existing.filter((relativePath) => !pruned.has(relativePath)))
}

function hydrationStateForHydratedPaths(hydratedPaths, visibleCloudPaths) {
  const visible = uniqueCloudPaths(visibleCloudPaths)
  const hydrated = uniqueCloudPaths(hydratedPaths)
  if (hydrated.length === 0) return 'metadata-only'
  if (hydrated.length === visible.length && visible.every((relativePath) => hydrated.includes(relativePath))) {
    return 'materialized'
  }
  return 'partial'
}

function materializationForHydrationState(hydrationState) {
  if (hydrationState === 'materialized') return 'managed-folder'
  if (hydrationState === 'partial') return 'partial-managed-folder'
  return 'metadata-only'
}

function latestIsoTimestamp(values) {
  const timestamps = values
    .filter((value) => typeof value === 'string' && value.length > 0)
    .map((value) => ({ value, time: new Date(value).getTime() }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => b.time - a.time)
  return timestamps[0]?.value ?? null
}

function emptyWorkspaceIndex(options) {
  return {
    schemaVersion: workspaceIndexVersion,
    updatedAt: null,
    root: workspaceIndexRoot(options),
    codebases: [],
  }
}

function normalizeWorkspaceIndex(value, options) {
  if (!value || typeof value !== 'object') return emptyWorkspaceIndex(options)
  const codebases = Array.isArray(value.codebases)
    ? value.codebases.filter((entry) => entry && typeof entry.id === 'string' && entry.id.length > 0)
    : []

  return {
    ...value,
    schemaVersion: workspaceIndexVersion,
    root: value.root && typeof value.root === 'object' ? value.root : workspaceIndexRoot(options),
    codebases,
  }
}

function mergeIndexedCodebases(indexedCodebases, current) {
  const byId = new Map()
  for (const codebase of indexedCodebases ?? []) {
    if (codebase?.id) byId.set(workspaceIndexEntryKey(codebase), codebase)
  }
  if (current?.id) {
    const key = workspaceIndexEntryKey(current)
    const existing = byId.get(key) ?? {}
    const localCache = mergeLocalCache(existing.localCache, current.localCache)
    byId.set(key, {
      ...existing,
      ...current,
      ...(localCache ? { localCache } : {}),
    })
  }

  return [...byId.values()].sort((a, b) => {
    const nameCompare = String(a.name ?? a.id).localeCompare(String(b.name ?? b.id))
    return nameCompare || String(a.id).localeCompare(String(b.id))
  })
}

function workspaceIndexEntryKey(entry) {
  const workspacePath = entry.workspace?.path ? path.resolve(entry.workspace.path) : '(unbound)'
  return `${entry.id}:${workspacePath}`
}

function findIndexedCodebase(index, codebaseId, workspacePath = null) {
  if (!index || !codebaseId) return null
  const resolvedWorkspace = workspacePath ? path.resolve(workspacePath) : null
  return (
    (index.codebases ?? []).find((codebase) => {
      if (codebase.id !== codebaseId) return false
      if (!resolvedWorkspace) return true
      return path.resolve(codebase.workspace?.path ?? '') === resolvedWorkspace
    }) ?? null
  )
}

function storableWorkspaceIndexEntry(entry) {
  if (!entry?.workspace?.index) return entry
  const { index: _index, ...workspace } = entry.workspace
  return {
    ...entry,
    workspace,
  }
}

function workspaceIndexEntryFromCloud(options, cloud, metadata = {}) {
  const now = metadata.now ?? new Date().toISOString()
  const codebaseId = cloud.codebase?.id ?? options['codebase-id'] ?? path.basename(path.resolve(options.workspace))
  const hydrationState = metadata.hydrationState ?? 'materialized'
  const hydratedPaths = Array.isArray(metadata.hydratedPaths)
    ? uniqueCloudPaths(metadata.hydratedPaths)
    : hydrationState === 'materialized'
      ? Object.keys(cloud.files ?? {}).sort()
      : []
  const materializedRevision = hydrationState === 'materialized' ? (cloud.revision ?? null) : null
  const contentManifest = contentManifestFromCloud(cloud, hydratedPaths)
  const hydration = {
    state: hydrationState,
    lastMaterializedAt: now,
    lastMaterializedRevision: materializedRevision,
    selectedStateRevision: cloud.selectedState?.revision ?? null,
    source: metadata.reason ?? 'unknown',
    lastEvent: metadata.lastEvent ?? null,
    hydratedPathCount: hydratedPaths.length,
  }
  const localCache = localCachePatchFromCloudMetadata(cloud, metadata, now)

  return {
    id: codebaseId,
    name: cloud.codebase?.name ?? codebaseId,
    initialized: true,
    workspace: {
      root: path.resolve(workspaceRootFromOptions(options)),
      path: path.resolve(options.workspace),
      exists: existsSync(options.workspace),
      adapter: workspaceMode.adapter,
      cacheMode: workspaceMode.cacheMode,
      virtualized: false,
    },
    cloud: {
      path: cloudLocationFromOptions(options, codebaseId),
      service: cloudServiceTypeFromOptions(options),
      exists: true,
    },
    activeChangeSetId: cloud.selectedState?.type === 'active-change-set' ? cloud.selectedState.id : null,
    mainId: cloud.main?.id ?? null,
    visibleFileCount: Object.keys(cloud.files ?? {}).length,
    hiddenFileCount: cloud.visibilityContext?.hiddenFileCount ?? null,
    materialization: metadata.materialization ?? (hydrationState === 'materialized' ? 'managed-folder' : 'metadata-only'),
    hydration,
    hydratedPaths,
    contentManifest,
    ...(localCache ? { localCache } : {}),
    remoteCursor: {
      graphRevision: cloud.revision ?? null,
      selectedStateRevision: cloud.selectedState?.revision ?? null,
      materializedRevision: hydration.lastMaterializedRevision,
      lastMaterializedAt: hydration.lastMaterializedAt,
    },
    virtualized: false,
    updatedAt: now,
  }
}

function workspaceIndexRoot(options) {
  return {
    path: path.resolve(workspaceRootFromOptions(options)),
    adapter: workspaceMode.adapter,
    cacheMode: workspaceMode.cacheMode,
    sourceOfTruth: workspaceMode.sourceOfTruth,
    virtualized: false,
  }
}

function workspaceIndexPath(options) {
  return options['workspace-index'] ?? path.join(agentStateRootFromOptions(options), 'workspaces.json')
}

function agentStateRootFromOptions(options) {
  return options['state-root'] ?? path.dirname(path.resolve(options.journal))
}

function workspaceIndexSummary(options, index) {
  return {
    path: path.resolve(workspaceIndexPath(options)),
    exists: Boolean(index),
    schemaVersion: index?.schemaVersion ?? null,
    updatedAt: index?.updatedAt ?? null,
    codebaseCount: index?.codebases?.length ?? 0,
  }
}

function contentManifestFromCloud(cloud, hydratedPaths = Object.keys(cloud.files ?? {})) {
  const files = {}
  for (const relativePath of uniqueCloudPaths(hydratedPaths)) {
    const file = cloud.files?.[relativePath]
    if (!file) continue
    const entry = normalizeCloudFileEntry(relativePath, file)
    files[relativePath] = {
      kind: entry.kind,
      hash: entry.hash,
      size: entry.size,
      scope: entry.scope ?? scopeForPath(relativePath),
      privacyZone: entry.privacyZone ?? privacyZoneForPath(relativePath),
      revision: Number.isInteger(entry.revision) ? entry.revision : null,
      target: entry.target ?? null,
    }
  }

  return {
    schemaVersion: 1,
    source: 'cloud-visible-graph',
    fileCount: Object.keys(files).length,
    files,
  }
}

async function contentManifestFromWorkspace(root) {
  const diskFiles = await readWorkspaceFiles(root)
  const files = {}
  for (const relativePath of Object.keys(diskFiles).sort()) {
    const entry = normalizeCloudFileEntry(relativePath, diskFiles[relativePath])
    files[relativePath] = {
      kind: entry.kind,
      hash: entry.hash,
      size: entry.size,
      scope: entry.scope,
      privacyZone: entry.privacyZone ?? privacyZoneForPath(relativePath),
      revision: null,
      target: entry.target ?? null,
    }
  }

  return {
    schemaVersion: 1,
    source: 'workspace-disk',
    fileCount: Object.keys(files).length,
    files,
  }
}

function contentManifestSummary(manifest) {
  return {
    exists: Boolean(manifest?.files),
    schemaVersion: manifest?.schemaVersion ?? null,
    fileCount: manifest?.fileCount ?? (manifest?.files ? Object.keys(manifest.files).length : 0),
    source: manifest?.source ?? null,
  }
}

async function workspaceLocalChanges(options, indexedCodebase) {
  if (!existsSync(options.workspace)) {
    return {
      safe: false,
      state: 'missing',
      reason: 'workspace_missing',
      addedCount: 0,
      modifiedCount: 0,
      deletedCount: 0,
      samplePaths: [],
    }
  }

  const baseline = indexedCodebase?.contentManifest
  if (!baseline?.files) {
    const hasEntries = await workspaceHasIncludedEntries(options.workspace, options)
    if (!hasEntries) {
      return {
        safe: true,
        state: 'clean',
        reason: null,
        addedCount: 0,
        modifiedCount: 0,
        deletedCount: 0,
        samplePaths: [],
      }
    }

    return {
      safe: false,
      state: 'unknown',
      reason: 'workspace_manifest_missing',
      addedCount: 0,
      modifiedCount: 0,
      deletedCount: 0,
      samplePaths: [],
    }
  }

  const diff = await diffWorkspaceAgainstManifest(options.workspace, baseline, options)
  const dirty = diff.addedCount > 0 || diff.modifiedCount > 0 || diff.deletedCount > 0

  return {
    safe: !dirty,
    state: dirty ? 'dirty' : 'clean',
    reason: dirty ? 'workspace_has_unjournaled_changes' : null,
    addedCount: diff.addedCount,
    modifiedCount: diff.modifiedCount,
    deletedCount: diff.deletedCount,
    samplePaths: diff.samplePaths,
  }
}

async function workspaceHasIncludedEntries(root, options = {}) {
  let found = false

  async function walk(dir) {
    if (found) return 0
    const entries = await sortedDirEntries(dir)
    let includedChildren = 0

    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name)
      const relativePath = toCloudPath(path.relative(root, absolutePath))
      if (shouldSkipWorkspacePath(relativePath, entry, options)) continue

      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const childCount = await walk(absolutePath)
        if (childCount === 0) {
          found = true
          includedChildren += 1
        } else {
          includedChildren += childCount
        }
      } else {
        found = true
        includedChildren += 1
      }

      if (found) return includedChildren
    }

    return includedChildren
  }

  await walk(root)
  return found
}

async function diffWorkspaceAgainstManifest(root, baseline, options = {}) {
  const baselineFiles = baseline?.files ?? {}
  const seen = new Set()
  const samplePaths = []
  let addedCount = 0
  let modifiedCount = 0

  function sample(relativePath) {
    if (samplePaths.length < 10) samplePaths.push(relativePath)
  }

  function recordAdded(relativePath) {
    addedCount += 1
    sample(relativePath)
  }

  async function compareEntry(relativePath, actualFactory) {
    const expected = baselineFiles[relativePath]
    if (!expected) {
      recordAdded(relativePath)
      return
    }

    seen.add(relativePath)
    const actual = await actualFactory()
    if (manifestEntryChanged(expected, actual)) {
      modifiedCount += 1
      sample(relativePath)
    }
  }

  async function walk(dir) {
    const entries = await sortedDirEntries(dir)
    let includedChildren = 0

    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name)
      const relativePath = toCloudPath(path.relative(root, absolutePath))
      if (shouldSkipWorkspacePath(relativePath, entry, options)) continue

      if (entry.isSymbolicLink()) {
        await compareEntry(relativePath, () => readWorkspaceSymlinkEntry(root, relativePath, absolutePath))
        includedChildren += 1
        continue
      }

      if (entry.isDirectory()) {
        const childCount = await walk(absolutePath)
        if (childCount === 0) {
          await compareEntry(relativePath, () => workspaceDirectoryEntry(relativePath))
          includedChildren += 1
        } else {
          includedChildren += childCount
        }
        continue
      }

      if (!entry.isFile()) continue

      await compareEntry(relativePath, () => readWorkspaceFileEntry(root, relativePath, absolutePath))
      includedChildren += 1
    }

    return includedChildren
  }

  await walk(root)

  let deletedCount = 0
  for (const relativePath of Object.keys(baselineFiles).sort()) {
    if (seen.has(relativePath)) continue
    deletedCount += 1
    sample(relativePath)
  }

  return {
    addedCount,
    modifiedCount,
    deletedCount,
    samplePaths,
  }
}

function manifestEntryChanged(expected, actual) {
  return (
    expected.kind !== actual.kind ||
    expected.hash !== actual.hash ||
    expected.size !== actual.size ||
    expected.scope !== actual.scope ||
    (expected.target ?? null) !== (actual.target ?? null)
  )
}

function diffContentManifests(baseline, disk) {
  const baselineFiles = baseline?.files ?? {}
  const diskFiles = disk?.files ?? {}
  const addedPaths = []
  const modifiedPaths = []
  const deletedPaths = []

  for (const relativePath of Object.keys(diskFiles).sort()) {
    const expected = baselineFiles[relativePath]
    const actual = diskFiles[relativePath]
    if (!expected) {
      addedPaths.push(relativePath)
      continue
    }
    if (
      expected.kind !== actual.kind ||
      expected.hash !== actual.hash ||
      expected.size !== actual.size ||
      expected.scope !== actual.scope ||
      (expected.target ?? null) !== (actual.target ?? null)
    ) {
      modifiedPaths.push(relativePath)
    }
  }

  for (const relativePath of Object.keys(baselineFiles).sort()) {
    if (!diskFiles[relativePath]) deletedPaths.push(relativePath)
  }

  return { addedPaths, modifiedPaths, deletedPaths }
}

function buildWorkspaceHydration({
  cloudSummary,
  workspaceExists,
  lastWorkspaceReady,
  lastRefreshComplete,
  indexedCodebase,
}) {
  const indexedHydration = indexedCodebase?.hydration ?? null
  const latestMaterializedEvent = latestEvent([lastWorkspaceReady, lastRefreshComplete])
  const lastMaterializedRevision = visibleRevisionFromEvent(latestMaterializedEvent)

  let state = 'not_initialized'
  if (cloudSummary.exists && workspaceExists && indexedHydration?.state === 'metadata-only') {
    state = 'metadata-only'
  } else if (cloudSummary.exists && workspaceExists && indexedHydration?.state === 'partial') {
    state = 'partial'
  } else if (cloudSummary.exists && workspaceExists && latestMaterializedEvent) {
    state = 'materialized'
  } else if (cloudSummary.exists && workspaceExists) {
    state = 'not_materialized'
  } else if (cloudSummary.exists) {
    state = 'not_materialized'
  }

  return {
    state,
    lastMaterializedAt: indexedHydration?.lastMaterializedAt ?? latestMaterializedEvent?.at ?? null,
    lastMaterializedRevision: indexedHydration?.lastMaterializedRevision ?? lastMaterializedRevision,
    selectedStateRevision: cloudSummary.selectedState?.revision ?? null,
    graphRevision: cloudSummary.revision,
    sourceEvent: indexedHydration?.lastEvent ?? latestMaterializedEvent?.event ?? null,
    hydratedPathCount: indexedHydration?.hydratedPathCount ?? indexedHydration?.hydratedPaths?.length ?? null,
  }
}

function buildRemoteCursor({ cloudSummary, eventsSummary, hydration }) {
  const latestCursorEvent = latestEvent([
    eventsSummary.lastWorkspaceReady,
    eventsSummary.lastRefreshComplete,
    eventsSummary.lastRemoteUpdate,
    eventsSummary.lastAcknowledgement,
  ])
  const graphRevision = cloudSummary.revision
  const materializedRevision = hydration.lastMaterializedRevision
  const behindByRevisions =
    Number.isInteger(graphRevision) && Number.isInteger(materializedRevision)
      ? Math.max(0, graphRevision - materializedRevision)
      : null

  return {
    graphRevision,
    selectedStateId: cloudSummary.selectedState?.id ?? null,
    selectedStateType: cloudSummary.selectedState?.type ?? null,
    selectedStateRevision: cloudSummary.selectedState?.revision ?? null,
    materializedRevision,
    lastMaterializedAt: hydration.lastMaterializedAt,
    lastRemoteUpdateRevision: visibleRevisionFromEvent(eventsSummary.lastRemoteUpdate),
    latestEventRevision: visibleRevisionFromEvent(latestCursorEvent),
    latestEvent: latestCursorEvent?.event ?? null,
    eventCount: eventsSummary.totalEntries,
    behindByRevisions,
  }
}

async function assertExportOutputSafe(output, options) {
  const workspace = path.resolve(options.workspace)
  const unsafeRoots = new Set([path.parse(output).root, os.homedir(), process.cwd()])
  if (unsafeRoots.has(output)) {
    throw new Error(`Refusing to export into unsafe output path: ${output}`)
  }
  if (pathsOverlap(output, workspace)) {
    throw new Error(`Refusing to export into or around the managed workspace: ${output}`)
  }
}

async function assertBackupOutputSafe(output, options) {
  const unsafeRoots = new Set([path.parse(output).root, os.homedir(), process.cwd(), path.resolve(options.workspace)])
  if (unsafeRoots.has(output)) {
    throw new Error(`Refusing to write backup into unsafe output path: ${output}`)
  }
}

async function prepareCleanOutputDirectory(output, options) {
  if (!existsSync(output)) {
    await fs.mkdir(output, { recursive: true })
    return
  }

  const entries = await fs.readdir(output)
  if (entries.length > 0 && !options.force) {
    throw new Error(`Export output is not empty: ${output}. Use --force to replace it.`)
  }

  await fs.rm(output, { recursive: true, force: true })
  await fs.mkdir(output, { recursive: true })
}

function backupDirectoryName(options) {
  const codebaseId = options['codebase-id'] ?? 'hopit'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${codebaseId}-${stamp}`
}

async function writeBackupFile(output, files, relativePath, value) {
  const destination = path.join(output, relativePath)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  const content = `${JSON.stringify(value, null, 2)}\n`
  await fs.writeFile(destination, content, 'utf8')
  files.push({
    path: relativePath,
    bytes: Buffer.byteLength(content),
    sha256: hashContent(content),
  })
}

async function copyBackupFileIfExists(output, files, relativePath, sourcePath) {
  if (!existsSync(sourcePath)) return
  const destination = path.join(output, relativePath)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  const content = await fs.readFile(sourcePath)
  await fs.writeFile(destination, content)
  files.push({
    path: relativePath,
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  })
}

function productionEnvTemplate(options) {
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

async function writeLaunchAgent(options) {
  if (process.platform !== 'darwin') {
    throw new Error('--launch-agent currently supports macOS launchd only.')
  }
  const codebaseId = options['codebase-id'] ?? 'hopit'
  const label = `com.hopit.agent.${codebaseId}`
  const launchAgentsRoot = path.join(os.homedir(), 'Library', 'LaunchAgents')
  const plistPath = path.join(launchAgentsRoot, `${label}.plist`)
  const hopBin = options['hop-bin'] ?? process.argv[1] ?? __filename
  const programArguments = [
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
    programArguments.push('--remote-pull')
  }
  if (options['remote-pull-cooldown-ms']) {
    programArguments.push('--remote-pull-cooldown-ms', options['remote-pull-cooldown-ms'])
  } else if (options['remote-refresh-interval-ms']) {
    programArguments.push('--remote-refresh-interval-ms', options['remote-refresh-interval-ms'])
  }

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

function escapePlist(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
  })

  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }

  return result
}

async function readAgentStatusEndpoint(options) {
  const cloudService = createCloudGraphService(options)
  const [journalEntries, eventEntries, workspaceIndex] = await Promise.all([
    readNdjson(options.journal),
    readNdjson(options.events),
    readWorkspaceIndex(options),
  ])
  const journalState = classifyJournalEntries(journalEntries, eventEntries)
  const eventsSummary = {
    ...summarizeAgentEvents(eventEntries),
    path: path.resolve(options.events),
    exists: existsSync(options.events),
  }
  const journalSummary = {
    ...summarizeAgentJournal(journalEntries, journalState),
    path: path.resolve(options.journal),
    exists: existsSync(options.journal),
  }
  const indexedCodebase = findIndexedCodebase(workspaceIndex, options['codebase-id'], options.workspace)
  const cloudSummary = fastCloudSummaryFromIndex(options, cloudService, indexedCodebase)
  const workspaceExists = existsSync(options.workspace)
  const hydration = buildWorkspaceHydration({
    cloudSummary,
    workspaceExists,
    lastWorkspaceReady: eventsSummary.lastWorkspaceReady,
    lastRefreshComplete: eventsSummary.lastRefreshComplete,
    indexedCodebase,
  })
  const syncHealth = buildSyncHealth(eventsSummary)
  const refreshHealth = buildRefreshHealth(eventsSummary)
  const watchHealth = buildWatchHealth(eventsSummary)
  const remotePullHealth = buildRemotePullHealth(options, eventsSummary)
  remotePullHealth.cursor = buildRemoteCursor({
    cloudSummary,
    eventsSummary,
    hydration,
  })
  const initialized = cloudSummary.exists && (hydration.state === 'materialized' || hydration.state === 'partial')
  const attached = cloudSummary.exists && hydration.state === 'metadata-only'
  const readiness = initialized || watchHealth.state === 'watching' ? 'ready' : attached ? 'attached' : 'not_initialized'
  const localCache = localCacheSnapshotForCloud(options, null, indexedCodebase)

  return {
    ok:
      (readiness === 'ready' || readiness === 'attached') &&
      journalSummary.failedCount === 0 &&
      syncHealth.state !== 'failed' &&
      refreshHealth.state !== 'blocked' &&
      !watchHealth.state.endsWith('degraded') &&
      watchHealth.state !== 'blocked',
    generatedAt: new Date().toISOString(),
    readiness,
    mode: workspaceMode,
    codebaseId: cloudSummary.codebase?.id ?? options['codebase-id'] ?? null,
    codebaseName: cloudSummary.codebase?.name ?? null,
    selectedStateType: cloudSummary.selectedState?.type ?? null,
    activeChangeSetId:
      cloudSummary.selectedState?.type === 'active-change-set' ? cloudSummary.selectedState.id : indexedCodebase?.activeChangeSetId ?? null,
    mainId: cloudSummary.main?.id ?? indexedCodebase?.mainId ?? null,
    ownerId: cloudSummary.owner?.id ?? cloudSummary.codebase?.ownerId ?? null,
    sessionId: cloudSummary.session?.id ?? null,
    requesterId: null,
    requesterSessionId: cloudSummary.session?.id ?? null,
    requesterRole: null,
    visibleFileCount: cloudSummary.fileCount,
    hiddenFileCount: cloudSummary.hiddenFileCount,
    hiddenScopeCounts: cloudSummary.hiddenScopeCounts,
    effectiveChangeSetVisibility:
      cloudSummary.selectedState?.effectiveVisibility ?? cloudSummary.visibility?.effective ?? null,
    review: {
      state: cloudSummary.selectedState?.reviewState ?? 'not-open',
      detail: cloudSummary.selectedState?.review ?? null,
    },
    merge: {
      state: cloudSummary.selectedState?.mergeState ?? 'unmerged',
      detail: cloudSummary.selectedState?.merge ?? null,
      mainRevision: cloudSummary.main?.revision ?? null,
    },
    conflict: {
      state: cloudSummary.selectedState?.conflictState ?? 'none',
      detail: cloudSummary.selectedState?.conflict ?? null,
    },
    workspace: {
      root: path.resolve(workspaceRootFromOptions(options)),
      path: path.resolve(options.workspace),
      exists: workspaceExists,
      adapter: workspaceMode.adapter,
      cacheMode: workspaceMode.cacheMode,
      hydration,
      localChanges: {
        safe: true,
        state: 'not_scanned',
        reason: 'status_endpoint_avoids_workspace_scan',
        addedCount: null,
        modifiedCount: null,
        deletedCount: null,
        samplePaths: [],
      },
      contentManifest: contentManifestSummary(indexedCodebase?.contentManifest),
      cache: localCache.summary,
      files: localCache.files,
      index: workspaceIndexSummary(options, workspaceIndex),
      virtualized: false,
    },
    cloud: cloudSummary,
    journal: {
      path: journalSummary.path,
      exists: journalSummary.exists,
      totalEntries: journalSummary.totalEntries,
      pendingCount: journalSummary.pendingCount,
      failedCount: journalSummary.failedCount,
      acknowledgedCount: journalSummary.acknowledgedCount,
      scopeCounts: journalSummary.scopeCounts,
      pendingScopeCounts: journalSummary.pendingScopeCounts,
      failedScopeCounts: journalSummary.failedScopeCounts,
      acknowledgedScopeCounts: journalSummary.acknowledgedScopeCounts,
    },
    sync: syncHealth,
    refresh: refreshHealth,
    remoteUpdate: {
      state: eventsSummary.lastRemoteUpdate ? 'updated' : 'idle',
      lastUpdate: eventsSummary.lastRemoteUpdate,
    },
    remotePull: remotePullHealth,
    watch: watchHealth,
    events: eventsSummary,
  }
}

async function readAgentEventsEndpoint(options) {
  return {
    ...summarizeAgentEvents(await readNdjson(options.events)),
    path: path.resolve(options.events),
    exists: existsSync(options.events),
  }
}

async function readAgentJournalEndpoint(options) {
  const [journalEntries, eventEntries] = await Promise.all([
    readNdjson(options.journal),
    readNdjson(options.events),
  ])
  return {
    ...summarizeAgentJournal(journalEntries, classifyJournalEntries(journalEntries, eventEntries)),
    path: path.resolve(options.journal),
    exists: existsSync(options.journal),
  }
}

async function readAgentCloudEndpoint(options) {
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readOptionalVisibleGraph(visibilityRequestFromOptions(options))
  const cloudFiles = cloud?.files ? Object.keys(cloud.files) : []
  const cloudSummary = {
    path: cloudService.location ?? path.resolve(options.cloud),
    service: cloudService.type,
    exists: Boolean(cloud),
    schemaVersion: cloud?.schemaVersion ?? null,
    codebase: cloud?.codebase
      ? {
          id: cloud.codebase.id ?? null,
          name: cloud.codebase.name ?? null,
          ownerId: cloud.codebase.ownerId ?? null,
        }
      : null,
    main: cloud?.main
      ? {
          id: cloud.main.id ?? null,
          revision: cloud.main.revision ?? null,
        }
      : null,
    selectedState: cloud?.selectedState
      ? {
          type: cloud.selectedState.type ?? null,
          id: cloud.selectedState.id ?? null,
          ownerId: cloud.selectedState.ownerId ?? null,
          baseMainId: cloud.selectedState.baseMainId ?? null,
          baseRevision: cloud.selectedState.baseRevision ?? null,
          revision: cloud.selectedState.revision ?? null,
          visibility: cloud.selectedState.visibility ?? null,
          effectiveVisibility: cloud.selectedState.effectiveVisibility ?? null,
          reviewState: cloud.selectedState.reviewState ?? null,
          mergeState: cloud.selectedState.mergeState ?? null,
          conflictState: cloud.selectedState.conflictState ?? null,
          conflict: cloud.selectedState.conflict ?? null,
          review: cloud.selectedState.review ?? null,
          merge: cloud.selectedState.merge ?? null,
        }
      : null,
    owner: cloud?.owner
      ? {
          id: cloud.owner.id ?? null,
        }
      : null,
    session: cloud?.session
      ? {
          id: cloud.session.id ?? null,
          deviceName: cloud.session.deviceName ?? null,
        }
      : null,
    requester: cloud?.visibilityContext ? summarizeRequester(cloud.visibilityContext) : null,
    access: cloud?.visibilityContext ? summarizeRequester(cloud.visibilityContext) : null,
    hiddenFileCount: cloud?.visibilityContext?.hiddenFileCount ?? null,
    hiddenScopeCounts: cloud?.visibilityContext?.hiddenScopeCounts ?? null,
    visibility: cloud?.visibility
      ? {
          productDefault: cloud.visibility.productDefault ?? null,
          globalUserDefault: cloud.visibility.globalUserDefault ?? null,
          codebaseOverride: cloud.visibility.codebaseOverride ?? null,
          changeSetOverride: cloud.visibility.changeSetOverride ?? null,
          effective: cloud.visibility.effective ?? null,
        }
      : null,
    revision: cloud?.revision ?? null,
    fileCount: cloudFiles.length,
    scopeCounts: countCloudScopes(cloud),
  }

  return {
    ...cloudSummary,
    graph: cloud,
  }
}

function summarizeAgentEvents(eventEntries) {
  const lastAcknowledgement = findLastEvent(eventEntries, 'cloud.acknowledged')
  const lastSync = findLastEvent(eventEntries, 'sync.complete')
  const lastStartedSync = findLastEvent(eventEntries, 'sync.started')
  const lastFailedSync = findLastEvent(eventEntries, 'sync.failed')
  const lastRecoveredSync = findLastEvent(eventEntries, 'sync.recovered')
  const latestSyncEvent = findLastEventOf(eventEntries, [
    'sync.started',
    'sync.complete',
    'sync.failed',
    'sync.recovered',
  ])
  const lastRefreshStarted = findLastEvent(eventEntries, 'refresh.started')
  const lastRefreshBlocked = findLastEvent(eventEntries, 'refresh.blocked')
  const lastRefreshComplete = findLastEvent(eventEntries, 'refresh.complete')
  const lastWorkspaceReady = findLastEvent(eventEntries, 'workspace.ready')
  const lastRemoteUpdate = findLastEvent(eventEntries, 'remote-update')
  const lastRemotePullStarted = findLastEvent(eventEntries, 'remote-pull.started')
  const lastRemotePullSkipped = findLastEvent(eventEntries, 'remote-pull.skipped')
  const lastRemotePullFailed = findLastEvent(eventEntries, 'remote-pull.failed')
  const lastRemotePullApplied = findLastEvent(eventEntries, 'remote-pull.applied')
  const latestRemotePullEvent = findLastEventOf(eventEntries, [
    'remote-pull.started',
    'remote-pull.applied',
    'remote-pull.skipped',
    'remote-pull.failed',
  ])
  const latestRefreshEvent = findLastEventOf(eventEntries, [
    'refresh.started',
    'refresh.blocked',
    'refresh.complete',
  ])
  const lastRecovery = findLastEvent(eventEntries, 'journal.recovery_complete')
  const lastWatchStarted = findLastEvent(eventEntries, 'watch.started')
  const lastWatchDegraded = findLastEvent(eventEntries, 'watch.degraded')
  const lastWatchRecoveryBlocked = findLastEvent(eventEntries, 'watch.recovery_blocked')
  const latestWatchEvent = findLastEventOf(eventEntries, [
    'watch.started',
    'watch.degraded',
    'watch.recovery_blocked',
  ])

  return {
    path: null,
    exists: eventEntries.length > 0,
    totalEntries: eventEntries.length,
    recent: eventEntries.slice(-20),
    lastAcknowledgement,
    lastSync,
    lastStartedSync,
    lastFailedSync,
    lastRecoveredSync,
    latestSyncEvent,
    lastWorkspaceReady,
    lastRefreshStarted,
    lastRefreshBlocked,
    lastRefreshComplete,
    lastRemoteUpdate,
    lastRemotePullStarted,
    lastRemotePullApplied,
    lastRemotePullSkipped,
    lastRemotePullFailed,
    latestRemotePullEvent,
    lastReviewOpened: findLastEvent(eventEntries, 'change_set.review_opened'),
    lastChangeSetMerged: findLastEvent(eventEntries, 'change_set.merged'),
    lastConflictDetected: findLastEvent(eventEntries, 'change_set.conflict_detected'),
    latestRefreshEvent,
    lastRecovery,
    lastWatchStarted,
    lastWatchDegraded,
    lastWatchRecoveryBlocked,
    latestWatchEvent,
  }
}

function summarizeAgentJournal(journalEntries, journalState) {
  const pendingJournalEntries = journalState.entries.filter((entry) => entry.recoveryStatus === 'pending')
  const failedJournalEntries = journalState.entries.filter((entry) => entry.recoveryStatus === 'failed')
  const acknowledgedJournalEntries = journalState.entries.filter(
    (entry) => entry.recoveryStatus === 'acknowledged',
  )

  return {
    path: null,
    exists: journalEntries.length > 0,
    totalEntries: journalEntries.length,
    pendingCount: pendingJournalEntries.length,
    failedCount: failedJournalEntries.length,
    acknowledgedCount: acknowledgedJournalEntries.length,
    scopeCounts: countEntryScopes(journalEntries),
    pendingScopeCounts: countEntryScopes(pendingJournalEntries),
    failedScopeCounts: countEntryScopes(failedJournalEntries),
    acknowledgedScopeCounts: countEntryScopes(acknowledgedJournalEntries),
    pendingEntries: pendingJournalEntries,
    failedEntries: failedJournalEntries,
    acknowledgedEntries: acknowledgedJournalEntries,
    entries: journalState.entries,
  }
}

function fastCloudSummaryFromIndex(options, cloudService, indexedCodebase) {
  const codebaseId = indexedCodebase?.id ?? options['codebase-id'] ?? null
  const selectedStateType = indexedCodebase?.activeChangeSetId ? 'active-change-set' : null
  const revision = indexedCodebase?.remoteCursor?.graphRevision ?? indexedCodebase?.hydration?.lastMaterializedRevision ?? null
  const selectedStateRevision = indexedCodebase?.remoteCursor?.selectedStateRevision ?? null

  return {
    path: cloudService.location ?? cloudLocationFromOptions(options, codebaseId),
    service: cloudService.type,
    exists: Boolean(indexedCodebase?.cloud?.exists ?? indexedCodebase),
    schemaVersion: null,
    codebase: codebaseId
      ? {
          id: codebaseId,
          name: indexedCodebase?.name ?? codebaseId,
          ownerId: null,
        }
      : null,
    main: indexedCodebase?.mainId
      ? {
          id: indexedCodebase.mainId,
          revision,
        }
      : null,
    selectedState: selectedStateType
      ? {
          type: selectedStateType,
          id: indexedCodebase.activeChangeSetId,
          ownerId: null,
          baseMainId: indexedCodebase.mainId ?? null,
          baseRevision: null,
          revision: selectedStateRevision,
          visibility: null,
          effectiveVisibility: null,
          reviewState: 'not-open',
          mergeState: 'unmerged',
          conflictState: 'none',
          conflict: null,
          review: null,
          merge: null,
        }
      : null,
    owner: null,
    session: {
      id: options['session-id'] ?? null,
      deviceName: options['device-name'] ?? null,
    },
    requester: null,
    hiddenFileCount: indexedCodebase?.hiddenFileCount ?? null,
    hiddenScopeCounts: indexedCodebase?.hiddenScopeCounts ?? null,
    visibility: null,
    revision,
    fileCount: indexedCodebase?.visibleFileCount ?? indexedCodebase?.hydration?.hydratedPathCount ?? 0,
    scopeCounts: indexedCodebase?.scopeCounts ?? null,
  }
}

async function readAgentState(options) {
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readOptionalVisibleGraph(visibilityRequestFromOptions(options))
  const journalEntries = await readNdjson(options.journal)
  const eventEntries = await readNdjson(options.events)
  const journalState = classifyJournalEntries(journalEntries, eventEntries)
  const recentEvents = eventEntries.slice(-20)
  const lastAcknowledgement = findLastEvent(eventEntries, 'cloud.acknowledged')
  const lastSync = findLastEvent(eventEntries, 'sync.complete')
  const lastStartedSync = findLastEvent(eventEntries, 'sync.started')
  const lastFailedSync = findLastEvent(eventEntries, 'sync.failed')
  const lastRecoveredSync = findLastEvent(eventEntries, 'sync.recovered')
  const latestSyncEvent = findLastEventOf(eventEntries, [
    'sync.started',
    'sync.complete',
    'sync.failed',
    'sync.recovered',
  ])
  const syncHealth = buildSyncHealth({
    lastStartedSync,
    lastSuccessfulSync: lastSync,
    lastFailedSync,
    lastRecoveredSync,
    latestSyncEvent,
  })
  const lastRefreshStarted = findLastEvent(eventEntries, 'refresh.started')
  const lastRefreshBlocked = findLastEvent(eventEntries, 'refresh.blocked')
  const lastRefreshComplete = findLastEvent(eventEntries, 'refresh.complete')
  const lastWorkspaceReady = findLastEvent(eventEntries, 'workspace.ready')
  const lastRemoteUpdate = findLastEvent(eventEntries, 'remote-update')
  const lastRemotePullStarted = findLastEvent(eventEntries, 'remote-pull.started')
  const lastRemotePullSkipped = findLastEvent(eventEntries, 'remote-pull.skipped')
  const lastRemotePullFailed = findLastEvent(eventEntries, 'remote-pull.failed')
  const latestRemotePullEvent = findLastEventOf(eventEntries, [
    'remote-pull.started',
    'remote-pull.applied',
    'remote-pull.skipped',
    'remote-pull.failed',
  ])
  const lastRemotePullApplied = findLastEvent(eventEntries, 'remote-pull.applied')
  const remotePullHealth = buildRemotePullHealth(options, {
    lastRemotePullStarted,
    lastRemotePullApplied,
    lastRemotePullSkipped,
    lastRemotePullFailed,
    latestRemotePullEvent,
  })
  const latestRefreshEvent = findLastEventOf(eventEntries, [
    'refresh.started',
    'refresh.blocked',
    'refresh.complete',
  ])
  const refreshHealth = buildRefreshHealth({
    lastRefreshStarted,
    lastRefreshBlocked,
    lastRefreshComplete,
    latestRefreshEvent,
  })
  const lastRecovery = findLastEvent(eventEntries, 'journal.recovery_complete')
  const lastWatchStarted = findLastEvent(eventEntries, 'watch.started')
  const lastWatchDegraded = findLastEvent(eventEntries, 'watch.degraded')
  const lastWatchRecoveryBlocked = findLastEvent(eventEntries, 'watch.recovery_blocked')
  const latestWatchEvent = findLastEventOf(eventEntries, [
    'watch.started',
    'watch.degraded',
    'watch.recovery_blocked',
  ])
  const watchHealth = buildWatchHealth({
    lastWatchStarted,
    lastWatchDegraded,
    lastWatchRecoveryBlocked,
    latestWatchEvent,
  })
  const cloudFiles = cloud?.files ? Object.keys(cloud.files) : []
  const scopeCounts = countCloudScopes(cloud)
  const pendingJournalEntries = journalState.entries.filter((entry) => entry.recoveryStatus === 'pending')
  const failedJournalEntries = journalState.entries.filter((entry) => entry.recoveryStatus === 'failed')
  const acknowledgedJournalEntries = journalState.entries.filter(
    (entry) => entry.recoveryStatus === 'acknowledged',
  )
  const workspaceExists = existsSync(options.workspace)
  const workspaceIndex = await readWorkspaceIndex(options)
  const indexedCodebase = findIndexedCodebase(
    workspaceIndex,
    cloud?.codebase?.id ?? options['codebase-id'],
    options.workspace,
  )

  const cloudSummary = {
    path: cloudService.location ?? path.resolve(options.cloud),
    service: cloudService.type,
    exists: Boolean(cloud),
    schemaVersion: cloud?.schemaVersion ?? null,
    codebase: cloud?.codebase
      ? {
          id: cloud.codebase.id ?? null,
          name: cloud.codebase.name ?? null,
          ownerId: cloud.codebase.ownerId ?? null,
        }
      : null,
    main: cloud?.main
      ? {
          id: cloud.main.id ?? null,
          revision: cloud.main.revision ?? null,
        }
      : null,
    selectedState: cloud?.selectedState
      ? {
          type: cloud.selectedState.type ?? null,
          id: cloud.selectedState.id ?? null,
          ownerId: cloud.selectedState.ownerId ?? null,
          baseMainId: cloud.selectedState.baseMainId ?? null,
          baseRevision: cloud.selectedState.baseRevision ?? null,
          revision: cloud.selectedState.revision ?? null,
          visibility: cloud.selectedState.visibility ?? null,
          effectiveVisibility: cloud.selectedState.effectiveVisibility ?? null,
          reviewState: cloud.selectedState.reviewState ?? null,
          mergeState: cloud.selectedState.mergeState ?? null,
          conflictState: cloud.selectedState.conflictState ?? null,
          conflict: cloud.selectedState.conflict ?? null,
          review: cloud.selectedState.review ?? null,
          merge: cloud.selectedState.merge ?? null,
        }
      : null,
    owner: cloud?.owner
      ? {
          id: cloud.owner.id ?? null,
        }
      : null,
    session: cloud?.session
      ? {
          id: cloud.session.id ?? null,
          deviceName: cloud.session.deviceName ?? null,
        }
      : null,
    requester: cloud?.visibilityContext ? summarizeRequester(cloud.visibilityContext) : null,
    hiddenFileCount: cloud?.visibilityContext?.hiddenFileCount ?? null,
    hiddenScopeCounts: cloud?.visibilityContext?.hiddenScopeCounts ?? null,
    visibility: cloud?.visibility
      ? {
          productDefault: cloud.visibility.productDefault ?? null,
          globalUserDefault: cloud.visibility.globalUserDefault ?? null,
          codebaseOverride: cloud.visibility.codebaseOverride ?? null,
          changeSetOverride: cloud.visibility.changeSetOverride ?? null,
          effective: cloud.visibility.effective ?? null,
        }
      : null,
    revision: cloud?.revision ?? null,
    fileCount: cloudFiles.length,
    scopeCounts,
  }

  const journalSummary = {
    path: path.resolve(options.journal),
    exists: existsSync(options.journal),
    totalEntries: journalEntries.length,
    pendingCount: pendingJournalEntries.length,
    failedCount: failedJournalEntries.length,
    acknowledgedCount: acknowledgedJournalEntries.length,
    scopeCounts: countEntryScopes(journalEntries),
    pendingScopeCounts: countEntryScopes(pendingJournalEntries),
    failedScopeCounts: countEntryScopes(failedJournalEntries),
    acknowledgedScopeCounts: countEntryScopes(acknowledgedJournalEntries),
    pendingEntries: pendingJournalEntries,
    failedEntries: failedJournalEntries,
    acknowledgedEntries: acknowledgedJournalEntries,
    entries: journalState.entries,
  }

  const eventsSummary = {
    path: path.resolve(options.events),
    exists: existsSync(options.events),
    totalEntries: eventEntries.length,
    recent: recentEvents,
    lastAcknowledgement,
    lastSync,
    lastStartedSync,
    lastFailedSync,
    lastRecoveredSync,
    latestSyncEvent,
    lastWorkspaceReady,
    lastRefreshStarted,
    lastRefreshBlocked,
    lastRefreshComplete,
    lastRemoteUpdate,
    lastRemotePullStarted,
    lastRemotePullApplied,
    lastRemotePullSkipped,
    lastRemotePullFailed,
    latestRemotePullEvent,
    lastReviewOpened: findLastEvent(eventEntries, 'change_set.review_opened'),
    lastChangeSetMerged: findLastEvent(eventEntries, 'change_set.merged'),
    lastConflictDetected: findLastEvent(eventEntries, 'change_set.conflict_detected'),
    latestRefreshEvent,
    lastRecovery,
    lastWatchStarted,
    lastWatchDegraded,
    lastWatchRecoveryBlocked,
    latestWatchEvent,
  }
  const hydration = buildWorkspaceHydration({
    cloudSummary,
    workspaceExists,
    lastWorkspaceReady,
    lastRefreshComplete,
    indexedCodebase,
  })
  const localChanges = await workspaceLocalChanges(options, indexedCodebase)
  const localCache = localCacheSnapshotForCloud(options, cloud, indexedCodebase)
  remotePullHealth.cursor = buildRemoteCursor({
    cloudSummary,
    eventsSummary,
    hydration,
  })
  const initialized = Boolean(cloud) && (hydration.state === 'materialized' || hydration.state === 'partial')
  const attached = Boolean(cloud) && hydration.state === 'metadata-only'
  const usable = initialized || attached

  return {
    status: {
      ok:
        usable &&
        localChanges.safe &&
        failedJournalEntries.length === 0 &&
        syncHealth.state !== 'failed' &&
        refreshHealth.state !== 'blocked' &&
        !watchHealth.state.endsWith('degraded') &&
        watchHealth.state !== 'blocked',
      generatedAt: new Date().toISOString(),
      readiness: initialized ? 'ready' : attached ? 'attached' : 'not_initialized',
      mode: workspaceMode,
      codebaseId: cloudSummary.codebase?.id ?? null,
      codebaseName: cloudSummary.codebase?.name ?? null,
      selectedStateType: cloudSummary.selectedState?.type ?? null,
      activeChangeSetId:
        cloudSummary.selectedState?.type === 'active-change-set' ? cloudSummary.selectedState.id : null,
      mainId: cloudSummary.main?.id ?? null,
      ownerId: cloudSummary.owner?.id ?? cloudSummary.codebase?.ownerId ?? null,
      sessionId: cloudSummary.session?.id ?? null,
      requesterId: cloudSummary.requester?.id ?? null,
      requesterSessionId: cloudSummary.requester?.sessionId ?? null,
      requesterRole: cloudSummary.requester?.role ?? null,
      visibleFileCount: cloudSummary.fileCount,
      hiddenFileCount: cloudSummary.hiddenFileCount,
      hiddenScopeCounts: cloudSummary.hiddenScopeCounts,
      effectiveChangeSetVisibility:
        cloudSummary.selectedState?.effectiveVisibility ?? cloudSummary.visibility?.effective ?? null,
      review: {
        state: cloudSummary.selectedState?.reviewState ?? 'not-open',
        detail: cloudSummary.selectedState?.review ?? null,
      },
      merge: {
        state: cloudSummary.selectedState?.mergeState ?? 'unmerged',
        detail: cloudSummary.selectedState?.merge ?? null,
        mainRevision: cloudSummary.main?.revision ?? null,
      },
      conflict: {
        state: cloudSummary.selectedState?.conflictState ?? 'none',
        detail: cloudSummary.selectedState?.conflict ?? null,
      },
      workspace: {
        root: path.resolve(workspaceRootFromOptions(options)),
        path: path.resolve(options.workspace),
        exists: workspaceExists,
        adapter: workspaceMode.adapter,
        cacheMode: workspaceMode.cacheMode,
        materializationPolicy: workspaceMode.materializationPolicy,
        hydrationPolicy: workspaceMode.hydrationPolicy,
        remoteUpdatePolicy: workspaceMode.remoteUpdatePolicy,
        hydration,
        localChanges,
        contentManifest: contentManifestSummary(indexedCodebase?.contentManifest),
        cache: localCache.summary,
        files: localCache.files,
        index: workspaceIndexSummary(options, workspaceIndex),
        virtualized: false,
      },
      cloud: cloudSummary,
      journal: {
        path: journalSummary.path,
        exists: journalSummary.exists,
        totalEntries: journalSummary.totalEntries,
        pendingCount: journalSummary.pendingCount,
        failedCount: journalSummary.failedCount,
        acknowledgedCount: journalSummary.acknowledgedCount,
        scopeCounts: journalSummary.scopeCounts,
        pendingScopeCounts: journalSummary.pendingScopeCounts,
        failedScopeCounts: journalSummary.failedScopeCounts,
        acknowledgedScopeCounts: journalSummary.acknowledgedScopeCounts,
      },
      sync: syncHealth,
      refresh: refreshHealth,
      remoteUpdate: {
        state: lastRemoteUpdate ? 'updated' : 'idle',
        lastUpdate: lastRemoteUpdate,
      },
      remotePull: remotePullHealth,
      watch: watchHealth,
      events: {
        path: eventsSummary.path,
        exists: eventsSummary.exists,
        totalEntries: eventsSummary.totalEntries,
        recent: eventsSummary.recent,
        lastAcknowledgement,
        lastSync,
        lastStartedSync,
        lastFailedSync,
        lastRecoveredSync,
        latestSyncEvent,
        lastWorkspaceReady,
        lastRefreshStarted,
        lastRefreshBlocked,
        lastRefreshComplete,
        lastRemoteUpdate,
        lastRemotePullStarted,
        lastRemotePullApplied,
        lastRemotePullSkipped,
        lastRemotePullFailed,
        latestRemotePullEvent,
        lastReviewOpened: eventsSummary.lastReviewOpened,
        lastChangeSetMerged: eventsSummary.lastChangeSetMerged,
        lastConflictDetected: eventsSummary.lastConflictDetected,
        latestRefreshEvent,
        lastRecovery,
        lastWatchStarted,
        lastWatchDegraded,
        lastWatchRecoveryBlocked,
        latestWatchEvent,
      },
    },
    cloud: {
      ...cloudSummary,
      graph: cloud,
    },
    journal: journalSummary,
    events: eventsSummary,
  }
}

async function prepareRecovery(cloud, entry, workspace) {
  if (!entry.id) throw new Error('journal entry is missing id')
  if (!entry.path) throw new Error('journal entry is missing path')

  const scope = entry.scope ?? scopeForPath(entry.path)
  const cloudFile = cloud.files?.[entry.path]
    ? normalizeCloudFileEntry(entry.path, cloud.files[entry.path])
    : null

  if (entry.type === 'delete') {
    if (!cloudFile) return { reason: 'cloud_already_deleted' }
    return { reason: 'cloud_delete_replayed' }
  }

  if (entry.type !== 'create' && entry.type !== 'write') {
    throw new Error(`unsupported journal entry type: ${entry.type}`)
  }

  if (cloudFile?.hash === entry.hash && cloudFile.scope === scope && (entry.kind ?? cloudFile.kind) === cloudFile.kind) {
    return { entry: cloudFile, reason: 'cloud_already_matches' }
  }

  if (!existsSync(workspace)) {
    throw new Error('workspace_missing')
  }

  const absolutePath = workspaceFilePath(workspace, entry.path)
  if (!existsSync(absolutePath)) {
    throw new Error('workspace_file_missing')
  }

  const diskEntry = normalizeCloudFileEntry(entry.path, await readSingleWorkspaceEntry(workspace, entry.path))
  if (diskEntry.hash !== entry.hash || diskEntry.kind !== (entry.kind ?? diskEntry.kind)) {
    throw new Error(`workspace_hash_mismatch: expected ${entry.hash}, got ${diskEntry.hash}`)
  }

  return { entry: diskEntry, reason: 'workspace_replayed' }
}

function applyJournalEntryToCloud(cloud, entry, options = {}) {
  const scope = entry.scope ?? scopeForPath(entry.path)
  const now = options.now ?? new Date().toISOString()

  if (!cloud.files) cloud.files = {}
  if (!Number.isInteger(cloud.revision)) cloud.revision = 0
  if (cloud.selectedState && !Number.isInteger(cloud.selectedState.revision)) {
    cloud.selectedState.revision = cloud.revision
  }

  assertEntrySelectedStateRevision(cloud, entry)
  assertEntryBaseRevision(cloud, entry)

  if (entry.type === 'delete') {
    const current = cloud.files[entry.path]
    if (current) {
      cloud.revision += 1
      if (cloud.selectedState) cloud.selectedState.revision = cloud.revision
      delete cloud.files[entry.path]
    }

    return {
      id: entry.id,
      type: entry.type,
      path: entry.path,
      kind: entry.kind ?? entryKind.file,
      scope,
      privacyZone: privacyZoneForPath(entry.path),
      revision: cloud.revision,
      selectedStateType: cloud.selectedState?.type ?? null,
      selectedStateId: cloud.selectedState?.id ?? null,
      selectedStateRevision: cloud.selectedState?.revision ?? null,
    }
  }

  const payload = options.entry
    ? normalizeCloudFileEntry(entry.path, options.entry)
    : normalizeCloudFileEntry(entry.path, {
        kind: entry.kind ?? entryKind.file,
        content: options.content ?? '',
        encoding: entry.encoding ?? entryEncoding.utf8,
        target: entry.target ?? null,
      })

  if (entry.hash && payload.hash !== entry.hash) {
    throw new Error(`content_hash_mismatch: expected ${entry.hash}, got ${payload.hash}`)
  }

  const current = cloud.files[entry.path]
  const currentEntry = current ? normalizeCloudFileEntry(entry.path, current) : null
  if (!currentEntry || !cloudEntryEquals(currentEntry, payload)) {
    cloud.revision += 1
    cloud.files[entry.path] = {
      kind: payload.kind,
      content: payload.content ?? '',
      encoding: payload.encoding ?? entryEncoding.utf8,
      target: payload.target ?? null,
      hash: payload.hash,
      size: payload.size,
      scope,
      privacyZone: privacyZoneForPath(entry.path),
      revision: cloud.revision,
      updatedAt: now,
    }
    if (payload.kind === entryKind.file && payload.contentStorage) {
      cloud.files[entry.path].contentStorage = payload.contentStorage
    }
    if (payload.kind === entryKind.file && payload.blobProvider) {
      cloud.files[entry.path].blobProvider = payload.blobProvider
    }
    if (payload.kind === entryKind.file && payload.blobKey) {
      cloud.files[entry.path].blobKey = payload.blobKey
    }
    if (payload.kind === entryKind.file && payload.blobHash) {
      cloud.files[entry.path].blobHash = payload.blobHash
    }
    if (payload.kind === entryKind.file && Number.isInteger(payload.blobSize)) {
      cloud.files[entry.path].blobSize = payload.blobSize
    }
    if (payload.kind === entryKind.file && payload.clientEncryption) {
      cloud.files[entry.path].clientEncryption = payload.clientEncryption
    }
    if (cloud.selectedState) cloud.selectedState.revision = cloud.revision
  }

  return {
    id: entry.id,
    type: entry.type,
    path: entry.path,
    kind: payload.kind,
    scope,
    privacyZone: privacyZoneForPath(entry.path),
    revision: cloud.revision,
    selectedStateType: cloud.selectedState?.type ?? null,
    selectedStateId: cloud.selectedState?.id ?? null,
    selectedStateRevision: cloud.selectedState?.revision ?? null,
  }
}

function assertEntrySelectedStateRevision(cloud, entry) {
  if (!Object.hasOwn(entry, 'targetStateRevision') || entry.targetStateRevision === undefined) return

  const actualRevision = cloud.selectedState?.revision ?? null
  if (entry.targetStateRevision === actualRevision) return

  throw new ConflictError(
    `selected_state_revision_mismatch: expected ${entry.targetStateRevision}, got ${actualRevision}`,
    {
      reason: 'selected_state_revision_mismatch',
      id: entry.id,
      type: entry.type,
      path: entry.path,
      scope: entry.scope ?? scopeForPath(entry.path ?? ''),
      expectedRevision: entry.targetStateRevision,
      actualRevision,
      selectedStateId: cloud.selectedState?.id ?? null,
      selectedStateRevision: actualRevision,
    },
  )
}

function assertEntryBaseRevision(cloud, entry) {
  if (!Object.hasOwn(entry, 'baseRevision') || entry.baseRevision === undefined) return

  const current = cloud.files?.[entry.path]
  const actualRevision = current?.revision ?? null
  if (entry.baseRevision === actualRevision) return

  throw new ConflictError(
    `base_revision_mismatch: expected ${entry.baseRevision}, got ${actualRevision}`,
    {
      reason: 'base_revision_mismatch',
      id: entry.id,
      type: entry.type,
      path: entry.path,
      scope: entry.scope ?? scopeForPath(entry.path ?? ''),
      expectedRevision: entry.baseRevision,
      actualRevision,
      selectedStateId: cloud.selectedState?.id ?? null,
      selectedStateRevision: cloud.selectedState?.revision ?? null,
    },
  )
}

function classifyJournalEntries(journalEntries, eventEntries) {
  const outcomesById = new Map()

  for (const event of eventEntries) {
    const id = event.detail?.id
    if (!id) continue

    if (event.event === 'cloud.acknowledged') {
      outcomesById.set(id, {
        recoveryStatus: 'acknowledged',
        event,
      })
      continue
    }

    if (event.event === 'journal.recovery_failed') {
      const current = outcomesById.get(id)
      if (current?.recoveryStatus !== 'acknowledged') {
        outcomesById.set(id, {
          recoveryStatus: 'failed',
          event,
        })
      }
    }
  }

  const entries = journalEntries.map((entry) => {
    const outcome = outcomesById.get(entry.id)
    return {
      ...entry,
      recoveryStatus: outcome?.recoveryStatus ?? 'pending',
      recoveryEvent: outcome?.event ?? null,
    }
  })

  return { entries }
}

async function readJournalSafety(options) {
  const journalEntries = await readNdjson(options.journal)
  const eventEntries = await readNdjson(options.events)
  const journalState = classifyJournalEntries(journalEntries, eventEntries)
  const pendingEntries = journalState.entries.filter((entry) => entry.recoveryStatus === 'pending')
  const failedEntries = journalState.entries.filter((entry) => entry.recoveryStatus === 'failed')

  return {
    safe: pendingEntries.length === 0 && failedEntries.length === 0,
    pendingEntries,
    failedEntries,
    summary: {
      totalEntries: journalEntries.length,
      pendingCount: pendingEntries.length,
      failedCount: failedEntries.length,
      pendingScopeCounts: countEntryScopes(pendingEntries),
      failedScopeCounts: countEntryScopes(failedEntries),
    },
  }
}

async function hasUnresolvedSyncFailure(options) {
  const events = await readNdjson(options.events)
  const lastSyncOutcome = findLastEventOf(events, ['sync.complete', 'sync.failed', 'sync.recovered'])
  if (lastSyncOutcome?.event !== 'sync.failed') return null

  return {
    at: lastSyncOutcome.at,
    reason: lastSyncOutcome.detail?.reason ?? null,
  }
}

function syncContextDetail(context) {
  const detail = {
    trigger: context.trigger ?? 'manual',
  }

  if (Number.isInteger(context.coalescedEvents)) detail.coalescedEvents = context.coalescedEvents
  if (context.eventType) detail.eventType = context.eventType
  if (context.path) detail.path = context.path

  return detail
}

function normalizeWatchFilename(filename) {
  if (typeof filename === 'string') return toCloudPath(filename)
  if (Buffer.isBuffer(filename)) return toCloudPath(filename.toString('utf8'))
  return null
}

function buildSyncHealth(syncEvents) {
  const { lastStartedSync, lastSuccessfulSync, lastFailedSync, lastRecoveredSync, latestSyncEvent } = syncEvents
  let state = 'idle'

  if (latestSyncEvent?.event === 'sync.failed') {
    state = 'failed'
  } else if (latestSyncEvent?.event === 'sync.started') {
    state = 'syncing'
  } else if (latestSyncEvent?.event === 'sync.complete' || latestSyncEvent?.event === 'sync.recovered') {
    state = 'healthy'
  }

  return {
    state,
    lastStartedSync,
    lastSuccessfulSync,
    lastFailedSync,
    lastRecoveredSync,
    lastError: lastFailedSync?.detail?.reason ?? null,
  }
}

function buildRefreshHealth(refreshEvents) {
  const { lastRefreshStarted, lastRefreshBlocked, lastRefreshComplete, latestRefreshEvent } = refreshEvents
  let state = 'idle'

  if (latestRefreshEvent?.event === 'refresh.blocked') {
    state = 'blocked'
  } else if (latestRefreshEvent?.event === 'refresh.started') {
    state = 'refreshing'
  } else if (latestRefreshEvent?.event === 'refresh.complete') {
    state = 'healthy'
  }

  return {
    state,
    lastStarted: lastRefreshStarted,
    lastBlocked: lastRefreshBlocked,
    lastComplete: lastRefreshComplete,
    lastError: state === 'blocked' ? (lastRefreshBlocked?.detail?.reason ?? null) : null,
  }
}

function buildWatchHealth(watchEvents) {
  const { lastWatchStarted, lastWatchDegraded, lastWatchRecoveryBlocked, latestWatchEvent } = watchEvents
  const latestProblem = latestEvent([lastWatchDegraded, lastWatchRecoveryBlocked])
  let state = 'unknown'

  if (latestWatchEvent?.event === 'watch.recovery_blocked') {
    state = 'blocked'
  } else if (latestWatchEvent?.event === 'watch.degraded') {
    if (lastWatchDegraded.detail?.state === 'unavailable') {
      state = 'unavailable-degraded'
    } else if (lastWatchDegraded.detail?.state === 'polling') {
      state = 'polling-degraded'
    } else {
      state = 'degraded'
    }
  } else if (latestWatchEvent?.event === 'watch.started') {
    state = 'watching'
  }

  return {
    state,
    lastStarted: lastWatchStarted,
    lastDegraded: lastWatchDegraded,
    lastRecoveryBlocked: lastWatchRecoveryBlocked,
    lastError: latestProblem?.detail?.reason ?? null,
  }
}

function buildRemotePullHealth(options, remotePullEvents) {
  const enabled = remotePullEnabled(options)
  const currentWatchStartedAt = remotePullEvents.lastWatchStarted?.at ?? null
  const lastRemotePullStarted = eventAtOrAfter(remotePullEvents.lastRemotePullStarted, currentWatchStartedAt)
  const lastRemotePullApplied = eventAtOrAfter(remotePullEvents.lastRemotePullApplied, currentWatchStartedAt)
  const lastRemotePullSkipped = eventAtOrAfter(remotePullEvents.lastRemotePullSkipped, currentWatchStartedAt)
  const lastRemotePullFailed = eventAtOrAfter(remotePullEvents.lastRemotePullFailed, currentWatchStartedAt)
  const latestRemotePullEvent = eventAtOrAfter(remotePullEvents.latestRemotePullEvent, currentWatchStartedAt)
  const latestProblem = latestEvent([
    lastRemotePullSkipped,
    lastRemotePullFailed,
  ])
  const latestProblemIsCurrent = latestProblem && latestProblem === latestRemotePullEvent
  let state = enabled ? 'enabled' : 'disabled'

  if (enabled && latestRemotePullEvent?.event === 'remote-pull.failed') {
    state = 'failed'
  } else if (enabled && latestRemotePullEvent?.event === 'remote-pull.skipped') {
    state = 'skipped'
  }

  return {
    enabled,
    state,
    intervalMs: enabled ? remoteRefreshIntervalMs(options) : null,
    safeRefreshOnly: enabled,
    lastStarted: lastRemotePullStarted,
    lastApplied: lastRemotePullApplied,
    lastSkipped: lastRemotePullSkipped,
    lastFailed: lastRemotePullFailed,
    latestEvent: latestRemotePullEvent,
    lastError: latestProblemIsCurrent ? (latestProblem.detail?.reason ?? null) : null,
  }
}

function eventAtOrAfter(event, reference) {
  if (!event || !reference) return event ?? null
  return isTimestampAtOrAfter(event.at, reference) ? event : null
}

function latestEvent(events) {
  return events.filter(Boolean).reduce((latest, event) => {
    if (!latest || isEventAfter(event, latest)) return event
    return latest
  }, null)
}

function isEventAfter(event, reference) {
  if (!event) return false
  if (!reference) return true

  const eventAt = Date.parse(event.at)
  const referenceAt = Date.parse(reference.at)
  if (Number.isNaN(eventAt) || Number.isNaN(referenceAt)) return false

  return eventAt >= referenceAt
}

function visibleRevisionFromEvent(event) {
  if (!event) return null
  if (Number.isInteger(event.detail?.toRevision)) return event.detail.toRevision
  if (Number.isInteger(event.detail?.revision)) return event.detail.revision
  return null
}

function workspaceRootFromOptions(options) {
  return options['workspace-root'] ?? path.dirname(path.resolve(options.workspace))
}

function cloudLocationFromOptions(options, codebaseId = options['codebase-id'] ?? null) {
  if (shouldUseD1Backend(options)) {
    return codebaseId ? `d1:${codebaseId}` : 'd1:unconfigured'
  }
  return path.resolve(options.cloud)
}

function cloudServiceTypeFromOptions(options) {
  if (shouldUseD1Backend(options)) return d1CloudServiceType
  return cloudServiceType
}

function remotePullEnabled(options) {
  return Boolean(options['remote-pull'] || options['auto-refresh'])
}

function remoteRefreshIntervalMs(options) {
  const usesCooldownOption = options['remote-pull-cooldown-ms'] !== undefined
  const rawValue = usesCooldownOption ? options['remote-pull-cooldown-ms'] : (options['remote-refresh-interval-ms'] ?? '300000')
  const value = Number(rawValue)
  if (!Number.isInteger(value) || value < 100) {
    const optionName = usesCooldownOption ? '--remote-pull-cooldown-ms' : '--remote-refresh-interval-ms'
    throw new Error(`Invalid ${optionName} value: ${rawValue}`)
  }
  return value
}

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(value ?? '')
}

async function assertWorkspacePathSafe(options, context = {}) {
  if (options['allow-unsafe-workspace']) return

  const workspace = path.resolve(options.workspace)
  const unsafeRoots = new Set([path.parse(workspace).root, os.homedir(), process.cwd()])
  if (unsafeRoots.has(workspace)) {
    throw new Error(`Refusing to use unsafe workspace path: ${workspace}`)
  }

  if (context.source) {
    const source = path.resolve(context.source)
    if (pathsOverlap(workspace, source)) {
      throw new Error(`Refusing workspace/source overlap: ${workspace} and ${source}`)
    }
  }

  if (options.profile === 'production') {
    const workspaceRoot = path.resolve(options['workspace-root'] ?? defaultWorkspaceRoot())
    if (!isPathInside(workspace, workspaceRoot) && workspace !== workspaceRoot) {
      throw new Error(
        `Production profile workspace must live under ${workspaceRoot}. Use --workspace-root or --allow-unsafe-workspace to override.`,
      )
    }
  }
}

function workspaceFilePath(workspace, relativePath) {
  const cloudPath = assertSafeCloudPath(relativePath)
  const root = path.resolve(workspace)
  const absolutePath = path.resolve(root, cloudPath)

  if (!isPathInside(absolutePath, root) && absolutePath !== root) {
    throw new Error(`Refusing workspace path escape: ${relativePath}`)
  }

  return absolutePath
}

function assertSafeCloudPath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('Cloud path must be a non-empty string.')
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Cloud path must be relative: ${relativePath}`)
  }

  const normalized = path.posix.normalize(relativePath)
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..') {
    throw new Error(`Cloud path must stay inside the workspace: ${relativePath}`)
  }

  return normalized
}

function pathsOverlap(first, second) {
  return isPathInside(first, second) || isPathInside(second, first) || path.resolve(first) === path.resolve(second)
}

function isPathInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function readWorkspaceFiles(root, options = {}) {
  const result = {}
  if (!existsSync(root)) return result

  async function walk(dir) {
    const entries = await sortedDirEntries(dir)
    let includedChildren = 0

    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name)
      const relativePath = toCloudPath(path.relative(root, absolutePath))
      if (shouldSkipWorkspacePath(relativePath, entry, options)) continue

      if (entry.isSymbolicLink()) {
        result[relativePath] = await readWorkspaceSymlinkEntry(root, relativePath, absolutePath)
        includedChildren += 1
        continue
      }

      if (entry.isDirectory()) {
        const childCount = await walk(absolutePath)
        if (childCount === 0) {
          result[relativePath] = workspaceDirectoryEntry(relativePath)
          includedChildren += 1
        } else {
          includedChildren += childCount
        }
        continue
      }
      if (!entry.isFile()) continue

      result[relativePath] = await readWorkspaceFileEntry(root, relativePath, absolutePath)
      includedChildren += 1
    }

    return includedChildren
  }

  await walk(root)
  return result
}

async function sortedDirEntries(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

function shouldSkipWorkspacePath(relativePath, entry, options = {}) {
  const parts = relativePath.split('/')
  const basename = parts.at(-1) ?? relativePath
  if (parts.includes('.hopit')) return true
  if (basename === '.DS_Store') return true
  if (isLocalOnlySecretPath(relativePath) && !shouldSyncLocalOnlySecretPath(relativePath, options)) return true
  return false
}

function shouldTrackLocalActivityPath(relativePath, entry) {
  return entry.isFile() && isLocalActivityMarkerPath(relativePath)
}

function isLocalActivityMarkerPath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return false
  const basename = relativePath.split('/').at(-1) ?? relativePath
  return basename === '.DS_Store'
}

function shouldSkipLiteralMirrorPath(relativePath, _entry) {
  const parts = relativePath.split('/')
  if (parts.includes('.hopit')) return true
  return false
}

function shouldSyncLocalOnlySecretPath(relativePath, options = {}) {
  return hasObjectBlobProvider(options) && shouldEncryptClientSide(relativePath, options)
}

function secretSyncStatus(options = {}) {
  const hasKey = Boolean(rawClientEncryptionKey(options))
  const hasBlobStore = hasObjectBlobProvider(options)
  const scope = clientEncryptionScopeFromOptions(options)
  const enabled = hasKey && hasBlobStore && scope !== clientEncryptionScopes.off
  let reason = null
  if (!hasKey) reason = 'client_encryption_key_missing'
  else if (!hasBlobStore) reason = 'object_blob_provider_missing'
  else if (scope === clientEncryptionScopes.off) reason = 'client_encryption_disabled'

  return {
    enabled,
    reason,
    scope,
  }
}

function hasObjectBlobProvider(options = {}) {
  return Boolean(normalizeBlobProvider(options['blob-provider'] ?? process.env.HOPIT_BLOB_PROVIDER))
}

function shouldEncryptClientSide(relativePath, options = {}) {
  if (!rawClientEncryptionKey(options)) return false
  const scope = clientEncryptionScopeFromOptions(options)
  if (scope === clientEncryptionScopes.off) return false
  if (scope === clientEncryptionScopes.all) return true
  if (scope === clientEncryptionScopes.ownerPrivate) return hasPrivatePrivacyZone(relativePath)
  return isLocalOnlySecretPath(relativePath)
}

async function readWorkspaceFileEntry(_root, relativePath, absolutePath) {
  const buffer = await fs.readFile(absolutePath)
  const encoded = encodeBufferForCloud(buffer)
  return {
    kind: entryKind.file,
    content: encoded.content,
    encoding: encoded.encoding,
    hash: hashBuffer(buffer),
    size: buffer.byteLength,
    scope: scopeForPath(relativePath),
    privacyZone: privacyZoneForPath(relativePath),
    revision: null,
  }
}

async function readWorkspaceSymlinkEntry(_root, relativePath, absolutePath) {
  const target = await fs.readlink(absolutePath)
  return {
    kind: entryKind.symlink,
    content: target,
    encoding: entryEncoding.utf8,
    target,
    hash: hashSymlinkTarget(target),
    size: Buffer.byteLength(target),
    scope: scopeForPath(relativePath),
    privacyZone: privacyZoneForPath(relativePath),
    revision: null,
  }
}

async function readSingleWorkspaceEntry(root, relativePath) {
  const absolutePath = workspaceFilePath(root, relativePath)
  const stat = await fs.lstat(absolutePath)
  if (stat.isSymbolicLink()) return readWorkspaceSymlinkEntry(root, relativePath, absolutePath)
  if (stat.isDirectory()) return workspaceDirectoryEntry(relativePath)
  if (stat.isFile()) return readWorkspaceFileEntry(root, relativePath, absolutePath)
  throw new Error(`Unsupported workspace entry type: ${relativePath}`)
}

function workspaceDirectoryEntry(relativePath) {
  return {
    kind: entryKind.directory,
    content: '',
    encoding: entryEncoding.utf8,
    hash: hashDirectoryEntry(relativePath),
    size: 0,
    scope: scopeForPath(relativePath),
    privacyZone: privacyZoneForPath(relativePath),
    revision: null,
  }
}

async function readImportableProjectFiles(root) {
  const files = {}
  let skipped = 0

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name)
      const relativePath = toCloudPath(path.relative(root, absolutePath))

      if (shouldSkipImportPath(relativePath, entry)) {
        skipped += 1
        continue
      }

      if (entry.isDirectory()) {
        await walk(absolutePath)
        continue
      }

      if (!entry.isFile()) {
        skipped += 1
        continue
      }

      const content = await readImportableTextFile(absolutePath)
      if (content === null) {
        skipped += 1
        continue
      }

      files[relativePath] = {
        content,
        scope: scopeForPath(relativePath),
        privacyZone: privacyZoneForPath(relativePath),
        revision: 1,
        updatedAt: new Date().toISOString(),
      }
    }
  }

  await walk(root)
  return { files, skipped }
}

async function readImportableTextFile(filePath) {
  const maxBytes = 512 * 1024
  const stat = await fs.stat(filePath)
  if (stat.size > maxBytes) return null

  const buffer = await fs.readFile(filePath)
  if (buffer.includes(0)) return null

  return buffer.toString('utf8')
}

function shouldSkipImportPath(relativePath, entry) {
  const parts = relativePath.split('/')
  const basename = parts.at(-1) ?? relativePath
  const ignoredDirectories = new Set([
    '.git',
    '.hopit-agent',
    '.next',
    '.turbo',
    '.vercel',
    'node_modules',
    'dist',
    'build',
    'out',
    'coverage',
    'artifacts',
    'mounts',
    'DerivedData',
  ])

  if (entry.isDirectory() && ignoredDirectories.has(basename)) return true
  if (parts.some((part) => ignoredDirectories.has(part))) return true
  if (basename === '.DS_Store') return true
  if (basename === 'dev.log' || basename === 'server.log') return true
  if (basename.endsWith('.local')) return true
  if (basename === '.env' || basename.startsWith('.env.')) return true
  if (basename.endsWith('.png') || basename.endsWith('.jpg') || basename.endsWith('.jpeg')) return true
  if (basename.endsWith('.gif') || basename.endsWith('.webp') || basename.endsWith('.ico')) return true
  if (basename.endsWith('.pdf') || basename.endsWith('.zip') || basename.endsWith('.gz')) return true
  if (basename.endsWith('.mp3') || basename.endsWith('.mp4') || basename.endsWith('.mov')) return true
  if (basename.endsWith('.tsbuildinfo')) return true

  return false
}

function createObjectBlobStore(options) {
  const provider = normalizeBlobProvider(options['blob-provider'] ?? process.env.HOPIT_BLOB_PROVIDER)
  if (!provider) return null

  const prefix = normalizeBlobPrefix(options['blob-prefix'] ?? process.env.HOPIT_BLOB_PREFIX)
  const budget = blobBudgetOptions(options, provider)
  const encryptionConfig = clientEncryptionConfigFromOptions(options)

  if (provider === objectBlobProvider.filesystem) {
    const root = options['blob-root'] ?? process.env.HOPIT_BLOB_ROOT ?? path.join(path.dirname(options.cloud ?? defaultOptions.cloud), 'blobs')
    return new FilesystemBlobStore({ root, prefix, budget, encryptionConfig })
  }

  if (provider === objectBlobProvider.r2) {
    const accountId = requiredBlobConfig(options, 'r2-account-id', 'HOPIT_R2_ACCOUNT_ID')
    const bucket = requiredBlobConfig(options, 'r2-bucket', 'HOPIT_R2_BUCKET')
    const accessKeyId = requiredBlobConfig(options, 'r2-access-key-id', 'HOPIT_R2_ACCESS_KEY_ID')
    const secretAccessKey = requiredBlobConfig(options, 'r2-secret-access-key', 'HOPIT_R2_SECRET_ACCESS_KEY')
    const endpoint = options['r2-endpoint'] ?? process.env.HOPIT_R2_ENDPOINT ?? `https://${accountId}.r2.cloudflarestorage.com`
    return new S3CompatibleBlobStore({
      provider,
      endpoint,
      bucket,
      region: options['r2-region'] ?? process.env.HOPIT_R2_REGION ?? 'auto',
      accessKeyId,
      secretAccessKey,
      prefix,
      forcePathStyle: true,
      budget,
      encryptionConfig,
    })
  }

  if (provider === objectBlobProvider.b2) {
    const bucket = requiredBlobConfig(options, 'b2-bucket', 'HOPIT_B2_BUCKET')
    const endpoint = requiredBlobConfig(options, 'b2-endpoint', 'HOPIT_B2_ENDPOINT')
    const accessKeyId = requiredBlobConfig(options, 'b2-key-id', 'HOPIT_B2_KEY_ID')
    const secretAccessKey = requiredBlobConfig(options, 'b2-application-key', 'HOPIT_B2_APPLICATION_KEY')
    return new S3CompatibleBlobStore({
      provider,
      endpoint,
      bucket,
      region: options['b2-region'] ?? process.env.HOPIT_B2_REGION ?? process.env.HOPIT_S3_REGION ?? 'us-west-004',
      accessKeyId,
      secretAccessKey,
      prefix,
      forcePathStyle: true,
      budget,
      encryptionConfig,
    })
  }

  const endpoint = requiredBlobConfig(options, 's3-endpoint', 'HOPIT_S3_ENDPOINT')
  const bucket = requiredBlobConfig(options, 's3-bucket', 'HOPIT_S3_BUCKET')
  const accessKeyId = requiredBlobConfig(options, 's3-access-key-id', 'HOPIT_S3_ACCESS_KEY_ID')
  const secretAccessKey = requiredBlobConfig(options, 's3-secret-access-key', 'HOPIT_S3_SECRET_ACCESS_KEY')
  return new S3CompatibleBlobStore({
    provider: objectBlobProvider.s3,
    endpoint,
    bucket,
    region: options['s3-region'] ?? process.env.HOPIT_S3_REGION ?? 'us-east-1',
    accessKeyId,
    secretAccessKey,
    prefix,
    forcePathStyle: truthyEnv(options['s3-force-path-style'] ?? process.env.HOPIT_S3_FORCE_PATH_STYLE ?? '1'),
    budget,
    encryptionConfig,
  })
}

function blobBudgetOptions(options, provider) {
  const freeOnly = blobFreeOnly(options, provider)
  const defaultBudget = provider === objectBlobProvider.r2 && freeOnly ? r2DefaultFreeOnlyBudgetBytes : null
  const budgetBytes = integerOption(
    options['blob-storage-budget-bytes'] ?? process.env.HOPIT_BLOB_STORAGE_BUDGET_BYTES,
    defaultBudget,
    'HOPIT_BLOB_STORAGE_BUDGET_BYTES',
  )
  return {
    freeOnly,
    budgetBytes,
  }
}

function blobFreeOnly(options, provider) {
  const configured = options['blob-free-only'] ?? process.env.HOPIT_BLOB_FREE_ONLY
  if (configured === undefined) return provider === objectBlobProvider.r2
  return truthyEnv(configured)
}

function integerOption(value, defaultValue, name) {
  if (value === undefined || value === null || value === '') return defaultValue
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`)
  }
  return parsed
}

function normalizeBlobProvider(value) {
  if (!value || value === 'inline') return null
  if (value === 'local' || value === 'fs' || value === objectBlobProvider.filesystem) return objectBlobProvider.filesystem
  if (value === objectBlobProvider.r2) return objectBlobProvider.r2
  if (value === objectBlobProvider.b2 || value === 'backblaze') return objectBlobProvider.b2
  if (value === objectBlobProvider.s3) return objectBlobProvider.s3
  throw new Error(`Unsupported HOPIT_BLOB_PROVIDER: ${value}`)
}

function requiredBlobConfig(options, optionName, envName) {
  const value = options[optionName] ?? process.env[envName]
  if (!value) {
    throw new Error(`Object blob provider requires --${optionName} or ${envName}.`)
  }
  return value
}

function normalizeBlobPrefix(value) {
  return String(value ?? '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('/')
}

function truthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? ''))
}

function blobKeyForHash(prefix, codebaseId, hash) {
  const safeCodebaseId = encodeURIComponent(String(codebaseId ?? 'hopit'))
  return [prefix, 'codebases', safeCodebaseId, 'blobs', 'sha256', hash.slice(0, 2), hash]
    .filter(Boolean)
    .join('/')
}

function managedBlobPrefix(prefix, codebaseId) {
  const safeCodebaseId = encodeURIComponent(String(codebaseId ?? 'hopit'))
  return [prefix, 'codebases', safeCodebaseId, 'blobs', 'sha256']
    .filter(Boolean)
    .join('/')
}

function isManagedBlobKey(key, prefix, codebaseId) {
  const root = managedBlobPrefix(prefix, codebaseId)
  const pattern = new RegExp(`^${escapeRegex(root)}/[0-9a-f]{2}/[0-9a-f]{64}$`)
  return pattern.test(key)
}

function assertManagedBlobKey(key, prefix, codebaseId) {
  if (!isManagedBlobKey(key, prefix, codebaseId)) {
    throw new Error(`Refusing to delete unmanaged blob key: ${key}`)
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function reachableBlobKeysForCloud(cloud) {
  const keys = new Set()
  for (const file of Object.values(cloud.files ?? {})) {
    if (file?.kind !== entryKind.file && file?.kind !== undefined) continue
    if (file?.contentStorage !== contentStorageMode.objectBlob) continue
    if (typeof file.blobKey === 'string' && file.blobKey) keys.add(file.blobKey)
  }
  return keys
}

function storageRetentionMsFromOptions(options) {
  const days = options['retention-days'] ?? process.env.HOPIT_BLOB_GC_RETENTION_DAYS
  if (days !== undefined) {
    const parsed = Number(days)
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error('HOPIT_BLOB_GC_RETENTION_DAYS must be non-negative.')
    return parsed * 24 * 60 * 60 * 1000
  }
  const ms = options['retention-ms'] ?? process.env.HOPIT_BLOB_GC_RETENTION_MS
  if (ms !== undefined) {
    const parsed = Number(ms)
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error('HOPIT_BLOB_GC_RETENTION_MS must be non-negative.')
    return parsed
  }
  return 0
}

class FilesystemBlobStore {
  constructor(options) {
    this.provider = objectBlobProvider.filesystem
    this.root = path.resolve(options.root)
    this.prefix = options.prefix ?? ''
    this.location = this.root
    this.budget = options.budget ?? { freeOnly: false, budgetBytes: null }
    this.usageCache = null
    this.encryptionConfig = options.encryptionConfig ?? null
  }

  shouldEncrypt(relativePath) {
    return shouldEncryptWithConfig(relativePath, this.encryptionConfig)
  }

  async putBlob({ codebaseId, relativePath, hash, buffer, encrypt = false }) {
    const prepared = prepareBlobPayload({
      codebaseId,
      relativePath,
      plaintextHash: hash,
      buffer,
      encrypt,
      encryptionConfig: this.encryptionConfig,
    })
    const key = blobKeyForHash(this.prefix, codebaseId, prepared.blobHash)
    const absolutePath = path.join(this.root, key)
    if (existsSync(absolutePath)) {
      const existing = await fs.readFile(absolutePath)
      if (hashBuffer(existing) !== prepared.blobHash) {
        throw new Error(`object_blob_hash_collision: existing filesystem blob differs for ${prepared.blobHash}.`)
      }
    } else {
      await this.assertWithinBudget(prepared.buffer.byteLength)
      await fs.mkdir(path.dirname(absolutePath), { recursive: true })
      await fs.writeFile(absolutePath, prepared.buffer)
      if (this.usageCache) this.usageCache.bytes += prepared.buffer.byteLength
    }
    return {
      provider: this.provider,
      key,
      hash,
      size: buffer.byteLength,
      blobHash: prepared.blobHash,
      blobSize: prepared.buffer.byteLength,
      clientEncryption: prepared.clientEncryption,
      contentStorage: contentStorageMode.objectBlob,
    }
  }

  async getBlob(file, context = {}) {
    if (!file.blobKey) throw new Error('Object-backed file is missing blobKey.')
    const buffer = await fs.readFile(path.join(this.root, file.blobKey))
    return unwrapBlobPayload(buffer, file, context, this.encryptionConfig)
  }

  async listBlobs({ codebaseId }) {
    const root = path.join(this.root, managedBlobPrefix(this.prefix, codebaseId))
    const result = []
    const storeRoot = this.root

    async function walk(dir) {
      if (!existsSync(dir)) return
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const absolutePath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(absolutePath)
          continue
        }
        if (!entry.isFile()) continue
        const stat = await fs.stat(absolutePath)
        result.push({
          key: toCloudPath(path.relative(storeRoot, absolutePath)),
          size: stat.size,
          lastModified: stat.mtime.toISOString(),
        })
      }
    }

    await walk(root)
    return result
  }

  async deleteBlob(key, { codebaseId }) {
    assertManagedBlobKey(key, this.prefix, codebaseId)
    await fs.rm(path.join(this.root, key), { force: true })
    this.usageCache = null
  }

  async assertWithinBudget(additionalBytes) {
    if (!Number.isSafeInteger(this.budget.budgetBytes)) return
    const usage = await this.readUsage()
    if (usage.bytes + additionalBytes > this.budget.budgetBytes) {
      throw new Error(
        `object_blob_budget_exceeded: ${usage.bytes} existing bytes + ${additionalBytes} new bytes would exceed budget ${this.budget.budgetBytes}.`,
      )
    }
  }

  async readUsage() {
    if (this.usageCache) return this.usageCache
    const root = path.join(this.root, this.prefix)
    let bytes = 0
    let objects = 0

    async function walk(dir) {
      if (!existsSync(dir)) return
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const absolutePath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(absolutePath)
          continue
        }
        if (!entry.isFile()) continue
        const stat = await fs.stat(absolutePath)
        bytes += stat.size
        objects += 1
      }
    }

    await walk(root)
    this.usageCache = { bytes, objects }
    return this.usageCache
  }
}

class S3CompatibleBlobStore {
  constructor(options) {
    this.provider = options.provider
    this.endpoint = new URL(options.endpoint)
    this.bucket = options.bucket
    this.region = options.region
    this.accessKeyId = options.accessKeyId
    this.secretAccessKey = options.secretAccessKey
    this.prefix = options.prefix ?? ''
    this.forcePathStyle = options.forcePathStyle !== false
    this.location = `${this.provider}:${this.bucket}`
    this.budget = options.budget ?? { freeOnly: false, budgetBytes: null }
    this.usageCache = null
    this.encryptionConfig = options.encryptionConfig ?? null
  }

  shouldEncrypt(relativePath) {
    return shouldEncryptWithConfig(relativePath, this.encryptionConfig)
  }

  async putBlob({ codebaseId, relativePath, hash, buffer, encrypt = false }) {
    const prepared = prepareBlobPayload({
      codebaseId,
      relativePath,
      plaintextHash: hash,
      buffer,
      encrypt,
      encryptionConfig: this.encryptionConfig,
    })
    const key = blobKeyForHash(this.prefix, codebaseId, prepared.blobHash)
    if (await this.exists(key)) {
      return {
        provider: this.provider,
        key,
        hash,
        size: buffer.byteLength,
        blobHash: prepared.blobHash,
        blobSize: prepared.buffer.byteLength,
        clientEncryption: prepared.clientEncryption,
        contentStorage: contentStorageMode.objectBlob,
      }
    }

    await this.assertWithinBudget(prepared.buffer.byteLength)
    await this.request('PUT', key, {
      body: prepared.buffer,
      headers: {
        'content-type': 'application/octet-stream',
      },
    })
    if (this.usageCache) this.usageCache.bytes += prepared.buffer.byteLength
    return {
      provider: this.provider,
      key,
      hash,
      size: buffer.byteLength,
      blobHash: prepared.blobHash,
      blobSize: prepared.buffer.byteLength,
      clientEncryption: prepared.clientEncryption,
      contentStorage: contentStorageMode.objectBlob,
    }
  }

  async getBlob(file, context = {}) {
    if (!file.blobKey) throw new Error('Object-backed file is missing blobKey.')
    const response = await this.request('GET', file.blobKey)
    const buffer = Buffer.from(await response.arrayBuffer())
    return unwrapBlobPayload(buffer, file, context, this.encryptionConfig)
  }

  async listBlobs({ codebaseId }) {
    const prefix = `${managedBlobPrefix(this.prefix, codebaseId)}/`
    let continuationToken = null
    const result = []

    do {
      const query = {
        'list-type': '2',
        prefix,
      }
      if (continuationToken) query['continuation-token'] = continuationToken
      const response = await this.request('GET', '', { query })
      const xml = await response.text()
      result.push(...parseS3ListObjects(xml))
      continuationToken = parseS3NextContinuationToken(xml)
    } while (continuationToken)

    return result
  }

  async deleteBlob(key, { codebaseId }) {
    assertManagedBlobKey(key, this.prefix, codebaseId)
    await this.request('DELETE', key)
    this.usageCache = null
  }

  async exists(key) {
    const response = await this.request('HEAD', key, { allowNotFound: true })
    return response.status !== 404
  }

  async assertWithinBudget(additionalBytes) {
    if (!Number.isSafeInteger(this.budget.budgetBytes)) return
    const usage = await this.readUsage()
    if (usage.bytes + additionalBytes > this.budget.budgetBytes) {
      const tierDetail = this.provider === objectBlobProvider.r2 && this.budget.freeOnly
        ? ` R2 free-only mode is capped at ${this.budget.budgetBytes} bytes below the ${r2FreeStorageTierBytes} byte free tier.`
        : ''
      throw new Error(
        `object_blob_budget_exceeded: ${usage.bytes} existing bytes + ${additionalBytes} new bytes would exceed budget ${this.budget.budgetBytes}.${tierDetail}`,
      )
    }
  }

  async readUsage() {
    if (this.usageCache) return this.usageCache
    const prefix = this.prefix ? `${this.prefix}/` : ''
    let continuationToken = null
    let bytes = 0
    let objects = 0

    do {
      const query = {
        'list-type': '2',
        prefix,
      }
      if (continuationToken) query['continuation-token'] = continuationToken
      const response = await this.request('GET', '', { query })
      const xml = await response.text()
      for (const size of parseS3ListObjectSizes(xml)) {
        bytes += size
        objects += 1
      }
      continuationToken = parseS3NextContinuationToken(xml)
    } while (continuationToken)

    this.usageCache = { bytes, objects }
    return this.usageCache
  }

  async request(method, key, options = {}) {
    const body = options.body ?? null
    const url = this.objectUrl(key)
    if (options.query) {
      const search = new URLSearchParams()
      for (const [name, value] of Object.entries(options.query)) {
        if (value !== undefined && value !== null) search.set(name, String(value))
      }
      search.sort()
      url.search = search.toString()
    }
    const payloadHash = body ? hashBuffer(body) : hashContent('')
    const now = new Date()
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
    const dateStamp = amzDate.slice(0, 8)
    const headers = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...(options.headers ?? {}),
    }
    const authorization = this.authorizationHeader({
      method,
      url,
      headers,
      payloadHash,
      amzDate,
      dateStamp,
    })
    headers.authorization = authorization

    const response = await fetch(url, {
      method,
      headers,
      body: body && method !== 'HEAD' ? body : undefined,
    })
    if (!response.ok && !(options.allowNotFound && response.status === 404)) {
      const detail = await safeResponseText(response)
      throw new Error(`${this.provider}_blob_request_failed: ${method} ${key} returned ${response.status}${detail ? ` ${detail}` : ''}`)
    }
    return response
  }

  objectUrl(key) {
    const encodedKey = encodeS3Key(key)
    if (this.forcePathStyle) {
      const url = new URL(this.endpoint.toString())
      url.pathname = joinUrlPath(url.pathname, this.bucket, encodedKey)
      return url
    }

    const url = new URL(this.endpoint.toString())
    url.hostname = `${this.bucket}.${url.hostname}`
    url.pathname = joinUrlPath(url.pathname, encodedKey)
    return url
  }

  authorizationHeader({ method, url, headers, payloadHash, amzDate, dateStamp }) {
    const canonicalHeaders = Object.entries(headers)
      .map(([name, value]) => [name.toLowerCase(), String(value).trim().replace(/\s+/g, ' ')])
      .sort(([a], [b]) => a.localeCompare(b))
    const signedHeaders = canonicalHeaders.map(([name]) => name).join(';')
    const canonicalRequest = [
      method,
      url.pathname || '/',
      url.search ? url.search.slice(1) : '',
      canonicalHeaders.map(([name, value]) => `${name}:${value}\n`).join(''),
      signedHeaders,
      payloadHash,
    ].join('\n')
    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      hashContent(canonicalRequest),
    ].join('\n')
    const signingKey = awsV4SigningKey(this.secretAccessKey, dateStamp, this.region, 's3')
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')

    return `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  }
}

function parseS3ListObjectSizes(xml) {
  const sizes = []
  const contentMatches = xml.matchAll(/<Contents\b[^>]*>([\s\S]*?)<\/Contents>/g)
  for (const match of contentMatches) {
    const sizeMatch = match[1].match(/<Size>(\d+)<\/Size>/)
    if (!sizeMatch) continue
    sizes.push(Number(sizeMatch[1]))
  }
  return sizes
}

function parseS3ListObjects(xml) {
  const objects = []
  const contentMatches = xml.matchAll(/<Contents\b[^>]*>([\s\S]*?)<\/Contents>/g)
  for (const match of contentMatches) {
    const keyMatch = match[1].match(/<Key>([\s\S]*?)<\/Key>/)
    if (!keyMatch) continue
    const sizeMatch = match[1].match(/<Size>(\d+)<\/Size>/)
    const modifiedMatch = match[1].match(/<LastModified>([\s\S]*?)<\/LastModified>/)
    objects.push({
      key: decodeXmlText(keyMatch[1]),
      size: sizeMatch ? Number(sizeMatch[1]) : null,
      lastModified: modifiedMatch ? decodeXmlText(modifiedMatch[1]) : null,
    })
  }
  return objects
}

function parseS3NextContinuationToken(xml) {
  const match = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)
  return match ? decodeXmlText(match[1]) : null
}

function decodeXmlText(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function encodeS3Key(key) {
  return key.split('/').map((part) => encodeURIComponent(part)).join('/')
}

function joinUrlPath(...parts) {
  return `/${parts
    .flatMap((part) => String(part ?? '').split('/'))
    .filter(Boolean)
    .join('/')}`
}

function awsV4SigningKey(secretAccessKey, dateStamp, region, service) {
  const kDate = createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest()
  const kRegion = createHmac('sha256', kDate).update(region).digest()
  const kService = createHmac('sha256', kRegion).update(service).digest()
  return createHmac('sha256', kService).update('aws4_request').digest()
}

async function safeResponseText(response) {
  try {
    const text = await response.text()
    return text.trim().slice(0, 500)
  } catch {
    return ''
  }
}

async function prepareGraphForBlobStorage(service, cloud) {
  if (!service.blobStore) return cloud
  const codebaseId = cloud.codebase?.id ?? service.codebaseId ?? 'hopit'
  for (const [relativePath, file] of Object.entries(cloud.files ?? {})) {
    const entry = normalizeCloudFileEntry(relativePath, file)
    cloud.files[relativePath] = await prepareEntryForBlobStorage(service.blobStore, codebaseId, relativePath, entry)
  }
  return cloud
}

async function prepareEntryForBlobStorage(blobStore, codebaseId, relativePath, entry) {
  const payload = normalizeCloudFileEntry(relativePath, entry)
  if (!blobStore || payload.kind !== entryKind.file || isObjectStoredFileEntry(payload)) return payload
  const buffer = bufferFromFileEntry(payload)
  const descriptor = await blobStore.putBlob({
    codebaseId,
    relativePath,
    hash: payload.hash,
    buffer,
    encrypt: blobStore.shouldEncrypt?.(relativePath) ?? false,
  })
  return {
    ...payload,
    content: '',
    contentStorage: contentStorageMode.objectBlob,
    blobProvider: descriptor.provider,
    blobKey: descriptor.key,
    blobHash: descriptor.blobHash ?? descriptor.hash,
    blobSize: descriptor.blobSize ?? descriptor.size,
    clientEncryption: descriptor.clientEncryption ?? null,
  }
}

function createCloudGraphService(options) {
  if (shouldUseD1Backend(options)) {
    return new D1CloudGraphService(options)
  }

  if (options.profile === 'production' && !options['allow-local-cloud']) {
    throw new Error('Production profile requires Cloudflare D1 backend configuration. Set HOPIT_CLOUD_BACKEND=d1 with HOPIT_D1_* values. Use --allow-local-cloud only for local dry runs.')
  }

  return new FixtureJsonCloudGraphService(options)
}

class FixtureJsonCloudGraphService {
  constructor(options) {
    this.path = options.cloud
    this.type = cloudServiceType
    this.location = path.resolve(options.cloud)
    this.usesAtomicFileMutations = false
    this.blobStore = createObjectBlobStore(options)
  }

  async exists() {
    return existsSync(this.path)
  }

  async readGraphHead() {
    if (!(await this.exists())) return null
    return graphHeadFromGraph(await this.readGraph())
  }

  async initialize(fixture) {
    const cloud = withComputedMetadata(fixture)
    await prepareGraphForBlobStorage(this, cloud)
    await this.writeGraph(cloud)
    return cloud
  }

  async readGraph() {
    return normalizeValidatedCloudGraph(await readJson(this.path))
  }

  async readVisibleGraph(request = {}) {
    return filterVisibleGraphForRequester(await this.readGraph(), request)
  }

  async readOptionalGraph() {
    if (!(await this.exists())) return null
    return this.readGraph()
  }

  async readOptionalVisibleGraph(request = {}) {
    if (!(await this.exists())) return null
    return this.readVisibleGraph(request)
  }

  async listCodebases(request = {}) {
    const graph = await this.readOptionalVisibleGraph(request)
    return graph ? [graphHeadFromGraph(graph)] : []
  }

  async writeGraph(cloud) {
    const normalized = normalizeValidatedCloudGraph(cloud)
    await prepareGraphForBlobStorage(this, normalized)
    await writeJson(this.path, normalized)
  }

  applyJournalEntry(cloud, entry, options = {}) {
    return applyJournalEntryToCloud(cloud, entry, options)
  }

  async commitJournalEntry(cloud, entry, options = {}) {
    const payload = options.entry
      ? await prepareEntryForBlobStorage(this.blobStore, cloud.codebase?.id ?? 'hopit', entry.path, options.entry)
      : null
    const acknowledgement = this.applyJournalEntry(cloud, entry, {
      ...options,
      entry: payload ?? options.entry,
    })
    await this.writeGraph(cloud)
    return acknowledgement
  }

  async readBlob(file, context = {}) {
    if (!this.blobStore) throw new Error('Object-backed file requires HOPIT_BLOB_PROVIDER.')
    return await this.blobStore.getBlob(file, context)
  }
}

class D1CloudGraphService extends CloudflareD1HopBackend {
  constructor(options) {
    super(d1ConfigFromOptions(options))
    this.codebaseId = options['codebase-id'] || process.env.HOPIT_CODEBASE_ID || this.codebaseId || null
    this.type = d1CloudServiceType
    this.location = this.codebaseId ? `d1:${this.codebaseId}` : `d1:${this.config.databaseId ?? 'unconfigured'}`
    this.usesAtomicFileMutations = false
    this.blobStore = createObjectBlobStore(options)
  }

  async initialize(fixture) {
    const cloud = withComputedMetadata(fixture)
    this.codebaseId = cloud.codebase.id
    this.location = `d1:${this.codebaseId}`
    await prepareGraphForBlobStorage(this, cloud)
    await super.initialize(cloud)
    return cloud
  }

  async readGraph() {
    const graph = await this.readOptionalGraph()
    if (!graph) {
      throw new Error(`D1 graph not found for codebase ${this.codebaseId ?? '(unset)'}.`)
    }
    return graph
  }

  async readOptionalGraph() {
    const graph = await super.readOptionalGraph(this.codebaseId)
    return graph ? normalizeValidatedCloudGraph(graph) : null
  }

  async readGraphHead() {
    return normalizeCloudGraphHead(await super.readGraphHead(this.codebaseId))
  }

  async readVisibleGraph(request = {}) {
    return filterVisibleGraphForRequester(await this.readGraph(), request)
  }

  async readOptionalVisibleGraph(request = {}) {
    const graph = await this.readOptionalGraph()
    return graph ? filterVisibleGraphForRequester(graph, request) : null
  }

  async listCodebases(request = {}) {
    const codebases = await super.listCodebases({
      userId: request.requesterId,
      sessionId: request.sessionId,
    })
    return Array.isArray(codebases) ? codebases.map(normalizeCloudGraphHead).filter(Boolean) : []
  }

  async writeGraph(cloud) {
    const normalized = normalizeValidatedCloudGraph(cloud)
    this.codebaseId = normalized.codebase.id
    this.location = `d1:${this.codebaseId}`
    await prepareGraphForBlobStorage(this, normalized)
    return await super.writeGraph(normalized)
  }

  applyJournalEntry(cloud, entry, options = {}) {
    return applyJournalEntryToCloud(cloud, entry, options)
  }

  async commitJournalEntry(cloud, entry, options = {}) {
    const payload = options.entry
      ? await prepareEntryForBlobStorage(this.blobStore, cloud.codebase?.id ?? this.codebaseId ?? 'hopit', entry.path, options.entry)
      : null
    const acknowledgement = this.applyJournalEntry(cloud, entry, {
      ...options,
      entry: payload ?? options.entry,
    })
    await this.writeGraph(cloud)
    return {
      ...acknowledgement,
      storageMode: 'd1-graph-save',
    }
  }

  async readBlob(file, context = {}) {
    if (!this.blobStore) throw new Error('Object-backed file requires HOPIT_BLOB_PROVIDER.')
    return await this.blobStore.getBlob(file, context)
  }
}

async function removeEmptyAncestorDirectories(root, relativeDir) {
  let current = relativeDir

  while (current && current !== '.') {
    const absolutePath = path.join(root, current)

    try {
      await fs.rmdir(absolutePath)
    } catch {
      return
    }

    current = path.dirname(current)
  }
}

function withComputedMetadata(cloud) {
  const next = normalizeCloudGraph(structuredClone(cloud))
  for (const [relativePath, file] of Object.entries(next.files)) {
    next.files[relativePath] = normalizeCloudFileEntry(relativePath, file)
  }
  validateCloudGraphContract(next)
  return next
}

function normalizeValidatedCloudGraph(cloud) {
  validateRawCloudGraphContract(cloud)
  const normalized = normalizeCloudGraph(cloud)
  validateCloudGraphContract(normalized)
  return normalized
}

function graphHeadFromGraph(cloud) {
  const graph = normalizeCloudGraph(structuredClone(cloud))
  return normalizeCloudGraphHead({
    exists: true,
    schemaVersion: graph.schemaVersion,
    codebase: graph.codebase,
    main: graph.main,
    selectedState: graph.selectedState,
    owner: graph.owner,
    session: graph.session,
    visibility: graph.visibility,
    access: graph.visibilityContext ?? null,
    revision: graph.revision,
    fileCount: Object.keys(graph.files ?? {}).length,
    privateFileCount: Object.keys(graph.files ?? {}).filter((filePath) => scopeForPath(filePath) === 'owner-private').length,
    memberCount: 1 + (Array.isArray(graph.collaborators) ? graph.collaborators.length : 0),
  })
}

function normalizeCloudGraphHead(head) {
  if (!head || typeof head !== 'object') return null

  const codebase = objectOrNull(head.codebase)
  const main = objectOrNull(head.main)
  const selectedState = objectOrNull(head.selectedState)
  const owner = objectOrNull(head.owner)
  const session = objectOrNull(head.session)
  const access = objectOrNull(head.access)
  const remoteUpdate = objectOrNull(head.remoteUpdate)

  return {
    exists: head.exists !== false,
    schemaVersion: integerOrNull(head.schemaVersion),
    codebase: codebase
      ? {
          id: textOrNull(codebase.id),
          name: textOrNull(codebase.name) ?? textOrNull(codebase.id),
          ownerId: textOrNull(codebase.ownerId),
        }
      : null,
    main: main
      ? {
          id: textOrNull(main.id),
          revision: integerOrNull(main.revision),
        }
      : null,
    selectedState: selectedState
      ? {
          type: textOrNull(selectedState.type),
          id: textOrNull(selectedState.id),
          ownerId: textOrNull(selectedState.ownerId),
          baseMainId: textOrNull(selectedState.baseMainId),
          baseRevision: integerOrNull(selectedState.baseRevision),
          revision: integerOrNull(selectedState.revision),
          visibility: textOrNull(selectedState.visibility),
          effectiveVisibility: textOrNull(selectedState.effectiveVisibility),
          reviewState: textOrNull(selectedState.reviewState),
          mergeState: textOrNull(selectedState.mergeState),
          conflictState: textOrNull(selectedState.conflictState),
        }
      : null,
    owner: owner ? { id: textOrNull(owner.id) } : null,
    session: session
      ? {
          id: textOrNull(session.id),
          deviceName: textOrNull(session.deviceName),
        }
      : null,
    visibility: objectOrNull(head.visibility),
    access: access
      ? {
          id: textOrNull(access.id),
          sessionId: textOrNull(access.sessionId),
          role: textOrNull(access.role) ?? 'guest',
          isOwner: access.isOwner === true,
          isCollaborator: access.isCollaborator === true,
          membershipSource: textOrNull(access.membershipSource) ?? 'unknown',
          permissions: Array.isArray(access.permissions)
            ? access.permissions.filter((permission) => typeof permission === 'string')
            : [],
          visibleFileCount: integerOrNull(access.visibleFileCount),
          hiddenFileCount: integerOrNull(access.hiddenFileCount),
          hiddenScopeCounts: objectOrNull(access.hiddenScopeCounts),
        }
      : null,
    revision: integerOrNull(head.revision),
    fileCount: integerOrNull(head.fileCount),
    privateFileCount: integerOrNull(head.privateFileCount),
    memberCount: integerOrNull(head.memberCount),
    remoteUpdate: remoteUpdate
      ? {
          state: textOrNull(remoteUpdate.state),
          delivery: textOrNull(remoteUpdate.delivery),
          graphRevision: integerOrNull(remoteUpdate.graphRevision),
          mainRevision: integerOrNull(remoteUpdate.mainRevision),
          materializedRevision: integerOrNull(remoteUpdate.materializedRevision),
          selectedStateRevision: integerOrNull(remoteUpdate.selectedStateRevision),
          behindByRevisions: integerOrNull(remoteUpdate.behindByRevisions),
          safeRefreshOnly: remoteUpdate.safeRefreshOnly === true,
          localHydrationState: textOrNull(remoteUpdate.localHydrationState),
          updatedAt: textOrNull(remoteUpdate.updatedAt),
        }
      : null,
    updatedAt: textOrNull(head.updatedAt),
  }
}

function normalizeCloudGraph(cloud) {
  if (!cloud || typeof cloud !== 'object') {
    throw new Error('Cloud graph must be an object.')
  }

  if (!cloud.files || typeof cloud.files !== 'object') cloud.files = {}
  if (!Number.isInteger(cloud.revision)) cloud.revision = 0

  cloud.schemaVersion = cloud.schemaVersion ?? 2
  cloud.codebase = cloud.codebase ?? {}
  cloud.codebase.id = cloud.codebase.id ?? 'hopit-core'
  cloud.codebase.name = cloud.codebase.name ?? cloud.codebase.id
  cloud.owner = cloud.owner ?? {}
  cloud.owner.id = cloud.owner.id ?? cloud.codebase.ownerId ?? 'user_demo_owner'
  cloud.codebase.ownerId = cloud.codebase.ownerId ?? cloud.owner.id
  cloud.collaborators = Array.isArray(cloud.collaborators) ? cloud.collaborators : []
  cloud.main = cloud.main ?? {}
  cloud.main.id = cloud.main.id ?? 'main'
  cloud.main.revision = Number.isInteger(cloud.main.revision) ? cloud.main.revision : cloud.revision
  cloud.main.updatedAt = cloud.main.updatedAt ?? null
  cloud.main.mergedChangeSetId = cloud.main.mergedChangeSetId ?? null
  cloud.selectedState = cloud.selectedState ?? {}
  cloud.selectedState.type = cloud.selectedState.type ?? 'active-change-set'
  cloud.selectedState.id = cloud.selectedState.id ?? 'cs_fixture_active'
  cloud.selectedState.ownerId = cloud.selectedState.ownerId ?? cloud.owner.id
  cloud.selectedState.baseMainId = cloud.selectedState.baseMainId ?? cloud.main.id
  cloud.selectedState.baseRevision = Number.isInteger(cloud.selectedState.baseRevision)
    ? cloud.selectedState.baseRevision
    : cloud.main.revision
  cloud.selectedState.revision = Number.isInteger(cloud.selectedState.revision)
    ? cloud.selectedState.revision
    : cloud.revision
  cloud.selectedState.reviewState = cloud.selectedState.reviewState ?? 'not-open'
  cloud.selectedState.mergeState = cloud.selectedState.mergeState ?? 'unmerged'
  cloud.selectedState.conflictState = cloud.selectedState.conflictState ?? 'none'
  cloud.selectedState.conflict = cloud.selectedState.conflict ?? null
  cloud.selectedState.review = cloud.selectedState.review ?? null
  cloud.selectedState.merge = cloud.selectedState.merge ?? null
  cloud.session = cloud.session ?? {}
  cloud.session.id = cloud.session.id ?? 'session_fixture_local'
  cloud.session.deviceName = cloud.session.deviceName ?? 'fixture-device'
  cloud.visibility = normalizeVisibilityContract(cloud.visibility)
  cloud.selectedState.visibility = cloud.selectedState.visibility ?? cloud.visibility.effective
  cloud.selectedState.effectiveVisibility = cloud.selectedState.effectiveVisibility ?? cloud.visibility.effective

  normalizeCloudScopes(cloud)
  return cloud
}

function validateRawCloudGraphContract(cloud) {
  if (!cloud || typeof cloud !== 'object') {
    throw new Error('Cloud graph must be an object.')
  }
  if (cloud.files !== undefined && (!cloud.files || typeof cloud.files !== 'object' || Array.isArray(cloud.files))) {
    throw new Error('Cloud graph files must be an object.')
  }

  for (const [relativePath, file] of Object.entries(cloud.files ?? {})) {
    assertSafeCloudPath(relativePath)
    if (file?.scope && file.scope !== scopeForPath(relativePath)) {
      throw new Error(`Cloud graph scope mismatch for ${relativePath}: expected ${scopeForPath(relativePath)}, got ${file.scope}.`)
    }
    if (file?.privacyZone && file.privacyZone !== privacyZoneForPath(relativePath)) {
      throw new Error(`Cloud graph privacy zone mismatch for ${relativePath}: expected ${privacyZoneForPath(relativePath)}, got ${file.privacyZone}.`)
    }
  }
}

function validateCloudGraphContract(cloud) {
  const errors = []
  const visibilityValues = new Set(['private', 'team-visible', 'review-visible'])
  const reviewStates = new Set(['not-open', 'open', 'merged'])
  const mergeStates = new Set(['unmerged', 'merged'])
  const conflictStates = new Set(['none', 'conflicted'])

  if (cloud.schemaVersion !== 2) errors.push('schemaVersion must be 2.')
  if (!isNonEmptyString(cloud.codebase?.id)) errors.push('codebase.id is required.')
  if (!isNonEmptyString(cloud.codebase?.name)) errors.push('codebase.name is required.')
  if (!isNonEmptyString(cloud.codebase?.ownerId)) errors.push('codebase.ownerId is required.')
  if (!isNonEmptyString(cloud.owner?.id)) errors.push('owner.id is required.')
  if (cloud.codebase?.ownerId !== cloud.owner?.id) errors.push('codebase.ownerId must match owner.id.')
  if (!isNonEmptyString(cloud.main?.id)) errors.push('main.id is required.')
  if (!Number.isInteger(cloud.main?.revision)) errors.push('main.revision must be an integer.')
  if (!isNonEmptyString(cloud.selectedState?.type)) errors.push('selectedState.type is required.')
  if (cloud.selectedState?.type !== 'active-change-set' && cloud.selectedState?.type !== 'main') {
    errors.push('selectedState.type must be active-change-set or main.')
  }
  if (!isNonEmptyString(cloud.selectedState?.id)) errors.push('selectedState.id is required.')
  if (!Number.isInteger(cloud.selectedState?.revision)) errors.push('selectedState.revision must be an integer.')
  if (!Number.isInteger(cloud.revision)) errors.push('revision must be an integer.')
  if (!visibilityValues.has(cloud.visibility?.effective)) errors.push('visibility.effective is invalid.')
  if (!visibilityValues.has(cloud.selectedState?.effectiveVisibility)) {
    errors.push('selectedState.effectiveVisibility is invalid.')
  }
  if (!reviewStates.has(cloud.selectedState?.reviewState)) errors.push('selectedState.reviewState is invalid.')
  if (!mergeStates.has(cloud.selectedState?.mergeState)) errors.push('selectedState.mergeState is invalid.')
  if (!conflictStates.has(cloud.selectedState?.conflictState)) errors.push('selectedState.conflictState is invalid.')
  if (!isNonEmptyString(cloud.session?.id)) errors.push('session.id is required.')
  if (!isNonEmptyString(cloud.session?.deviceName)) errors.push('session.deviceName is required.')

  for (const [relativePath, file] of Object.entries(cloud.files ?? {})) {
    try {
      assertSafeCloudPath(relativePath)
    } catch (error) {
      errors.push(error.message)
    }
    if (!file || typeof file !== 'object') errors.push(`${relativePath} must be a file object.`)
    const kind = file?.kind ?? entryKind.file
    if (!Object.values(entryKind).includes(kind)) errors.push(`${relativePath}.kind is invalid.`)
    if (kind === entryKind.file && typeof file?.content !== 'string') errors.push(`${relativePath}.content must be a string.`)
    if (kind === entryKind.file && file?.encoding !== undefined && !Object.values(entryEncoding).includes(file.encoding)) {
      errors.push(`${relativePath}.encoding is invalid.`)
    }
    if (kind === entryKind.file && file?.contentStorage !== undefined && !Object.values(contentStorageMode).includes(file.contentStorage)) {
      errors.push(`${relativePath}.contentStorage is invalid.`)
    }
    if (kind === entryKind.file && file?.contentStorage === contentStorageMode.objectBlob) {
      if (!isNonEmptyString(file.blobProvider)) errors.push(`${relativePath}.blobProvider is required for object-backed files.`)
      if (!isNonEmptyString(file.blobKey)) errors.push(`${relativePath}.blobKey is required for object-backed files.`)
      if (!isNonEmptyString(file.blobHash ?? file.hash)) errors.push(`${relativePath}.blobHash is required for object-backed files.`)
      errors.push(...validateClientEncryptionMetadata(file.clientEncryption, `${relativePath}.clientEncryption`))
    }
    if (
      kind === entryKind.file &&
      privacyZoneForPath(relativePath) === 'secrets' &&
      !(
        file?.contentStorage === contentStorageMode.objectBlob &&
        file?.clientEncryption?.state === 'client-encrypted' &&
        validateClientEncryptionMetadata(file.clientEncryption, `${relativePath}.clientEncryption`).length === 0
      )
    ) {
      errors.push(`${relativePath} must be stored as encrypted object-backed content because it is in the secrets privacy zone.`)
    }
    if (kind === entryKind.symlink && typeof file?.target !== 'string') errors.push(`${relativePath}.target must be a string.`)
    if (kind === entryKind.directory && file?.content !== '') errors.push(`${relativePath}.content must be empty for directories.`)
    if (file?.scope !== scopeForPath(relativePath)) {
      errors.push(`${relativePath}.scope must be ${scopeForPath(relativePath)}.`)
    }
    if (file?.privacyZone !== undefined && file.privacyZone !== privacyZoneForPath(relativePath)) {
      errors.push(`${relativePath}.privacyZone must be ${privacyZoneForPath(relativePath)}.`)
    }
    if (!Number.isInteger(file?.revision)) errors.push(`${relativePath}.revision must be an integer.`)
    if (file?.hash !== undefined && file.hash !== null && typeof file.hash !== 'string') {
      errors.push(`${relativePath}.hash must be a string when present.`)
    }
    if (file?.size !== undefined && file.size !== null && !Number.isInteger(file.size)) {
      errors.push(`${relativePath}.size must be an integer when present.`)
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid HopIt cloud graph: ${errors.join(' ')}`)
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function textOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null
}

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function visibilityRequestFromOptions(options) {
  return {
    requesterId: options['requester-id'] ?? options.requester,
    sessionId: options['session-id'] ?? options['requester-session'],
  }
}

function filterVisibleGraphForRequester(cloud, request = {}) {
  const graph = normalizeCloudGraph(structuredClone(cloud))
  const context = visibilityContextForGraph(graph, request)
  const files = {}
  const hiddenPaths = []

  for (const [relativePath, file] of Object.entries(graph.files ?? {})) {
    if (!canRequesterSeePath(context, relativePath)) {
      hiddenPaths.push(relativePath)
      continue
    }
    files[relativePath] = file
  }

  graph.files = files
  graph.visibilityContext = {
    ...context,
    visibleFileCount: Object.keys(files).length,
    hiddenFileCount: hiddenPaths.length,
    hiddenScopeCounts: countPathScopes(hiddenPaths),
  }

  return graph
}

function visibilityContextForGraph(cloud, request = {}) {
  if (!request.requesterId && !request.sessionId && cloud.visibilityContext) {
    return cloud.visibilityContext
  }

  const ownerId = cloud.owner?.id ?? cloud.codebase?.ownerId ?? null
  const requesterId = request.requesterId ?? ownerId
  const collaborator = (cloud.collaborators ?? []).find((entry) => entry.id === requesterId) ?? null
  const isOwner = Boolean(ownerId && requesterId === ownerId)
  const isCollaborator = Boolean(collaborator)
  const effectiveVisibility = effectiveChangeSetVisibilityForCloud(cloud)

  return {
    id: requesterId,
    sessionId: request.sessionId ?? (isOwner ? cloud.session?.id : null),
    ownerId,
    role: isOwner ? 'owner' : isCollaborator ? (collaborator.role ?? 'member') : 'guest',
    isOwner,
    isCollaborator,
    selectedStateType: cloud.selectedState?.type ?? null,
    selectedStateId: cloud.selectedState?.id ?? null,
    effectiveChangeSetVisibility: effectiveVisibility,
  }
}

function canRequesterSeePath(context, relativePath) {
  if (context.isOwner) return true
  if (scopeForPath(relativePath) === fileScope.ownerPrivate) return false
  if (!context.isCollaborator) return false

  if (context.selectedStateType === 'main') return true

  return (
    context.effectiveChangeSetVisibility === 'team-visible' ||
    context.effectiveChangeSetVisibility === 'review-visible'
  )
}

function effectiveChangeSetVisibilityForCloud(cloud) {
  return cloud?.selectedState?.effectiveVisibility ?? cloud?.visibility?.effective ?? 'private'
}

function summarizeRequester(context) {
  if (!context) return null

  return {
    id: context.id ?? null,
    sessionId: context.sessionId ?? null,
    role: context.role ?? null,
    isOwner: Boolean(context.isOwner),
    isCollaborator: Boolean(context.isCollaborator),
    selectedStateId: context.selectedStateId ?? null,
    effectiveChangeSetVisibility: context.effectiveChangeSetVisibility ?? null,
    visibleFileCount: context.visibleFileCount ?? null,
    hiddenFileCount: context.hiddenFileCount ?? null,
    hiddenScopeCounts: context.hiddenScopeCounts ?? { shared: 0, private: 0 },
  }
}

function normalizeVisibilityContract(visibility = {}) {
  const productDefault = visibility.productDefault ?? 'private'
  const effective =
    visibility.changeSetOverride ??
    visibility.codebaseOverride ??
    visibility.globalUserDefault ??
    visibility.effective ??
    productDefault

  return {
    productDefault,
    globalUserDefault: visibility.globalUserDefault ?? null,
    codebaseOverride: visibility.codebaseOverride ?? null,
    changeSetOverride: visibility.changeSetOverride ?? null,
    effective,
  }
}

function summarizeGraphContract(cloud) {
  return {
    schemaVersion: cloud?.schemaVersion ?? null,
    codebaseId: cloud?.codebase?.id ?? null,
    mainId: cloud?.main?.id ?? null,
    selectedStateType: cloud?.selectedState?.type ?? null,
    selectedStateId: cloud?.selectedState?.id ?? null,
    selectedStateRevision: cloud?.selectedState?.revision ?? null,
    ownerId: cloud?.owner?.id ?? cloud?.codebase?.ownerId ?? null,
    sessionId: cloud?.session?.id ?? null,
    effectiveChangeSetVisibility:
      cloud?.selectedState?.effectiveVisibility ?? cloud?.visibility?.effective ?? null,
  }
}

function journalContextForCloud(cloud) {
  const contract = summarizeGraphContract(cloud)
  return {
    targetStateType: contract.selectedStateType,
    targetStateId: contract.selectedStateId,
    targetStateRevision: contract.selectedStateRevision,
    ownerId: contract.ownerId,
    sessionId: contract.sessionId,
    effectiveChangeSetVisibility: contract.effectiveChangeSetVisibility,
  }
}

function actorIdFromOptions(options, cloud) {
  return options['requester-id'] ?? options.requester ?? cloud.owner?.id ?? cloud.codebase?.ownerId ?? null
}

function ensureActiveChangeSet(cloud) {
  if (cloud.selectedState?.type !== 'active-change-set') {
    throw new Error('Selected state must be an active change set.')
  }
  if (!cloud.selectedState.id) {
    throw new Error('Selected active change set is missing id.')
  }
}

function recordChangeSetConflict(cloud, detail) {
  ensureActiveChangeSet(cloud)

  const conflict = {
    state: 'conflicted',
    selectedStateId: cloud.selectedState.id,
    selectedStateRevision: cloud.selectedState.revision,
    mainId: cloud.main?.id ?? null,
    mainRevision: cloud.main?.revision ?? null,
    ...detail,
  }

  cloud.selectedState.conflictState = 'conflicted'
  cloud.selectedState.conflict = conflict
  return conflict
}

function normalizeCloudScopes(cloud) {
  for (const [relativePath, file] of Object.entries(cloud.files ?? {})) {
    cloud.files[relativePath] = normalizeCloudFileEntry(relativePath, file)
  }
}

function scopeForPath(relativePath) {
  return relativePath === '.private' ||
    relativePath.startsWith('.private/') ||
    relativePath === '.git' ||
    relativePath.startsWith('.git/')
    ? fileScope.ownerPrivate
    : fileScope.shared
}

function countCloudScopes(cloud) {
  return countPathScopes(cloud?.files ? Object.keys(cloud.files) : [])
}

function countEntryScopes(entries) {
  return countScopes(entries.map((entry) => entry.scope ?? scopeForPath(entry.path ?? '')))
}

function countPathScopes(paths) {
  return countScopes(paths.map((relativePath) => scopeForPath(relativePath)))
}

function countScopes(scopes) {
  const counts = {
    shared: 0,
    private: 0,
  }

  for (const scope of scopes) {
    if (scope === fileScope.ownerPrivate) {
      counts.private += 1
    } else {
      counts.shared += 1
    }
  }

  return counts
}

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex')
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function hashSymlinkTarget(target) {
  return hashContent(`symlink\0${target}`)
}

function hashDirectoryEntry(relativePath) {
  return hashContent(`directory\0${relativePath}`)
}

function encodeBufferForCloud(buffer) {
  if (isRoundTrippableUtf8(buffer) && !buffer.includes(0)) {
    return {
      content: buffer.toString('utf8'),
      encoding: entryEncoding.utf8,
    }
  }

  return {
    content: buffer.toString('base64'),
    encoding: entryEncoding.base64,
  }
}

function isRoundTrippableUtf8(buffer) {
  const text = buffer.toString('utf8')
  return Buffer.from(text, 'utf8').equals(buffer)
}

function normalizeCloudFileEntry(relativePath, file) {
  const value = file && typeof file === 'object' ? { ...file } : { content: '' }
  value.kind = value.kind ?? entryKind.file
  value.scope = scopeForPath(relativePath)
  value.privacyZone = privacyZoneForPath(relativePath)

  if (value.kind === entryKind.directory) {
    value.content = ''
    value.encoding = entryEncoding.utf8
    value.target = null
    value.size = 0
    value.hash = typeof value.hash === 'string' ? value.hash : hashDirectoryEntry(relativePath)
    return value
  }

  if (value.kind === entryKind.symlink) {
    value.target = typeof value.target === 'string' ? value.target : String(value.content ?? '')
    value.content = value.target
    value.encoding = entryEncoding.utf8
    value.size = Number.isInteger(value.size) ? value.size : Buffer.byteLength(value.target)
    value.hash = typeof value.hash === 'string' ? value.hash : hashSymlinkTarget(value.target)
    return value
  }

  value.kind = entryKind.file
  value.encoding = value.encoding === entryEncoding.base64 ? entryEncoding.base64 : entryEncoding.utf8
  value.content = typeof value.content === 'string' ? value.content : ''
  value.contentStorage = normalizeContentStorageMode(value.contentStorage)
  value.blobProvider = typeof value.blobProvider === 'string' ? value.blobProvider : null
  value.blobKey = typeof value.blobKey === 'string' ? value.blobKey : null
  value.blobHash = typeof value.blobHash === 'string' ? value.blobHash : (typeof value.hash === 'string' ? value.hash : null)
  value.blobSize = Number.isInteger(value.blobSize) ? value.blobSize : null
  value.clientEncryption = normalizeClientEncryptionMetadata(value.clientEncryption)
  const buffer = bufferFromFileEntry(value)
  value.size = Number.isInteger(value.size) ? value.size : buffer.byteLength
  value.hash = typeof value.hash === 'string' ? value.hash : (isNonEmptyString(value.blobHash) ? value.blobHash : hashBuffer(buffer))
  if (!value.blobHash) value.blobHash = value.hash
  if (!value.blobSize && value.contentStorage === contentStorageMode.objectBlob) value.blobSize = value.size
  return value
}

function bufferFromFileEntry(file) {
  if (file.kind && file.kind !== entryKind.file) return Buffer.alloc(0)
  const content = typeof file.content === 'string' ? file.content : ''
  return Buffer.from(content, file.encoding === entryEncoding.base64 ? 'base64' : 'utf8')
}

async function bufferFromCloudFileEntry(file, cloudService = null, context = {}) {
  if (file.kind && file.kind !== entryKind.file) return Buffer.alloc(0)
  if (!isObjectStoredFileEntry(file)) return bufferFromFileEntry(file)
  if (!cloudService?.readBlob) {
    throw new Error(`Cannot read object-backed file without a configured blob store: ${file.blobKey ?? file.hash ?? '(missing key)'}`)
  }

  const buffer = await cloudService.readBlob(file, context)
  const actualHash = hashBuffer(buffer)
  const expectedHash = file.hash
  if (expectedHash && actualHash !== expectedHash) {
    throw new Error(`object_blob_plaintext_hash_mismatch: expected ${expectedHash}, got ${actualHash}`)
  }
  if (Number.isInteger(file.size) && buffer.byteLength !== file.size) {
    throw new Error(`object_blob_plaintext_size_mismatch: expected ${file.size}, got ${buffer.byteLength}`)
  }
  return buffer
}

async function cloudFileTextForVerification(file, cloudService = null) {
  if (!file) return ''
  const entry = normalizeCloudFileEntry('', file)
  return (await bufferFromCloudFileEntry(entry, cloudService)).toString('utf8')
}

function isObjectStoredFileEntry(file) {
  return file?.kind === entryKind.file && file.contentStorage === contentStorageMode.objectBlob
}

function normalizeContentStorageMode(value) {
  if (value === contentStorageMode.objectBlob) return contentStorageMode.objectBlob
  return contentStorageMode.inline
}

function cloudEntryContentBytes(relativePath, file) {
  const entry = normalizeCloudFileEntry(relativePath, file)
  if (entry.kind === entryKind.file) return entry.contentStorage === contentStorageMode.objectBlob ? entry.size : bufferFromFileEntry(entry).byteLength
  if (entry.kind === entryKind.symlink) return Buffer.byteLength(entry.target ?? '')
  return 0
}

function cloudEntryEncodedBytes(relativePath, file) {
  const entry = normalizeCloudFileEntry(relativePath, file)
  if (entry.kind === entryKind.file) return entry.contentStorage === contentStorageMode.objectBlob ? entry.size : Buffer.byteLength(entry.content ?? '')
  if (entry.kind === entryKind.symlink) return Buffer.byteLength(entry.target ?? '')
  return 0
}

function cloudEntryEquals(a, b) {
  if (!a || !b) return false
  return (
    a.kind === b.kind &&
    a.hash === b.hash &&
    a.size === b.size &&
    a.scope === b.scope &&
    (a.privacyZone ?? null) === (b.privacyZone ?? null) &&
    (a.target ?? null) === (b.target ?? null)
  )
}

function toCloudPath(value) {
  return value.split(path.sep).join('/')
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'local-project'
}

async function readJson(filePath) {
  const content = await fs.readFile(filePath, 'utf8')
  return JSON.parse(content)
}

async function readNdjson(filePath) {
  if (!existsSync(filePath)) return []

  const content = await fs.readFile(filePath, 'utf8')
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fs.rename(tempPath, filePath)
}

async function writeSecureJson(filePath, value) {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await chmodIfSupported(dir, 0o700)
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await chmodIfSupported(tempPath, 0o600)
  await fs.rename(tempPath, filePath)
  await chmodIfSupported(filePath, 0o600)
}

async function chmodIfSupported(filePath, mode) {
  if (process.platform === 'win32') return
  await fs.chmod(filePath, mode)
}

async function appendNdjson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8')
}

async function emit(options, event, detail) {
  const payload = {
    event,
    detail,
    at: new Date().toISOString(),
  }
  await appendNdjson(options.events, payload)
  await appendRemoteEvent(options, payload)
  console.log(`${event} ${JSON.stringify(detail)}`)
}

async function appendRemoteEvent(options, payload) {
  if (shouldUseD1Backend(options)) {
    await appendD1Event(options, payload)
  }
}

async function appendD1Event(options, payload) {
  const codebaseId = codebaseIdFromEvent(options, payload.detail)
  if (!codebaseId) return

  try {
    const backend = new CloudflareD1HopBackend(d1ConfigFromOptions({
      ...options,
      'codebase-id': codebaseId,
    }))
    await backend.appendEvent({
      codebaseId,
      event: payload.event,
      detail: payload.detail,
      at: payload.at,
      source: 'local-agent',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown D1 event error'
    console.error(`d1.event_failed ${JSON.stringify({ event: payload.event, reason: message })}`)
  }
}

function codebaseIdFromEvent(options, detail) {
  return (
    detail?.contract?.codebaseId ??
    detail?.codebaseId ??
    options['codebase-id'] ??
    process.env.HOPIT_CODEBASE_ID ??
    null
  )
}

function cloudBackendPreference(options) {
  return options['cloud-backend'] ?? process.env.HOPIT_CLOUD_BACKEND ?? null
}

function shouldUseD1Backend(options) {
  const preference = cloudBackendPreference(options)
  if (preference === 'd1' || preference === 'cloudflare-d1') return true
  if (preference === 'fixture' || preference === 'local') return false
  return isD1Configured(options)
}

function agentSessionTokenFromOptions(options) {
  return options['session-token'] ?? process.env.HOPIT_AGENT_SESSION_TOKEN ?? null
}

function sessionCapabilitiesFromOptions(options) {
  const raw = options.capabilities ?? process.env.HOPIT_AGENT_SESSION_CAPABILITIES
  if (!raw) return ['read', 'write', 'sync', 'watch']
  return String(raw)
    .split(',')
    .map((capability) => capability.trim())
    .filter(Boolean)
}

function supportsAgentSessions(cloudService) {
  return Boolean(
    cloudService &&
    typeof cloudService.registerAgentSession === 'function' &&
    typeof cloudService.listAgentSessions === 'function' &&
    typeof cloudService.touchAgentSession === 'function' &&
    typeof cloudService.revokeAgentSession === 'function',
  )
}

function supportsKeyRegistration(cloudService) {
  return Boolean(
    cloudService &&
    typeof cloudService.registerDeviceKey === 'function' &&
    typeof cloudService.ensureUserKeyring === 'function' &&
    typeof cloudService.createWrappedKey === 'function',
  )
}

function findLastEvent(events, eventName) {
  return events.findLast((entry) => entry.event === eventName) ?? null
}

function findLastEventOf(events, eventNames) {
  const names = new Set(eventNames)
  return events.findLast((entry) => names.has(entry.event)) ?? null
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(`${JSON.stringify(payload, null, 2)}\n`)
}

function printHelp() {
  console.log(`hop - HopIt local workspace agent

Commands:
  init        Seed a local cloud file graph
  import      Import a real local folder into the HopIt graph and hydrate it
  import-git  Production-safe literal Git checkout conversion into HopIt
  import-git-url Clone a remote Git URL, then production-safe import the checkout
  mirror      Literal-copy a local folder into the managed workspace with safety checks
  hydrate     Materialize cloud files into the managed workspace
  refresh     Update the managed workspace from cloud when journal and disk are safe
  remote-pull Run one safe remote refresh decision, matching activity-gated watch/service refresh
  sync        Scan managed-folder writes, journal them, and acknowledge to cloud
  recover     Replay unacknowledged journal entries into the cloud graph
  review      Open the selected active change set for review
  merge       Merge the reviewed selected change set into Main
  export      Export the selected graph state to a clean Git repo
  publish     Export a reviewed and merged change set to a clean Git repo
  validate    Validate the configured cloud graph contract
  doctor      Run a production-oriented local health check
  backup      Write a restorable cloud/status/event backup folder
  install     Prepare production state, workspace, env, and optional launch agent
  workspace   Manage/list/discover/attach the configured HopIt workspace root and codebase
  session     Manage this device/session registration (alias: device)
  keys        Manage local encryption device keys and recovery exports
  storage     Inspect object storage usage and dry-run or execute blob GC
  service     Manage the local agent service: start, stop, restart, status, run
  watch       Hydrate and watch the workspace for edits
  status      Print read-only local agent status JSON
  serve       Serve read-only local agent status JSON over HTTP
  demo        Run init, hydrate, edit, sync, and verify

Compatibility aliases:
  import-local, import-remote-git, git-url-import, mirror-local, sync-once, review-open, status-server, workspaces, device, devices, sessions, key, keyring

Options:
  --source <path>     Source folder for import
  --url <git-url>     Remote Git URL for import-git-url or import-git --url
  --branch <name>     Branch or tag to clone for remote Git import
  --depth <n>         Optional clone depth for remote Git import
  --git-timeout-ms <n> Remote Git clone timeout, default 600000
  --storage-budget-bytes <n> mirror: maximum encoded bytes before cloud sync is skipped
  --blob-provider <provider> Object blob provider: r2, b2, s3, or filesystem
  --blob-free-only <1|0> Keep provider uploads under the configured free-only budget
  --blob-storage-budget-bytes <n> Maximum existing+new object bytes before upload fails
  --client-encryption-key <key> Local-only 32-byte base64:/hex: key for encrypted secret sync
  --client-encryption-scope <scope> Encrypt secrets, owner-private, all, or off
  --device-keys <path> Override local per-codebase device keyring path
  --recovery-passphrase <secret> One-shot passphrase for keys export-recovery
  --production-safe import-git/mirror: skip cloud sync if routed secrets are not encrypted
  --execute          storage gc/workspace prune: perform planned local removals; default is dry-run
  --launch-agent-label <label> mirror: macOS LaunchAgent label to stop/restart
  --output <path>     Output folder for Git export/publish
  --path <cloud-path> Cloud file/folder path for workspace hydrate-file, hydrate-path, prune, pin, or unpin
  --recursive        workspace hydrate-path/pin/unpin/prune: include visible files under a folder prefix
  --inactive-ms <n>  workspace prune: only prune clean cached files inactive for this many ms
  --codebase-id <id>  Codebase id for import
  --codebase-name <name> Codebase display name for import
  --profile <name>    development or production path profile
  --state-root <path> Agent state root for production profile
  --workspace-root <path> Root that contains managed HopIt codebase folders
  --workspace-index <path> Optional workspace root index path
  --cloud <path>      Cloud graph JSON path
  --cloud-backend <name> d1 or local. Defaults to D1 when HOPIT_D1_* is configured
  --d1-account-id <id> Cloudflare account id for D1
  --d1-database-id <id> Cloudflare D1 database id
  --d1-api-token <token> Cloudflare API token with D1 edit/read access
  --d1-api-base-url <url> Override Cloudflare API base URL for tests/proxies
  --session-token <token> D1 scoped per-device session token
  --workspace <path>  Managed workspace folder path
  --journal <path>    Pending write journal path
  --events <path>     Event log path
  --pid <path>        Service pid file path
  --requester-id <id> Requester identity for visibility-filtered reads
  --session-id <id>   Requester session id for visibility-filtered reads
  --device-name <name> Device name for session registration
  --capabilities <csv> Session capabilities, default read,write,sync,watch
  --host <host>        Status server host, defaults to 127.0.0.1
  --port <port>        Status server port, defaults to 4785
  --remote-pull        Opt into activity-gated safe cloud refresh in watch/service mode
  --remote-pull-cooldown-ms <ms> Minimum delay between activity-triggered remote pulls, default 300000
  --remote-refresh-interval-ms <ms> Legacy alias for --remote-pull-cooldown-ms
  --start-service      install: start the production service after preparing paths
  --write-env          install: write hopit.env.example under the agent state root
  --launch-agent       install: write a macOS LaunchAgent for start-on-login
  --skip-service-control mirror: do not stop or restart the macOS LaunchAgent
  --json              Accepted for scripting; commands already emit JSON where applicable
  --message <text>    Git commit message for export/publish
  --include-private   Include .private files in export only; publish always omits them
  --allow-unsafe-workspace Override workspace path safety checks
  --allow-local-cloud Allow production profile to use local JSON cloud for dry runs
  --force             Overwrite the cloud graph on init
`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

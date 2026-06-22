#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, watch } from 'node:fs'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConvexHttpClient } from 'convex/browser'
import { anyApi } from 'convex/server'

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
}

const workspaceIndexVersion = 1
const cloudServiceType = 'fixture-json-cloud-graph'
const convexCloudServiceType = 'convex-cloud-graph'

const fileScope = {
  shared: 'shared',
  ownerPrivate: 'owner-private',
}

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
  const options = parseOptions(args)

  if (command === 'init') {
    await initCloud(options)
    return
  }

  if (command === 'import-local') {
    await importLocalProject(options)
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
    sync: 'sync-once',
    review: 'review-open',
    export: 'export-git',
    serve: 'status-server',
    server: 'status-server',
    workspaces: 'workspace',
    device: 'session',
    devices: 'session',
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
  if (!provided.has('remote-refresh-interval-ms') && process.env.HOPIT_REMOTE_REFRESH_INTERVAL_MS) {
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

async function hydrateWorkspace(options) {
  await assertWorkspacePathSafe(options)
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readVisibleGraph(visibilityRequestFromOptions(options))
  const requester = summarizeRequester(cloud.visibilityContext)
  await fs.mkdir(options.workspace, { recursive: true })

  for (const [relativePath, file] of Object.entries(cloud.files)) {
    const scope = scopeForPath(relativePath)
    const absolutePath = workspaceFilePath(options.workspace, relativePath)
    await fs.mkdir(path.dirname(absolutePath), { recursive: true })
    await fs.writeFile(absolutePath, file.content, 'utf8')
    await emit(options, 'file.hydrated', {
      path: relativePath,
      scope,
      bytes: Buffer.byteLength(file.content),
      revision: file.revision,
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
  const relativePath = assertSafeCloudPath(options.path ?? options.file)
  await assertWorkspacePathSafe(options)
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readVisibleGraph(visibilityRequestFromOptions(options))
  const file = cloud.files?.[relativePath]
  if (!file) {
    throw new Error(`File is not visible in the configured cloud graph: ${relativePath}`)
  }
  if (typeof file.content !== 'string') {
    throw new Error(`Cloud file is missing string content: ${relativePath}`)
  }

  const absolutePath = workspaceFilePath(options.workspace, relativePath)
  await fs.mkdir(path.dirname(absolutePath), { recursive: true })
  await fs.writeFile(absolutePath, file.content, 'utf8')
  const hydratedPaths = await hydratedPathUnion(options, cloud.codebase?.id, [relativePath])

  await emit(options, 'file.lazy_hydrated', {
    path: relativePath,
    scope: scopeForPath(relativePath),
    bytes: Buffer.byteLength(file.content),
    revision: file.revision,
    workspace: options.workspace,
    service: cloudService.type,
    contract: summarizeGraphContract(cloud),
    hydratedPathCount: hydratedPaths.length,
  })
  const index = await upsertWorkspaceIndexFromCloud(options, cloud, {
    reason: 'lazy-hydrate',
    lastEvent: 'file.lazy_hydrated',
    hydrationState: 'partial',
    hydratedPaths,
    materialization: 'partial-managed-folder',
  })

  console.log(JSON.stringify({
    ok: true,
    action: 'hydrate-file',
    path: relativePath,
    workspace: path.resolve(options.workspace),
    file: workspaceFileMetadata(options, relativePath, file, true),
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
  for (const relativePath of Object.keys(cloud.files ?? {})) {
    const absolutePath = workspaceFilePath(options.workspace, relativePath)
    if (!existsSync(absolutePath)) continue
    await fs.rm(absolutePath, { force: true })
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

  const result = await materializeCloudToWorkspace(options, cloud)
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

async function materializeCloudToWorkspace(options, cloud) {
  await fs.mkdir(options.workspace, { recursive: true })

  const diskFiles = await readWorkspaceFiles(options.workspace)
  const cloudPaths = new Set(Object.keys(cloud.files ?? {}))
  const changedPaths = []
  const deletedPaths = []
  let written = 0
  let deleted = 0
  let unchanged = 0

  for (const [relativePath, file] of Object.entries(cloud.files ?? {})) {
    if (typeof file.content !== 'string') {
      throw new Error(`Cloud file is missing string content: ${relativePath}`)
    }

    const content = file.content
    const absolutePath = workspaceFilePath(options.workspace, relativePath)
    await fs.mkdir(path.dirname(absolutePath), { recursive: true })

    if (diskFiles[relativePath] === content) {
      unchanged += 1
      continue
    }

    await fs.writeFile(absolutePath, content, 'utf8')
    changedPaths.push(relativePath)
    written += 1
  }

  for (const relativePath of Object.keys(diskFiles)) {
    if (cloudPaths.has(relativePath)) continue

    await fs.rm(workspaceFilePath(options.workspace, relativePath), { force: true })
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
  const diskFiles = await readWorkspaceFiles(options.workspace)
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

  for (const [relativePath, content] of Object.entries(diskFiles)) {
    if (!canRequesterSeePath(visibilityContext, relativePath)) continue

    const nextHash = hashContent(content)
    const current = cloud.files[relativePath]
    const scope = scopeForPath(relativePath)
    cloudPaths.delete(relativePath)

    if (current?.hash === nextHash) continue

    const entry = {
      id: randomUUID(),
      type: current ? 'write' : 'create',
      path: relativePath,
      scope,
      hash: nextHash,
      bytes: Buffer.byteLength(content),
      baseRevision: current?.revision ?? null,
      createdAt: now,
      status: 'pending',
      ...journalContextForCloud(cloud),
    }

    await appendNdjson(options.journal, entry)
    await emit(options, 'write.journaled', entry)

    const acknowledgement = await cloudService.commitJournalEntry(cloud, entry, {
      content,
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
      scope,
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
    hydratedPaths: hydratedPathsAfterSync(indexedCodebase, Object.keys(diskFiles), Object.keys(visibleCloud.files ?? {})),
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
        content: recovery.content,
        now,
      })
      await emit(options, 'cloud.acknowledged', {
        ...acknowledgement,
        recovered: true,
        recoveryReason: recovery.reason,
      })
      result.acknowledged += 1
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
    const diskFiles = await readWorkspaceFiles(options.workspace)
    const hydrationState = workspaceIndexHydrationStateForSync(indexedCodebase)
    const visibleCloud = filterVisibleGraphForRequester(cloud, visibilityRequestFromOptions(options))
    await upsertWorkspaceIndexFromCloud(options, visibleCloud, {
      reason: 'recover',
      lastEvent: 'journal.recovery_complete',
      hydrationState,
      hydratedPaths: hydratedPathsAfterSync(indexedCodebase, Object.keys(diskFiles), Object.keys(visibleCloud.files ?? {})),
      materialization: hydrationState === 'materialized' ? 'managed-folder' : 'partial-managed-folder',
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

  const scheduleSync = createWatchSyncScheduler(options)
  let watcher
  let poller = null
  let remotePuller = null
  const degradeToPolling = async (error) => {
    if (!poller) {
      poller = await createWorkspacePoller(options.workspace, scheduleSync)
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
  let lastEvent = null

  const drain = async () => {
    if (running) return
    running = true

    try {
      while (queued) {
        const coalescedEvents = queuedEvents
        const triggeringEvent = lastEvent
        queued = false
        queuedEvents = 0
        lastEvent = null

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
    } finally {
      running = false
    }
  }

  const schedule = (eventType, filename) => {
    queued = true
    queuedEvents += 1
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
  let previousSnapshot = await snapshotWorkspace(workspace)
  let running = false

  const interval = setInterval(() => {
    if (running) return
    running = true

    snapshotWorkspace(workspace)
      .then((nextSnapshot) => {
        if (nextSnapshot !== previousSnapshot) {
          previousSnapshot = nextSnapshot
          onChange('poll', null)
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

async function snapshotWorkspace(root) {
  const files = []

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue
        await walk(absolutePath)
        continue
      }
      if (!entry.isFile()) continue

      const stat = await fs.stat(absolutePath)
      files.push(`${toCloudPath(path.relative(root, absolutePath))}:${stat.size}:${stat.mtimeMs}`)
    }
  }

  await walk(root)
  files.sort()
  return files.join('\n')
}

async function createRemoteRefreshScheduler(options, schedulerOptions = {}) {
  if (!remotePullEnabled(options)) return null

  const intervalMs = remoteRefreshIntervalMs(options)
  const localSyncIdle = schedulerOptions.localSyncIdle ?? (() => true)
  let closed = false
  let running = false

  await emit(options, 'remote-pull.started', {
    state: 'enabled',
    workspace: options.workspace,
    intervalMs,
    adapter: workspaceMode.adapter,
    cacheMode: workspaceMode.cacheMode,
    safeRefreshOnly: true,
  })

  const run = async (trigger) => {
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
        workspace: options.workspace,
        fromRevision: decision.fromRevision,
        toRevision: decision.toRevision,
        intervalMs,
        safeRefreshOnly: true,
      })
    } catch (error) {
      await emit(options, 'remote-pull.failed', {
        state: 'failed',
        trigger,
        workspace: options.workspace,
        reason: error.message,
      })
    } finally {
      running = false
    }
  }

  const interval = setInterval(() => {
    run('interval').catch((error) => {
      console.error(error)
    })
  }, intervalMs)

  run('startup').catch((error) => {
    console.error(error)
  })

  return {
    close() {
      closed = true
      clearInterval(interval)
    },
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
  if (!(await cloudService.exists())) {
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

  const cloud = await cloudService.readVisibleGraph(visibilityRequestFromOptions(options))
  const eventEntries = await readNdjson(options.events)
  const lastVisibleWorkspaceEvent = findLastEventOf(eventEntries, [
    'workspace.ready',
    'refresh.complete',
    'remote-update',
  ])
  const workspaceIndex = await readWorkspaceIndex(options)
  const indexedCodebase = findIndexedCodebase(workspaceIndex, cloud.codebase?.id ?? options['codebase-id'], options.workspace)
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

  const indexedRevision = indexedCodebase?.hydration?.lastMaterializedRevision
  const visibleRevision = Number.isInteger(indexedRevision)
    ? indexedRevision
    : visibleRevisionFromEvent(lastVisibleWorkspaceEvent)
  if (visibleRevision === cloud.revision) {
    return {
      state: 'skip',
      emit: false,
    }
  }

  return {
    state: 'refresh',
    fromRevision: visibleRevision,
    toRevision: cloud.revision,
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
      const state = await readAgentState(options)

      if (url.pathname === '/' || url.pathname === '/status') {
        sendJson(response, 200, state.status)
        return
      }

      if (url.pathname === '/events') {
        sendJson(response, 200, state.events)
        return
      }

      if (url.pathname === '/journal') {
        sendJson(response, 200, state.journal)
        return
      }

      if (url.pathname === '/cloud') {
        sendJson(response, 200, state.cloud)
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

  try {
    statusServer = await serveStatus(options)
    watchHandle = await watchWorkspace(options)
  } catch (error) {
    watchHandle?.close()
    statusServer?.close()
    throw error
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
  const logHandle = await fs.open(logPath, 'a')
  const childEnv = {
    ...process.env,
  }
  const token = agentTokenFromOptions(options)
  if (token) childEnv.HOPIT_AGENT_TOKEN = token
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
  const timeoutMs = waitOptions.timeoutMs ?? 15000
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
  const running = typeof pid === 'number' && isProcessRunning(pid)
  let agent = null
  let error = null
  let fresh = false

  if (running) {
    let timeout
    try {
      const controller = new AbortController()
      timeout = setTimeout(() => controller.abort(), 1000)
      const response = await fetch(`http://${options.host}:${options.port}/status`, {
        cache: 'no-store',
        signal: controller.signal,
      })
      agent = response.ok ? await response.json() : null
      if (!response.ok) error = `status endpoint returned ${response.status}`
      fresh = agentWatchStartedAfter(agent, record?.startedAt)
      if (agent && !fresh) error = 'status endpoint has not observed this service start yet'
    } catch (statusError) {
      error = statusError instanceof Error ? statusError.message : 'status endpoint unavailable'
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

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
    ['--convex-url', convexUrlFromOptions(options)],
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
  if (options['remote-refresh-interval-ms']) {
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

  const cloud = await createCloudGraphService(demoOptions).readGraph()
  const saved = cloud.files['README.md']?.content.includes('managed workspace folder')
  const privateSaved =
    cloud.files[privatePath]?.scope === fileScope.ownerPrivate &&
    cloud.files[privatePath]?.content.includes('Owner-only demo snapshot.')

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
    if (typeof file.content !== 'string') {
      throw new Error(`Cannot export non-text file content for ${relativePath}.`)
    }
    const absolutePath = workspaceFilePath(output, relativePath)
    await fs.mkdir(path.dirname(absolutePath), { recursive: true })
    await fs.writeFile(absolutePath, file.content, 'utf8')
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
        service: convexUrlFromOptions(options) ? convexCloudServiceType : cloudServiceType,
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
  const allowedActions = new Set(['status', 'list', 'ensure', 'files', 'hydrate-file', 'dehydrate'])
  if (!allowedActions.has(action)) {
    throw new Error(`Unknown workspace action: ${action}`)
  }

  if (action === 'hydrate-file') {
    if (!options.path && !options.file) {
      throw new Error('workspace hydrate-file requires --path <cloud-path>.')
    }
    await hydrateWorkspaceFile(options)
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
      virtualized: false,
      index: workspaceIndexSummary(options, index),
      note: 'HopIt currently uses managed folders under this root, not a FUSE or OS filesystem provider.',
    },
    current,
    codebases: indexedCodebases,
  }

  if (action === 'files') {
    result.files = cloud
      ? Object.entries(cloud.files ?? {}).map(([relativePath, file]) =>
          workspaceFileMetadata(options, relativePath, file),
        )
      : []
    result.summary = {
      visibleFiles: result.files.length,
      hydratedFiles: result.files.filter((file) => file.local.exists).length,
      materialization: current?.materialization ?? 'unknown',
      hydration: current?.hydration ?? null,
    }
  }

  console.log(JSON.stringify(result, null, 2))
}

function workspaceCodebaseSummary(options, state) {
  const status = state.status
  const codebaseId = status.codebaseId ?? options['codebase-id'] ?? path.basename(path.resolve(options.workspace))

  return {
    id: codebaseId,
    name: status.codebaseName ?? codebaseId,
    initialized: status.readiness === 'ready',
    workspace: status.workspace,
    cloud: {
      path: status.cloud.path,
      service: status.cloud.service,
      exists: status.cloud.exists,
    },
    activeChangeSetId: status.activeChangeSetId,
    mainId: status.mainId,
    visibleFileCount: status.visibleFileCount,
    hiddenFileCount: status.hiddenFileCount,
    materialization: 'managed-folder',
    hydration: status.workspace.hydration,
    localChanges: status.workspace.localChanges,
    contentManifest: status.workspace.contentManifest,
    remoteCursor: status.remotePull.cursor,
    virtualized: false,
  }
}

function workspaceFileMetadata(options, relativePath, file, forceExists = false) {
  const absolutePath = workspaceFilePath(options.workspace, relativePath)
  const exists = forceExists || existsSync(absolutePath)
  return {
    path: relativePath,
    scope: file.scope ?? scopeForPath(relativePath),
    revision: file.revision ?? null,
    size: file.size ?? (typeof file.content === 'string' ? Buffer.byteLength(file.content) : null),
    hash: file.hash ?? (typeof file.content === 'string' ? hashContent(file.content) : null),
    local: {
      path: absolutePath,
      exists,
      hydrated: exists,
    },
  }
}

async function writeWorkspaceMetadataManifest(options, cloud, detail = {}) {
  await fs.mkdir(path.join(options.workspace, '.hopit'), { recursive: true })
  const files = Object.entries(cloud.files ?? {}).map(([relativePath, file]) => ({
    path: relativePath,
    scope: file.scope ?? scopeForPath(relativePath),
    revision: file.revision ?? null,
    size: file.size ?? null,
    hash: file.hash ?? null,
  }))
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
        serviceTokenConfigured: Boolean(agentTokenFromOptions(options)),
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
  if (!(cloudService instanceof ConvexCloudGraphService)) {
    throw new Error(`Session ${action} requires Convex. Configure --convex-url or HOPIT_CONVEX_URL.`)
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
    byId.set(key, {
      ...(byId.get(key) ?? {}),
      ...current,
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
      service: convexUrlFromOptions(options) ? convexCloudServiceType : cloudServiceType,
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
    const content = typeof file.content === 'string' ? file.content : ''
    files[relativePath] = {
      hash: typeof file.hash === 'string' ? file.hash : hashContent(content),
      size: Number.isInteger(file.size) ? file.size : Buffer.byteLength(content),
      scope: file.scope ?? scopeForPath(relativePath),
      revision: Number.isInteger(file.revision) ? file.revision : null,
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
    const content = diskFiles[relativePath]
    files[relativePath] = {
      hash: hashContent(content),
      size: Buffer.byteLength(content),
      scope: scopeForPath(relativePath),
      revision: null,
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

  const disk = await contentManifestFromWorkspace(options.workspace)
  const diff = diffContentManifests(baseline, disk)
  const dirty = diff.addedPaths.length > 0 || diff.modifiedPaths.length > 0 || diff.deletedPaths.length > 0

  return {
    safe: !dirty,
    state: dirty ? 'dirty' : 'clean',
    reason: dirty ? 'workspace_has_unjournaled_changes' : null,
    addedCount: diff.addedPaths.length,
    modifiedCount: diff.modifiedPaths.length,
    deletedCount: diff.deletedPaths.length,
    samplePaths: [...diff.addedPaths, ...diff.modifiedPaths, ...diff.deletedPaths].slice(0, 10),
  }
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
    if (expected.hash !== actual.hash || expected.size !== actual.size || expected.scope !== actual.scope) {
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
HOPIT_CONVEX_URL=${convexUrlFromOptions(options) ?? 'https://your-convex-deployment.convex.cloud'}
HOPIT_AGENT_STATE_ROOT=${JSON.stringify(path.resolve(agentStateRootFromOptions(options)))}
HOPIT_WORKSPACE_ROOT=${JSON.stringify(path.resolve(workspaceRootFromOptions(options)))}
HOPIT_WORKSPACE_INDEX=${JSON.stringify(path.resolve(workspaceIndexPath(options)))}
HOPIT_SESSION_ID=${options['session-id'] ?? `session_${codebaseId}_${os.hostname().replace(/[^a-zA-Z0-9]+/g, '_')}`}
HOPIT_DEVICE_NAME=${JSON.stringify(options['device-name'] ?? os.hostname() ?? 'local-device')}
HOPIT_AGENT_SESSION_TOKEN=replace-with-hop-device-register-token
HOPIT_REMOTE_PULL=1
HOPIT_REMOTE_REFRESH_INTERVAL_MS=${options['remote-refresh-interval-ms'] ?? '5000'}
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
    '--remote-pull',
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
  remotePullHealth.cursor = buildRemoteCursor({
    cloudSummary,
    eventsSummary,
    hydration,
  })
  const initialized = Boolean(cloud) && (hydration.state === 'materialized' || hydration.state === 'partial')

  return {
    status: {
      ok:
        initialized &&
        localChanges.safe &&
        failedJournalEntries.length === 0 &&
        syncHealth.state !== 'failed' &&
        refreshHealth.state !== 'blocked' &&
        !watchHealth.state.endsWith('degraded') &&
        watchHealth.state !== 'blocked',
      generatedAt: new Date().toISOString(),
      readiness: initialized ? 'ready' : 'not_initialized',
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
        hydration,
        localChanges,
        contentManifest: contentManifestSummary(indexedCodebase?.contentManifest),
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

  if (entry.type === 'delete') {
    if (!cloudFile) return { reason: 'cloud_already_deleted' }
    return { reason: 'cloud_delete_replayed' }
  }

  if (entry.type !== 'create' && entry.type !== 'write') {
    throw new Error(`unsupported journal entry type: ${entry.type}`)
  }

  if (cloudFile?.hash === entry.hash && cloudFile.scope === scope) {
    return { content: cloudFile.content, reason: 'cloud_already_matches' }
  }

  if (!existsSync(workspace)) {
    throw new Error('workspace_missing')
  }

  const absolutePath = workspaceFilePath(workspace, entry.path)
  if (!existsSync(absolutePath)) {
    throw new Error('workspace_file_missing')
  }

  const content = await fs.readFile(absolutePath, 'utf8')
  const hash = hashContent(content)
  if (hash !== entry.hash) {
    throw new Error(`workspace_hash_mismatch: expected ${entry.hash}, got ${hash}`)
  }

  return { content, reason: 'workspace_replayed' }
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
      scope,
      revision: cloud.revision,
      selectedStateType: cloud.selectedState?.type ?? null,
      selectedStateId: cloud.selectedState?.id ?? null,
      selectedStateRevision: cloud.selectedState?.revision ?? null,
    }
  }

  const content = options.content
  if (typeof content !== 'string') {
    throw new Error(`Cannot apply ${entry.type} without file content.`)
  }

  const hash = hashContent(content)
  if (entry.hash && hash !== entry.hash) {
    throw new Error(`content_hash_mismatch: expected ${entry.hash}, got ${hash}`)
  }

  const current = cloud.files[entry.path]
  if (current?.hash !== hash || current.scope !== scope) {
    cloud.revision += 1
    cloud.files[entry.path] = {
      content,
      hash,
      size: Buffer.byteLength(content),
      scope,
      revision: cloud.revision,
      updatedAt: now,
    }
    if (cloud.selectedState) cloud.selectedState.revision = cloud.revision
  }

  return {
    id: entry.id,
    type: entry.type,
    path: entry.path,
    scope,
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
  const latestProblem = latestEvent([
    remotePullEvents.lastRemotePullSkipped,
    remotePullEvents.lastRemotePullFailed,
  ])
  let state = enabled ? 'enabled' : 'disabled'

  if (enabled && remotePullEvents.latestRemotePullEvent?.event === 'remote-pull.failed') {
    state = 'failed'
  } else if (enabled && remotePullEvents.latestRemotePullEvent?.event === 'remote-pull.skipped') {
    state = 'skipped'
  }

  return {
    enabled,
    state,
    intervalMs: enabled ? remoteRefreshIntervalMs(options) : null,
    safeRefreshOnly: enabled,
    lastStarted: remotePullEvents.lastRemotePullStarted,
    lastApplied: remotePullEvents.lastRemotePullApplied,
    lastSkipped: remotePullEvents.lastRemotePullSkipped,
    lastFailed: remotePullEvents.lastRemotePullFailed,
    latestEvent: remotePullEvents.latestRemotePullEvent,
    lastError: latestProblem?.detail?.reason ?? null,
  }
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
  if (convexUrlFromOptions(options)) {
    return codebaseId ? `convex:${codebaseId}` : `convex:${convexUrlFromOptions(options)}`
  }
  return path.resolve(options.cloud)
}

function remotePullEnabled(options) {
  return Boolean(options['remote-pull'] || options['auto-refresh'])
}

function remoteRefreshIntervalMs(options) {
  const rawValue = options['remote-refresh-interval-ms'] ?? '5000'
  const value = Number(rawValue)
  if (!Number.isInteger(value) || value < 100) {
    throw new Error(`Invalid --remote-refresh-interval-ms value: ${rawValue}`)
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

async function readWorkspaceFiles(root) {
  const result = {}
  if (!existsSync(root)) return result

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name)
      const relativePath = toCloudPath(path.relative(root, absolutePath))
      if (shouldSkipWorkspacePath(relativePath, entry)) continue

      if (entry.isDirectory()) {
        await walk(absolutePath)
        continue
      }
      if (!entry.isFile()) continue

      result[relativePath] = await fs.readFile(absolutePath, 'utf8')
    }
  }

  await walk(root)
  return result
}

function shouldSkipWorkspacePath(relativePath, entry) {
  const parts = relativePath.split('/')
  if (parts.includes('.hopit')) return true
  if (entry.isDirectory() && entry.name === '.git') return true
  return false
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

function createCloudGraphService(options) {
  if (convexUrlFromOptions(options)) {
    return new ConvexCloudGraphService(options)
  }

  if (options.profile === 'production' && !options['allow-local-cloud']) {
    throw new Error('Production profile requires --convex-url or HOPIT_CONVEX_URL. Use --allow-local-cloud only for local dry runs.')
  }

  return new FixtureJsonCloudGraphService(options.cloud)
}

class FixtureJsonCloudGraphService {
  constructor(cloudPath) {
    this.path = cloudPath
    this.type = cloudServiceType
    this.location = path.resolve(cloudPath)
    this.usesAtomicFileMutations = false
  }

  async exists() {
    return existsSync(this.path)
  }

  async initialize(fixture) {
    const cloud = withComputedMetadata(fixture)
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

  async writeGraph(cloud) {
    await writeJson(this.path, normalizeValidatedCloudGraph(cloud))
  }

  applyJournalEntry(cloud, entry, options = {}) {
    return applyJournalEntryToCloud(cloud, entry, options)
  }

  async commitJournalEntry(cloud, entry, options = {}) {
    const acknowledgement = this.applyJournalEntry(cloud, entry, options)
    await this.writeGraph(cloud)
    return acknowledgement
  }
}

class ConvexCloudGraphService {
  constructor(options) {
    this.url = convexUrlFromOptions(options)
    this.token = agentTokenFromOptions(options)
    this.sessionToken = agentSessionTokenFromOptions(options)
    this.preferSessionToken = preferSessionTokenFromOptions(options)
    this.codebaseId = options['codebase-id'] || process.env.HOPIT_CODEBASE_ID || null
    this.type = convexCloudServiceType
    this.location = this.codebaseId ? `convex:${this.codebaseId}` : `convex:${this.url}`
    this.client = new ConvexHttpClient(this.url, { logger: false })
    this.usesAtomicFileMutations = true
  }

  async exists() {
    return Boolean(await this.readOptionalGraph())
  }

  async initialize(fixture) {
    const cloud = withComputedMetadata(fixture)
    this.codebaseId = cloud.codebase.id
    this.location = `convex:${this.codebaseId}`
    await this.writeGraph(cloud)
    return cloud
  }

  async readGraph() {
    const graph = await this.readOptionalGraph()
    if (!graph) {
      throw new Error(`Convex graph not found for codebase ${this.codebaseId ?? '(unset)'}.`)
    }
    return graph
  }

  async readVisibleGraph(request = {}) {
    return filterVisibleGraphForRequester(await this.readGraph(), request)
  }

  async readOptionalGraph() {
    if (!this.codebaseId) return null

    const args = { codebaseId: this.codebaseId }
    Object.assign(args, this.credentialArgs())

    const graph = await this.client.query(anyApi.agent.getGraph, args)
    return graph ? normalizeValidatedCloudGraph(graph) : null
  }

  async readOptionalVisibleGraph(request = {}) {
    const graph = await this.readOptionalGraph()
    if (!graph) return null
    return filterVisibleGraphForRequester(graph, request)
  }

  async writeGraph(cloud) {
    const normalized = normalizeValidatedCloudGraph(cloud)
    this.codebaseId = normalized.codebase.id
    this.location = `convex:${this.codebaseId}`
    const args = { graph: normalized }
    Object.assign(args, this.credentialArgs())

    await this.client.mutation(anyApi.agent.saveGraph, args)
  }

  applyJournalEntry(cloud, entry, options = {}) {
    return applyJournalEntryToCloud(cloud, entry, options)
  }

  async commitJournalEntry(cloud, entry, options = {}) {
    const args = {
      codebaseId: cloud.codebase.id,
      type: entry.type,
      path: entry.path,
      baseRevision: Object.hasOwn(entry, 'baseRevision') ? entry.baseRevision : undefined,
      targetStateRevision: Object.hasOwn(entry, 'targetStateRevision') ? entry.targetStateRevision : undefined,
    }
    if (entry.hash) args.hash = entry.hash
    if (Number.isInteger(entry.bytes)) args.size = entry.bytes
    if (typeof options.content === 'string') args.content = options.content
    Object.assign(args, this.credentialArgs())

    let remoteAcknowledgement
    try {
      remoteAcknowledgement = await this.client.mutation(anyApi.agent.applyFileMutation, args)
    } catch (error) {
      if (!isMissingConvexFunctionError(error)) throw error

      const legacyAcknowledgement = this.applyJournalEntry(cloud, entry, options)
      await this.writeGraph(cloud)
      return {
        ...legacyAcknowledgement,
        storageMode: 'legacy-save-graph-fallback',
      }
    }

    const localAcknowledgement = this.applyJournalEntry(cloud, entry, options)
    return {
      ...localAcknowledgement,
      ...remoteAcknowledgement,
      storageMode: 'per-file-mutation',
    }
  }

  async registerAgentSession(options = {}) {
    const args = {
      codebaseId: requireConvexCodebaseId(this.codebaseId),
      deviceName: options.deviceName,
      capabilities: options.capabilities,
    }
    if (options.sessionId) args.sessionId = options.sessionId
    if (options.expiresAt) args.expiresAt = options.expiresAt
    Object.assign(args, this.credentialArgs())

    return await this.client.mutation(anyApi.agent.registerAgentSession, args)
  }

  async listAgentSessions(options = {}) {
    const args = { codebaseId: requireConvexCodebaseId(this.codebaseId) }
    if (options.status) args.status = options.status
    Object.assign(args, this.credentialArgs())

    return await this.client.query(anyApi.agent.listAgentSessions, args)
  }

  async touchAgentSession(options = {}) {
    const args = {
      sessionId: options.sessionId,
    }
    Object.assign(args, this.credentialArgs())

    return await this.client.mutation(anyApi.agent.touchAgentSession, args)
  }

  async revokeAgentSession(options = {}) {
    const args = {
      sessionId: options.sessionId,
    }
    Object.assign(args, this.credentialArgs())

    return await this.client.mutation(anyApi.agent.revokeAgentSession, args)
  }

  credentialArgs() {
    return convexCredentialArgs({
      token: this.token,
      sessionToken: this.sessionToken,
      preferSessionToken: this.preferSessionToken,
    })
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
    file.hash = hashContent(file.content)
    file.size = Buffer.byteLength(file.content)
    file.scope = scopeForPath(relativePath)
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
    if (typeof file?.content !== 'string') errors.push(`${relativePath}.content must be a string.`)
    if (file?.scope !== scopeForPath(relativePath)) {
      errors.push(`${relativePath}.scope must be ${scopeForPath(relativePath)}.`)
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
    file.scope = scopeForPath(relativePath)
  }
}

function scopeForPath(relativePath) {
  return relativePath === '.private' || relativePath.startsWith('.private/')
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
  await appendConvexEvent(options, payload)
  console.log(`${event} ${JSON.stringify(detail)}`)
}

async function appendConvexEvent(options, payload) {
  const url = convexUrlFromOptions(options)
  if (!url) return

  const codebaseId = codebaseIdFromEvent(options, payload.detail)
  if (!codebaseId) return

  try {
    const client = new ConvexHttpClient(url, { logger: false })
    const args = {
      codebaseId,
      event: payload.event,
      detail: payload.detail,
      at: payload.at,
      source: 'local-agent',
    }
    Object.assign(args, convexCredentialArgsFromOptions(options))

    await client.mutation(anyApi.agent.appendEvent, args)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Convex event error'
    console.error(`convex.event_failed ${JSON.stringify({ event: payload.event, reason: message })}`)
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

function convexUrlFromOptions(options) {
  return options['convex-url'] ?? process.env.HOPIT_CONVEX_URL ?? process.env.CONVEX_URL ?? null
}

function agentTokenFromOptions(options) {
  return options['agent-token'] ?? process.env.HOPIT_AGENT_TOKEN ?? null
}

function agentSessionTokenFromOptions(options) {
  return options['session-token'] ?? process.env.HOPIT_AGENT_SESSION_TOKEN ?? null
}

function preferSessionTokenFromOptions(options) {
  return Boolean(agentSessionTokenFromOptions(options) && !options._provided?.has('agent-token'))
}

function convexCredentialArgsFromOptions(options) {
  return convexCredentialArgs({
    token: agentTokenFromOptions(options),
    sessionToken: agentSessionTokenFromOptions(options),
    preferSessionToken: preferSessionTokenFromOptions(options),
  })
}

function convexCredentialArgs({ token, sessionToken, preferSessionToken }) {
  if (preferSessionToken && sessionToken) return { sessionToken }
  if (token) return { token }
  if (sessionToken) return { sessionToken }
  return {}
}

function sessionCapabilitiesFromOptions(options) {
  const raw = options.capabilities ?? process.env.HOPIT_AGENT_SESSION_CAPABILITIES
  if (!raw) return ['read', 'write', 'sync', 'watch']
  return String(raw)
    .split(',')
    .map((capability) => capability.trim())
    .filter(Boolean)
}

function requireConvexCodebaseId(codebaseId) {
  if (!codebaseId) {
    throw new Error('Convex session commands require --codebase-id or HOPIT_CODEBASE_ID.')
  }
  return codebaseId
}

function isMissingConvexFunctionError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /applyFileMutation|not found|Could not find public function|No function/i.test(message)
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
  hydrate     Materialize cloud files into the managed workspace
  refresh     Update the managed workspace from cloud when the journal is safe
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
  workspace   Manage/list the configured HopIt workspace root and codebase
  session     Manage this device/session registration (alias: device)
  service     Manage the local agent service: start, stop, restart, status, run
  watch       Hydrate and watch the workspace for edits
  status      Print read-only local agent status JSON
  serve       Serve read-only local agent status JSON over HTTP
  demo        Run init, hydrate, edit, sync, and verify

Compatibility aliases:
  import-local, sync-once, review-open, status-server, workspaces, device, devices, sessions

Options:
  --source <path>     Source folder for import
  --output <path>     Output folder for Git export/publish
  --path <cloud-path> Cloud file path for workspace hydrate-file
  --codebase-id <id>  Codebase id for import
  --codebase-name <name> Codebase display name for import
  --profile <name>    development or production path profile
  --state-root <path> Agent state root for production profile
  --workspace-root <path> Root that contains managed HopIt codebase folders
  --workspace-index <path> Optional workspace root index path
  --cloud <path>      Cloud graph JSON path
  --convex-url <url>  Convex deployment URL for the real cloud graph
  --agent-token <token> Agent token for Convex mutations/queries
  --session-token <token> Per-device Convex session token
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
  --remote-pull        Opt into safe background cloud refresh in watch/service mode
  --remote-refresh-interval-ms <ms> Background refresh interval, default 5000
  --start-service      install: start the production service after preparing paths
  --write-env          install: write hopit.env.example under the agent state root
  --launch-agent       install: write a macOS LaunchAgent for start-on-login
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

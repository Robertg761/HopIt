#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, watch } from 'node:fs'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const fixturePath = path.resolve(__dirname, '../fixtures/demo-cloud.json')

const defaultOptions = {
  cloud: '.hopit-agent/cloud.json',
  workspace: '.hopit-agent/workspaces/hopit-core',
  journal: '.hopit-agent/journal.ndjson',
  events: '.hopit-agent/events.ndjson',
  host: '127.0.0.1',
  port: '4785',
}

const workspaceMode = {
  adapter: 'managed-folder',
  cacheMode: 'local-cache',
  sourceOfTruth: 'cloud',
}

const cloudServiceType = 'fixture-json-cloud-graph'

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
  const [command = 'help', ...args] = process.argv.slice(2)
  const options = parseOptions(args)

  if (command === 'init') {
    await initCloud(options)
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

function parseOptions(args) {
  const options = { ...defaultOptions }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg.startsWith('--')) continue

    const key = arg.slice(2)
    if (key === 'force') {
      options.force = true
      continue
    }

    const value = args[i + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`)
    }
    options[key] = value
    i += 1
  }

  return options
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

async function hydrateWorkspace(options) {
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readVisibleGraph(visibilityRequestFromOptions(options))
  const requester = summarizeRequester(cloud.visibilityContext)
  await fs.mkdir(options.workspace, { recursive: true })

  for (const [relativePath, file] of Object.entries(cloud.files)) {
    const scope = scopeForPath(relativePath)
    const absolutePath = path.join(options.workspace, relativePath)
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
}

async function refreshWorkspace(options) {
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
    const absolutePath = path.join(options.workspace, relativePath)
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

    await fs.rm(path.join(options.workspace, relativePath), { force: true })
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
  const cloudPaths = new Set(Object.keys(cloud.files))
  const writeEvents = []
  const now = new Date().toISOString()

  for (const [relativePath, content] of Object.entries(diskFiles)) {
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

    const acknowledgement = cloudService.applyJournalEntry(cloud, entry, {
      content,
      now,
    })
    await cloudService.writeGraph(cloud)
    await emit(options, 'cloud.acknowledged', acknowledgement)

    writeEvents.push(entry)
  }

  for (const relativePath of cloudPaths) {
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

    const acknowledgement = cloudService.applyJournalEntry(cloud, entry, { now })
    await cloudService.writeGraph(cloud)
    await emit(options, 'cloud.acknowledged', acknowledgement)

    writeEvents.push(entry)
  }

  await cloudService.writeGraph(cloud)
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
      const acknowledgement = cloudService.applyJournalEntry(cloud, entry, {
        content: recovery.content,
        now,
      })
      await cloudService.writeGraph(cloud)
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

  console.log(`HopIt agent watching ${options.workspace}`)
  console.log('Press Ctrl+C to stop.')
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

  return (eventType, filename) => {
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
  const lastRemoteUpdate = findLastEvent(eventEntries, 'remote-update')
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

  const cloudSummary = {
    path: path.resolve(options.cloud),
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
    lastRefreshStarted,
    lastRefreshBlocked,
    lastRefreshComplete,
    lastRemoteUpdate,
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

  return {
    status: {
      ok:
        failedJournalEntries.length === 0 &&
        syncHealth.state !== 'failed' &&
        refreshHealth.state !== 'blocked' &&
        !watchHealth.state.endsWith('degraded') &&
        watchHealth.state !== 'blocked',
      generatedAt: new Date().toISOString(),
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
        path: path.resolve(options.workspace),
        exists: existsSync(options.workspace),
        adapter: workspaceMode.adapter,
        cacheMode: workspaceMode.cacheMode,
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
        lastRefreshStarted,
        lastRefreshBlocked,
        lastRefreshComplete,
        lastRemoteUpdate,
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

  const absolutePath = path.join(workspace, entry.path)
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

async function readWorkspaceFiles(root) {
  const result = {}

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(absolutePath)
        continue
      }
      if (!entry.isFile()) continue

      const relativePath = toCloudPath(path.relative(root, absolutePath))
      result[relativePath] = await fs.readFile(absolutePath, 'utf8')
    }
  }

  await walk(root)
  return result
}

function createCloudGraphService(options) {
  return new FixtureJsonCloudGraphService(options.cloud)
}

class FixtureJsonCloudGraphService {
  constructor(cloudPath) {
    this.path = cloudPath
    this.type = cloudServiceType
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
    return normalizeCloudGraph(await readJson(this.path))
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
    await writeJson(this.path, normalizeCloudGraph(cloud))
  }

  applyJournalEntry(cloud, entry, options = {}) {
    return applyJournalEntryToCloud(cloud, entry, options)
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
  return next
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
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
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
  console.log(`${event} ${JSON.stringify(detail)}`)
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
  console.log(`HopIt agent spike

Commands:
  init        Seed a local cloud file graph
  hydrate     Materialize cloud files into the managed workspace
  refresh     Update the managed workspace from cloud when the journal is safe
  sync-once   Scan managed-folder writes, journal them, and acknowledge to cloud
  recover     Replay unacknowledged journal entries into the cloud graph
  review-open Open the selected active change set for review
  merge       Merge the reviewed selected change set into Main
  watch       Hydrate and watch the workspace for edits
  status      Print read-only local agent status JSON
  status-server Serve read-only local agent status JSON over HTTP
  demo        Run init, hydrate, edit, sync, and verify

Options:
  --cloud <path>      Cloud graph JSON path
  --workspace <path>  Managed workspace folder path
  --journal <path>    Pending write journal path
  --events <path>     Event log path
  --requester-id <id> Requester identity for visibility-filtered reads
  --session-id <id>   Requester session id for visibility-filtered reads
  --host <host>        Status server host, defaults to 127.0.0.1
  --port <port>        Status server port, defaults to 4785
  --force             Overwrite the cloud graph on init
`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

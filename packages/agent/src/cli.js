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

const fileScope = {
  shared: 'shared',
  ownerPrivate: 'owner-private',
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

  if (command === 'sync-once') {
    await syncOnce(options)
    return
  }

  if (command === 'recover') {
    const recovery = await recoverJournal(options)
    if (recovery.failed > 0) process.exitCode = 1
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
  if (existsSync(options.cloud) && !options.force) {
    await emit(options, 'cloud.exists', { cloud: options.cloud })
    return
  }

  const fixture = await readJson(fixturePath)
  const cloud = withComputedMetadata(fixture)
  await writeJson(options.cloud, cloud)
  await emit(options, 'cloud.initialized', {
    cloud: options.cloud,
    files: Object.keys(fixture.files).length,
    scopeCounts: countCloudScopes(cloud),
  })
}

async function hydrateWorkspace(options) {
  const cloud = await readJson(options.cloud)
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
    adapter: workspaceMode.adapter,
    cacheMode: workspaceMode.cacheMode,
    scopeCounts: countCloudScopes(cloud),
  })
}

async function syncOnce(options) {
  const cloud = await readJson(options.cloud)
  normalizeCloudScopes(cloud)
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
      createdAt: now,
      status: 'pending',
    }

    await appendNdjson(options.journal, entry)
    await emit(options, 'write.journaled', entry)

    const acknowledgement = applyJournalEntryToCloud(cloud, entry, {
      content,
      now,
    })
    await writeJson(options.cloud, cloud)
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
      createdAt: now,
      status: 'pending',
    }

    await appendNdjson(options.journal, entry)
    await emit(options, 'write.journaled', entry)

    const acknowledgement = applyJournalEntryToCloud(cloud, entry, { now })
    await writeJson(options.cloud, cloud)
    await emit(options, 'cloud.acknowledged', acknowledgement)

    writeEvents.push(entry)
  }

  await writeJson(options.cloud, cloud)
  await emit(options, 'sync.complete', {
    writes: writeEvents.length,
    revision: cloud.revision,
    scopeCounts: countCloudScopes(cloud),
    journaledScopeCounts: countEntryScopes(writeEvents),
  })
}

async function recoverJournal(options) {
  const cloud = await readJson(options.cloud)
  normalizeCloudScopes(cloud)

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
      const acknowledgement = applyJournalEntryToCloud(cloud, entry, {
        content: recovery.content,
        now,
      })
      await writeJson(options.cloud, cloud)
      await emit(options, 'cloud.acknowledged', {
        ...acknowledgement,
        recovered: true,
        recoveryReason: recovery.reason,
      })
      result.acknowledged += 1
    } catch (error) {
      result.failed += 1
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
    scopeCounts: countCloudScopes(cloud),
  })

  return result
}

async function watchWorkspace(options) {
  if (!existsSync(options.cloud)) await initCloud(options)
  const recovery = await recoverJournal(options)
  if (recovery.failed > 0) {
    await emit(options, 'watch.recovery_blocked', {
      failed: recovery.failed,
      attempted: recovery.attempted,
    })
    throw new Error('Watch startup blocked because pending journal entries could not be recovered.')
  }
  await hydrateWorkspace(options)
  await emit(options, 'watch.started', {
    workspace: options.workspace,
    adapter: workspaceMode.adapter,
    cacheMode: workspaceMode.cacheMode,
  })

  let timer
  const scheduleSync = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      syncOnce(options).catch((error) => {
        console.error(error)
      })
    }, 250)
  }

  watch(options.workspace, { recursive: true }, scheduleSync)
  console.log(`HopIt agent watching ${options.workspace}`)
  console.log('Press Ctrl+C to stop.')
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

  const cloud = await readJson(demoOptions.cloud)
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
  const cloud = await readOptionalJson(options.cloud)
  const journalEntries = await readNdjson(options.journal)
  const eventEntries = await readNdjson(options.events)
  const journalState = classifyJournalEntries(journalEntries, eventEntries)
  const recentEvents = eventEntries.slice(-20)
  const lastAcknowledgement = findLastEvent(eventEntries, 'cloud.acknowledged')
  const lastSync = findLastEvent(eventEntries, 'sync.complete')
  const lastRecovery = findLastEvent(eventEntries, 'journal.recovery_complete')
  const cloudFiles = cloud?.files ? Object.keys(cloud.files) : []
  const scopeCounts = countCloudScopes(cloud)
  const pendingJournalEntries = journalState.entries.filter((entry) => entry.recoveryStatus === 'pending')
  const failedJournalEntries = journalState.entries.filter((entry) => entry.recoveryStatus === 'failed')
  const acknowledgedJournalEntries = journalState.entries.filter(
    (entry) => entry.recoveryStatus === 'acknowledged',
  )

  const cloudSummary = {
    path: path.resolve(options.cloud),
    exists: Boolean(cloud),
    codebase: cloud?.codebase
      ? {
          id: cloud.codebase.id ?? null,
          name: cloud.codebase.name ?? null,
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
    lastRecovery,
  }

  return {
    status: {
      ok: failedJournalEntries.length === 0,
      generatedAt: new Date().toISOString(),
      mode: workspaceMode,
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
      events: {
        path: eventsSummary.path,
        exists: eventsSummary.exists,
        totalEntries: eventsSummary.totalEntries,
        recent: eventsSummary.recent,
        lastAcknowledgement,
        lastSync,
        lastRecovery,
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

  if (entry.type === 'delete') {
    const current = cloud.files[entry.path]
    if (current) {
      cloud.revision += 1
      delete cloud.files[entry.path]
    }

    return {
      id: entry.id,
      type: entry.type,
      path: entry.path,
      scope,
      revision: cloud.revision,
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
  }

  return {
    id: entry.id,
    type: entry.type,
    path: entry.path,
    scope,
    revision: cloud.revision,
  }
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

function withComputedMetadata(cloud) {
  const next = structuredClone(cloud)
  for (const [relativePath, file] of Object.entries(next.files)) {
    file.hash = hashContent(file.content)
    file.size = Buffer.byteLength(file.content)
    file.scope = scopeForPath(relativePath)
  }
  return next
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

async function readOptionalJson(filePath) {
  if (!existsSync(filePath)) return null
  return readJson(filePath)
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
  sync-once   Scan managed-folder writes, journal them, and acknowledge to cloud
  recover     Replay unacknowledged journal entries into the cloud graph
  watch       Hydrate and watch the workspace for edits
  status      Print read-only local agent status JSON
  status-server Serve read-only local agent status JSON over HTTP
  demo        Run init, hydrate, edit, sync, and verify

Options:
  --cloud <path>      Cloud graph JSON path
  --workspace <path>  Managed workspace folder path
  --journal <path>    Pending write journal path
  --events <path>     Event log path
  --host <host>        Status server host, defaults to 127.0.0.1
  --port <port>        Status server port, defaults to 4785
  --force             Overwrite the cloud graph on init
`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

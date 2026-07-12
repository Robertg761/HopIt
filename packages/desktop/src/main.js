// @ts-check
// HopIt desktop — a thin windowed shell over the local `hop` agent.
//
// It reads state from the agent's loopback status/events endpoints and performs
// every side effect by spawning the installed `hop` CLI. It contains no agent
// logic of its own. The window is the product (a GitHub-Desktop-style view of
// your synced projects); the tray is a minimal always-available handle.

import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell, screen } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { deriveServicePort, eventsUrlForCodebase, statusUrlForCodebase } from './lib/ports.js'
import { defaultAgentStateRoot, defaultWorkspaceRoot, resolveHopBinary, assertSafeAbsolutePath, assertPathWithin } from './lib/paths.js'
import { readProjects } from './lib/projects.js'
import { fetchStatus, fetchEvents } from './lib/status-client.js'
import { deriveViewModel } from './lib/state.js'
import { renderTrayIconPng } from './lib/icon.js'
import { formatActivity } from './lib/activity.js'
import { deriveHistory } from './lib/history.js'
import { buildDirectoryListing } from './lib/file-tree.js'
import { inspectFolder } from './lib/add-inspect.js'
import {
  streamHop,
  syncArgs,
  refreshArgs,
  serviceArgs,
  addArgs,
  hydratePathArgs,
  pinArgs,
} from './lib/hop.js'
import { loadWindowState, saveWindowState, resolveInitialBounds } from './lib/window-state.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DASHBOARD_URL = 'https://hopit.dev'
const POLL_INTERVAL_MS = 5000
const SMOKE = process.env.HOPIT_DESKTOP_SMOKE === '1'
const NO_WINDOW = process.argv.includes('--no-window')

/** Merge a few path-relevant keys from the hop env file so discovery matches the CLI. */
function envForPaths() {
  const env = { ...process.env }
  const candidate = process.env.HOPIT_ENV_FILE || path.join(os.homedir(), '.config', 'hopit', 'production.env')
  try {
    const text = fs.readFileSync(candidate, 'utf8')
    for (const line of text.split('\n')) {
      const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (!match) continue
      const key = match[1]
      if (key !== 'HOPIT_AGENT_STATE_ROOT' && key !== 'HOPIT_WORKSPACE_ROOT') continue
      if (env[key]) continue // real env always wins
      let value = match[2].trim().replace(/^["']|["']$/g, '')
      value = value.replace(/^\$HOME/, os.homedir()).replace(/^~(?=\/)/, os.homedir())
      env[key] = value
    }
  } catch {
    // no env file — defaults are correct for the standard install
  }
  return env
}

const runtimeEnv = envForPaths()
const stateRoot = defaultAgentStateRoot(runtimeEnv)
const workspaceRootFallback = defaultWorkspaceRoot(runtimeEnv)
const hopBinary = resolveHopBinary({ env: runtimeEnv })

/** @type {BrowserWindow|null} */
let mainWindow = null
/** @type {Tray|null} */
let tray = null
let pollTimer = null
let isQuitting = false

/** Last derived view model, served to the renderer on demand. */
let lastView = { trayState: 'service-stopped', label: { glyph: '□', text: 'Service stopped' }, projects: [] }
let lastWorkspaceRoot = workspaceRootFallback
/** Cache of the most recent raw status per codebase (for the Files/Now tabs). */
const statusCache = new Map()
const eventsCache = new Map()

// ---------------------------------------------------------------------------
// Window + tray
// ---------------------------------------------------------------------------

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
    return mainWindow
  }
  const workArea = screen.getPrimaryDisplay().workArea
  const bounds = resolveInitialBounds(loadWindowState(app.getPath('userData')), workArea)

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'HopIt',
    backgroundColor: '#1a1b1e',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  if (!NO_WINDOW) {
    mainWindow.once('ready-to-show', () => mainWindow?.show())
  }

  const persist = () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized()) {
      saveWindowState(app.getPath('userData'), mainWindow.getBounds())
    }
  }
  mainWindow.on('resize', persist)
  mainWindow.on('move', persist)

  // Closing the window keeps the app alive in the tray (unless really quitting).
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      persist()
      mainWindow?.hide()
      if (process.platform === 'darwin') app.dock?.hide()
    }
  })

  // Block any attempt to navigate to remote content; the dashboard opens
  // externally. The renderer only ever loads its local file.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url)
    return { action: 'deny' }
  })

  return mainWindow
}

function showWindow() {
  if (process.platform === 'darwin') app.dock?.show()
  createWindow()
  mainWindow?.show()
  mainWindow?.focus()
}

function trayIcon(trayState) {
  const image = nativeImage.createFromBuffer(renderTrayIconPng(trayState, { size: 22 }))
  const image2x = nativeImage.createFromBuffer(renderTrayIconPng(trayState, { size: 44 }))
  image.addRepresentation({ scaleFactor: 2, buffer: renderTrayIconPng(trayState, { size: 44 }) })
  void image2x
  return image
}

function updateTray() {
  if (!tray) return
  tray.setImage(trayIcon(lastView.trayState))
  tray.setToolTip(`HopIt — ${lastView.label.text}`)
  const menu = Menu.buildFromTemplate([
    { label: `HopIt — ${lastView.label.text}`, enabled: false },
    { type: 'separator' },
    { label: 'Open HopIt', click: () => showWindow() },
    {
      label: 'Sync now',
      enabled: lastView.projects.length > 0 && Boolean(hopBinary),
      click: () => {
        // Never let a spawn failure become an unhandled rejection in main.
        for (const project of lastView.projects) runSync(project.codebaseId).catch(() => {})
      },
    },
    { type: 'separator' },
    { label: 'Quit HopIt', click: () => { isQuitting = true; app.quit() } },
  ])
  tray.setContextMenu(menu)
}

function createTray() {
  tray = new Tray(trayIcon(lastView.trayState))
  tray.setToolTip('HopIt')
  tray.on('click', () => showWindow())
  updateTray()
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

async function pollOnce() {
  let projects
  try {
    projects = await readProjects(stateRoot)
  } catch {
    projects = []
  }
  const probes = await Promise.all(
    projects.map(async (project) => {
      const result = await fetchStatus(statusUrlForCodebase(project.codebaseId), { timeoutMs: 4000 })
      if (result.reachable && result.status) {
        statusCache.set(project.codebaseId, result.status)
        if (result.status.workspace?.root) lastWorkspaceRoot = result.status.workspace.root
      }
      return {
        codebaseId: project.codebaseId,
        name: project.name,
        workspacePath: project.workspacePath,
        reachable: result.reachable,
        status: result.status,
        error: result.error,
      }
    }),
  )
  lastView = deriveViewModel(probes)
  updateTray()
  broadcastState()
}

function broadcastState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:update', {
      trayState: lastView.trayState,
      label: lastView.label,
      projects: lastView.projects,
      workspaceRoot: lastWorkspaceRoot,
      hopAvailable: Boolean(hopBinary),
    })
  }
}

function startPolling() {
  void pollOnce()
  pollTimer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS)
}

// ---------------------------------------------------------------------------
// Actions (spawn hop)
// ---------------------------------------------------------------------------

function requireHop() {
  if (!hopBinary) throw new Error('The hop CLI was not found. Install it, then reopen HopIt.')
  return hopBinary
}

async function runSync(codebaseId) {
  return streamHop(requireHop(), syncArgs(codebaseId), { env: process.env, humanMode: true })
    .then(() => pollOnce())
}

// ---------------------------------------------------------------------------
// IPC surface (typed via preload). Every handler is small and delegates to a
// pure module or a hop spawn.
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('getState', () => ({
    trayState: lastView.trayState,
    label: lastView.label,
    projects: lastView.projects,
    workspaceRoot: lastWorkspaceRoot,
    hopAvailable: Boolean(hopBinary),
  }))

  ipcMain.handle('projectStatus', async (_event, codebaseId) => {
    const result = await fetchStatus(statusUrlForCodebase(codebaseId))
    if (result.reachable && result.status) statusCache.set(codebaseId, result.status)
    const status = result.status ?? statusCache.get(codebaseId) ?? null
    return {
      reachable: result.reachable,
      error: result.error,
      codebaseId,
      readiness: status?.readiness ?? null,
      revision: status?.merge?.mainRevision ?? null,
      visibleFileCount: status?.visibleFileCount ?? null,
      localChanges: status?.workspace?.localChanges ?? null,
      journal: status?.journal
        ? { pendingCount: status.journal.pendingCount, failedCount: status.journal.failedCount, acknowledgedCount: status.journal.acknowledgedCount }
        : null,
      cache: status?.workspace?.cache ?? null,
      sync: status?.sync ?? null,
      remotePush: status?.remotePush
        ? { state: status.remotePush.state ?? null, connection: status.remotePush.connection ?? null }
        : null,
      lastSyncAt: status?.events?.lastSync?.at ?? status?.sync?.lastCompletedAt ?? null,
      workspacePath: status?.workspace?.path ?? null,
      hydration: status?.workspace?.hydration ?? null,
    }
  })

  ipcMain.handle('projectHistory', async (_event, codebaseId) => {
    const result = await fetchEvents(eventsUrlForCodebase(codebaseId))
    if (result.reachable && result.events) eventsCache.set(codebaseId, result.events)
    const events = result.events ?? eventsCache.get(codebaseId) ?? null
    return {
      reachable: result.reachable,
      error: result.error,
      rows: deriveHistory(events?.recent ?? []),
      totalEntries: events?.totalEntries ?? null,
      windowed: true,
    }
  })

  ipcMain.handle('projectActivity', async (_event, codebaseId) => {
    const result = await fetchEvents(eventsUrlForCodebase(codebaseId))
    if (result.reachable && result.events) eventsCache.set(codebaseId, result.events)
    const events = result.events ?? eventsCache.get(codebaseId) ?? null
    return {
      reachable: result.reachable,
      error: result.error,
      lines: formatActivity(events?.recent ?? [], { limit: 25 }),
    }
  })

  ipcMain.handle('projectFiles', async (_event, codebaseId, subpath = '') => {
    const result = await fetchStatus(statusUrlForCodebase(codebaseId))
    if (result.reachable && result.status) statusCache.set(codebaseId, result.status)
    const status = result.status ?? statusCache.get(codebaseId) ?? null
    if (!status) return { reachable: false, error: result.error, listing: null, cache: null, sampled: null }
    const filesMap = status.workspace?.files ?? {}
    const listing = buildDirectoryListing(filesMap, { subpath })
    return {
      reachable: result.reachable,
      error: null,
      listing,
      cache: status.workspace?.cache ?? null,
      // The status endpoint may sample only a subset of files vs the real cache
      // count; expose both so the UI can be honest about completeness.
      sampled: {
        shown: Object.keys(filesMap).length,
        cacheFileCount: status.workspace?.cache?.fileCount ?? null,
      },
    }
  })

  ipcMain.handle('syncNow', async (_event, codebaseId) => {
    await runSync(codebaseId)
    return { ok: true }
  })

  ipcMain.handle('refreshNow', async (_event, codebaseId) => {
    await streamHop(requireHop(), refreshArgs(codebaseId), { env: process.env })
    await pollOnce()
    return { ok: true }
  })

  ipcMain.handle('serviceControl', async (_event, action, codebaseId) => {
    await streamHop(requireHop(), serviceArgs(action, codebaseId), { env: process.env })
    await pollOnce()
    return { ok: true }
  })

  ipcMain.handle('hydratePath', async (_event, codebaseId, cloudPath, options = {}) => {
    await streamHop(requireHop(), hydratePathArgs({ codebaseId, cloudPath, recursive: Boolean(options.recursive), withSiblings: Boolean(options.withSiblings) }), { env: process.env })
    await pollOnce()
    return { ok: true }
  })

  ipcMain.handle('pinPath', async (_event, codebaseId, cloudPath, pinned) => {
    await streamHop(requireHop(), pinArgs({ codebaseId, cloudPath, pinned: Boolean(pinned) }), { env: process.env })
    await pollOnce()
    return { ok: true }
  })

  ipcMain.handle('revealPath', async (_event, targetPath, options = {}) => {
    // A file reveal joins a trusted workspace root with an agent-supplied file
    // path; confine it so a hostile `..` path cannot escape into the filesystem.
    // Whole-folder reveals (workspace root, project folder) pass no `within`.
    const within = options && typeof options.within === 'string' ? options.within : null
    const safe = within ? assertPathWithin(within, targetPath) : assertSafeAbsolutePath(targetPath)
    if (!fs.existsSync(safe)) return { ok: false, error: 'That location does not exist on this Mac yet.' }
    const error = await shell.openPath(safe)
    return { ok: !error, error: error || null }
  })

  ipcMain.handle('openDashboard', async (_event, codebaseId) => {
    const url = codebaseId ? `${DASHBOARD_URL}/${encodeURIComponent(codebaseId)}` : DASHBOARD_URL
    await shell.openExternal(url)
    return { ok: true }
  })

  ipcMain.handle('pickFolder', async () => {
    if (!mainWindow) return { canceled: true }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a project folder to add to HopIt',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    return { canceled: false, path: result.filePaths[0] }
  })

  ipcMain.handle('inspectFolder', async (_event, folderPath) => {
    const safe = assertSafeAbsolutePath(folderPath)
    let projects = []
    try {
      projects = await readProjects(stateRoot)
    } catch {
      projects = []
    }
    return inspectFolder(safe, { workspaceRoot: lastWorkspaceRoot, projects })
  })

  ipcMain.handle('addProject', async (event, payload = {}) => {
    const bin = requireHop()
    const args = addArgs({ source: payload.source, codebaseId: payload.codebaseId || undefined })
    const send = (channel, data) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, data)
    }
    send('add:state', { state: 'starting' })
    try {
      const result = await streamHop(bin, args, {
        env: process.env,
        humanMode: true,
        onLine: (line) => send('add:log', { line }),
      })
      await pollOnce()
      const ok = result.code === 0
      send('add:done', { ok, code: result.code })
      return { ok, code: result.code }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      send('add:log', { line: `Error: ${message}` })
      send('add:done', { ok: false, code: null, error: message })
      return { ok: false, error: message }
    }
  })

  ipcMain.handle('openExternalDashboard', async () => {
    await shell.openExternal(DASHBOARD_URL)
    return { ok: true }
  })
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.on('window-all-closed', () => {
  // Keep running in the tray; do not quit on window close.
})

app.on('activate', () => showWindow())
app.on('before-quit', () => { isQuitting = true })

app.whenReady().then(() => {
  registerIpc()
  createTray()
  createWindow()
  startPolling()

  // Headless self-test: boot far enough to prove tray + window + poll wiring,
  // then quit cleanly without needing a human. Used by the smoke script.
  if (SMOKE) {
    const marker = {
      event: 'desktop-smoke-ready',
      trayCreated: Boolean(tray),
      windowCreated: Boolean(mainWindow),
      hopBinary,
      stateRoot,
      workspaceRoot: lastWorkspaceRoot,
    }
    console.log(`HOPIT_DESKTOP_SMOKE ${JSON.stringify(marker)}`)
    setTimeout(() => {
      isQuitting = true
      if (pollTimer) clearInterval(pollTimer)
      app.quit()
    }, 2500)
  }
})

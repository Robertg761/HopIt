// HopIt desktop renderer. Vanilla JS over the preload `window.hopit` bridge.
// The renderer holds only view state; every fact on screen comes from the main
// process (which reads the agent endpoints) and every action goes back through
// the typed IPC surface.

/* global hopit */
'use strict'

import { reconcileSelection, syncStateLabel } from '../lib/state.js'

const $ = (id) => document.getElementById(id)

const state = {
  projects: [],
  trayState: 'service-stopped',
  label: { text: '…' },
  workspaceRoot: null,
  hopAvailable: true,
  selectedId: null,
  selectionMissStreak: 0, // consecutive polls the selection was absent (sticky-selection guard)
  view: 'empty', // empty | project | add
  tab: 'now',
  filesSubpath: '',
  inspected: null, // add-flow folder inspection result
  addRunning: false,
}

// ---------------------------------------------------------------------------
// Sidebar + routing
// ---------------------------------------------------------------------------

function pillClassFor(trayOrProjectState) {
  switch (trayOrProjectState) {
    case 'all-synced':
    case 'synced':
      return 'pill pill-ok'
    case 'syncing':
      return 'pill pill-active'
    case 'attention':
      return 'pill pill-warn'
    default:
      return 'pill pill-muted'
  }
}

function dotClassFor(projectState) {
  switch (projectState) {
    case 'synced': return 'dot dot-synced'
    case 'syncing': return 'dot dot-syncing'
    case 'attention': return 'dot dot-attention'
    default: return 'dot dot-stopped'
  }
}

function renderSidebar() {
  const pill = $('agg-pill')
  pill.textContent = state.label.text
  pill.className = pillClassFor(state.trayState)

  const list = $('project-list')
  list.textContent = ''
  for (const project of state.projects) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'project-item' + (project.codebaseId === state.selectedId ? ' active' : '')
    const dot = document.createElement('span')
    dot.className = dotClassFor(project.state)
    const body = document.createElement('span')
    body.style.minWidth = '0'
    const name = document.createElement('span')
    name.className = 'p-name'
    name.textContent = project.name
    const sub = document.createElement('span')
    sub.className = 'p-sub'
    sub.textContent = project.revision != null ? `${project.stateLabel} · rev ${project.revision}` : project.stateLabel
    body.append(name, sub)
    btn.append(dot, body)
    btn.addEventListener('click', () => selectProject(project.codebaseId))
    list.appendChild(btn)
  }

  $('workspace-root-path').textContent = state.workspaceRoot ?? '…'
  $('hop-missing').classList.toggle('hidden', state.hopAvailable)
}

function showView(view) {
  state.view = view
  $('view-empty').classList.toggle('hidden', view !== 'empty')
  $('view-project').classList.toggle('hidden', view !== 'project')
  $('view-add').classList.toggle('hidden', view !== 'add')
}

function selectProject(codebaseId) {
  state.selectedId = codebaseId
  state.filesSubpath = ''
  showView('project')
  renderSidebar()
  renderProjectHeader()
  void refreshActiveTab()
}

function selectedProject() {
  return state.projects.find((p) => p.codebaseId === state.selectedId) ?? null
}

// ---------------------------------------------------------------------------
// Project header + tabs
// ---------------------------------------------------------------------------

function renderProjectHeader() {
  const project = selectedProject()
  if (!project) return
  $('project-name').textContent = project.name
  const pill = $('project-state-pill')
  pill.textContent = project.stateLabel
  pill.className = pillClassFor(project.state)
  $('project-path').textContent = project.workspacePath ?? 'Workspace folder not created yet'
  $('project-path-btn').disabled = !project.workspacePath

  const running = project.state !== 'stopped'
  const serviceBtn = $('service-btn')
  serviceBtn.textContent = running ? 'Stop service' : 'Start service'
  serviceBtn.dataset.action = running ? 'stop' : 'start'
  $('sync-btn').disabled = !state.hopAvailable
  $('refresh-btn').disabled = !state.hopAvailable
  serviceBtn.disabled = !state.hopAvailable
}

function setTab(tab) {
  state.tab = tab
  document.querySelectorAll('#tabs .tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.tab === tab)
  })
  for (const name of ['now', 'history', 'activity', 'files']) {
    $(`panel-${name}`).classList.toggle('hidden', name !== tab)
  }
  void refreshActiveTab()
}

async function refreshActiveTab() {
  if (state.view !== 'project' || !state.selectedId) return
  const id = state.selectedId
  try {
    if (state.tab === 'now') await renderNow(id)
    else if (state.tab === 'history') await renderHistory(id)
    else if (state.tab === 'activity') await renderActivity(id)
    else if (state.tab === 'files') await renderFiles(id)
  } catch (error) {
    // Panels degrade to a note; never a blank crash.
    const panel = $(`panel-${state.tab}`)
    panel.textContent = ''
    panel.appendChild(note(`Could not load this view: ${error?.message ?? error}`, true))
  }
}

function note(text, attention = false) {
  const div = document.createElement('div')
  div.className = 'now-note' + (attention ? ' attention' : '')
  div.textContent = text
  return div
}

function statCard(label, value, sub) {
  const card = document.createElement('div')
  card.className = 'stat-card'
  const l = document.createElement('span')
  l.className = 's-label'
  l.textContent = label
  const v = document.createElement('span')
  v.className = 's-value'
  v.textContent = value
  card.append(l, v)
  if (sub) {
    const s = document.createElement('span')
    s.className = 's-sub'
    s.textContent = sub
    card.appendChild(s)
  }
  return card
}

function formatBytes(bytes) {
  if (typeof bytes !== 'number' || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = bytes, u = 0
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1 }
  return `${v >= 10 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`
}

function timeAgo(iso) {
  if (!iso) return '—'
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (Number.isNaN(seconds)) return '—'
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

// ---------------------------------------------------------------------------
// Now tab
// ---------------------------------------------------------------------------

async function renderNow(codebaseId) {
  const status = await hopit.projectStatus(codebaseId)
  if (codebaseId !== state.selectedId || state.tab !== 'now') return
  const panel = $('panel-now')
  panel.textContent = ''

  if (!status.reachable && !status.revision) {
    panel.appendChild(note('The background service for this project is not running, so live state is unavailable. Use "Start service" above to bring it back.', true))
    return
  }

  const grid = document.createElement('div')
  grid.className = 'stat-grid'
  grid.appendChild(statCard('Revision', status.revision != null ? `#${status.revision}` : '—', 'latest cloud revision'))
  grid.appendChild(statCard('Files', status.visibleFileCount != null ? String(status.visibleFileCount) : '—', 'synced in this project'))
  const pending = status.journal?.pendingCount ?? 0
  const failed = status.journal?.failedCount ?? 0
  grid.appendChild(statCard('Waiting to sync', String(pending), failed ? `${failed} failed — needs attention` : 'local changes not yet in cloud'))
  grid.appendChild(statCard('Last sync', timeAgo(status.lastSyncAt), syncStateLabel(status.sync?.state) ?? undefined))
  if (status.cache) {
    grid.appendChild(statCard('On this Mac', `${status.cache.hydratedFiles ?? '—'} files`, formatBytes(status.cache.bytesOnDisk)))
  }
  if (status.remotePush?.state) {
    grid.appendChild(statCard('Live connection', humanPushState(status.remotePush.state), 'instant updates from other devices'))
  }
  panel.appendChild(grid)

  if (!status.reachable) {
    panel.appendChild(note('Live service is unreachable right now — showing the last known state.', true))
  } else if (failed > 0) {
    panel.appendChild(note(`${failed} change${failed === 1 ? '' : 's'} failed to reach the cloud. Run a sync, and if it persists check the dashboard.`, true))
  } else if (pending === 0) {
    panel.appendChild(note('Everything in this folder is safely in your cloud. Edits you make are picked up automatically within seconds.'))
  }
}

function humanPushState(pushState) {
  switch (pushState) {
    case 'push-connected': return 'Connected'
    case 'push-fallback-polling': return 'Polling'
    case 'push-disconnected': return 'Disconnected'
    default: return pushState ?? '—'
  }
}

// ---------------------------------------------------------------------------
// History tab
// ---------------------------------------------------------------------------

async function renderHistory(codebaseId) {
  const history = await hopit.projectHistory(codebaseId)
  if (codebaseId !== state.selectedId || state.tab !== 'history') return
  const panel = $('panel-history')
  panel.textContent = ''

  if (!history.reachable && history.rows.length === 0) {
    panel.appendChild(note('The background service is not running, so the recent trail is unavailable.', true))
    return
  }
  if (history.rows.length === 0) {
    panel.appendChild(note('No recent trail steps in the current event window. New saves appear here.'))
    return
  }
  for (const row of history.rows) {
    const el = document.createElement('div')
    el.className = 'history-row'
    const rev = document.createElement('span')
    rev.className = 'history-rev'
    rev.textContent = `#${row.revision}`
    const body = document.createElement('span')
    body.className = 'history-body'
    const line = document.createElement('span')
    line.textContent = row.changedCount != null
      ? `${row.changedCount} file${row.changedCount === 1 ? '' : 's'} changed`
      : 'Changed'
    const tag = document.createElement('span')
    tag.className = `tag tag-${row.trigger.code}`
    tag.textContent = row.trigger.label
    line.appendChild(tag)
    body.appendChild(line)
    if (row.samplePaths?.length) {
      const paths = document.createElement('div')
      paths.className = 'history-paths'
      paths.textContent = row.samplePaths.join(' · ')
      body.appendChild(paths)
    }
    const when = document.createElement('span')
    when.className = 'history-when'
    when.textContent = timeAgo(row.at)
    el.append(rev, body, when)
    panel.appendChild(el)
  }
  panel.appendChild(Object.assign(document.createElement('p'), {
    className: 'files-note',
    textContent: 'Showing trail steps from the recent event window on this Mac. The full trail lives on the dashboard.',
  }))
}

// ---------------------------------------------------------------------------
// Activity tab
// ---------------------------------------------------------------------------

async function renderActivity(codebaseId) {
  const activity = await hopit.projectActivity(codebaseId)
  if (codebaseId !== state.selectedId || state.tab !== 'activity') return
  const panel = $('panel-activity')
  panel.textContent = ''
  if (!activity.reachable && activity.lines.length === 0) {
    panel.appendChild(note('The background service is not running, so live activity is unavailable.', true))
    return
  }
  if (activity.lines.length === 0) {
    panel.appendChild(note('No recent activity.'))
    return
  }
  for (const line of activity.lines) {
    const row = document.createElement('div')
    row.className = 'activity-row'
    const when = document.createElement('span')
    when.className = 'activity-when'
    when.textContent = line.relative ?? ''
    const text = document.createElement('span')
    text.textContent = line.text
    row.append(when, text)
    panel.appendChild(row)
  }
}

// ---------------------------------------------------------------------------
// Files tab
// ---------------------------------------------------------------------------

async function renderFiles(codebaseId) {
  // Capture the folder this request is for. Fast folder clicks can resolve out of
  // order; without pinning the subpath, a stale listing could be painted under
  // breadcrumbs built from a newer folder (listing for one folder, crumbs for another).
  const subpath = state.filesSubpath
  const result = await hopit.projectFiles(codebaseId, subpath)
  if (codebaseId !== state.selectedId || state.tab !== 'files' || subpath !== state.filesSubpath) return
  const panel = $('panel-files')
  panel.textContent = ''

  if (!result.listing) {
    panel.appendChild(note('The background service is not running, so file state is unavailable.', true))
    return
  }

  // Breadcrumbs
  const toolbar = document.createElement('div')
  toolbar.className = 'files-toolbar'
  const rootCrumb = document.createElement('button')
  rootCrumb.type = 'button'
  rootCrumb.className = 'crumb'
  rootCrumb.textContent = selectedProject()?.name ?? 'Project'
  rootCrumb.addEventListener('click', () => { state.filesSubpath = ''; void renderFiles(codebaseId) })
  toolbar.appendChild(rootCrumb)
  const segments = state.filesSubpath ? state.filesSubpath.split('/') : []
  segments.forEach((segment, index) => {
    const sep = document.createElement('span')
    sep.className = 'crumb-sep'
    sep.textContent = '/'
    toolbar.appendChild(sep)
    const target = segments.slice(0, index + 1).join('/')
    if (index === segments.length - 1) {
      const current = document.createElement('span')
      current.className = 'crumb-current'
      current.textContent = segment
      toolbar.appendChild(current)
    } else {
      const crumb = document.createElement('button')
      crumb.type = 'button'
      crumb.className = 'crumb'
      crumb.textContent = segment
      crumb.addEventListener('click', () => { state.filesSubpath = target; void renderFiles(codebaseId) })
      toolbar.appendChild(crumb)
    }
  })
  panel.appendChild(toolbar)

  if (result.listing.empty) {
    panel.appendChild(note('Nothing here.'))
    return
  }

  const project = selectedProject()
  for (const folder of result.listing.folders) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'file-row'
    row.addEventListener('click', () => { state.filesSubpath = folder.path; void renderFiles(codebaseId) })
    row.append(
      makeIcon('📁'),
      makeName(folder.name),
      makePill(folder.badge),
    )
    panel.appendChild(row)
  }
  for (const file of result.listing.files) {
    const row = document.createElement('div')
    row.className = 'file-row'
    const actions = document.createElement('span')
    actions.className = 'file-actions'
    if (file.badge.code === 'cloud') {
      actions.appendChild(miniBtn('Keep on this Mac', async () => {
        await hopit.hydratePath(codebaseId, file.path, {})
        void renderFiles(codebaseId)
      }))
    } else if (project?.workspacePath) {
      actions.appendChild(miniBtn('Show in Finder', () => {
        // Confine to the project folder: file.path is agent/cloud-derived data.
        void hopit.revealPath(`${project.workspacePath}/${file.path}`, { within: project.workspacePath })
      }))
    }
    actions.appendChild(miniBtn(file.pinned ? 'Unpin' : 'Pin', async () => {
      await hopit.pinPath(codebaseId, file.path, !file.pinned)
      void renderFiles(codebaseId)
    }))

    const size = document.createElement('span')
    size.className = 'file-size'
    size.textContent = file.bytesOnDisk != null ? formatBytes(file.bytesOnDisk) : ''

    row.append(
      makeIcon('📄'),
      makeName(file.name + (file.pinned ? ' ' : '')),
      actions,
      size,
      makePill(file.badge),
    )
    if (file.pinned) {
      const flag = document.createElement('span')
      flag.className = 'pin-flag'
      flag.title = 'Pinned: always kept on this Mac'
      flag.textContent = '📌'
      row.insertBefore(flag, row.children[2])
    }
    panel.appendChild(row)
  }

  const footer = document.createElement('p')
  footer.className = 'files-note'
  const cacheCount = result.sampled?.cacheFileCount
  footer.textContent =
    (cacheCount != null ? `${cacheCount} files tracked. ` : '') +
    '“On this Mac” files are stored locally and in your cloud; “Cloud only” files download when you need them.'
  panel.appendChild(footer)
}

function makeIcon(glyph) {
  const el = document.createElement('span')
  el.className = 'file-icon'
  el.textContent = glyph
  return el
}
function makeName(text) {
  const el = document.createElement('span')
  el.className = 'file-name'
  el.textContent = text
  return el
}
function makePill(badge) {
  const el = document.createElement('span')
  el.className = 'pill ' + (badge.tone === 'ok' ? 'pill-ok' : badge.tone === 'active' ? 'pill-active' : badge.tone === 'danger' ? 'pill-danger' : 'pill-muted')
  el.textContent = badge.label
  return el
}
function miniBtn(label, onClick) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'mini-btn'
  btn.textContent = label
  btn.addEventListener('click', (event) => { event.stopPropagation(); void onClick() })
  return btn
}

// ---------------------------------------------------------------------------
// Add-project flow
// ---------------------------------------------------------------------------

function showAdd() {
  showView('add')
  state.inspected = null
  $('add-step-pick').classList.remove('hidden')
  $('add-step-confirm').classList.add('hidden')
  $('add-step-run').classList.add('hidden')
  $('picked-none').textContent = 'No folder chosen yet.'
  $('codebase-id-input').value = ''
}

async function pickFolder() {
  const picked = await hopit.pickFolder()
  if (picked.canceled) return
  $('picked-none').textContent = 'Inspecting…'
  const inspection = await hopit.inspectFolder(picked.path)
  state.inspected = inspection
  $('picked-none').textContent = inspection.folderPath

  $('inspect-headline').textContent = inspection.headline
  $('inspect-desc').textContent = inspection.description

  const stats = $('inspect-stats')
  stats.textContent = ''
  if (inspection.fileCount != null) {
    const files = document.createElement('span')
    files.textContent = `${inspection.fileCount}${inspection.truncated ? '+' : ''} files`
    const size = document.createElement('span')
    size.textContent = formatBytes(inspection.totalBytes)
    stats.append(files, size)
  }

  const confirmBtn = $('add-confirm-btn')
  const openExistingBtn = $('add-open-existing-btn')
  confirmBtn.classList.toggle('hidden', inspection.recommendation !== 'add')
  openExistingBtn.classList.toggle('hidden', inspection.recommendation !== 'open-existing')
  if (inspection.recommendation === 'open-existing') {
    openExistingBtn.onclick = () => {
      selectProject(inspection.existingProjectId)
    }
  }
  $('advanced-details').classList.toggle('hidden', inspection.recommendation !== 'add')

  $('add-step-confirm').classList.remove('hidden')
}

async function confirmAdd() {
  if (!state.inspected || state.addRunning) return
  state.addRunning = true
  $('add-step-confirm').classList.add('hidden')
  $('add-step-run').classList.remove('hidden')
  $('add-run-state').textContent = 'Adding… your browser will open once to approve this Mac.'
  $('add-done-btn').classList.add('hidden')
  $('add-retry-btn').classList.add('hidden')
  const log = $('add-log')
  log.textContent = ''

  const codebaseId = $('codebase-id-input').value.trim()
  const result = await hopit.addProject({
    source: state.inspected.folderPath,
    codebaseId: codebaseId || undefined,
  })
  state.addRunning = false
  if (result.ok) {
    $('add-run-state').textContent = 'Project added. It now syncs automatically.'
    $('add-done-btn').classList.remove('hidden')
  } else {
    $('add-run-state').textContent = 'Adding failed. Nothing was changed in your original folder.'
    $('add-retry-btn').classList.remove('hidden')
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function applyState(payload) {
  state.projects = payload.projects ?? []
  state.trayState = payload.trayState
  state.label = payload.label ?? { text: '…' }
  state.workspaceRoot = payload.workspaceRoot ?? state.workspaceRoot
  state.hopAvailable = Boolean(payload.hopAvailable)

  // Keep the selection sticky across a transient empty/incomplete poll (the
  // workspace index file caught mid-rewrite): only clear after the project stays
  // absent for 2+ consecutive polls. This also avoids resetting filesSubpath on a
  // blip, since selectProject() (which clears it) is not re-run while sticky.
  const reconciled = reconcileSelection({
    selectedId: state.selectedId,
    projects: state.projects,
    missStreak: state.selectionMissStreak,
  })
  state.selectedId = reconciled.selectedId
  state.selectionMissStreak = reconciled.missStreak
  // Only fall back to the empty view once the selection has actually been cleared,
  // not on a momentary empty poll while a selection is still held.
  if (state.projects.length === 0 && !state.selectedId && state.view === 'project') showView('empty')

  renderSidebar()
  if (state.view === 'project') renderProjectHeader()

  // First data arrival: select the first project and load its active tab.
  if (!state.selectedId && state.projects.length > 0 && state.view !== 'add') {
    selectProject(state.projects[0].codebaseId)
  }
}

function wire() {
  $('add-project-btn').addEventListener('click', showAdd)
  $('empty-add-btn').addEventListener('click', showAdd)
  $('add-back-btn').addEventListener('click', () => {
    showView(state.projects.length ? 'project' : 'empty')
    if (state.selectedId) void refreshActiveTab()
  })
  $('pick-folder-btn').addEventListener('click', () => void pickFolder())
  $('add-confirm-btn').addEventListener('click', () => void confirmAdd())
  $('add-cancel-btn').addEventListener('click', showAdd)
  $('add-retry-btn').addEventListener('click', showAdd)
  $('add-done-btn').addEventListener('click', () => {
    if (state.inspected) {
      // The new project id may differ (derived); select the newest list entry.
      const known = new Set(state.projects.map((p) => p.codebaseId))
      hopit.getState().then((payload) => {
        applyState(payload)
        const fresh = state.projects.find((p) => !known.has(p.codebaseId))
        selectProject(fresh?.codebaseId ?? state.projects[0]?.codebaseId)
      })
    }
  })

  $('workspace-root-btn').addEventListener('click', () => {
    if (state.workspaceRoot) void hopit.revealPath(state.workspaceRoot)
  })
  $('dashboard-btn').addEventListener('click', () => void hopit.openDashboard())
  $('project-dashboard-btn').addEventListener('click', () => {
    if (state.selectedId) void hopit.openDashboard(state.selectedId)
  })
  $('project-path-btn').addEventListener('click', () => {
    const project = selectedProject()
    if (project?.workspacePath) void hopit.revealPath(project.workspacePath)
  })

  $('sync-btn').addEventListener('click', async () => {
    const btn = $('sync-btn')
    btn.disabled = true
    btn.textContent = 'Syncing…'
    try { await hopit.syncNow(state.selectedId) } finally {
      btn.disabled = false
      btn.textContent = 'Sync now'
      void refreshActiveTab()
    }
  })
  $('refresh-btn').addEventListener('click', async () => {
    const btn = $('refresh-btn')
    btn.disabled = true
    btn.textContent = 'Refreshing…'
    try { await hopit.refreshNow(state.selectedId) } finally {
      btn.disabled = false
      btn.textContent = 'Refresh from cloud'
      void refreshActiveTab()
    }
  })
  $('service-btn').addEventListener('click', async () => {
    const btn = $('service-btn')
    const action = btn.dataset.action ?? 'start'
    btn.disabled = true
    btn.textContent = action === 'start' ? 'Starting…' : 'Stopping…'
    try { await hopit.serviceControl(action, state.selectedId) } finally {
      renderProjectHeader()
      void refreshActiveTab()
    }
  })

  document.querySelectorAll('#tabs .tab').forEach((el) => {
    el.addEventListener('click', () => setTab(el.dataset.tab))
  })

  hopit.onStateUpdate(applyState)
  hopit.onAddLog(({ line }) => {
    const log = $('add-log')
    log.textContent += line + '\n'
    log.scrollTop = log.scrollHeight
  })

  // Light periodic refresh of the visible tab so panels stay live.
  setInterval(() => { if (!document.hidden) void refreshActiveTab() }, 7000)
}

async function boot() {
  wire()
  const payload = await hopit.getState()
  applyState(payload)
  if (state.projects.length === 0) showView('empty')
}

if (typeof hopit === 'undefined') {
  // Loaded outside Electron (e.g. a plain browser preview): show static shell.
  document.addEventListener('DOMContentLoaded', () => {
    $('agg-pill').textContent = 'Preview'
  })
} else {
  document.addEventListener('DOMContentLoaded', () => void boot())
}

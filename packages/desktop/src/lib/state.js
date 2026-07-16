// @ts-check
// Pure derivation of per-project and aggregate tray state from status JSON.
//
// A per-project probe is `{ codebaseId, reachable, status, error }` where
// `status` is the parsed /status body (or null when unreachable). All functions
// here are pure so the tray icon/label/menu are a deterministic function of the
// probes: this is the unit-tested behavioural core of the shell.

/** @typedef {'synced'|'syncing'|'attention'|'stopped'} ProjectState */
/** @typedef {'all-synced'|'syncing'|'attention'|'service-stopped'} TrayState */

/**
 * @typedef {Object} ProjectProbe
 * @property {string} codebaseId
 * @property {boolean} reachable
 * @property {any} [status]
 * @property {string|null} [error]
 */

/**
 * Derive a single project's state from its status probe.
 * @param {ProjectProbe} probe
 * @returns {ProjectState}
 */
export function projectStateFromProbe(probe) {
  if (!probe || !probe.reachable || !probe.status) return 'stopped'
  const status = probe.status

  // Anything the agent itself flags as a problem, or an explicit failure/block,
  // needs the owner's attention.
  const failedJournal = Number(status.journal?.failedCount ?? 0) > 0
  const syncFailed = status.sync?.state === 'failed'
  const refreshBlocked = status.refresh?.state === 'blocked'
  const hasConflict = status.conflict?.state && status.conflict.state !== 'none'
  const watchState = status.watch?.state
  const watchBad = watchState === 'degraded' || watchState === 'unavailable-degraded' || watchState === 'blocked'
  if (failedJournal || syncFailed || refreshBlocked || hasConflict || watchBad) return 'attention'

  // In-flight work: pending journal entries, a running sync, or partial/
  // in-progress hydration.
  const pending = Number(status.journal?.pendingCount ?? 0) > 0
  const syncRunning = status.sync?.state === 'running' || status.sync?.state === 'in-progress'
  const hydrationState = status.workspace?.hydration?.state
  const hydrating = hydrationState === 'partial' || hydrationState === 'hydrating'
  const notReady = status.readiness && status.readiness !== 'ready' && status.readiness !== 'attached'
  if (pending || syncRunning || hydrating || notReady) return 'syncing'

  return 'synced'
}

/**
 * Aggregate the whole-device tray state from per-project states.
 * @param {ProjectState[]} projectStates
 * @returns {TrayState}
 */
export function aggregateTrayState(projectStates) {
  if (!Array.isArray(projectStates) || projectStates.length === 0) return 'service-stopped'
  if (projectStates.includes('attention')) return 'attention'
  if (projectStates.includes('syncing')) return 'syncing'
  if (projectStates.every((state) => state === 'stopped')) return 'service-stopped'
  // A mix of synced and stopped: a background service is down -> needs attention.
  if (projectStates.includes('stopped')) return 'attention'
  return 'all-synced'
}

/** Human label + short glyph for a tray state (used in tooltip/title). */
export function trayStateLabel(trayState) {
  switch (trayState) {
    case 'all-synced':
      return { glyph: '✓', text: 'All synced' }
    case 'syncing':
      return { glyph: '↻', text: 'Syncing…' }
    case 'attention':
      return { glyph: '!', text: 'Attention needed' }
    case 'service-stopped':
    default:
      return { glyph: '□', text: 'Service stopped' }
  }
}

/**
 * Human phrase for the agent's sync-health state, for the "Last sync" card
 * subtitle. The agent emits one of `idle | syncing | healthy | failed`
 * (see buildSyncHealth in status-state.js). Returns null for an unknown or
 * missing state so the caller can omit the subtitle rather than print a raw
 * state word ("sync syncing").
 * @param {string|null|undefined} syncState
 * @returns {string|null}
 */
export function syncStateLabel(syncState) {
  switch (syncState) {
    case 'syncing':
      return 'syncing now'
    case 'healthy':
      return 'up to date'
    case 'idle':
      return 'waiting for changes'
    case 'failed':
      return 'last sync failed'
    default:
      return null
  }
}

/** One-line status label for a single project (tray submenu / list). */
export function projectStateLabel(projectState) {
  switch (projectState) {
    case 'synced':
      return 'Synced'
    case 'syncing':
      return 'Syncing…'
    case 'attention':
      return 'Attention needed'
    case 'stopped':
    default:
      return 'Service stopped'
  }
}

/**
 * Build the full derived view model for a set of probes: per-project rows with
 * state + revision + file counts, plus the aggregate tray state. Pure.
 * @param {Array<ProjectProbe & { name?: string, workspacePath?: string }>} probes
 */
export function deriveViewModel(probes) {
  const projects = (probes ?? []).map((probe) => {
    const projectState = projectStateFromProbe(probe)
    const status = probe.status ?? null
    return {
      codebaseId: probe.codebaseId,
      name: probe.name ?? status?.codebaseName ?? probe.codebaseId,
      workspacePath: probe.workspacePath ?? status?.workspace?.path ?? null,
      reachable: Boolean(probe.reachable),
      state: projectState,
      stateLabel: projectStateLabel(projectState),
      readiness: status?.readiness ?? null,
      revision: status?.merge?.mainRevision ?? status?.workspace?.hydration?.graphRevision ?? null,
      visibleFileCount: status?.visibleFileCount ?? null,
      hydrationState: status?.workspace?.hydration?.state ?? null,
      pendingCount: status?.journal?.pendingCount ?? null,
      failedCount: status?.journal?.failedCount ?? null,
      conflictState: status?.conflict?.state ?? null,
      error: probe.error ?? null,
    }
  })
  const trayState = aggregateTrayState(projects.map((project) => project.state))
  return { trayState, label: trayStateLabel(trayState), projects }
}

/**
 * Decide whether a freshly polled project list should clear the current
 * selection. The workspace index file can be caught mid-rewrite, yielding a
 * momentarily-empty (or incomplete) list; a single such poll must NOT deselect
 * the user's project and drop them back to the empty view. The selection is only
 * cleared once its project stays absent for `threshold` consecutive polls.
 *
 * Pure and self-contained so the sticky-selection behaviour is unit-tested
 * rather than living implicitly in the renderer's poll handler.
 *
 * @param {Object} input
 * @param {string|null} input.selectedId  currently selected codebase id
 * @param {Array<{codebaseId: string}>} input.projects  projects from the new poll
 * @param {number} input.missStreak  consecutive polls the selection has been absent
 * @param {number} [input.threshold=2]  polls of absence tolerated before clearing
 * @returns {{ selectedId: string|null, missStreak: number }}
 */
export function reconcileSelection({ selectedId, projects, missStreak, threshold = 2 }) {
  if (!selectedId) return { selectedId: null, missStreak: 0 }
  const present = (projects ?? []).some((project) => project.codebaseId === selectedId)
  if (present) return { selectedId, missStreak: 0 }
  const nextStreak = Number(missStreak ?? 0) + 1
  if (nextStreak >= threshold) return { selectedId: null, missStreak: 0 }
  return { selectedId, missStreak: nextStreak }
}

/** One-line summary text for a project, e.g. "HopIt · Synced · rev 4437". */
export function projectSummaryLine(project) {
  const parts = [project.name ?? project.codebaseId, '·', project.stateLabel]
  const detail = []
  if (project.revision != null) detail.push(`rev ${project.revision}`)
  if (project.pendingCount) detail.push(`${project.pendingCount} pending`)
  if (project.failedCount) detail.push(`${project.failedCount} failed`)
  if (detail.length) parts.push(`· ${detail.join(' · ')}`)
  return parts.join(' ')
}

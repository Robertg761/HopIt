// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import { createCloudGraphService, visibilityRequestFromOptions } from './cloud/d1-graph-service.js'
import { hydrateWorkspace, pruneWorkspaceCache } from './commands/hydrate.js'
import { initCloud } from './commands/import.js'
import { recoverJournal, refreshWorkspace, syncOnce } from './commands/sync.js'
import { workspaceMode } from './constants.js'
import { emit, findLastEventOf, readNdjson } from './io.js'
import { createRemotePushClient } from './remote-push.js'
import { toCloudPath } from './journal.js'
import { assertWorkspacePathSafe, remotePullEnabled, remotePushEnabled, remoteRefreshIntervalMs } from './paths.js'
import { normalizeWatchFilename, readJournalSafety, visibleRevisionFromEvent } from './status-state.js'
import { findIndexedCodebase, readWorkspaceIndex } from './workspace-index.js'
import { exonerateWorkspaceChangesAgainstCloud, isLocalActivityMarkerPath, shouldSkipWorkspacePath, shouldTrackLocalActivityPath, workspaceLocalChanges } from './workspace-manifest.js'
import { watch } from 'node:fs'

export async function watchWorkspace(options) {
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
  const workspaceIndex = await readWorkspaceIndex(options)
  const indexedCodebase = findIndexedCodebase(
    workspaceIndex,
    options['codebase-id'],
    options.workspace,
  )
  const hydrationState = indexedCodebase?.hydration?.state ?? null
  if (!hydrationState || hydrationState === 'materialized') {
    await hydrateWorkspace(options)
  } else {
    // Attached and partially hydrated workspaces are intentionally lazy caches.
    // Starting the watcher must not turn service startup into a full download.
    await fs.mkdir(options.workspace, { recursive: true })
  }
  await emit(options, 'watch.started', {
    state: 'watching',
    workspace: options.workspace,
    adapter: workspaceMode.adapter,
    cacheMode: workspaceMode.cacheMode,
    hydrationState,
  })

  let watcher
  let poller = null
  let remotePuller = null
  let remotePusher = null
  let autoPruner = null
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
  remotePusher = await createRemotePushClient(options, {
    localSyncIdle: () => scheduleSync.isIdle?.() ?? true,
    remoteRefreshDecision,
    refreshWorkspace,
  })
  autoPruner = await createAutoPruneScheduler(options, {
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
      remotePusher?.close()
      autoPruner?.close()
    },
  }
}

const defaultAutoPruneIntervalMs = 6 * 60 * 60 * 1000
const defaultAutoPruneInactiveMs = 7 * 24 * 60 * 60 * 1000
const minimumAutoPruneMs = 60 * 1000

export async function createAutoPruneScheduler(options, schedulerOptions = {}) {
  if (!options['auto-prune']) return null

  const intervalMs = schedulerOptions.intervalMs ?? parseAutoPruneMs(
    options['auto-prune-interval-ms'],
    defaultAutoPruneIntervalMs,
    '--auto-prune-interval-ms',
  )
  const inactiveMs = schedulerOptions.inactiveMs ?? parseAutoPruneMs(
    options['auto-prune-inactive-ms'],
    defaultAutoPruneInactiveMs,
    '--auto-prune-inactive-ms',
  )
  const localSyncIdle = schedulerOptions.localSyncIdle ?? (() => true)
  const pruneWorkspace = schedulerOptions.pruneWorkspace ?? pruneWorkspaceCache
  let closed = false
  let running = false

  await emit(options, 'cache.auto_prune_started', {
    state: 'scheduled',
    workspace: options.workspace,
    intervalMs,
    inactiveMs,
    cleanAcknowledgedOnly: true,
    preservesPinned: true,
  })

  const run = async () => {
    if (closed || running) return
    running = true
    try {
      if (!localSyncIdle()) {
        await emit(options, 'cache.auto_prune_skipped', {
          state: 'skipped',
          workspace: options.workspace,
          reason: 'local_sync_pending',
        })
        return
      }

      const journalSafety = await readJournalSafety(options)
      if (!journalSafety.safe) {
        await emit(options, 'cache.auto_prune_skipped', {
          state: 'skipped',
          workspace: options.workspace,
          reason: 'journal_has_unresolved_entries',
          journal: journalSafety.summary,
        })
        return
      }

      await pruneWorkspace({
        ...options,
        path: 'all',
        recursive: true,
        execute: true,
        'inactive-ms': String(inactiveMs),
      })
    } catch (error) {
      await emit(options, 'cache.auto_prune_failed', {
        state: 'failed',
        workspace: options.workspace,
        reason: error instanceof Error ? error.message : 'auto_prune_failed',
      })
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => {
    run().catch((error) => {
      console.error(error)
    })
  }, intervalMs)
  timer.unref?.()

  return {
    close() {
      closed = true
      clearInterval(timer)
    },
  }
}

export function parseAutoPruneMs(rawValue, fallback, optionName) {
  const value = Number(rawValue ?? fallback)
  if (!Number.isInteger(value) || value < minimumAutoPruneMs) {
    throw new Error(`Invalid ${optionName} value: ${rawValue ?? fallback}. Use at least ${minimumAutoPruneMs}ms.`)
  }
  return value
}

export function createWatchSyncScheduler(options, schedulerOptions = {}) {
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

export async function createWorkspacePoller(workspace, onChange, pollerOptions = {}) {
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

export function firstChangedSnapshotPath(previousSnapshot, nextSnapshot) {
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

export function snapshotLineMap(snapshot) {
  const result = new Map()
  for (const line of snapshot.split('\n')) {
    if (!line) continue
    const separator = line.indexOf(':')
    const relativePath = separator === -1 ? line : line.slice(0, separator)
    result.set(relativePath, line)
  }
  return result
}

export async function snapshotWorkspace(root, options = {}) {
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

export async function createRemoteRefreshScheduler(options, schedulerOptions = {}) {
  const activityTriggersEnabled = remotePullEnabled(options)
  const pushReconciliationEnabled = remotePushEnabled(options)
  if (!activityTriggersEnabled && !pushReconciliationEnabled) return null

  const cooldownMs = remoteRefreshIntervalMs(options)
  const localSyncIdle = schedulerOptions.localSyncIdle ?? (() => true)
  let closed = false
  let running = false
  let timer = null
  let queued = false
  let queuedTrigger = null
  let queuedDetail = null
  let lastRunAt = 0
  let reconciliationTimer = null

  await emit(options, 'remote-pull.started', {
    state: 'enabled',
    mode: activityTriggersEnabled
      ? 'periodic-head-reconciliation-with-activity'
      : 'periodic-head-reconciliation',
    workspace: options.workspace,
    intervalMs: cooldownMs,
    cooldownMs,
    reconciliationIntervalMs: cooldownMs,
    activityTriggersEnabled,
    pushReconciliationEnabled,
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
    if (trigger === 'local-change' && !activityTriggersEnabled) return
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

  reconciliationTimer = setInterval(() => {
    schedule('periodic-head-reconciliation', {
      trigger: 'periodic-head-reconciliation',
    }).catch((error) => {
      console.error(error)
    })
  }, cooldownMs)
  reconciliationTimer.unref?.()

  return {
    schedule,
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      if (reconciliationTimer) clearInterval(reconciliationTimer)
      timer = null
      reconciliationTimer = null
    },
  }
}

export function remotePullActivitySummary(detail) {
  if (!detail || typeof detail !== 'object') return null
  return {
    trigger: detail.trigger ?? null,
    eventType: detail.eventType ?? null,
    path: detail.path ?? null,
    coalescedEvents: detail.coalescedEvents ?? null,
  }
}

export async function remotePullOnce(options) {
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

export async function remoteRefreshDecision(options, context) {
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

  const rawLocalChanges = await workspaceLocalChanges(options, indexedCodebase, { includePaths: true })
  let localChanges = rawLocalChanges
  if (!rawLocalChanges.safe) {
    // A stale content manifest can flag already-committed files as unjournaled
    // and wrongly skip a push apply. Read the visible graph (refresh was about
    // to do that anyway) and exonerate changes that already match cloud. The
    // exonerated result is compact (counts + ≤10-path samples), so the skip
    // detail embedded below stays bounded even for huge dirty workspaces.
    const visibleCloud = await cloudService.readVisibleGraph(visibilityRequestFromOptions(options))
    localChanges = await exonerateWorkspaceChangesAgainstCloud(options, rawLocalChanges, visibleCloud)
  }
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
    ...(localChanges.manifestStale
      ? {
          manifestSelfHealed: true,
          manifestStaleSamplePaths: localChanges.exoneratedSamplePaths ?? [],
          manifestStalePathCount: localChanges.exoneratedCount ?? 0,
        }
      : {}),
  }
}

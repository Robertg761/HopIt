// @ts-check
import fs from 'node:fs/promises'
import path from 'node:path'
import { createCloudGraphService, visibilityRequestFromOptions } from './cloud/d1-graph-service.js'
import { hydrateWorkspace, pruneWorkspaceCache } from './commands/hydrate.js'
import { initCloud } from './commands/import.js'
import { recoverJournal, refreshWorkspace, syncOnce } from './commands/sync.js'
import { defaultDiskPressureFreeBytesThreshold, defaultDiskPressureFreeFraction, defaultWorkspaceScanIntervalMs, diskPressureAccelerationFactor, legacySyncDebounceMs, minimumWorkspaceScanIntervalMs, workspaceMode } from './constants.js'
import { emit, findLastEventOf, readNdjson } from './io.js'
import { withCloudFetchRetry } from './cloud-retry.js'
import { createRemotePushClient } from './remote-push.js'
import { toCloudPath } from './journal.js'
import { assertWorkspacePathSafe, remotePullEnabled, remotePushEnabled, remoteRefreshIntervalMs, syncDebounceMs, syncMaxDelayMs, watchLimitPollIntervalMs } from './paths.js'
import { normalizeWatchFilename, readJournalSafety, visibleRevisionFromEvent } from './status-state.js'
import { findIndexedCodebase, readWorkspaceIndex } from './workspace-index.js'
import { exonerateWorkspaceChangesAgainstCloud, isLocalActivityMarkerPath, shouldSkipWorkspacePath, shouldTrackLocalActivityPath, workspaceLocalChanges } from './workspace-manifest.js'
import { acquireWorkspaceLock } from './workspace-lock.js'
import { watch } from 'node:fs'

// The Linux OS watch limit (fs.inotify.max_user_watches) surfaces from
// fs.watch as ENOSPC once every watchable inode in the workspace tree
// exhausts the kernel's inotify budget. Node re-uses ENOSPC for a couple of
// other rare fs failures too, but on the watch-constructor/watcher-error path
// this is specifically the watch-limit signal decisions §12 asks us to
// surface loudly rather than let sync silently stall.
export function isWatchLimitExhaustedError(error) {
  return error?.code === 'ENOSPC'
}

// Shown in the `watch.degraded` event, the status API, and `hop doctor` so the
// fix is discoverable wherever an operator looks, per decisions §12 ("surfaces
// a degraded-watch state ... with the fix").
export const watchLimitRemedyMessage =
  'HopIt could not start the native file watcher because the OS watch limit ' +
  '(inotify) is exhausted. It is syncing via periodic scans instead, so writes ' +
  'still sync but a little more slowly. To fix: run ' +
  '`sudo sysctl -w fs.inotify.max_user_watches=524288` for an immediate increase, ' +
  'and add `fs.inotify.max_user_watches=524288` to /etc/sysctl.conf (or a file ' +
  'under /etc/sysctl.d/) so the limit survives a reboot. HopIt picks the native ' +
  'watcher back up automatically the next time the agent starts.'

export async function watchWorkspace(options, deps = {}) {
  const watchFn = deps.watchFn ?? watch
  const createPoller = deps.createPoller ?? createWorkspacePoller
  await assertWorkspacePathSafe(options)
  // One agent per workspace (decisions doc §12): fail fast, before touching
  // the cloud service or journal, if another live agent already holds this
  // workspace folder.
  const workspaceLock = await acquireWorkspaceLock(options)

  try {
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
    let scanner = null
    let remotePuller = null
    let remotePusher = null
    let autoPruner = null
    const scheduleSync = createWatchSyncScheduler(options, {
      afterDrain: async (detail) => {
        await remotePuller?.schedule('local-change', detail)
      },
    })
    const degradeToPolling = async (error) => {
      const watchLimitExhausted = isWatchLimitExhaustedError(error)
      if (!poller) {
        poller = await createPoller(options.workspace, scheduleSync, {
          agentOptions: options,
          ...(watchLimitExhausted ? { intervalMs: watchLimitPollIntervalMs(options) } : {}),
        })
      }
      await emit(options, 'watch.degraded', {
        state: 'polling',
        workspace: options.workspace,
        reason: error.message,
        ...(watchLimitExhausted
          ? {
              kind: 'watch-limit-exhausted',
              code: error.code,
              remedy: watchLimitRemedyMessage,
            }
          : {}),
      })
    }

    try {
      watcher = watchFn(options.workspace, { recursive: true }, (eventType, filename) => {
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

    scanner = await createWorkspaceScanScheduler(options, {
      onChange: scheduleSync,
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
      async close() {
        try {
          watcher?.close()
        } catch {
          // Watchers may already be closed by an error handler.
        }
        scheduleSync.cancel?.()
        poller?.close()
        scanner?.close()
        remotePuller?.close()
        remotePusher?.close()
        autoPruner?.close()
        await workspaceLock.release()
      },
    }
  } catch (error) {
    // Startup failed after the lock was taken; release it so a retry (or a
    // different agent) is not blocked by a lock this process will never use.
    await workspaceLock.release()
    throw error
  }
}

// Idle window before an untouched codebase dehydrates back to metadata-only
// (decisions §11 default: 7 days). User-tunable via --auto-prune-inactive-ms /
// HOPIT_AUTO_PRUNE_INACTIVE_MS, and shortened automatically under disk
// pressure by diskPressureAcceleratedInactiveMs below.
const defaultAutoPruneIntervalMs = 6 * 60 * 60 * 1000
const defaultAutoPruneInactiveMs = 7 * 24 * 60 * 60 * 1000
const minimumAutoPruneMs = 60 * 1000

// Reads free/total space for the device backing the workspace root. Returns
// null (never throws) when statfs is unsupported or the path does not exist
// yet, so a disk-pressure read failure degrades to "no acceleration" rather
// than blocking the scheduler.
export async function statWorkspaceDisk(workspacePath) {
  try {
    const stats = await fs.statfs(workspacePath)
    const blockSize = Number(stats.bsize)
    if (!Number.isFinite(blockSize) || blockSize <= 0) return null
    return {
      freeBytes: Number(stats.bavail) * blockSize,
      totalBytes: Number(stats.blocks) * blockSize,
    }
  } catch {
    return null
  }
}

// GR-G1 (decisions §11): "disk-pressure acceleration (low free disk ⇒
// shorten window)". Pure function — tests inject synthetic disk stats rather
// than filling a real disk. When free space is below either the absolute or
// fractional floor, the idle window shrinks by accelerationFactor (never
// below the scheduler's minimum cadence); otherwise the configured window is
// returned unchanged. This only ever changes *when* already-synced content is
// evicted — it never touches the journal (see pruneWorkspaceCache) and never
// overrides the unacknowledged-write refusal.
export function diskPressureAcceleratedInactiveMs(baseInactiveMs, diskStats, thresholds = {}) {
  if (!diskStats || !Number.isFinite(diskStats.freeBytes)) return baseInactiveMs
  const freeBytesThreshold = thresholds.freeBytesThreshold ?? defaultDiskPressureFreeBytesThreshold
  const freeFractionThreshold = thresholds.freeFractionThreshold ?? defaultDiskPressureFreeFraction
  const accelerationFactor = thresholds.accelerationFactor ?? diskPressureAccelerationFactor
  const totalBytes = Number.isFinite(diskStats.totalBytes) && diskStats.totalBytes > 0 ? diskStats.totalBytes : null
  const freeFraction = totalBytes ? diskStats.freeBytes / totalBytes : 1
  const underPressure = diskStats.freeBytes < freeBytesThreshold || freeFraction < freeFractionThreshold
  if (!underPressure) return baseInactiveMs
  return Math.max(minimumAutoPruneMs, Math.round(baseInactiveMs * accelerationFactor))
}

export async function createAutoPruneScheduler(options, schedulerOptions = {}) {
  // auto-prune defaults on (GR-G1); only an explicit --no-auto-prune /
  // HOPIT_AUTO_PRUNE=0 (both surface as options['auto-prune'] === false)
  // disables it.
  if (options['auto-prune'] === false) return null

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
  const statDisk = schedulerOptions.statDisk ?? statWorkspaceDisk
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

      const diskStats = await statDisk(options.workspace)
      const effectiveInactiveMs = diskPressureAcceleratedInactiveMs(inactiveMs, diskStats)
      if (effectiveInactiveMs !== inactiveMs) {
        await emit(options, 'cache.auto_prune_disk_pressure', {
          state: 'accelerated',
          workspace: options.workspace,
          baseInactiveMs: inactiveMs,
          inactiveMs: effectiveInactiveMs,
          freeBytes: diskStats?.freeBytes ?? null,
          totalBytes: diskStats?.totalBytes ?? null,
        })
      }

      await pruneWorkspace({
        ...options,
        path: 'all',
        recursive: true,
        execute: true,
        'inactive-ms': String(effectiveInactiveMs),
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
  // Coalescing window. HOPIT_SYNC_DEBOUNCE_MS (or --sync-debounce-ms) tunes how
  // long rapid successive saves are collapsed before a single journaled sync;
  // 0 disables coalescing and restores the legacy micro-debounce with no cap.
  const debounceMs = schedulerOptions.debounceMs ?? syncDebounceMs(options)
  const coalescingEnabled = debounceMs > 0
  const waitMs = coalescingEnabled ? debounceMs : legacySyncDebounceMs
  // The delay cap bounds how long the first unsynced change is held so a user
  // who never stops typing still syncs within seconds. Disabled when coalescing
  // is off (legacy behavior never capped a change).
  const maxDelayMs = coalescingEnabled
    ? (schedulerOptions.maxDelayMs ?? syncMaxDelayMs(options, debounceMs))
    : null
  const runSync = schedulerOptions.syncOnce ?? syncOnce
  const now = schedulerOptions.now ?? (() => Date.now())

  let waitTimer = null
  let capTimer = null
  let running = false
  let queued = false
  let queuedEvents = 0
  let queuedSyncEvents = 0
  let lastEvent = null
  let windowStartedAt = null

  const clearCap = () => {
    if (capTimer) clearTimeout(capTimer)
    capTimer = null
    windowStartedAt = null
  }

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
        // A change that arrives during the drain starts a fresh coalescing
        // window, so retire the current cap now that we are committing.
        clearCap()

        if (syncableEvents > 0) {
          try {
            await runSync(options, {
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

  const flush = () => {
    if (waitTimer) clearTimeout(waitTimer)
    waitTimer = null
    clearCap()
    drain().catch((error) => {
      console.error(error)
    })
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

    // Reset the quiet-window timer on every save so a tight burst collapses into
    // one flush once activity settles.
    clearTimeout(waitTimer)
    waitTimer = setTimeout(() => {
      waitTimer = null
      flush()
    }, waitMs)

    // Arm the hard delay cap from the first change in this window. It is not
    // reset by later saves, so a continuous editing stream still flushes by the
    // cap and never starves the invisible-sync promise.
    if (coalescingEnabled) {
      if (windowStartedAt === null) windowStartedAt = now()
      if (capTimer === null) {
        const capRemaining = Math.max(0, maxDelayMs - (now() - windowStartedAt))
        capTimer = setTimeout(() => {
          capTimer = null
          windowStartedAt = null
          flush()
        }, capRemaining)
      }
    }
  }

  schedule.isIdle = () => !running && !queued && waitTimer === null && capTimer === null
  // Drop any armed window without flushing. Used on shutdown so a pending
  // coalescing window does not fire a stray sync after the watcher is closed.
  schedule.cancel = () => {
    if (waitTimer) clearTimeout(waitTimer)
    waitTimer = null
    clearCap()
  }
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

const minimumWorkspaceScanMs = minimumWorkspaceScanIntervalMs

// Periodic full workspace diff-scan (GR-H1 / decisions §12). Missed watcher
// events are assumed, not exceptional: a dropped FSEvents/inotify notification
// leaves a write invisible to the debounced watch scheduler until something
// else notices it. This scheduler runs independently of both the fs watcher
// (which may be healthy, degraded to polling, or unavailable) and the 5-min
// cloud graph-head reconciliation (which only covers the cloud side) — it
// re-walks the on-disk tree every interval, compares it to the last scan, and
// feeds any drift into the normal watch-sync path exactly like a live watcher
// event would, so a missed write heals within one scan interval. The walk
// reuses snapshotWorkspace's cheap stat-based comparison (no content hashing)
// and shouldSkipWorkspacePath's derived-path exclusions (GR-C1), keeping the
// cost bounded even on large trees.
export async function createWorkspaceScanScheduler(options, schedulerOptions = {}) {
  const intervalMs = schedulerOptions.intervalMs ?? parseWorkspaceScanMs(
    options['scan-interval-ms'],
    defaultWorkspaceScanIntervalMs,
    '--scan-interval-ms',
  )
  const onChange = schedulerOptions.onChange ?? (() => {})
  const takeSnapshot = schedulerOptions.snapshotWorkspace ?? snapshotWorkspace
  let closed = false
  let running = false
  let previousSnapshot = await takeSnapshot(options.workspace, options)

  await emit(options, 'watch.scan_started', {
    state: 'scheduled',
    workspace: options.workspace,
    intervalMs,
  })

  const run = async () => {
    if (closed || running) return
    running = true
    const startedAt = Date.now()

    try {
      const nextSnapshot = await takeSnapshot(options.workspace, options)
      const changed = nextSnapshot !== previousSnapshot
      const changedPath = changed ? firstChangedSnapshotPath(previousSnapshot, nextSnapshot) : null
      previousSnapshot = nextSnapshot

      await emit(options, 'watch.scan_completed', {
        state: 'completed',
        workspace: options.workspace,
        durationMs: Date.now() - startedAt,
        changed,
      })

      if (changed) {
        await emit(options, 'watch.scan_healed', {
          state: 'healed',
          workspace: options.workspace,
          path: changedPath,
        })
        onChange('scan', changedPath)
      }
    } catch (error) {
      await emit(options, 'watch.scan_failed', {
        state: 'failed',
        workspace: options.workspace,
        reason: error instanceof Error ? error.message : 'scan_failed',
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
    // Exposed so tests can force a scan deterministically instead of racing
    // the interval timer.
    runOnce: run,
    close() {
      closed = true
      clearInterval(timer)
    },
  }
}

export function parseWorkspaceScanMs(rawValue, fallback, optionName) {
  const value = Number(rawValue ?? fallback)
  if (!Number.isInteger(value) || value < minimumWorkspaceScanMs) {
    throw new Error(`Invalid ${optionName} value: ${rawValue ?? fallback}. Use at least ${minimumWorkspaceScanMs}ms.`)
  }
  return value
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

export async function remotePullOnce(options, inject = {}) {
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
      cloudService: inject.cloudService,
      retryOptions: inject.retryOptions,
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

// Wraps a single cloud read (graph head / visible graph) performed by the
// remote-pull decision in the same bounded transient-retry used by hydration.
// A dropped socket mid-reconciliation (observed live as bare `fetch failed`
// during periodic-head-reconciliation) is retried instead of immediately
// surfacing as `remote-pull.failed`. On recovery we journal `cloud.fetch_recovered`
// (same convention as hydrate) so the flakiness stays observable; exhausted
// retries re-throw so the caller still emits `remote-pull.failed`.
function withRemotePullFetchRetry(options, context, phase, fn) {
  return withCloudFetchRetry(fn, {
    ...(context.retryOptions ?? {}),
    onRetrySuccess: async ({ attempt, failures, error }) => {
      await emit(options, 'cloud.fetch_recovered', {
        phase,
        trigger: context.trigger,
        attempts: attempt,
        failures,
        reason: error instanceof Error ? error.message : error != null ? String(error) : null,
        code: error?.code ?? error?.cause?.code ?? null,
        workspace: options.workspace,
        safeRefreshOnly: true,
      })
    },
  })
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

  const cloudService = context.cloudService ?? createCloudGraphService(options)
  const cloudHead = await withRemotePullFetchRetry(options, context, 'head-reconciliation', () =>
    cloudService.readGraphHead(),
  )
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
    const visibleCloud = await withRemotePullFetchRetry(options, context, 'exoneration-visible-graph', () =>
      cloudService.readVisibleGraph(visibilityRequestFromOptions(options)),
    )
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

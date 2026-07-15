// Trail-episode clustering. Raw trail steps (one per graph revision) are too
// fine-grained to browse one by one, so a run of steps from the same device
// with no long pause collapses into a single "episode": the browse/rollback
// unit that a cheap model later labels. This module is PURE: it takes the
// file-version rows the WS7c history layer already records (path, device,
// timestamp per revision) and returns deterministic episodes. No I/O, no model.

export const DEFAULT_EPISODE_GAP_MS = 30 * 60 * 1000 // 30 minutes
export const DEFAULT_SAMPLE_PATH_LIMIT = 5

/**
 * Cluster file-version rows into trail episodes.
 *
 * A "step" is one graph revision (a single save, which may touch many files).
 * Consecutive steps join the same episode while they share a device and the
 * gap between them stays under `gapMs`. Ordering is by timestamp, then by
 * revision, so the result is fully deterministic for a given input.
 *
 * @param {Array<object>} versionRows rows shaped like `listFileVersions()` output
 * @param {{ gapMs?: number, sampleLimit?: number }} [options]
 * @returns {Array<object>} episodes
 */
export function clusterEpisodes(versionRows, options = {}) {
  const gapMs = normalizeGapMs(options.gapMs)
  const sampleLimit = normalizeSampleLimit(options.sampleLimit)
  const steps = stepsFromVersionRows(versionRows)

  const episodes = []
  let current = null

  for (const step of steps) {
    if (
      current &&
      current.device === step.device &&
      step.atMs - current.lastStepAtMs <= gapMs
    ) {
      appendStepToEpisode(current, step)
    } else {
      if (current) episodes.push(finalizeEpisode(current, sampleLimit))
      current = startEpisode(step)
    }
  }
  if (current) episodes.push(finalizeEpisode(current, sampleLimit))

  return episodes
}

/**
 * Collapse file-version rows into ordered per-revision steps. Exported for
 * tests and callers that want the intermediate representation.
 */
export function stepsFromVersionRows(versionRows) {
  const byRevision = new Map()

  for (const raw of Array.isArray(versionRows) ? versionRows : []) {
    const revision = integerOrNull(raw?.graphRevision ?? raw?.graph_revision)
    const atMs = timestampMs(raw?.createdAt ?? raw?.created_at)
    if (revision === null || atMs === null) continue
    const device = deviceOrNull(raw?.deviceName ?? raw?.device_name ?? raw?.device)
    const filePath = typeof raw?.path === 'string' ? raw.path : null

    let step = byRevision.get(revision)
    if (!step) {
      step = { revision, device, atMs, atIso: isoFromMs(atMs), paths: new Set() }
      byRevision.set(revision, step)
    } else {
      // Rows in one revision should agree on device/time; be defensive and
      // keep the earliest timestamp and the first non-null device so the
      // clustering stays deterministic regardless of row order.
      if (atMs < step.atMs) {
        step.atMs = atMs
        step.atIso = isoFromMs(atMs)
      }
      if (step.device === null && device !== null) step.device = device
    }
    if (filePath) step.paths.add(filePath)
  }

  return [...byRevision.values()].sort(
    (a, b) => a.atMs - b.atMs || a.revision - b.revision,
  )
}

function startEpisode(step) {
  return {
    device: step.device,
    fromRevision: step.revision,
    toRevision: step.revision,
    startedAt: step.atIso,
    endedAt: step.atIso,
    lastStepAtMs: step.atMs,
    stepCount: 1,
    paths: new Set(step.paths),
  }
}

function appendStepToEpisode(episode, step) {
  episode.toRevision = step.revision
  episode.endedAt = step.atIso
  episode.lastStepAtMs = step.atMs
  episode.stepCount += 1
  for (const filePath of step.paths) episode.paths.add(filePath)
}

function finalizeEpisode(episode, sampleLimit) {
  const sortedPaths = [...episode.paths].sort()
  return {
    episodeId: episodeId(episode.fromRevision, episode.toRevision),
    fromRevision: episode.fromRevision,
    toRevision: episode.toRevision,
    deviceName: episode.device,
    startedAt: episode.startedAt,
    endedAt: episode.endedAt,
    stepCount: episode.stepCount,
    changedPathCount: sortedPaths.length,
    samplePaths: sortedPaths.slice(0, sampleLimit),
  }
}

// Episode ids are deterministic and stable: episodes never overlap, so a
// (fromRevision, toRevision) pair uniquely identifies one within a codebase.
export function episodeId(fromRevision, toRevision) {
  return `ep_${fromRevision}_${toRevision}`
}

function normalizeGapMs(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_EPISODE_GAP_MS
  return parsed
}

function normalizeSampleLimit(value) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_SAMPLE_PATH_LIMIT
  return parsed
}

function integerOrNull(value) {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return Number.isSafeInteger(parsed) ? parsed : null
}

function deviceOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function timestampMs(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function isoFromMs(ms) {
  return new Date(ms).toISOString()
}

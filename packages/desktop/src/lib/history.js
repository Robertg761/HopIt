// @ts-check
// User-facing name for this view is "Trail"; the internal identifiers
// (projectHistory, deriveHistory, history.js) stay as-is on purpose.
// Derive a per-project revision history from the agent's event journal (the
// /events endpoint `recent` array). We only surface what the events actually
// carry: the endpoint returns a bounded recent window, so this is an honest
// "recent revisions" view, not a complete log. Fields are read from the real
// event detail shapes:
//   sync.complete      -> { trigger, path, writes, revision }
//   sync.bulk_commit   -> { count, fromRevision, toRevision, paths[] }
//   refresh.complete   -> { revision, written, deleted, changedPaths[], deletedPaths[] }
//   remote-push.applied-> { trigger, fromRevision, toRevision } (no path detail)
//   remote-pull.applied-> { revision }
// When an event does not carry a changed-path count we record null so the UI can
// render "Not available" rather than fabricate a number.

const SAMPLE_CAP = 12

/** Classify the trigger behind a revision-advancing event. */
export function triggerForEvent(eventName) {
  switch (eventName) {
    case 'sync.complete':
    case 'sync.bulk_commit':
    case 'cloud.acknowledged':
      return { code: 'local', label: 'Local edit' }
    case 'remote-push.applied':
    case 'remote-pull.applied':
      return { code: 'remote', label: 'Another device' }
    case 'refresh.complete':
      return { code: 'refresh', label: 'Refresh from cloud' }
    default:
      return { code: 'other', label: 'Update' }
  }
}

/**
 * Extract a normalized revision record from a single event, or null if the event
 * does not advance/represent a revision we can attribute.
 * @param {{ event?: string, detail?: any, at?: string }} entry
 */
export function revisionFromEvent(entry) {
  const name = entry?.event
  const detail = entry?.detail ?? {}
  const at = entry?.at ?? null
  const trigger = triggerForEvent(name ?? '')

  switch (name) {
    case 'sync.bulk_commit': {
      const revision = detail.toRevision ?? detail.revision ?? null
      if (revision == null) return null
      return {
        revision,
        at,
        trigger,
        // Bulk commits carry their own span; the Trail compares exactly it.
        fromRevision: typeof detail.fromRevision === 'number' ? detail.fromRevision : null,
        changedCount: typeof detail.count === 'number' ? detail.count : Array.isArray(detail.paths) ? detail.paths.length : null,
        samplePaths: sample(detail.paths),
        event: name,
      }
    }
    case 'sync.complete': {
      const revision = detail.revision ?? null
      if (revision == null) return null
      const writes = typeof detail.writes === 'number' ? detail.writes : null
      const samplePaths = writes && detail.path ? [detail.path] : []
      return { revision, at, trigger, changedCount: writes, samplePaths, event: name }
    }
    case 'refresh.complete': {
      const revision = detail.revision ?? null
      if (revision == null) return null
      const changed = [...(detail.changedPaths ?? []), ...(detail.deletedPaths ?? [])]
      const count =
        typeof detail.written === 'number' || typeof detail.deleted === 'number'
          ? (detail.written ?? 0) + (detail.deleted ?? 0)
          : changed.length || null
      return { revision, at, trigger, changedCount: count, samplePaths: sample(changed), event: name }
    }
    case 'remote-push.applied': {
      const revision = detail.toRevision ?? detail.pushedRevision ?? detail.revision ?? null
      if (revision == null) return null
      // A push carries the span it applied; use it as the compare's left edge.
      const fromRevision = typeof detail.fromRevision === 'number' ? detail.fromRevision : null
      return { revision, at, trigger, fromRevision, changedCount: null, samplePaths: [], event: name }
    }
    case 'remote-pull.applied': {
      const revision = detail.toRevision ?? detail.revision ?? null
      if (revision == null) return null
      return { revision, at, trigger, changedCount: null, samplePaths: [], event: name }
    }
    default:
      return null
  }
}

/**
 * Build the history rows (one per revision, newest first) from a recent-events
 * array. When multiple events reference the same revision, the one carrying the
 * most path detail wins so the row is as informative as the data allows.
 * @param {Array<{event?: string, detail?: any, at?: string}>} recent
 * @param {{ limit?: number }} [opts]
 */
export function deriveHistory(recent, opts = {}) {
  const { limit = 30 } = opts
  /** @type {Map<number|string, any>} */
  const byRevision = new Map()
  for (const entry of Array.isArray(recent) ? recent : []) {
    const record = revisionFromEvent(entry)
    if (!record) continue
    const existing = byRevision.get(record.revision)
    if (!existing || informationScore(record) > informationScore(existing)) {
      byRevision.set(record.revision, record)
    }
  }
  return [...byRevision.values()]
    .sort((a, b) => Number(b.revision) - Number(a.revision))
    .slice(0, limit)
}

function informationScore(record) {
  let score = 0
  if (record.samplePaths?.length) score += record.samplePaths.length
  if (typeof record.changedCount === 'number') score += 1
  // Prefer records that name a concrete trigger over the generic fallback.
  if (record.trigger?.code && record.trigger.code !== 'other') score += 0.5
  return score
}

function sample(paths) {
  if (!Array.isArray(paths)) return []
  return paths.slice(0, SAMPLE_CAP)
}

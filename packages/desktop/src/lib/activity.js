// @ts-check
// Turn raw agent event entries (from the /events endpoint `recent` array) into
// human-readable one-liners for the Activity strip. Pure and unit-tested.
//
// Each event is `{ event: string, detail?: object, at?: string }`. Unknown event
// names fall back to a humanized form of the event key so new agent events still
// render something sensible rather than being dropped.

/**
 * @param {string} eventName
 * @param {any} [detail]
 * @returns {string}
 */
export function describeEvent(eventName, detail = {}) {
  const rev = detail?.toRevision ?? detail?.revision ?? detail?.lastPushedRevision ?? null
  const revSuffix = rev != null ? ` (rev ${rev})` : ''
  switch (eventName) {
    case 'workspace.ready':
      return `Workspace ready${revSuffix}`
    case 'workspace.opened':
      return 'Workspace opened'
    case 'file.hydrated':
      return `Hydrated ${detail?.path ?? 'a file'}`
    case 'write.journaled':
      return `Recorded a local change to ${detail?.path ?? 'a file'}`
    case 'cloud.acknowledged':
      return `Cloud acknowledged a change${revSuffix}`
    case 'cloud.initialized':
      return 'Cloud graph initialized'
    case 'sync.started':
      return 'Sync started'
    case 'sync.complete':
      return `Sync complete${revSuffix}`
    case 'sync.failed':
      return `Sync failed${detail?.reason ? `: ${detail.reason}` : ''}`
    case 'sync.recovered':
      return 'Sync recovered after a failure'
    case 'sync.bulk_commit':
      return `Bulk sync committed${detail?.count ? ` ${detail.count} files` : ''}${revSuffix}`
    case 'refresh.started':
      return 'Refresh started'
    case 'refresh.complete':
      return `Refreshed from cloud${revSuffix}`
    case 'refresh.blocked':
      return `Refresh blocked${detail?.reason ? `: ${detail.reason}` : ''}`
    case 'remote-update':
      return `Remote update available${revSuffix}`
    case 'remote-pull.started':
      return 'Checking for remote changes'
    case 'remote-pull.applied':
      return `Applied remote changes${revSuffix}`
    case 'remote-pull.skipped':
      return 'No remote changes to apply'
    case 'remote-pull.failed':
      return 'Remote pull failed'
    case 'remote-push.started':
      return 'Connecting to the sync hub'
    case 'remote-push.connected':
      return 'Connected to the sync hub'
    case 'remote-push.disconnected':
      return 'Disconnected from the sync hub'
    case 'remote-push.fallback_polling':
      return 'Sync hub offline — polling instead'
    case 'remote-push.applied':
      return `Applied a pushed change${revSuffix}`
    case 'remote-push.failed':
      return 'Push apply failed'
    case 'watch.started':
      return 'Background watch started'
    case 'watch.degraded':
      return 'Background watch degraded'
    case 'watch.recovery_blocked':
      return 'Watch blocked pending recovery'
    case 'journal.recovery_complete':
      return 'Recovery complete'
    case 'journal.recovery_failed':
      return 'Recovery failed'
    case 'change_set.review_opened':
      return 'Change set opened for review'
    case 'change_set.merged':
      return `Change set merged${revSuffix}`
    case 'change_set.conflict_detected':
      return 'Conflict detected'
    default:
      return humanizeEventName(eventName)
  }
}

/** Fallback: "some.event_name" -> "Some event name". */
export function humanizeEventName(eventName) {
  if (!eventName) return 'Activity'
  const words = String(eventName).replace(/[._]/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * Format one event entry into an activity line.
 * @param {{ event?: string, detail?: any, at?: string }} entry
 * @param {{ codebaseId?: string }} [context]
 */
export function formatActivityLine(entry, context = {}) {
  const text = describeEvent(entry?.event ?? '', entry?.detail ?? {})
  return {
    text: context.codebaseId ? `${context.codebaseId}: ${text}` : text,
    event: entry?.event ?? null,
    at: entry?.at ?? null,
    relative: entry?.at ? relativeTime(entry.at) : null,
  }
}

/**
 * Format a recent-events array (newest last, as the endpoint returns) into
 * activity lines ordered newest-first, capped at `limit`.
 * @param {Array<{event?: string, detail?: any, at?: string}>} recent
 * @param {{ limit?: number, codebaseId?: string, now?: number }} [opts]
 */
export function formatActivity(recent, opts = {}) {
  const { limit = 20, codebaseId } = opts
  const entries = Array.isArray(recent) ? recent.slice() : []
  entries.reverse()
  return entries.slice(0, limit).map((entry) => formatActivityLine(entry, { codebaseId }))
}

/** Compact relative time like "5s", "3m", "2h", "1d". */
export function relativeTime(iso, now = Date.now()) {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return null
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  return `${days}d`
}

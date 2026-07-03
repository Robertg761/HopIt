import type { RawAgentStatus } from './normalize'

export function remotePullModeLabel(remotePull: RawAgentStatus['remotePull']) {
  if (!remotePull?.enabled) return 'Disabled'

  const detailMode = remotePull.lastStarted?.detail?.mode
  const detailState = remotePull.lastStarted?.detail?.state
  if (detailMode === 'local-change-cooldown' || detailState === 'activity-gated') {
    return 'Activity gated'
  }

  return titleCase(remotePull.state ?? 'enabled')
}

export function remotePullCadenceLabel(remotePull: RawAgentStatus['remotePull']) {
  if (!remotePull?.enabled) return 'No remote pull'

  const cooldownMs =
    numberOrNull(remotePull.lastStarted?.detail?.cooldownMs) ?? numberOrNull(remotePull.intervalMs)
  return cooldownMs === null ? 'Cooldown unknown' : `${formatDuration(cooldownMs)} cooldown`
}

export function formatDuration(ms: number) {
  if (ms % 60000 === 0) return `${ms / 60000} min`
  if (ms % 1000 === 0) return `${ms / 1000} sec`
  return `${ms} ms`
}

export function titleCase(value: string) {
  return value
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}


export function formatRevision(prefix: string, revision: number | null | undefined) {
  return typeof revision === 'number' ? `${prefix} ${revision}` : 'Unavailable'
}

export function formatEventTime(timestamp: string | null | undefined) {
  if (!timestamp) return 'Unavailable'

  const time = new Date(timestamp).getTime()
  if (Number.isNaN(time)) return 'Unavailable'

  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000))
  if (seconds < 5) return 'now'
  if (seconds < 60) return `${seconds} sec ago`

  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`

  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hr ago`

  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}


function numberOrNull(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

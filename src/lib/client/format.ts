const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 1000 * 60 * 60 * 24 * 365],
  ['month', 1000 * 60 * 60 * 24 * 30],
  ['week', 1000 * 60 * 60 * 24 * 7],
  ['day', 1000 * 60 * 60 * 24],
  ['hour', 1000 * 60 * 60],
  ['minute', 1000 * 60],
]

const relativeFormatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'narrow' })

export function formatRelativeTime(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'Not available'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : 'Not available'

  const delta = date.getTime() - Date.now()
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (Math.abs(delta) >= ms) {
      return relativeFormatter.format(Math.round(delta / ms), unit)
    }
  }
  return 'just now'
}

export function formatAbsoluteTime(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : ''
  return date.toLocaleString()
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return 'Not available'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 'B'
  for (const next of units) {
    if (value < 1024) break
    value /= 1024
    unit = next
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${unit}`
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'Not available'
  return new Intl.NumberFormat('en').format(value)
}

import { shouldAllowBasicAuthFallback } from '@/lib/auth-config'
import { warnBasicAuthFallbackEnabledOnce } from './basic-auth-fallback-guard'

export function hasValidBasicAuthFallbackCredentials(headers: Headers) {
  if (!shouldAllowBasicAuthFallback()) return false
  warnBasicAuthFallbackEnabledOnce()
  const expectedPassword = process.env.HOPIT_DASHBOARD_PASSWORD
  if (!expectedPassword) return false

  const expectedUsername = process.env.HOPIT_DASHBOARD_USERNAME ?? 'hopit'
  const credentials = readBasicCredentials(headers.get('authorization'))

  return Boolean(
    credentials &&
      credentials.username === expectedUsername &&
      credentials.password === expectedPassword,
  )
}

function readBasicCredentials(header: string | null) {
  if (!header?.startsWith('Basic ')) return null

  try {
    const decoded = atob(header.slice('Basic '.length))
    const separator = decoded.indexOf(':')
    if (separator === -1) return null

    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    }
  } catch {
    return null
  }
}

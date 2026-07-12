// @ts-check
// Thin HTTP client for the local agent status/events endpoints. Uses the global
// fetch available in the Electron main process (Node 18+). Never throws for an
// unreachable service: a stopped codebase service simply reports reachable:false
// so the tray can show "service stopped" rather than crashing the poll loop.

/**
 * @param {string} url
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ reachable: boolean, status: any, error: string|null }>}
 */
export async function fetchStatus(url, opts = {}) {
  const { timeoutMs = 4000 } = opts
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      return { reachable: false, status: null, error: `HTTP ${response.status}` }
    }
    const status = await response.json()
    return { reachable: true, status, error: null }
  } catch (error) {
    return { reachable: false, status: null, error: describeFetchError(error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * @param {string} url
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ reachable: boolean, events: any, error: string|null }>}
 */
export async function fetchEvents(url, opts = {}) {
  const { timeoutMs = 4000 } = opts
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return { reachable: false, events: null, error: `HTTP ${response.status}` }
    const events = await response.json()
    return { reachable: true, events, error: null }
  } catch (error) {
    return { reachable: false, events: null, error: describeFetchError(error) }
  } finally {
    clearTimeout(timer)
  }
}

function describeFetchError(error) {
  if (error && typeof error === 'object') {
    const err = /** @type {any} */ (error)
    if (err.name === 'AbortError') return 'timeout'
    if (err.cause?.code === 'ECONNREFUSED' || err.code === 'ECONNREFUSED') return 'connection refused'
    if (typeof err.message === 'string') return err.message
  }
  return 'unreachable'
}

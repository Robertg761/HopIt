// @ts-check

// Bounded retry-with-backoff for per-entry cloud reads (blob fetches) during
// hydration. A single dropped connection (observed live as
// `TypeError: fetch failed` / `SocketError: other side closed`,
// code UND_ERR_SOCKET) must not abort a long hydrate and force a manual re-run.
// We retry ONLY transient network faults; auth/validation (4xx) errors fail
// immediately so a misconfigured request is not silently hammered.

const defaultTransientCodes = new Set([
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
])

function statusFromError(error) {
  const candidate = error?.status ?? error?.statusCode ?? error?.response?.status ?? error?.cause?.status
  return Number.isInteger(candidate) ? candidate : null
}

function messageMatchesTransient(message) {
  if (typeof message !== 'string' || message.length === 0) return false
  return /fetch failed|other side closed|socket hang up|network|terminated|premature close|connection (?:reset|closed|refused|timed out)/i.test(
    message,
  )
}

export function isTransientCloudError(error) {
  if (!error) return false

  // HTTP status wins: 429 and 5xx are transient; any other 4xx (401/403/400/…)
  // is a hard auth/validation failure and must never be retried.
  const status = statusFromError(error)
  if (status !== null) {
    if (status === 429) return true
    if (status >= 500 && status <= 599) return true
    if (status >= 400 && status <= 499) return false
  }

  const code = error.code ?? error.cause?.code ?? null
  if (typeof code === 'string' && defaultTransientCodes.has(code)) return true

  // Undici surfaces dropped sockets as `TypeError: fetch failed` with the real
  // fault on `error.cause`. Inspect both layers.
  if (messageMatchesTransient(error.message)) return true
  if (messageMatchesTransient(error.cause?.message)) return true

  return false
}

function defaultSleep(delayMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs)
    timer.unref?.()
  })
}

// Runs `fn` (which performs one cloud fetch attempt) with bounded exponential
// backoff. Returns the first successful result. Re-throws immediately on a
// non-transient error or once attempts are exhausted (preserving the existing
// "fail the command after retries" behavior). When a retry finally succeeds,
// `onRetrySuccess({ attempt, failures, error })` is invoked so the flakiness is
// observable in the journal.
export async function withCloudFetchRetry(fn, retryOptions = {}) {
  const attempts = Number.isInteger(retryOptions.attempts) && retryOptions.attempts > 0 ? retryOptions.attempts : 5
  const baseDelayMs = Number.isFinite(retryOptions.baseDelayMs) && retryOptions.baseDelayMs >= 0 ? retryOptions.baseDelayMs : 250
  const maxDelayMs = Number.isFinite(retryOptions.maxDelayMs) && retryOptions.maxDelayMs >= 0 ? retryOptions.maxDelayMs : 5000
  const sleep = typeof retryOptions.sleep === 'function' ? retryOptions.sleep : defaultSleep
  const isTransient = typeof retryOptions.isTransient === 'function' ? retryOptions.isTransient : isTransientCloudError
  const onRetrySuccess = typeof retryOptions.onRetrySuccess === 'function' ? retryOptions.onRetrySuccess : null

  let failures = 0
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await fn(attempt)
      if (failures > 0 && onRetrySuccess) {
        await onRetrySuccess({ attempt, failures, error: lastError })
      }
      return result
    } catch (error) {
      lastError = error
      if (attempt >= attempts || !isTransient(error)) throw error
      failures += 1
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
      await sleep(delay, { attempt, error })
    }
  }
  throw lastError
}

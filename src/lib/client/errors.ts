/**
 * Turn raw backend/vendor error strings into short, human-readable notes.
 * Raw messages (Clerk stack hints, JSON parse noise, proxy errors) must never
 * reach the page — always route user-facing error text through this.
 */
export function humanizeApiError(message: string | null | undefined): string {
  const text = (message ?? '').trim()
  if (!text) return 'The request failed.'

  if (/Clerk|clerkMiddleware|browser_auth_required|Product auth/i.test(text)) {
    return 'Sign in with your HopIt account to load collaboration data.'
  }
  if (/Unexpected end of JSON|Unexpected token|JSON input/i.test(text)) {
    return 'The server returned an unexpected response. It may require sign-in or still be starting up.'
  }
  if (/D1 backend|d1_required|cloud backend|No HopIt cloud backend|cloud_backend_unavailable/i.test(text)) {
    return 'The hosted cloud backend is not available in this environment.'
  }
  if (/Failed to fetch|NetworkError|ECONNREFUSED|fetch failed/i.test(text)) {
    return 'Could not reach the server. Check your connection and try again.'
  }
  if (/Internal Server Error/i.test(text)) {
    return 'The server hit an internal error. Try again in a moment.'
  }
  if (text.length > 160) return `${text.slice(0, 157)}…`
  return text
}

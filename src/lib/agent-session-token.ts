import type { NextRequest } from 'next/server'

// Agent session tokens ("hst_"-prefixed) are the credential the AI collaborator
// and CLI use to reach the Next.js API routes without a Clerk browser session.
// This module holds the ONE canonical parser for that token so the edge
// middleware (src/proxy.ts) and the Node route helper
// (src/lib/request-cloud-actor.ts) agree byte-for-byte on what counts as a
// well-shaped token. The middleware only recognizes the shape and defers; the
// REAL validation (lookup / revocation / expiry / codebase scope) happens in
// request-cloud-actor via requireD1AgentAccess.

const AGENT_SESSION_TOKEN_PREFIX = 'hst_'

/**
 * Extract a well-shaped agent session token from either accepted header form:
 *  - `x-hopit-agent-session-token: hst_...`
 *  - `Authorization: Bearer hst_...`
 *
 * Returns the raw token string when the shape matches, otherwise `null`. This
 * performs NO validation beyond the `hst_` prefix. It never touches D1 and is
 * safe to call in the edge runtime.
 */
export function agentSessionTokenFromHeaders(headers: Headers): string | null {
  const explicit = headers.get('x-hopit-agent-session-token')?.trim()
  if (explicit?.startsWith(AGENT_SESSION_TOKEN_PREFIX)) return explicit

  const authorization = headers.get('authorization')?.trim()
  const match = authorization?.match(/^Bearer\s+(.+)$/i)
  const token = match?.[1]?.trim()
  return token?.startsWith(AGENT_SESSION_TOKEN_PREFIX) ? token : null
}

/**
 * Decide whether the Clerk middleware should step aside and let a request reach
 * its route handler, where `cloudActorFromRequest` performs the real token
 * validation. True only for `/api` requests that carry a well-shaped agent
 * session token in either header form.
 *
 * Deliberately narrow:
 *  - Non-`/api` paths (pages) are NEVER bypassed, even with an `hst_` header.
 *    they keep full Clerk protection.
 *  - A malformed token (missing `hst_` prefix) does NOT bypass; such a request
 *    stays on the Clerk path exactly as before.
 *
 * This function does NOT validate the token (no D1 access in the edge runtime). A
 * forged-but-well-shaped token bypasses Clerk here and is then rejected by the
 * route's `cloudActorFromRequest` path with a JSON 4xx envelope.
 */
export function shouldBypassClerkForAgentToken(request: NextRequest): boolean {
  const pathname = request.nextUrl.pathname
  if (pathname !== '/api' && !pathname.startsWith('/api/')) return false
  return agentSessionTokenFromHeaders(request.headers) !== null
}

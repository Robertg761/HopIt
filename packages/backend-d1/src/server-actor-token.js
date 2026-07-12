import { createHmac } from 'node:crypto'

// Per-request credential the hosted dashboard presents to the D1 Worker when
// HOPIT_MULTITENANT is on, replacing the omnipotent proxy token on the tenant
// request path. The token carries the authenticated Clerk user id and an HMAC
// (keyed by the shared HOPIT_D1_SERVER_ACTOR_SECRET) so the Worker can re-derive
// a trusted user id and enforce per-codebase entitlement — see
// cloudflare/d1/api-worker.js verifyServerActorToken. Format:
//   hsa_<base64url(payloadJson)>.<base64url(hmac-sha256(secret, payloadPart))>
export const serverActorTokenPrefix = 'hsa_'
export const defaultServerActorTokenTtlMs = 60_000

export function mintServerActorToken({ userId, secret, ttlMs = defaultServerActorTokenTtlMs, now = Date.now() }) {
  if (!userId) throw new Error('Server actor token requires a user id.')
  if (!secret) throw new Error('Server actor token requires a signing secret.')
  const issuedAt = typeof now === 'number' ? now : Date.now()
  const payload = { u: userId, iat: issuedAt, exp: issuedAt + ttlMs }
  const payloadPart = base64UrlFromString(JSON.stringify(payload))
  const signature = createHmac('sha256', secret).update(payloadPart).digest('base64url')
  return `${serverActorTokenPrefix}${payloadPart}.${signature}`
}

function base64UrlFromString(value) {
  return Buffer.from(value, 'utf8').toString('base64url')
}

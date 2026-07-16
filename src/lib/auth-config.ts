export const signInPath = '/sign-in'
export const signUpPath = '/sign-up'
export const signedInHomePath = '/overview'

export function isClerkPublicConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY)
}

export function isClerkServerConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY)
}

export function shouldEnableClerkUi() {
  return shouldUseClerkAuth() && isClerkPublicConfigured()
}

export function isHostedRuntime() {
  return process.env.VERCEL === '1' || process.env.HOPIT_REQUIRE_CLOUD === '1'
}

export function shouldUseClerkAuth() {
  if (process.env.HOPIT_AUTH_PROVIDER === 'basic') return false
  if (process.env.HOPIT_AUTH_PROVIDER === 'clerk') return true
  return isClerkServerConfigured()
}

// Master multi-tenant flag (Phase 3). Mirrors the backend's truthy parsing
// (config.js truthyEnv) so the Next app and @hopit/backend-d1 agree on when
// tenancy is on. Default off => single-tenant production is byte-for-byte
// unchanged until the owner flips it.
export function isMultiTenant() {
  return /^(1|true|yes|on)$/i.test(String(process.env.HOPIT_MULTITENANT ?? ''))
}

export function shouldAllowBasicAuthFallback() {
  // Design decision 10 / §2e item 7: the basic-auth fallback resolves to an
  // empty wildcard actor ({}), a tenant bypass in a real multi-tenant world.
  // When tenancy is on it is forced OFF regardless of
  // HOPIT_ALLOW_BASIC_AUTH_FALLBACK, which structurally closes the empty-actor
  // path (hasValidBasicAuthFallbackCredentials can then never return true).
  if (isMultiTenant()) return false
  return process.env.HOPIT_ALLOW_BASIC_AUTH_FALLBACK === '1'
}

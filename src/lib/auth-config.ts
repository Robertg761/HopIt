export const signInPath = '/sign-in'
export const signUpPath = '/sign-up'

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
  return process.env.VERCEL === '1' || process.env.HOPIT_REQUIRE_CONVEX === '1'
}

export function shouldUseClerkAuth() {
  if (process.env.HOPIT_AUTH_PROVIDER === 'basic') return false
  if (process.env.HOPIT_AUTH_PROVIDER === 'clerk') return true
  return isClerkServerConfigured()
}

export function shouldAllowBasicAuthFallback() {
  return process.env.HOPIT_ALLOW_BASIC_AUTH_FALLBACK === '1'
}

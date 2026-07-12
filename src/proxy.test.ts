import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// Integration tests for the middleware DECISION in src/proxy.ts. The real
// `shouldBypassClerkForAgentToken` predicate stays unmocked (that IS the logic
// under test); everything Clerk-shaped is mocked so the suite runs without a
// live Clerk environment. The guarantee: an hst_-bearing /api request is let
// through to its route handler (NextResponse.next()), while every other request
// keeps its pre-fix treatment — pages redirect to Clerk, tokenless /api requests
// redirect to Clerk, and the basic-auth / public-route pass-throughs are intact.

const shouldUseClerkAuth = vi.fn(() => true)
const isClerkServerConfigured = vi.fn(() => true)
const shouldAllowBasicAuthFallback = vi.fn(() => false)
const isHostedRuntime = vi.fn(() => true)
const hasValidBasicAuthFallbackCredentials = vi.fn(() => false)

vi.mock('@/lib/auth-config', () => ({
  isClerkServerConfigured: () => isClerkServerConfigured(),
  isHostedRuntime: () => isHostedRuntime(),
  shouldAllowBasicAuthFallback: () => shouldAllowBasicAuthFallback(),
  shouldUseClerkAuth: () => shouldUseClerkAuth(),
  signInPath: '/sign-in',
}))

vi.mock('@/lib/basic-auth-fallback', () => ({
  // The return value is driven by mockReturnValue per test; the header argument
  // is irrelevant to these decision tests, so it is intentionally not forwarded.
  hasValidBasicAuthFallbackCredentials: () => hasValidBasicAuthFallbackCredentials(),
}))

// A minimal stand-in for Clerk's middleware + route matcher. `clerkMiddleware`
// returns a handler that produces a recognizable "would redirect to sign-in"
// response so tests can distinguish "Clerk handled it" from "middleware stepped
// aside". `createRouteMatcher` compiles the simple patterns proxy.ts uses.
vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: () => () =>
    new Response(null, {
      status: 307,
      headers: { location: '/sign-in', 'x-clerk-protect': '1' },
    }),
  createRouteMatcher: (patterns: string[]) => {
    const regexes = patterns.map((p) => new RegExp('^' + p.replace(/\(\.\*\)/g, '.*') + '$'))
    return (req: NextRequest) => regexes.some((r) => r.test(req.nextUrl.pathname))
  },
}))

import { proxy } from './proxy'

function run(path: string, headers: Record<string, string> = {}) {
  const request = new NextRequest(`https://app.test${path}`, { headers })
  return proxy(request, {} as never) as Response
}

function isPassThrough(response: Response) {
  return response.headers.get('x-middleware-next') === '1'
}

function isClerkRedirect(response: Response) {
  return response.headers.get('x-clerk-protect') === '1'
}

beforeEach(() => {
  shouldUseClerkAuth.mockReturnValue(true)
  isClerkServerConfigured.mockReturnValue(true)
  shouldAllowBasicAuthFallback.mockReturnValue(false)
  isHostedRuntime.mockReturnValue(true)
  hasValidBasicAuthFallbackCredentials.mockReturnValue(false)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('proxy() agent-session-token pass-through (Clerk mode)', () => {
  it('lets an hst_ /api request through to the route (dedicated header)', () => {
    const response = run('/api/codebase-files', { 'x-hopit-agent-session-token': 'hst_abc' })
    expect(isPassThrough(response)).toBe(true)
    expect(isClerkRedirect(response)).toBe(false)
  })

  it('lets an hst_ /api request through to the route (Bearer header)', () => {
    const response = run('/api/codebases/compare', { authorization: 'Bearer hst_abc' })
    expect(isPassThrough(response)).toBe(true)
  })

  it('does NOT bypass Clerk for a page request carrying an hst_ header', () => {
    const response = run('/dashboard', { 'x-hopit-agent-session-token': 'hst_abc' })
    expect(isClerkRedirect(response)).toBe(true)
    expect(isPassThrough(response)).toBe(false)
  })

  it('does NOT bypass Clerk for a page request carrying a Bearer hst_ header', () => {
    const response = run('/settings', { authorization: 'Bearer hst_abc' })
    expect(isClerkRedirect(response)).toBe(true)
  })

  it('redirects a tokenless /api request to Clerk', () => {
    const response = run('/api/codebase-files')
    expect(isClerkRedirect(response)).toBe(true)
    expect(isPassThrough(response)).toBe(false)
  })

  it('redirects an /api request with a malformed Bearer token to Clerk', () => {
    const response = run('/api/codebase-files', { authorization: 'Bearer not-a-token' })
    expect(isClerkRedirect(response)).toBe(true)
  })

  it('redirects an /api request with a Basic Authorization header to Clerk', () => {
    const response = run('/api/codebase-files', { authorization: 'Basic aG9waXQ6c2VjcmV0' })
    expect(isClerkRedirect(response)).toBe(true)
  })
})

describe('proxy() unchanged pass-throughs (Clerk mode)', () => {
  it('keeps the basic-auth fallback pass-through for /api requests', () => {
    hasValidBasicAuthFallbackCredentials.mockReturnValue(true)
    const response = run('/api/codebase-files')
    expect(isPassThrough(response)).toBe(true)
  })

  it('keeps the basic-auth fallback pass-through for pages', () => {
    hasValidBasicAuthFallbackCredentials.mockReturnValue(true)
    const response = run('/dashboard')
    expect(isPassThrough(response)).toBe(true)
  })

  it('keeps device-authorization creation/polling public without a token', () => {
    const response = run('/api/device-authorizations')
    expect(isPassThrough(response)).toBe(true)
    expect(isClerkRedirect(response)).toBe(false)
  })

  it('keeps the install route public', () => {
    const response = run('/install')
    expect(isPassThrough(response)).toBe(true)
  })

  it('keeps the sign-in route public', () => {
    const response = run('/sign-in')
    expect(isPassThrough(response)).toBe(true)
  })

  it('returns 503 when Clerk is selected but not configured', () => {
    isClerkServerConfigured.mockReturnValue(false)
    const response = run('/dashboard')
    expect(response.status).toBe(503)
  })
})

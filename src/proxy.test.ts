import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// Integration tests for the middleware DECISION in src/proxy.ts. The real
// `shouldBypassClerkForAgentToken` predicate stays unmocked (that IS the logic
// under test); everything Clerk-shaped is mocked so the suite runs without a
// live Clerk environment. The guarantee: an hst_-bearing /api request is let
// through to its route handler (NextResponse.next()), while protected pages and
// tokenless /api requests still redirect to Clerk. Public and unknown page routes
// pass through so public content and branded 404s remain reachable.

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
vi.mock('@clerk/nextjs/server', () => {
  let middlewareRegistration = 0
  return {
    clerkMiddleware: () => {
      const registration = middlewareRegistration++
      return () => registration === 0
        ? new Response(null, {
            status: 307,
            headers: { location: '/sign-in', 'x-clerk-protect': '1' },
          })
        : new Response(null, { headers: { 'x-middleware-next': '1', 'x-clerk-session': '1' } })
    },
    createRouteMatcher: (patterns: string[]) => {
      const regexes = patterns.map((p) => new RegExp('^' + p.replace(/\(\.\*\)/g, '.*') + '$'))
      return (req: NextRequest) => regexes.some((r) => r.test(req.nextUrl.pathname))
    },
  }
})

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
    const response = run('/overview', { 'x-hopit-agent-session-token': 'hst_abc' })
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
    const response = run('/overview')
    expect(isPassThrough(response)).toBe(true)
  })

  it('keeps device-authorization creation/polling public without a token', () => {
    const response = run('/api/device-authorizations')
    expect(isPassThrough(response)).toBe(true)
    expect(isClerkRedirect(response)).toBe(false)
  })

  it('lets Stripe webhooks reach their signature verifier without Clerk', () => {
    const response = run('/api/billing/webhook')
    expect(isPassThrough(response)).toBe(true)
    expect(isClerkRedirect(response)).toBe(false)
  })

  it('lets the billing reconcile cron reach its secret check without Clerk', () => {
    const response = run('/api/billing/reconcile')
    expect(isPassThrough(response)).toBe(true)
    expect(isClerkRedirect(response)).toBe(false)
  })

  it('keeps browser-authenticated billing routes protected', () => {
    const response = run('/api/billing/checkout')
    expect(isClerkRedirect(response)).toBe(true)
    expect(isPassThrough(response)).toBe(false)
  })

  it('keeps the install route public', () => {
    const response = run('/install')
    expect(isPassThrough(response)).toBe(true)
  })

  it('keeps device-specific downloads public', () => {
    const response = run('/api/download/darwin-arm64')
    expect(isPassThrough(response)).toBe(true)
    expect(isClerkRedirect(response)).toBe(false)
  })

  it('keeps the sign-in route public', () => {
    const response = run('/sign-in')
    expect(isPassThrough(response)).toBe(true)
    expect(response.headers.get('x-clerk-session')).toBe('1')
  })

  it.each(['/', '/download', '/privacy', '/terms'])('keeps the public launch route %s open', (path) => {
    const response = run(path)
    expect(isPassThrough(response)).toBe(true)
    expect(isClerkRedirect(response)).toBe(false)
  })

  it.each(['/robots.txt', '/sitemap.xml'])('keeps public metadata route %s outside Clerk', (path) => {
    const response = run(path)
    expect(isPassThrough(response)).toBe(true)
    expect(response.headers.get('x-clerk-session')).toBeNull()
  })

  it('passes unknown page routes through so Next can return a 404', () => {
    const response = run('/does-not-exist')
    expect(isPassThrough(response)).toBe(true)
    expect(isClerkRedirect(response)).toBe(false)
  })

  it.each([
    '/activity',
    '/admin',
    '/codebases',
    '/device',
    '/files',
    '/members',
    '/overview',
    '/pricing',
    '/review',
    '/settings',
    '/status',
    '/team',
    '/work-items',
  ])('keeps authenticated app route %s protected', (path) => {
    expect(isClerkRedirect(run(path))).toBe(true)
  })

  it('returns 503 when Clerk is selected but not configured', () => {
    isClerkServerConfigured.mockReturnValue(false)
    const response = run('/overview')
    expect(response.status).toBe(503)
  })
})

describe('proxy() explicit protection in Basic Auth mode', () => {
  beforeEach(() => {
    shouldUseClerkAuth.mockReturnValue(false)
    shouldAllowBasicAuthFallback.mockReturnValue(true)
  })

  it('returns a Basic Auth challenge for protected pages', () => {
    const previous = process.env.HOPIT_DASHBOARD_PASSWORD
    process.env.HOPIT_DASHBOARD_PASSWORD = 'test-password'
    try {
      const response = run('/overview')
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toContain('Basic')
    } finally {
      if (previous === undefined) delete process.env.HOPIT_DASHBOARD_PASSWORD
      else process.env.HOPIT_DASHBOARD_PASSWORD = previous
    }
  })

  it('passes unknown pages through to the branded 404', () => {
    expect(isPassThrough(run('/does-not-exist'))).toBe(true)
  })
})

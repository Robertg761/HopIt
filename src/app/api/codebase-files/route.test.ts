import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// These tests exercise the REAL agent-session-token validation path: the route
// calls the real `cloudActorFromRequest`, which recognizes an `hst_` token and
// delegates to `requireD1AgentAccess`. We mock only the leaf dependencies (the
// D1 backend, cloud-backend helpers, Clerk, and the basic-auth fallback) so a
// forged-but-well-shaped token flows through the same code an /api request hits
// once the middleware has stepped aside. The guarantee under test: such a token
// yields a JSON 4xx envelope from the route, never a sign-in redirect or a 500.

const requireD1AgentAccess = vi.fn()
const readCloudTextFile = vi.fn()
const mutateCloudTextFile = vi.fn()
const missingCloudBackendConfig = vi.fn(() => [] as string[])
const configuredCloudBackend = vi.fn(() => 'd1')
const hasValidBasicAuthFallbackCredentials = vi.fn(() => false)
const clerkAuth = vi.fn(async () => ({ userId: null, sessionId: null }))
const currentUser = vi.fn(async () => null)

vi.mock('@hopit/backend-d1', () => ({
  createD1Backend: () => ({ requireD1AgentAccess }),
}))
vi.mock('@/lib/cloud-backend', () => ({
  missingCloudBackendConfig: () => missingCloudBackendConfig(),
  configuredCloudBackend: () => configuredCloudBackend(),
  readCloudTextFile: (...args: unknown[]) => readCloudTextFile(...args),
  mutateCloudTextFile: (...args: unknown[]) => mutateCloudTextFile(...args),
}))
vi.mock('@/lib/basic-auth-fallback', () => ({
  hasValidBasicAuthFallbackCredentials: () => hasValidBasicAuthFallbackCredentials(),
}))
vi.mock('@clerk/nextjs/server', () => ({
  auth: () => clerkAuth(),
  currentUser: () => currentUser(),
}))

import { GET } from './route'

function get(query: string, headers: Record<string, string> = {}) {
  return GET(new Request(`https://app.test/api/codebase-files?${query}`, { headers }))
}

async function body(response: Response) {
  return (await response.json()) as Record<string, unknown>
}

beforeEach(() => {
  missingCloudBackendConfig.mockReturnValue([])
  configuredCloudBackend.mockReturnValue('d1')
  hasValidBasicAuthFallbackCredentials.mockReturnValue(false)
  clerkAuth.mockResolvedValue({ userId: null, sessionId: null })
  currentUser.mockResolvedValue(null)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/codebase-files agent-session-token path', () => {
  it('rejects a valid-shaped but invalid token with a JSON 4xx envelope, not a redirect', async () => {
    // This mirrors what the middleware defers to: the token is well-shaped
    // ("hst_"), so it reaches the route, and the REAL validation fails.
    requireD1AgentAccess.mockRejectedValue(new Error('Agent session token was not found.'))

    const response = await get('codebaseId=repo&path=README.md', {
      authorization: 'Bearer hst_forged_deadbeef',
    })

    // A JSON 4xx envelope — the critical contrast with the pre-fix behavior,
    // which was a 307 redirect to /sign-in.
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
    expect(response.status).not.toBe(307)
    const payload = await body(response)
    expect(payload.ok).toBe(false)
    expect((payload.error as { code: string }).code).toBeTruthy()
    // The real validation was consulted; Clerk was never used for this request.
    expect(requireD1AgentAccess).toHaveBeenCalledOnce()
    expect(clerkAuth).not.toHaveBeenCalled()
  })

  it('rejects a wrong-codebase / revoked token with a JSON 4xx envelope', async () => {
    requireD1AgentAccess.mockRejectedValue(new Error('Agent session is not scoped to codebase repo.'))

    const response = await get('codebaseId=repo&path=README.md', {
      'x-hopit-agent-session-token': 'hst_scoped_to_other',
    })

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
    expect((await body(response)).ok).toBe(false)
    expect(clerkAuth).not.toHaveBeenCalled()
  })

  it('serves the file when the agent token validates, without touching Clerk', async () => {
    requireD1AgentAccess.mockResolvedValue({ userId: 'user_1', session: { session_id: 'sess_1' } })
    readCloudTextFile.mockResolvedValue({ path: 'README.md', content: 'hello' })

    const response = await get('codebaseId=repo&path=README.md', {
      authorization: 'Bearer hst_valid_token',
    })

    expect(response.status).toBe(200)
    const payload = await body(response)
    expect(payload.ok).toBe(true)
    expect(payload.file).toMatchObject({ path: 'README.md' })
    expect(readCloudTextFile).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { userId: 'user_1', sessionId: 'sess_1' } }),
    )
    expect(clerkAuth).not.toHaveBeenCalled()
  })

  it('returns a 401 browser_auth_required envelope when there is no token and no Clerk user', async () => {
    // No agent token and no Clerk session: the ambient-auth fallback yields no
    // actor, so the route returns its 401 envelope (never a redirect).
    const response = await get('codebaseId=repo&path=README.md')

    expect(response.status).toBe(401)
    expect((await body(response)).error).toMatchObject({ code: 'browser_auth_required' })
    expect(requireD1AgentAccess).not.toHaveBeenCalled()
  })
})

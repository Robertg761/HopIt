import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Phase 3 §1.4 / decision 10: the basic-auth fallback resolves to an empty
// wildcard actor ({}) that downstream visibility code treats as an unscoped
// bypass. These tests prove that path is byte-for-byte unchanged with tenancy
// OFF and structurally unreachable with tenancy ON — even when the credential
// check is (mis)configured to pass.

const authMock = vi.fn()
const currentUserMock = vi.fn()
const agentSessionTokenFromHeaders = vi.fn()
const hasValidBasicAuthFallbackCredentials = vi.fn()
const configuredCloudBackend = vi.fn(() => 'd1')

vi.mock('@clerk/nextjs/server', () => ({
  auth: () => authMock(),
  currentUser: () => currentUserMock(),
}))
vi.mock('@/lib/agent-session-token', () => ({
  agentSessionTokenFromHeaders: (...args: unknown[]) => agentSessionTokenFromHeaders(...args),
}))
vi.mock('@/lib/basic-auth-fallback', () => ({
  hasValidBasicAuthFallbackCredentials: (...args: unknown[]) => hasValidBasicAuthFallbackCredentials(...args),
}))
vi.mock('@/lib/cloud-backend', () => ({
  configuredCloudBackend: () => configuredCloudBackend(),
}))
vi.mock('@hopit/backend-d1', () => ({
  createD1Backend: () => ({ requireD1AgentAccess: vi.fn() }),
}))

import { cloudActorFromRequest } from './request-cloud-actor'

const FLAG = 'HOPIT_MULTITENANT'
let originalFlag: string | undefined

function request() {
  return new Request('https://app.test/api/codebases', { headers: { authorization: 'Basic aG9waXQ6cHc=' } })
}

beforeEach(() => {
  originalFlag = process.env[FLAG]
  delete process.env[FLAG]
  agentSessionTokenFromHeaders.mockReturnValue(null)
  hasValidBasicAuthFallbackCredentials.mockReturnValue(true)
  authMock.mockResolvedValue({ userId: null, sessionId: null })
  currentUserMock.mockResolvedValue(null)
})

afterEach(() => {
  if (originalFlag === undefined) delete process.env[FLAG]
  else process.env[FLAG] = originalFlag
  vi.clearAllMocks()
})

describe('cloudActorFromRequest empty-actor bypass', () => {
  it('returns the empty wildcard actor with the flag OFF and allowBasicFallback (byte-for-byte legacy)', async () => {
    const actor = await cloudActorFromRequest(request(), { allowBasicFallback: true })
    expect(actor).toEqual({})
  })

  it('returns null with the flag OFF, valid basic creds, but allowBasicFallback not set (legacy)', async () => {
    const actor = await cloudActorFromRequest(request(), { allowBasicFallback: false })
    expect(actor).toBeNull()
  })

  it('never returns the empty actor with the flag ON, even when basic creds pass and fallback is allowed', async () => {
    process.env[FLAG] = '1'
    const actor = await cloudActorFromRequest(request(), { allowBasicFallback: true })
    // No Clerk user + no agent token => null. Critically, it is NOT {}.
    expect(actor).toBeNull()
    expect(actor).not.toEqual({})
  })

  it('with the flag ON still resolves a real Clerk actor (basic-auth path is simply skipped)', async () => {
    process.env[FLAG] = '1'
    authMock.mockResolvedValue({ userId: 'user_9', sessionId: 'sess_9' })
    currentUserMock.mockResolvedValue({
      primaryEmailAddress: { emailAddress: 'stranger@example.com', verification: { status: 'verified' } },
      fullName: 'Stranger',
      imageUrl: null,
    })
    const actor = await cloudActorFromRequest(request(), { allowBasicFallback: true })
    expect(actor).toMatchObject({ userId: 'user_9', primaryEmail: 'stranger@example.com' })
  })
})

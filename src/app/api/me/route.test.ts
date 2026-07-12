import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Phase 3 §2e item 1: on a new Clerk user's first authenticated request /api/me
// auto-provisions their own free tenant (no card, no owner-email gate) and the
// step is idempotent. With the flag off it is skipped entirely (byte-for-byte).

const authMock = vi.fn()
const currentUserMock = vi.fn()
const shouldUseClerkAuth = vi.fn(() => true)
const isMultiTenant = vi.fn(() => false)
const hasValidBasicAuthFallbackCredentials = vi.fn()
const configuredCloudBackend = vi.fn(() => 'd1')
const upsertCloudUser = vi.fn()
const bootstrapCloudAccount = vi.fn()
const provisionCloudTenant = vi.fn()

vi.mock('@clerk/nextjs/server', () => ({
  auth: () => authMock(),
  currentUser: () => currentUserMock(),
}))
vi.mock('@/lib/auth-config', () => ({
  shouldUseClerkAuth: () => shouldUseClerkAuth(),
  isMultiTenant: () => isMultiTenant(),
}))
vi.mock('@/lib/basic-auth-fallback', () => ({
  hasValidBasicAuthFallbackCredentials: (...args: unknown[]) => hasValidBasicAuthFallbackCredentials(...args),
}))
vi.mock('@/lib/cloud-backend', () => ({
  configuredCloudBackend: () => configuredCloudBackend(),
  upsertCloudUser: (...args: unknown[]) => upsertCloudUser(...args),
  bootstrapCloudAccount: (...args: unknown[]) => bootstrapCloudAccount(...args),
  provisionCloudTenant: (...args: unknown[]) => provisionCloudTenant(...args),
}))

import { GET } from './route'

function get() {
  return GET(new Request('https://app.test/api/me'))
}

async function body(response: Response) {
  return (await response.json()) as Record<string, any>
}

beforeEach(() => {
  shouldUseClerkAuth.mockReturnValue(true)
  isMultiTenant.mockReturnValue(false)
  hasValidBasicAuthFallbackCredentials.mockReturnValue(false)
  configuredCloudBackend.mockReturnValue('d1')
  authMock.mockResolvedValue({ userId: 'user_new', sessionId: 'sess_new' })
  currentUserMock.mockResolvedValue({
    primaryEmailAddress: { emailAddress: 'stranger@example.com', verification: { status: 'verified' } },
    fullName: 'Stranger',
    imageUrl: null,
  })
  upsertCloudUser.mockResolvedValue({ userId: 'user_new', primaryEmail: 'stranger@example.com' })
  bootstrapCloudAccount.mockResolvedValue({ ok: true, codebases: [], claimed: [], failed: [] })
  provisionCloudTenant.mockResolvedValue({ tenantId: 'user_new', plan: 'free', createdAt: '2026-07-12T00:00:00.000Z' })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/me tenant provisioning', () => {
  it('provisions a free tenant on first authed request when tenancy is ON', async () => {
    isMultiTenant.mockReturnValue(true)
    const response = await get()
    expect(response.status).toBe(200)
    expect(provisionCloudTenant).toHaveBeenCalledTimes(1)
    expect(provisionCloudTenant).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user_new' }))
    const payload = await body(response)
    expect(payload.cloud.tenant).toMatchObject({ tenantId: 'user_new', plan: 'free', provisioned: true })
  })

  it('is idempotent: a second request re-provisions without error and stays free', async () => {
    isMultiTenant.mockReturnValue(true)
    const first = await body(await get())
    const second = await body(await get())
    expect(provisionCloudTenant).toHaveBeenCalledTimes(2)
    expect(first.cloud.tenant).toMatchObject({ plan: 'free', provisioned: true })
    expect(second.cloud.tenant).toMatchObject({ plan: 'free', provisioned: true })
  })

  it('does NOT provision (no proxy call) when tenancy is OFF — byte-for-byte legacy', async () => {
    isMultiTenant.mockReturnValue(false)
    const payload = await body(await get())
    expect(provisionCloudTenant).not.toHaveBeenCalled()
    expect(payload.cloud.tenant).toBeNull()
  })

  it('never blocks /api/me when provisioning fails (best-effort)', async () => {
    isMultiTenant.mockReturnValue(true)
    provisionCloudTenant.mockRejectedValue(new Error('d1 down'))
    const response = await get()
    expect(response.status).toBe(200)
    const payload = await body(response)
    expect(payload.cloud.tenant).toMatchObject({ provisioned: false, error: 'd1 down' })
    // The rest of the account sync still succeeds.
    expect(payload.cloud.accountSynced).toBe(true)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.fn()
const currentUser = vi.fn()

vi.mock('@clerk/nextjs/server', () => ({
  auth: () => auth(),
  currentUser: () => currentUser(),
}))

import { currentServiceAdmin, serviceEconomics } from './service-admin'

beforeEach(() => {
  process.env.HOPIT_OWNER_EMAIL = 'owner@example.com'
  auth.mockResolvedValue({ userId: 'user-owner' })
  currentUser.mockResolvedValue({
    primaryEmailAddress: {
      emailAddress: 'OWNER@example.com',
      verification: { status: 'verified' },
    },
  })
})

afterEach(() => {
  vi.clearAllMocks()
  delete process.env.HOPIT_MARGIN_PROVIDER_RATE
  delete process.env.HOPIT_MARGIN_PLATFORM_BASE_USD
})

describe('service admin access', () => {
  it('accepts only the signed-in verified owner email', async () => {
    await expect(currentServiceAdmin()).resolves.toEqual({ userId: 'user-owner', email: 'owner@example.com' })

    currentUser.mockResolvedValueOnce({
      primaryEmailAddress: { emailAddress: 'stranger@example.com', verification: { status: 'verified' } },
    })
    await expect(currentServiceAdmin()).resolves.toBeNull()

    currentUser.mockResolvedValueOnce({
      primaryEmailAddress: { emailAddress: 'owner@example.com', verification: { status: 'unverified' } },
    })
    await expect(currentServiceAdmin()).resolves.toBeNull()
  })
})

describe('service economics', () => {
  it('models live MRR and keeps both launch plans above the 50% at-cap floor', () => {
    const result = serviceEconomics({
      totals: { totalStorageBytes: 30_000_000_000, rowsWrittenToday: 20_000 },
      tenants: [
        { subscription: { entitlementActive: true, planKey: 'plus' } },
        { subscription: { entitlementActive: true, planKey: 'plus_storage' } },
      ],
    })
    expect(result.grossMrrUsd).toBe(25)
    expect(result.paidTenants).toBe(2)
    expect(result.monthlyWriteRunRate).toBe(600_000)
    expect(result.planGuardrails.every((plan) => plan.marginRatio >= 0.5)).toBe(true)
  })

  it('honors owner-tunable cost assumptions', () => {
    process.env.HOPIT_MARGIN_PROVIDER_RATE = '0.10'
    process.env.HOPIT_MARGIN_PLATFORM_BASE_USD = '9'
    const result = serviceEconomics({
      totals: { totalStorageBytes: 0, rowsWrittenToday: 0 },
      tenants: [{ subscription: { entitlementActive: true, planKey: 'plus' } }],
    })
    expect(result.assumptions.providerRate).toBe(0.1)
    expect(result.costLines.platformBaseUsd).toBe(9)
  })
})

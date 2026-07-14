import { beforeEach, describe, expect, it, vi } from 'vitest'

const listStripeSubscriptionEntitlements = vi.fn()
const readCloudTenantSubscription = vi.fn()
const applyCloudBillingEvent = vi.fn()

vi.mock('@/lib/stripe-billing', () => ({
  isBillingEnabled: () => true,
  listStripeSubscriptionEntitlements: () => listStripeSubscriptionEntitlements(),
  shouldPreserveRevokedEntitlement: () => false,
}))

vi.mock('@/lib/cloud-backend', () => ({
  readCloudTenantSubscription: (...args: unknown[]) => readCloudTenantSubscription(...args),
  applyCloudBillingEvent: (...args: unknown[]) => applyCloudBillingEvent(...args),
}))

import { reconcileBillingEntitlements } from './billing-reconcile'

beforeEach(() => {
  vi.clearAllMocks()
  listStripeSubscriptionEntitlements.mockResolvedValue([
    { tenantId: 'tenant-a' },
    { tenantId: 'tenant-b' },
    { tenantId: 'tenant-c' },
  ])
  readCloudTenantSubscription.mockResolvedValue(null)
  applyCloudBillingEvent
    .mockResolvedValueOnce({ applied: true })
    .mockRejectedValueOnce(new Error('tenant-b write failed'))
    .mockResolvedValueOnce({ reason: 'duplicate' })
})

describe('reconcileBillingEntitlements', () => {
  it('continues after a tenant failure and returns an explicit partial result', async () => {
    const result = await reconcileBillingEntitlements()

    expect(result).toMatchObject({
      ok: false,
      partial: true,
      checked: 3,
      applied: 1,
      duplicates: 1,
      failures: [{ tenantId: 'tenant-b', message: 'tenant-b write failed' }],
    })
    expect(applyCloudBillingEvent).toHaveBeenCalledTimes(3)
  })
})

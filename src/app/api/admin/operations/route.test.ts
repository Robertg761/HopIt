import { beforeEach, describe, expect, it, vi } from 'vitest'

const requireServiceAdmin = vi.fn()
const requestServiceOperations = vi.fn()
const reconcileBillingEntitlements = vi.fn()
const setStripeSubscriptionCancellation = vi.fn()

vi.mock('@/lib/service-admin', () => ({
  requireServiceAdmin: () => requireServiceAdmin(),
  requestServiceOperations: (...args: unknown[]) => requestServiceOperations(...args),
  serviceAdminRuntimeConfig: () => ({}),
  serviceEconomics: () => ({}),
  ServiceAdminAccessError: class ServiceAdminAccessError extends Error {},
}))

vi.mock('@/lib/billing-reconcile', () => ({
  reconcileBillingEntitlements: () => reconcileBillingEntitlements(),
}))

vi.mock('@/lib/stripe-billing', () => ({
  setStripeSubscriptionCancellation: (...args: unknown[]) => setStripeSubscriptionCancellation(...args),
}))

import { POST } from './route'

beforeEach(() => {
  vi.resetAllMocks()
  requireServiceAdmin.mockResolvedValue({ userId: 'owner-user', email: 'owner@example.com' })
  requestServiceOperations
    .mockResolvedValueOnce({
      tenants: [{
        tenantId: 'tenant-a',
        subscription: { providerSubscriptionId: 'sub_a', cancelAtPeriodEnd: false },
      }],
    })
    .mockResolvedValueOnce({ tenants: [] })
  setStripeSubscriptionCancellation.mockResolvedValue({ id: 'sub_a' })
  reconcileBillingEntitlements.mockResolvedValue({ ok: true, checked: 1, applied: 1 })
})

describe('POST /api/admin/operations', () => {
  it('requires an exact tenant confirmation before changing Stripe renewal', async () => {
    const response = await POST(request({
      action: 'set_subscription_cancellation',
      tenantId: 'tenant-a',
      confirmation: 'wrong',
      cancelAtPeriodEnd: true,
    }))
    expect(response.status).toBe(400)
    expect(setStripeSubscriptionCancellation).not.toHaveBeenCalled()
  })

  it('rejects a missing or non-boolean cancellation state instead of resuming renewal', async () => {
    const response = await POST(request({
      action: 'set_subscription_cancellation',
      tenantId: 'tenant-a',
      confirmation: 'tenant-a',
    }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_cancellation_state' } })
    expect(setStripeSubscriptionCancellation).not.toHaveBeenCalled()
  })

  it('uses the subscription stored for the tenant, reconciles, and audits the change', async () => {
    const response = await POST(request({
      action: 'set_subscription_cancellation',
      tenantId: 'tenant-a',
      confirmation: 'tenant-a',
      cancelAtPeriodEnd: true,
    }))
    expect(response.status).toBe(200)
    expect(setStripeSubscriptionCancellation).toHaveBeenCalledWith({ subscriptionId: 'sub_a', cancelAtPeriodEnd: true })
    expect(reconcileBillingEntitlements).toHaveBeenCalledOnce()
    expect(requestServiceOperations).toHaveBeenLastCalledWith(
      { userId: 'owner-user', email: 'owner@example.com' },
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          action: 'record_billing_action',
          tenantId: 'tenant-a',
          confirmation: 'tenant-a',
        }),
      }),
    )
  })

  it('never accepts a provider subscription id supplied by the browser', async () => {
    await POST(request({
      action: 'set_subscription_cancellation',
      tenantId: 'tenant-a',
      confirmation: 'tenant-a',
      providerSubscriptionId: 'sub_attacker',
      cancelAtPeriodEnd: false,
    }))
    expect(setStripeSubscriptionCancellation).toHaveBeenCalledWith({ subscriptionId: 'sub_a', cancelAtPeriodEnd: false })
  })

  it('reports Stripe success with warnings when reconciliation fails afterward', async () => {
    reconcileBillingEntitlements.mockRejectedValueOnce(new Error('D1 unavailable'))
    const response = await POST(request({
      action: 'set_subscription_cancellation',
      tenantId: 'tenant-a',
      confirmation: 'tenant-a',
      cancelAtPeriodEnd: true,
    }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      operation: {
        applied: true,
        completedWithWarnings: true,
      },
    })
  })

  it('requires service confirmation before reconciling billing', async () => {
    const response = await POST(request({ action: 'reconcile_billing' }))
    expect(response.status).toBe(400)
    expect(reconcileBillingEntitlements).not.toHaveBeenCalled()
  })
})

function request(body: Record<string, unknown>) {
  return new Request('https://hopit.dev/api/admin/operations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

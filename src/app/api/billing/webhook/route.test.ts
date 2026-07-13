import { beforeEach, describe, expect, it, vi } from 'vitest'

const applyCloudBillingEvent = vi.fn()
const readCloudSubscriptionByProviderCustomer = vi.fn()
const constructStripeEvent = vi.fn()
const entitlementEventFromStripe = vi.fn()
const revocationTargetFromStripe = vi.fn()
const revokedEntitlementEventFromSubscription = vi.fn()
const isBillingEnabled = vi.fn(() => true)

vi.mock('@/lib/cloud-backend', () => ({
  applyCloudBillingEvent: (...args: unknown[]) => applyCloudBillingEvent(...args),
  readCloudSubscriptionByProviderCustomer: (...args: unknown[]) => readCloudSubscriptionByProviderCustomer(...args),
}))

vi.mock('@/lib/stripe-billing', () => ({
  constructStripeEvent: (...args: unknown[]) => constructStripeEvent(...args),
  entitlementEventFromStripe: (...args: unknown[]) => entitlementEventFromStripe(...args),
  revocationTargetFromStripe: (...args: unknown[]) => revocationTargetFromStripe(...args),
  revokedEntitlementEventFromSubscription: (...args: unknown[]) => revokedEntitlementEventFromSubscription(...args),
  isBillingEnabled: () => isBillingEnabled(),
}))

import { POST } from './route'

function request(signature?: string) {
  return new Request('https://hopit.dev/api/billing/webhook', {
    method: 'POST',
    headers: signature ? { 'stripe-signature': signature } : {},
    body: '{"id":"evt_1"}',
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  isBillingEnabled.mockReturnValue(true)
  constructStripeEvent.mockReturnValue({ id: 'evt_1' })
  entitlementEventFromStripe.mockReturnValue({ eventId: 'evt_1', tenantId: 'user_a' })
  revocationTargetFromStripe.mockResolvedValue(null)
  readCloudSubscriptionByProviderCustomer.mockResolvedValue(null)
  revokedEntitlementEventFromSubscription.mockReturnValue(null)
  applyCloudBillingEvent.mockResolvedValue({ applied: true })
})

describe('POST /api/billing/webhook', () => {
  it('rejects an unsigned webhook before parsing its body', async () => {
    const response = await POST(request())
    expect(response.status).toBe(400)
    expect(constructStripeEvent).not.toHaveBeenCalled()
  })

  it('rejects an invalid Stripe signature', async () => {
    constructStripeEvent.mockImplementation(() => { throw new Error('bad signature') })
    const response = await POST(request('invalid'))
    expect(response.status).toBe(400)
    expect(applyCloudBillingEvent).not.toHaveBeenCalled()
  })

  it('applies a verified entitlement event', async () => {
    const response = await POST(request('valid'))
    expect(response.status).toBe(200)
    expect(applyCloudBillingEvent).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'evt_1' }))
    expect(await response.json()).toMatchObject({ ok: true, applied: true, duplicate: false })
  })

  it('acknowledges but does not reapply a replayed event', async () => {
    applyCloudBillingEvent.mockResolvedValue({ applied: false, reason: 'duplicate' })
    const response = await POST(request('valid'))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, applied: false, duplicate: true })
  })

  it('maps a full refund through the stored Stripe customer id', async () => {
    entitlementEventFromStripe.mockReturnValue(null)
    revocationTargetFromStripe.mockResolvedValue({ providerCustomerId: 'cus_a', status: 'refunded' })
    readCloudSubscriptionByProviderCustomer.mockResolvedValue({ tenantId: 'user_a', planKey: 'plus' })
    revokedEntitlementEventFromSubscription.mockReturnValue({
      eventId: 'evt_1', tenantId: 'user_a', planKey: 'plus', status: 'refunded', entitlementActive: false,
    })
    const response = await POST(request('valid'))
    expect(response.status).toBe(200)
    expect(readCloudSubscriptionByProviderCustomer).toHaveBeenCalledWith('stripe_managed_payments', 'cus_a')
    expect(applyCloudBillingEvent).toHaveBeenCalledWith(expect.objectContaining({ status: 'refunded' }))
  })
})

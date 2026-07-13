import { describe, expect, it } from 'vitest'
import type Stripe from 'stripe'

import {
  entitlementEventFromStripe,
  revocationTargetFromStripe,
  revokedEntitlementEventFromSubscription,
  shouldPreserveRevokedEntitlement,
} from './stripe-billing'

function stripeEvent(type: Stripe.Event.Type, object: Record<string, unknown>): Stripe.Event {
  return {
    id: `evt_${type}`,
    object: 'event',
    api_version: null,
    created: 1_752_364_800,
    data: { object },
    livemode: false,
    pending_webhooks: 0,
    request: null,
    type,
  } as unknown as Stripe.Event
}

describe('Stripe Managed Payments entitlement translation', () => {
  it('activates the selected checkout plan for the authenticated tenant metadata', () => {
    const result = entitlementEventFromStripe(stripeEvent('checkout.session.completed', {
      mode: 'subscription',
      client_reference_id: 'user_a',
      customer: 'cus_a',
      subscription: 'sub_a',
      metadata: { tenant_id: 'user_a', plan_key: 'plus_storage' },
    }))
    expect(result).toMatchObject({
      tenantId: 'user_a',
      planKey: 'plus_storage',
      providerCustomerId: 'cus_a',
      providerSubscriptionId: 'sub_a',
      entitlementActive: true,
    })
  })

  it('keeps access during Stripe dunning statuses', () => {
    const result = entitlementEventFromStripe(stripeEvent('customer.subscription.updated', {
      id: 'sub_a',
      customer: 'cus_a',
      status: 'past_due',
      cancel_at_period_end: false,
      metadata: { tenant_id: 'user_a', plan_key: 'plus' },
      items: { data: [] },
    }))
    expect(result).toMatchObject({ status: 'past_due', entitlementActive: true })
  })

  it('removes paid entitlement only when the subscription is deleted', () => {
    const result = entitlementEventFromStripe(stripeEvent('customer.subscription.deleted', {
      id: 'sub_a',
      customer: 'cus_a',
      status: 'canceled',
      metadata: { tenant_id: 'user_a', plan_key: 'plus' },
      items: { data: [] },
    }))
    expect(result).toMatchObject({ status: 'canceled', entitlementActive: false })
  })

  it('ignores unrelated or unscoped events', () => {
    expect(entitlementEventFromStripe(stripeEvent('payment_intent.created', { id: 'pi_a' }))).toBeNull()
    expect(entitlementEventFromStripe(stripeEvent('customer.subscription.updated', {
      id: 'sub_a', status: 'active', metadata: {}, items: { data: [] },
    }))).toBeNull()
  })

  it('ignores partial refunds but resolves a full refund by Stripe customer', async () => {
    expect(await revocationTargetFromStripe(stripeEvent('charge.refunded', {
      amount: 1_000,
      amount_refunded: 500,
      refunded: false,
      customer: 'cus_a',
    }))).toBeNull()
    expect(await revocationTargetFromStripe(stripeEvent('charge.refunded', {
      amount: 1_000,
      amount_refunded: 1_000,
      refunded: true,
      customer: 'cus_a',
    }))).toEqual({ providerCustomerId: 'cus_a', status: 'refunded' })
  })

  it('builds a revocation from the stored customer mapping instead of charge metadata', () => {
    const event = stripeEvent('charge.refunded', { customer: 'cus_a', refunded: true })
    expect(revokedEntitlementEventFromSubscription(event, {
      tenantId: 'user_a',
      providerCustomerId: 'cus_a',
      providerSubscriptionId: 'sub_a',
      planKey: 'plus',
      status: 'active',
    }, 'refunded')).toMatchObject({
      tenantId: 'user_a',
      providerCustomerId: 'cus_a',
      providerSubscriptionId: 'sub_a',
      planKey: 'plus',
      status: 'refunded',
      entitlementActive: false,
    })
  })

  it('keeps a refund override during reconcile but allows a replacement subscription', () => {
    const current = { status: 'refunded', providerSubscriptionId: 'sub_old' }
    const incoming = {
      eventId: 'reconcile:sub_old',
      provider: 'stripe_managed_payments' as const,
      eventCreatedAt: '2026-07-13T12:00:00.000Z',
      tenantId: 'user_a',
      providerCustomerId: 'cus_a',
      providerSubscriptionId: 'sub_old',
      planKey: 'plus' as const,
      status: 'active',
      entitlementActive: true,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
    }
    expect(shouldPreserveRevokedEntitlement(current, incoming)).toBe(true)
    expect(shouldPreserveRevokedEntitlement(current, { ...incoming, providerSubscriptionId: 'sub_new' })).toBe(false)
  })
})

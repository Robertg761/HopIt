import Stripe from 'stripe'

import { billingPlans, type BillingPlanKey } from '@/lib/billing-plans'

export { billingPlans, type BillingPlanKey } from '@/lib/billing-plans'

export type BillingEntitlementEvent = {
  eventId: string
  provider: 'stripe_managed_payments'
  eventCreatedAt: string
  tenantId: string
  providerCustomerId: string | null
  providerSubscriptionId: string | null
  planKey: BillingPlanKey
  status: string
  entitlementActive: boolean
  cancelAtPeriodEnd: boolean
  currentPeriodEnd: string | null
}

export type StoredBillingSubscription = {
  tenantId?: unknown
  providerCustomerId?: unknown
  providerSubscriptionId?: unknown
  planKey?: unknown
  status?: unknown
}

const billingPriceEnv: Record<BillingPlanKey, 'STRIPE_PRICE_PLUS' | 'STRIPE_PRICE_PLUS_STORAGE'> = {
  plus: 'STRIPE_PRICE_PLUS',
  plus_storage: 'STRIPE_PRICE_PLUS_STORAGE',
}

const managedPaymentsApiVersion = '2026-03-04.preview'

let cachedStripe: Stripe | null = null
let cachedSecret: string | null = null

export function isBillingEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.HOPIT_BILLING ?? ''))
}

export function stripeClient() {
  const secret = requiredEnv('STRIPE_SECRET_KEY')
  if (!cachedStripe || cachedSecret !== secret) {
    cachedStripe = new Stripe(secret, { typescript: true })
    cachedSecret = secret
  }
  return cachedStripe
}

export function stripeWebhookSecret() {
  return requiredEnv('STRIPE_WEBHOOK_SECRET')
}

export function priceIdForPlan(planKey: BillingPlanKey) {
  return requiredEnv(billingPriceEnv[planKey])
}

export function billingPlanKey(value: unknown): BillingPlanKey | null {
  return value === 'plus' || value === 'plus_storage' ? value : null
}

export async function createManagedCheckout(input: {
  tenantId: string
  email: string | null
  planKey: BillingPlanKey
  successUrl: string
  cancelUrl: string
}) {
  const metadata = { tenant_id: input.tenantId, plan_key: input.planKey }
  const params = {
    mode: 'subscription',
    line_items: [{ price: priceIdForPlan(input.planKey), quantity: 1 }],
    client_reference_id: input.tenantId,
    customer_email: input.email ?? undefined,
    metadata,
    subscription_data: { metadata },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    allow_promotion_codes: false,
    consent_collection: { terms_of_service: 'required' },
    managed_payments: { enabled: true },
  }
  return stripeClient().checkout.sessions.create(
    params as unknown as Stripe.Checkout.SessionCreateParams,
    { apiVersion: managedPaymentsApiVersion as never },
  )
}

export async function createBillingPortal(input: { customerId: string; returnUrl: string }) {
  return stripeClient().billingPortal.sessions.create({
    customer: input.customerId,
    return_url: input.returnUrl,
  })
}

export async function setStripeSubscriptionCancellation(input: { subscriptionId: string; cancelAtPeriodEnd: boolean }) {
  return stripeClient().subscriptions.update(input.subscriptionId, {
    cancel_at_period_end: input.cancelAtPeriodEnd,
  })
}

export function constructStripeEvent(payload: string, signature: string) {
  return stripeClient().webhooks.constructEvent(payload, signature, stripeWebhookSecret())
}

export function entitlementEventFromStripe(event: Stripe.Event): BillingEntitlementEvent | null {
  const object = record(event.data.object)
  if (!object) return null

  if (event.type === 'checkout.session.completed') {
    if (object.mode !== 'subscription') return null
    const metadata = record(object.metadata)
    const tenantId = string(metadata?.tenant_id) ?? string(object.client_reference_id)
    const planKey = billingPlanKey(metadata?.plan_key)
    if (!tenantId || !planKey) return null
    return entitlementEvent({
      event,
      tenantId,
      planKey,
      customerId: object.customer,
      subscriptionId: object.subscription,
      status: 'active',
      entitlementActive: true,
      cancelAtPeriodEnd: false,
      currentPeriodEnd: null,
    })
  }

  if (event.type.startsWith('customer.subscription.')) {
    const metadata = record(object.metadata)
    const tenantId = string(metadata?.tenant_id)
    const planKey = billingPlanKey(metadata?.plan_key) ?? planKeyFromSubscriptionItems(object)
    if (!tenantId || !planKey) return null
    const status = string(object.status) ?? (event.type.endsWith('.deleted') ? 'canceled' : 'unknown')
    return entitlementEvent({
      event,
      tenantId,
      planKey,
      customerId: object.customer,
      subscriptionId: object.id,
      status,
      entitlementActive: paidStatus(status) && !event.type.endsWith('.deleted'),
      cancelAtPeriodEnd: object.cancel_at_period_end === true,
      currentPeriodEnd: unixTimestamp(object.current_period_end) ?? subscriptionItemPeriodEnd(object),
    })
  }

  return null
}

export async function revocationTargetFromStripe(event: Stripe.Event) {
  const object = record(event.data.object)
  if (!object) return null

  if (event.type === 'charge.refunded') {
    const fullyRefunded = object.refunded === true
      || (positiveNumber(object.amount) !== null && positiveNumber(object.amount_refunded) === positiveNumber(object.amount))
    if (!fullyRefunded) return null
    const providerCustomerId = idValue(object.customer)
    return providerCustomerId ? { providerCustomerId, status: 'refunded' as const } : null
  }

  if (event.type === 'charge.dispute.created') {
    const expandedCharge = record(object.charge)
    let providerCustomerId = idValue(expandedCharge?.customer)
    if (!providerCustomerId) {
      const chargeId = idValue(object.charge)
      if (!chargeId) return null
      const charge = await stripeClient().charges.retrieve(chargeId)
      providerCustomerId = idValue(charge.customer)
    }
    return providerCustomerId ? { providerCustomerId, status: 'disputed' as const } : null
  }

  return null
}

export function revokedEntitlementEventFromSubscription(
  event: Stripe.Event,
  subscription: StoredBillingSubscription | null,
  status: 'refunded' | 'disputed',
) {
  const tenantId = string(subscription?.tenantId)
  const planKey = billingPlanKey(subscription?.planKey)
  if (!tenantId || !planKey) return null
  return entitlementEvent({
    event,
    tenantId,
    planKey,
    customerId: subscription?.providerCustomerId,
    subscriptionId: subscription?.providerSubscriptionId,
    status,
    entitlementActive: false,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
  })
}

export function shouldPreserveRevokedEntitlement(
  current: StoredBillingSubscription | null,
  incoming: BillingEntitlementEvent,
) {
  const status = string(current?.status)
  if (status !== 'refunded' && status !== 'disputed') return false
  const currentSubscriptionId = string(current?.providerSubscriptionId)
  return incoming.entitlementActive
    && Boolean(currentSubscriptionId)
    && currentSubscriptionId === incoming.providerSubscriptionId
}

export async function listStripeSubscriptionEntitlements() {
  const events: BillingEntitlementEvent[] = []
  const created = Math.floor(Date.now() / 1000)
  for await (const subscription of stripeClient().subscriptions.list({ status: 'all', limit: 100 })) {
    const source = subscription as unknown as Record<string, unknown>
    const stateKey = [
      subscription.id,
      source.status,
      source.cancel_at_period_end === true ? 'canceling' : 'renewing',
      source.current_period_end ?? subscriptionItemPeriodEnd(source) ?? 'none',
    ].join(':')
    const event = entitlementEventFromStripe({
      id: `reconcile:${stateKey}`,
      object: 'event',
      api_version: null,
      created,
      data: { object: subscription },
      livemode: subscription.livemode,
      pending_webhooks: 0,
      request: null,
      type: 'customer.subscription.updated',
    } as Stripe.Event)
    if (event) events.push(event)
  }
  return events
}

export function checkoutUrls(requestUrl: string) {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim()
  const origin = configured ? new URL(configured).origin : new URL(requestUrl).origin
  return {
    successUrl: `${origin}/pricing?checkout=success`,
    cancelUrl: `${origin}/pricing?checkout=canceled`,
    returnUrl: `${origin}/pricing`,
  }
}

function entitlementEvent(input: {
  event: Stripe.Event
  tenantId: string
  planKey: BillingPlanKey
  customerId: unknown
  subscriptionId: unknown
  status: string
  entitlementActive: boolean
  cancelAtPeriodEnd: boolean
  currentPeriodEnd: string | null
}): BillingEntitlementEvent {
  return {
    eventId: input.event.id,
    provider: 'stripe_managed_payments',
    eventCreatedAt: new Date(input.event.created * 1000).toISOString(),
    tenantId: input.tenantId,
    providerCustomerId: idValue(input.customerId),
    providerSubscriptionId: idValue(input.subscriptionId),
    planKey: input.planKey,
    status: input.status,
    entitlementActive: input.entitlementActive,
    cancelAtPeriodEnd: input.cancelAtPeriodEnd,
    currentPeriodEnd: input.currentPeriodEnd,
  }
}

function paidStatus(status: string) {
  return status === 'active' || status === 'trialing' || status === 'past_due' || status === 'unpaid'
}

function planKeyFromSubscriptionItems(subscription: Record<string, unknown>): BillingPlanKey | null {
  const items = record(subscription.items)
  const data = Array.isArray(items?.data) ? items.data : []
  for (const item of data) {
    const price = record(record(item)?.price)
    const id = string(price?.id)
    if (id && id === process.env.STRIPE_PRICE_PLUS_STORAGE) return 'plus_storage'
    if (id && id === process.env.STRIPE_PRICE_PLUS) return 'plus'
  }
  return null
}

function subscriptionItemPeriodEnd(subscription: Record<string, unknown>) {
  const items = record(subscription.items)
  const first = Array.isArray(items?.data) ? record(items.data[0]) : null
  return unixTimestamp(first?.current_period_end)
}

function unixTimestamp(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000).toISOString() : null
}

function positiveNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function idValue(value: unknown) {
  if (typeof value === 'string') return value
  return string(record(value)?.id)
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function string(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is not configured.`)
  return value
}

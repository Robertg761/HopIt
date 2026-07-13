import { NextResponse } from 'next/server'

import { applyCloudBillingEvent, readCloudSubscriptionByProviderCustomer } from '@/lib/cloud-backend'
import {
  constructStripeEvent,
  entitlementEventFromStripe,
  isBillingEnabled,
  revocationTargetFromStripe,
  revokedEntitlementEventFromSubscription,
} from '@/lib/stripe-billing'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request) {
  if (!isBillingEnabled()) return responseError('billing_disabled', 'Billing is not enabled.', 404)
  const signature = request.headers.get('stripe-signature')?.trim()
  if (!signature) return responseError('signature_missing', 'Stripe signature is required.', 400)

  let stripeEvent
  try {
    stripeEvent = constructStripeEvent(await request.text(), signature)
  } catch {
    return responseError('signature_invalid', 'Stripe signature is invalid.', 400)
  }

  let entitlement = entitlementEventFromStripe(stripeEvent)
  if (!entitlement) {
    try {
      const target = await revocationTargetFromStripe(stripeEvent)
      if (target) {
        const subscription = await readCloudSubscriptionByProviderCustomer(
          'stripe_managed_payments',
          target.providerCustomerId,
        )
        entitlement = revokedEntitlementEventFromSubscription(stripeEvent, subscription, target.status)
      }
    } catch (cause) {
      return responseError('revocation_lookup_failed', cause instanceof Error ? cause.message : 'Revocation lookup failed.', 500)
    }
  }
  if (!entitlement) return NextResponse.json({ ok: true, ignored: true }, noStore())

  try {
    const result = await applyCloudBillingEvent(entitlement) as { applied?: boolean; reason?: string } | null
    return NextResponse.json({
      ok: true,
      applied: result?.applied === true,
      duplicate: result?.reason === 'duplicate',
    }, noStore())
  } catch (cause) {
    return responseError('entitlement_update_failed', cause instanceof Error ? cause.message : 'Entitlement update failed.', 500)
  }
}

function responseError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status, ...noStore() })
}

function noStore() {
  return { headers: { 'Cache-Control': 'no-store' } }
}

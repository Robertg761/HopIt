import { auth, currentUser } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'

import { readCloudTenantSubscription } from '@/lib/cloud-backend'
import {
  billingPlanKey,
  checkoutUrls,
  createManagedCheckout,
  isBillingEnabled,
} from '@/lib/stripe-billing'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request) {
  if (!isBillingEnabled()) return error('billing_disabled', 'Billing is not enabled yet.', 404)
  const { userId } = await auth()
  if (!userId) return error('browser_auth_required', 'Sign in to upgrade your HopIt plan.', 401)

  const body = await request.json().catch(() => null)
  const planKey = billingPlanKey(record(body)?.plan)
  if (!planKey) return error('billing_plan_invalid', 'Choose a valid HopIt plan.', 400)

  try {
    const current = await readCloudTenantSubscription(userId)
    if (record(current)?.entitlementActive === true) {
      return error('subscription_active', 'Your account already has an active paid plan. Manage it instead.', 409)
    }
    const user = await currentUser()
    const urls = checkoutUrls(request.url)
    const session = await createManagedCheckout({
      tenantId: userId,
      email: user?.primaryEmailAddress?.emailAddress ?? null,
      planKey,
      successUrl: urls.successUrl,
      cancelUrl: urls.cancelUrl,
    })
    if (!session.url) return error('checkout_unavailable', 'Stripe did not return a checkout URL.', 502)
    return NextResponse.json({ ok: true, url: session.url }, noStore())
  } catch (cause) {
    return error('checkout_failed', message(cause), 500)
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function error(code: string, detail: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message: detail } }, { status, ...noStore() })
}

function noStore() {
  return { headers: { 'Cache-Control': 'no-store' } }
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : 'Checkout could not be created.'
}

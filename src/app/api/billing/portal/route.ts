import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'

import { readCloudTenantSubscription } from '@/lib/cloud-backend'
import { checkoutUrls, createBillingPortal, isBillingEnabled } from '@/lib/stripe-billing'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request) {
  if (!isBillingEnabled()) return responseError('billing_disabled', 'Billing is not enabled yet.', 404)
  const { userId } = await auth()
  if (!userId) return responseError('browser_auth_required', 'Sign in to manage your subscription.', 401)

  try {
    const subscription = await readCloudTenantSubscription(userId) as { providerCustomerId?: unknown } | null
    const customerId = typeof subscription?.providerCustomerId === 'string' ? subscription.providerCustomerId : null
    if (!customerId) return responseError('subscription_missing', 'No paid subscription was found for this account.', 404)
    const session = await createBillingPortal({ customerId, returnUrl: checkoutUrls(request.url).returnUrl })
    return NextResponse.json({ ok: true, url: session.url }, noStore())
  } catch (cause) {
    return responseError('portal_failed', cause instanceof Error ? cause.message : 'The billing portal is unavailable.', 500)
  }
}

function responseError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status, ...noStore() })
}

function noStore() {
  return { headers: { 'Cache-Control': 'no-store' } }
}

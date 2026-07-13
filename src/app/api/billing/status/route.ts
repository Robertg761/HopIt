import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'

import { readCloudTenantSubscription, readCloudTenantUsage } from '@/lib/cloud-backend'
import { isBillingEnabled } from '@/lib/stripe-billing'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  const { userId } = await auth()
  if (!userId) {
    return NextResponse.json({ ok: false, error: { code: 'browser_auth_required', message: 'Sign in to view your plan.' } }, {
      status: 401,
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  try {
    const [subscription, usage] = await Promise.all([
      readCloudTenantSubscription(userId),
      readCloudTenantUsage(userId),
    ])
    return NextResponse.json({
      ok: true,
      billingEnabled: isBillingEnabled(),
      subscription,
      usage,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (cause) {
    return NextResponse.json({
      ok: false,
      error: { code: 'billing_status_failed', message: cause instanceof Error ? cause.message : 'Plan status is unavailable.' },
    }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }
}

import { NextResponse } from 'next/server'

import { applyCloudBillingEvent, readCloudTenantSubscription } from '@/lib/cloud-backend'
import {
  isBillingEnabled,
  listStripeSubscriptionEntitlements,
  shouldPreserveRevokedEntitlement,
} from '@/lib/stripe-billing'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: { code: 'cron_unauthorized', message: 'Unauthorized.' } }, { status: 401 })
  }
  if (!isBillingEnabled()) return NextResponse.json({ ok: true, skipped: 'billing_disabled' })

  try {
    const events = await listStripeSubscriptionEntitlements()
    let applied = 0
    let duplicates = 0
    let preservedRevocations = 0
    for (const event of events) {
      const current = await readCloudTenantSubscription(event.tenantId)
      if (shouldPreserveRevokedEntitlement(current, event)) {
        preservedRevocations += 1
        continue
      }
      const result = await applyCloudBillingEvent(event) as { applied?: boolean; reason?: string }
      if (result?.applied) applied += 1
      if (result?.reason === 'duplicate') duplicates += 1
    }
    return NextResponse.json({ ok: true, checked: events.length, applied, duplicates, preservedRevocations })
  } catch (cause) {
    return NextResponse.json({
      ok: false,
      error: { code: 'reconcile_failed', message: cause instanceof Error ? cause.message : 'Reconciliation failed.' },
    }, { status: 500 })
  }
}

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET?.trim()
  return Boolean(secret && request.headers.get('authorization') === `Bearer ${secret}`)
}

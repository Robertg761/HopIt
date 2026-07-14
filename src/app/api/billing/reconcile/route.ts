import { NextResponse } from 'next/server'

import { reconcileBillingEntitlements } from '@/lib/billing-reconcile'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: { code: 'cron_unauthorized', message: 'Unauthorized.' } }, { status: 401 })
  }
  try {
    return NextResponse.json(await reconcileBillingEntitlements())
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

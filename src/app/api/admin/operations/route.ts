import { NextResponse } from 'next/server'

import { reconcileBillingEntitlements } from '@/lib/billing-reconcile'
import { setStripeSubscriptionCancellation } from '@/lib/stripe-billing'
import {
  requestServiceOperations,
  requireServiceAdmin,
  serviceAdminRuntimeConfig,
  serviceEconomics,
  ServiceAdminAccessError,
} from '@/lib/service-admin'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    const actor = await requireServiceAdmin()
    const operations = await requestServiceOperations(actor)
    return response(operations)
  } catch (cause) {
    return failure(cause)
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireServiceAdmin()
    const body = await request.json().catch(() => null) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ ok: false, error: { code: 'invalid_body', message: 'An action body is required.' } }, { status: 400 })

    if (body.action === 'reconcile_billing') {
      const result = await reconcileBillingEntitlements()
      const operations = await requestServiceOperations(actor, {
        method: 'POST',
        body: {
          action: 'record_billing_reconcile',
          confirmation: 'hopit-service',
          detail: result,
        },
      })
      return response(operations)
    }

    if (body.action === 'set_subscription_cancellation') {
      const tenantId = typeof body.tenantId === 'string' ? body.tenantId.trim() : ''
      if (!tenantId || body.confirmation !== tenantId) {
        return NextResponse.json({ ok: false, error: { code: 'confirmation_mismatch', message: 'Action confirmation did not match its tenant.' } }, { status: 400 })
      }
      const current = await requestServiceOperations(actor)
      const tenants = Array.isArray(current.tenants) ? current.tenants as Array<Record<string, unknown>> : []
      const tenant = tenants.find((entry) => entry.tenantId === tenantId)
      const subscription = record(tenant?.subscription)
      const subscriptionId = typeof subscription?.providerSubscriptionId === 'string' ? subscription.providerSubscriptionId : ''
      if (!subscriptionId) {
        return NextResponse.json({ ok: false, error: { code: 'subscription_missing', message: 'No Stripe subscription was found for this tenant.' } }, { status: 404 })
      }
      const cancelAtPeriodEnd = body.cancelAtPeriodEnd === true
      const stripeSubscription = await setStripeSubscriptionCancellation({ subscriptionId, cancelAtPeriodEnd })
      const reconcile = await reconcileBillingEntitlements()
      const operations = await requestServiceOperations(actor, {
        method: 'POST',
        body: {
          action: 'record_billing_action',
          tenantId,
          confirmation: tenantId,
          detail: {
            operation: cancelAtPeriodEnd ? 'cancel_at_period_end' : 'resume_renewal',
            providerSubscriptionId: stripeSubscription.id,
            reconcile,
          },
        },
      })
      return response(operations)
    }

    const operations = await requestServiceOperations(actor, { method: 'POST', body })
    return response(operations)
  } catch (cause) {
    return failure(cause)
  }
}

function record(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null
}

function response(operations: Record<string, unknown>) {
  return NextResponse.json({
    ok: true,
    ...operations,
    runtime: serviceAdminRuntimeConfig(),
    economics: serviceEconomics(operations),
  }, { headers: { 'Cache-Control': 'no-store' } })
}

function failure(cause: unknown) {
  const forbidden = cause instanceof ServiceAdminAccessError
  return NextResponse.json({
    ok: false,
    error: {
      code: forbidden ? 'service_admin_forbidden' : 'service_operations_failed',
      message: cause instanceof Error ? cause.message : 'The operations console is unavailable.',
    },
  }, { status: forbidden ? 403 : 500, headers: { 'Cache-Control': 'no-store' } })
}

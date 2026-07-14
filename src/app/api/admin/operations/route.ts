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
      if (body.confirmation !== 'hopit-service') {
        return NextResponse.json({ ok: false, error: { code: 'confirmation_mismatch', message: 'Action confirmation did not match the service.' } }, { status: 400 })
      }
      const result = await reconcileBillingEntitlements()
      const recorded = await recordAppliedOperation(actor, {
        action: 'record_billing_reconcile',
        confirmation: 'hopit-service',
        detail: result,
      })
      return response(recorded.operations, operationResult('billing_reconcile', result, recorded.warnings))
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
      if (typeof body.cancelAtPeriodEnd !== 'boolean') {
        return NextResponse.json({ ok: false, error: { code: 'invalid_cancellation_state', message: 'cancelAtPeriodEnd must be an explicit boolean.' } }, { status: 400 })
      }
      const cancelAtPeriodEnd = body.cancelAtPeriodEnd
      const stripeSubscription = await setStripeSubscriptionCancellation({ subscriptionId, cancelAtPeriodEnd })
      const warnings: string[] = []
      const reconcile = await reconcileBillingAfterMutation(tenantId, warnings)
      const detail = {
        operation: cancelAtPeriodEnd ? 'cancel_at_period_end' : 'resume_renewal',
        providerSubscriptionId: stripeSubscription.id,
        reconcile,
      }
      const recorded = await recordAppliedOperation(actor, {
        action: 'record_billing_action',
        tenantId,
        confirmation: tenantId,
        detail,
      })
      return response(
        recorded.operations,
        operationResult(detail.operation, reconcile, [...warnings, ...recorded.warnings], {
          tenantId,
          providerSubscriptionId: stripeSubscription.id,
        }),
      )
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

async function reconcileBillingAfterMutation(tenantId: string, warnings: string[]) {
  try {
    return await reconcileBillingEntitlements()
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Billing reconciliation could not run.'
    warnings.push(`Stripe changed successfully, but entitlement reconciliation failed: ${message}`)
    return { ok: false, partial: false, checked: 0, applied: 0, failures: [{ tenantId, message }] }
  }
}

async function recordAppliedOperation(actor: Awaited<ReturnType<typeof requireServiceAdmin>>, body: Record<string, unknown>) {
  const warnings: string[] = []
  try {
    return {
      operations: await requestServiceOperations(actor, { method: 'POST', body }),
      warnings,
    }
  } catch (cause) {
    warnings.push(`The operation was applied, but its audit record could not be confirmed: ${cause instanceof Error ? cause.message : 'unknown audit failure'}`)
    try {
      return { operations: await requestServiceOperations(actor), warnings }
    } catch (refreshCause) {
      warnings.push(`The dashboard snapshot could not be refreshed: ${refreshCause instanceof Error ? refreshCause.message : 'unknown refresh failure'}`)
      return { operations: { snapshotAvailable: false }, warnings }
    }
  }
}

function operationResult(
  operation: string,
  reconcile: Record<string, any>,
  warnings: string[],
  detail: Record<string, unknown> = {},
) {
  const reconciliationFailures = Array.isArray(reconcile.failures)
    ? reconcile.failures.map((failure: unknown) => record(failure)?.message).filter((message): message is string => typeof message === 'string')
    : []
  const allWarnings = [...warnings, ...reconciliationFailures.map((message) => `Entitlement reconciliation warning: ${message}`)]
  return {
    operation,
    applied: true,
    completedWithWarnings: allWarnings.length > 0,
    warnings: allWarnings,
    reconcile,
    ...detail,
  }
}

function response(operations: Record<string, unknown>, operation?: Record<string, unknown>) {
  return NextResponse.json({
    ok: true,
    ...operations,
    ...(operation ? { operation } : {}),
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

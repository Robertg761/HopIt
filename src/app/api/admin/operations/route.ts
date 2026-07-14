import { NextResponse } from 'next/server'

import { reconcileBillingEntitlements } from '@/lib/billing-reconcile'
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

    const operations = await requestServiceOperations(actor, { method: 'POST', body })
    return response(operations)
  } catch (cause) {
    return failure(cause)
  }
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

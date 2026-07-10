import { NextResponse } from 'next/server'

import {
  approveCloudDeviceAuthorization,
  listCloudCodebases,
  missingCloudBackendConfig,
  upsertCloudUser,
} from '@/lib/cloud-backend'
import { cloudActorFromRequest } from '@/lib/request-cloud-actor'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request) {
  const missing = missingCloudBackendConfig()
  if (missing.length > 0) return approvalError('cloud_backend_unavailable', 'HopIt Cloud is unavailable.', 503)
  if (!sameOrigin(request)) return approvalError('invalid_origin', 'Device approval must come from HopIt.', 403)

  try {
    const actor = await cloudActorFromRequest(request)
    if (!actor?.userId) return approvalError('browser_auth_required', 'Sign in before approving this device.', 401)
    await upsertCloudUser(actor)
    const body = await request.json().catch(() => null)
    const record = recordValue(body)
    const userCode = requireText(record?.userCode, 'userCode')
    const codebaseId = requireText(record?.codebaseId, 'codebaseId')
    const visibleCodebases = await listCloudCodebases(actor) as Array<Record<string, unknown>>
    if (!visibleCodebases.some((entry) => codebaseIdFor(entry) === codebaseId)) {
      return approvalError('codebase_forbidden', 'You do not have access to that codebase.', 403)
    }
    const authorization = await approveCloudDeviceAuthorization({ userCode, codebaseId, actor })
    return NextResponse.json({ ok: true, authorization }, responseInit())
  } catch (error) {
    return approvalError('device_authorization_approval_failed', errorMessage(error), 400)
  }
}

function sameOrigin(request: Request) {
  const origin = request.headers.get('origin')
  if (!origin) return true
  try {
    return new URL(origin).host === new URL(request.url).host
  } catch {
    return false
  }
}

function codebaseIdFor(entry: Record<string, unknown>) {
  const codebase = recordValue(entry.codebase)
  return optionalText(codebase?.id) ?? optionalText(entry.id)
}

function requireText(value: unknown, label: string) {
  const text = optionalText(value)
  if (!text) throw new Error(`${label} is required.`)
  return text
}

function optionalText(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Device approval failed.'
}

function responseInit() {
  return { headers: { 'Cache-Control': 'no-store' } }
}

function approvalError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status, ...responseInit() })
}

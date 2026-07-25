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
    const selections = approvalSelections(record)
    if (selections.length === 0) {
      return approvalError('codebase_required', 'Select at least one project to approve.', 400)
    }
    // Every selected project is access-checked, not just the first one.
    const visibleCodebases = await listCloudCodebases(actor) as Array<Record<string, unknown>>
    const visibleIds = new Set(visibleCodebases.map(codebaseIdFor).filter((id): id is string => Boolean(id)))
    for (const selection of selections) {
      if (!visibleIds.has(selection.codebaseId)) {
        return approvalError('codebase_forbidden', 'You do not have access to that codebase.', 403)
      }
    }
    const authorization = await approveCloudDeviceAuthorization({ userCode, selections, actor })
    return NextResponse.json({ ok: true, authorization }, responseInit())
  } catch (error) {
    return approvalError('device_authorization_approval_failed', errorMessage(error), 400)
  }
}

/**
 * Normalize the batch (`selections`) and legacy scalar (`codebaseId`) request
 * shapes into one list. The legacy branch keeps a browser tab holding pre-batch
 * JavaScript working while a deploy rolls out.
 *
 * `acknowledgedExisting` is forwarded rather than inferred: the backend refuses a
 * selection that adopts an existing project instead of creating the requested one
 * unless this flag is explicitly set, so it must survive the wire intact.
 */
function approvalSelections(record: Record<string, unknown> | null) {
  const raw = Array.isArray(record?.selections)
    ? record.selections
    : [{
        codebaseId: record?.codebaseId,
        requestedCodebaseId: record?.requestedCodebaseId,
        acknowledgedExisting: record?.acknowledgedExisting,
      }]
  const selections: Array<{ codebaseId: string; requestedCodebaseId: string | null; acknowledgedExisting: boolean }> = []
  const seen = new Set<string>()
  for (const item of raw) {
    const entry = recordValue(item)
    const codebaseId = optionalText(entry?.codebaseId)
    if (!codebaseId || seen.has(codebaseId)) continue
    seen.add(codebaseId)
    selections.push({
      codebaseId,
      requestedCodebaseId: optionalText(entry?.requestedCodebaseId),
      acknowledgedExisting: entry?.acknowledgedExisting === true,
    })
  }
  return selections
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

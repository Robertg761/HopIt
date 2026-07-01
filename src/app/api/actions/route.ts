import { NextResponse } from 'next/server'

import {
  createCloudActionJob,
  listCloudActionJobs,
  missingCloudBackendConfig,
} from '@/lib/cloud-backend'
import { cloudActorFromRequest } from '@/lib/request-cloud-actor'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request) {
  const unavailable = unavailableReason({ feature: 'actions' })
  if (unavailable) return actionError(unavailable.code, unavailable.message, unavailable.status)

  const codebaseId = new URL(request.url).searchParams.get('codebaseId')?.trim()
  if (!codebaseId) return actionError('codebase_required', 'Expected a codebaseId query parameter.', 400)

  try {
    const actor = await cloudActorFromRequest(request, {
      allowBasicFallback: true,
      codebaseId,
      agentCapability: 'read',
    })
    if (!actor) return actionError('browser_auth_required', 'Running actions requires product auth.', 401)
    const jobs = await listCloudActionJobs({
      codebaseId,
      limit: 20,
      actor,
    })
    return NextResponse.json({ ok: true, jobs: Array.isArray(jobs) ? jobs : [] }, responseInit())
  } catch (error) {
    return actionError('action_list_failed', errorMessage(error), 400)
  }
}

export async function POST(request: Request) {
  const body = await readBody(request)
  const unavailable = unavailableReason({ feature: 'actions' })
  if (unavailable) return actionError(unavailable.code, unavailable.message, unavailable.status)

  try {
    const codebaseId = requireText(body.codebaseId, 'codebaseId')
    const actor = await cloudActorFromRequest(request, {
      codebaseId,
      agentCapability: 'write',
    })
    if (!actor) return actionError('browser_auth_required', 'Running actions requires product auth.', 401)
    const job = await createCloudActionJob({
      codebaseId,
      kind: actionKind(body.kind),
      actor,
    })
    return NextResponse.json({ ok: true, job }, responseInit())
  } catch (error) {
    return actionError('action_create_failed', errorMessage(error), 400)
  }
}

function unavailableReason({ feature }: { feature: string }) {
  const missing = missingCloudBackendConfig()
  if (missing.length > 0) {
    return {
      code: 'cloud_backend_unavailable',
      message: `No HopIt cloud backend is configured for ${feature}. Missing: ${missing.join(', ')}.`,
      status: 503,
    }
  }

  return null
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null)
  return recordValue(body) ?? {}
}

function requireText(value: unknown, label: string) {
  const text = typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
  if (!text) throw new Error(`${label} is required.`)
  return text
}

function actionKind(value: unknown) {
  if (value === 'lint' || value === 'test' || value === 'build') return value
  throw new Error('Action kind must be lint, test, or build.')
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function responseInit() {
  return {
    headers: {
      'Cache-Control': 'no-store',
    },
  }
}

function actionError(code: string, message: string, status = 400) {
  return NextResponse.json({ ok: false, error: { code, message }, jobs: [] }, { status, ...responseInit() })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Action request failed.'
}

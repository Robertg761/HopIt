import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'

import { hasValidBasicAuthFallbackCredentials } from '@/lib/basic-auth-fallback'
import {
  createCloudActionJob,
  listCloudActionJobs,
  missingCloudBackendConfig,
  type CloudActor,
} from '@/lib/cloud-backend'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request) {
  const unavailable = await unavailableReason(request, { allowBasicFallback: true })
  if (unavailable) return actionError(unavailable.code, unavailable.message, unavailable.status)

  const codebaseId = new URL(request.url).searchParams.get('codebaseId')?.trim()
  if (!codebaseId) return actionError('codebase_required', 'Expected a codebaseId query parameter.', 400)

  try {
    const actor = await requireActor(request, { allowBasicFallback: true })
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
  const unavailable = await unavailableReason(request)
  if (unavailable) return actionError(unavailable.code, unavailable.message, unavailable.status)

  try {
    const actor = await requireActor(request)
    const job = await createCloudActionJob({
      codebaseId: requireText(body.codebaseId, 'codebaseId'),
      kind: actionKind(body.kind),
      actor,
    })
    return NextResponse.json({ ok: true, job }, responseInit())
  } catch (error) {
    return actionError('action_create_failed', errorMessage(error), 400)
  }
}

async function unavailableReason(request: Request, { allowBasicFallback = false } = {}) {
  const missing = missingCloudBackendConfig()
  if (missing.length > 0) {
    return {
      code: 'cloud_backend_unavailable',
      message: `No HopIt cloud backend is configured for actions. Missing: ${missing.join(', ')}.`,
      status: 503,
    }
  }

  if (hasValidBasicAuthFallbackCredentials(request.headers)) {
    return allowBasicFallback
      ? null
      : {
          code: 'browser_auth_required',
          message: 'Running actions requires product auth.',
          status: 401,
        }
  }

  const { userId } = await auth()
  if (!userId) {
    return {
      code: 'browser_auth_required',
      message: 'Running actions requires product auth.',
      status: 401,
    }
  }

  return null
}

async function requireActor(request: Request, { allowBasicFallback = false } = {}): Promise<CloudActor> {
  if (allowBasicFallback && hasValidBasicAuthFallbackCredentials(request.headers)) return {}
  const { userId } = await auth()
  if (!userId) throw new Error('Product auth is required.')
  return { userId }
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

import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'

import { hasValidBasicAuthFallbackCredentials } from '@/lib/basic-auth-fallback'
import {
  createCloudCodebase,
  deleteCloudCodebase,
  listCloudCodebases,
  missingCloudBackendConfig,
  updateCloudCodebase,
  type CloudActor,
} from '@/lib/cloud-backend'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request) {
  const unavailable = await unavailableReason(request, { allowBasicFallback: true })
  if (unavailable) return codebaseError(unavailable.code, unavailable.message, unavailable.status)

  try {
    const actor = await requireActor(request, { allowBasicFallback: true })
    const codebases = await listCloudCodebases(actor)
    return NextResponse.json({ ok: true, codebases: Array.isArray(codebases) ? codebases : [] }, responseInit())
  } catch (error) {
    return codebaseError('codebase_list_failed', errorMessage(error), 400)
  }
}

export async function POST(request: Request) {
  const body = await readBody(request)
  const unavailable = await unavailableReason(request)
  if (unavailable) return codebaseError(unavailable.code, unavailable.message, unavailable.status)

  try {
    const actor = await requireActor(request)
    const codebase = await createCloudCodebase({
      name: requireText(body.name, 'name'),
      codebaseId: optionalText(body.codebaseId),
      description: optionalText(body.description),
      actor,
    })
    const codebases = await listCloudCodebases(actor)

    return NextResponse.json(
      {
        ok: true,
        codebase,
        codebases: Array.isArray(codebases) ? codebases : [],
      },
      responseInit(),
    )
  } catch (error) {
    return codebaseError('codebase_create_failed', errorMessage(error), 400)
  }
}

export async function PATCH(request: Request) {
  const body = await readBody(request)
  const unavailable = await unavailableReason(request)
  if (unavailable) return codebaseError(unavailable.code, unavailable.message, unavailable.status)

  try {
    const actor = await requireActor(request)
    const codebase = await updateCloudCodebase({
      codebaseId: requireText(body.codebaseId, 'codebaseId'),
      name: optionalText(body.name),
      visibility: visibilityValue(body.visibility),
      actor,
    })
    const codebases = await listCloudCodebases(actor)

    return NextResponse.json(
      {
        ok: true,
        codebase,
        codebases: Array.isArray(codebases) ? codebases : [],
      },
      responseInit(),
    )
  } catch (error) {
    return codebaseError('codebase_update_failed', errorMessage(error), 400)
  }
}

export async function DELETE(request: Request) {
  const body = await readBody(request)
  const unavailable = await unavailableReason(request)
  if (unavailable) return codebaseError(unavailable.code, unavailable.message, unavailable.status)

  try {
    const actor = await requireActor(request)
    await deleteCloudCodebase({
      codebaseId: requireText(body.codebaseId, 'codebaseId'),
      actor,
    })
    const codebases = await listCloudCodebases(actor)

    return NextResponse.json(
      {
        ok: true,
        codebases: Array.isArray(codebases) ? codebases : [],
      },
      responseInit(),
    )
  } catch (error) {
    return codebaseError('codebase_delete_failed', errorMessage(error), 400)
  }
}

async function unavailableReason(request: Request, { allowBasicFallback = false } = {}) {
  const missing = missingCloudBackendConfig()
  if (missing.length > 0) {
    return {
      code: 'cloud_backend_unavailable',
      message: `No HopIt cloud backend is configured for codebases. Missing: ${missing.join(', ')}.`,
      status: 503,
    }
  }

  if (hasValidBasicAuthFallbackCredentials(request.headers)) {
    return allowBasicFallback
      ? null
      : {
          code: 'browser_auth_required',
          message: 'Managing codebases requires product auth.',
          status: 401,
        }
  }

  const { userId } = await auth()
  if (!userId) {
    return {
      code: 'browser_auth_required',
      message: 'Managing codebases requires product auth.',
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
  const text = optionalText(value)
  if (!text) throw new Error(`${label} is required.`)
  return text
}

function optionalText(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function visibilityValue(value: unknown) {
  if (value === 'private' || value === 'team-visible' || value === 'review-visible') return value
  return undefined
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

function codebaseError(code: string, message: string, status = 400) {
  return NextResponse.json({ ok: false, error: { code, message }, codebases: [] }, { status, ...responseInit() })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Codebase request failed.'
}

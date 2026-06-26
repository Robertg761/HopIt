import { NextResponse } from 'next/server'
import { anyApi } from 'convex/server'

import { convexAuthToken, convexClient, convexUrl } from '@/lib/convex-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  const unavailable = await unavailableReason()
  if (unavailable) return codebaseError(unavailable.code, unavailable.message, unavailable.status)

  try {
    const authToken = await convexAuthToken()
    const codebases = await convexClient(authToken).query(anyApi.agent.listCodebases, {})
    return NextResponse.json({ ok: true, codebases: Array.isArray(codebases) ? codebases : [] }, responseInit())
  } catch (error) {
    return codebaseError('codebase_list_failed', errorMessage(error), 400)
  }
}

export async function POST(request: Request) {
  const body = await readBody(request)
  const unavailable = await unavailableReason()
  if (unavailable) return codebaseError(unavailable.code, unavailable.message, unavailable.status)

  try {
    const authToken = await convexAuthToken()
    const codebase = await convexClient(authToken).mutation(anyApi.agent.createCodebase, {
      name: requireText(body.name, 'name'),
      codebaseId: optionalText(body.codebaseId),
      description: optionalText(body.description),
    })
    const codebases = await convexClient(authToken).query(anyApi.agent.listCodebases, {})

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
  const unavailable = await unavailableReason()
  if (unavailable) return codebaseError(unavailable.code, unavailable.message, unavailable.status)

  try {
    const authToken = await convexAuthToken()
    const codebase = await convexClient(authToken).mutation(anyApi.agent.updateCodebase, {
      codebaseId: requireText(body.codebaseId, 'codebaseId'),
      name: optionalText(body.name),
      visibility: visibilityValue(body.visibility),
    })
    const codebases = await convexClient(authToken).query(anyApi.agent.listCodebases, {})

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
  const unavailable = await unavailableReason()
  if (unavailable) return codebaseError(unavailable.code, unavailable.message, unavailable.status)

  try {
    const authToken = await convexAuthToken()
    await convexClient(authToken).mutation(anyApi.agent.deleteCodebase, {
      codebaseId: requireText(body.codebaseId, 'codebaseId'),
    })
    const codebases = await convexClient(authToken).query(anyApi.agent.listCodebases, {})

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

async function unavailableReason() {
  if (!convexUrl()) {
    return { code: 'convex_unavailable', message: 'Convex is not configured for codebases.', status: 503 }
  }

  const authToken = await convexAuthToken()
  if (!authToken) {
    return {
      code: 'browser_auth_required',
      message: 'Managing codebases requires product auth.',
      status: 401,
    }
  }

  return null
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

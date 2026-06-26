import { NextResponse } from 'next/server'
import { anyApi } from 'convex/server'

import { convexAuthToken, convexClient, convexUrl } from '@/lib/convex-auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function PATCH(request: Request) {
  const body = await readBody(request)

  if (!convexUrl()) {
    return fileError('convex_unavailable', 'Convex is not configured for file edits.', 503)
  }

  const authToken = await convexAuthToken()
  if (!authToken) {
    return fileError('browser_auth_required', 'Editing codebase files requires product auth.', 401)
  }

  try {
    const result = await convexClient(authToken).mutation(anyApi.agent.mutateTextFile, {
      codebaseId: requireText(body.codebaseId, 'codebaseId'),
      path: requireText(body.path, 'path'),
      content: requireString(body.content, 'content'),
      baseRevision: optionalRevision(body.baseRevision),
    })

    return NextResponse.json({ ok: true, result }, responseInit())
  } catch (error) {
    return fileError('file_mutation_failed', errorMessage(error), 400)
  }
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

function requireString(value: unknown, label: string) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  return value
}

function optionalRevision(value: unknown) {
  if (value === null) return null
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
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

function fileError(code: string, message: string, status = 400) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status, ...responseInit() })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'File request failed.'
}

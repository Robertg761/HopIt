import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'

import { hasValidBasicAuthFallbackCredentials } from '@/lib/basic-auth-fallback'
import {
  missingCloudBackendConfig,
  mutateCloudTextFile,
  readCloudTextFile,
  type CloudActor,
} from '@/lib/cloud-backend'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request) {
  const url = new URL(request.url)

  const missing = missingCloudBackendConfig()
  if (missing.length > 0) {
    return fileError('cloud_backend_unavailable', `No HopIt cloud backend is configured for file reads. Missing: ${missing.join(', ')}.`, 503)
  }

  const actor = await actorFromRequest(request, { allowBasicFallback: true })
  if (!actor) {
    return fileError('browser_auth_required', 'Reading codebase files requires product auth.', 401)
  }

  try {
    const result = await readCloudTextFile({
      codebaseId: requireText(url.searchParams.get('codebaseId'), 'codebaseId'),
      path: requireText(url.searchParams.get('path'), 'path'),
      actor,
    })

    return NextResponse.json({ ok: true, file: result }, responseInit())
  } catch (error) {
    return fileError('file_read_failed', errorMessage(error), 400)
  }
}

export async function PATCH(request: Request) {
  const body = await readBody(request)

  const missing = missingCloudBackendConfig()
  if (missing.length > 0) {
    return fileError('cloud_backend_unavailable', `No HopIt cloud backend is configured for file edits. Missing: ${missing.join(', ')}.`, 503)
  }

  const actor = await actorFromRequest(request)
  if (!actor) {
    return fileError('browser_auth_required', 'Editing codebase files requires product auth.', 401)
  }

  try {
    const result = await mutateCloudTextFile({
      codebaseId: requireText(body.codebaseId, 'codebaseId'),
      path: requireText(body.path, 'path'),
      content: requireString(body.content, 'content'),
      baseRevision: optionalRevision(body.baseRevision),
      actor,
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

async function actorFromRequest(request: Request, { allowBasicFallback = false } = {}): Promise<CloudActor | null> {
  if (allowBasicFallback && hasValidBasicAuthFallbackCredentials(request.headers)) return {}
  if (hasValidBasicAuthFallbackCredentials(request.headers)) return null
  const { userId } = await auth()
  return userId ? { userId } : null
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

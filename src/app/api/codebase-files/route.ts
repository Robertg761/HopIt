import { NextResponse } from 'next/server'

import {
  missingCloudBackendConfig,
  mutateCloudTextFile,
  readCloudTextFile,
} from '@/lib/cloud-backend'
import { cloudActorFromRequest } from '@/lib/request-cloud-actor'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request) {
  const url = new URL(request.url)

  const missing = missingCloudBackendConfig()
  if (missing.length > 0) {
    return fileError('cloud_backend_unavailable', `No HopIt cloud backend is configured for file reads. Missing: ${missing.join(', ')}.`, 503)
  }

  try {
    const codebaseId = requireText(url.searchParams.get('codebaseId'), 'codebaseId')
    const actor = await cloudActorFromRequest(request, {
      allowBasicFallback: true,
      codebaseId,
      agentCapability: 'read',
    })
    if (!actor) {
      return fileError('browser_auth_required', 'Reading codebase files requires product auth.', 401)
    }

    const result = await readCloudTextFile({
      codebaseId,
      path: requireText(url.searchParams.get('path'), 'path'),
      actor,
    })

    return NextResponse.json({ ok: true, file: result }, responseInit())
  } catch (error) {
    const failure = fileRequestFailure(error, 'file_read_failed')
    return fileError(failure.code, failure.message, failure.status)
  }
}

export async function PATCH(request: Request) {
  const body = await readBody(request)

  const missing = missingCloudBackendConfig()
  if (missing.length > 0) {
    return fileError('cloud_backend_unavailable', `No HopIt cloud backend is configured for file edits. Missing: ${missing.join(', ')}.`, 503)
  }

  try {
    const codebaseId = requireText(body.codebaseId, 'codebaseId')
    const actor = await cloudActorFromRequest(request, {
      codebaseId,
      agentCapability: 'write',
    })
    if (!actor) {
      return fileError('browser_auth_required', 'Editing codebase files requires product auth.', 401)
    }

    const result = await mutateCloudTextFile({
      codebaseId,
      path: requireText(body.path, 'path'),
      content: requireString(body.content, 'content'),
      baseRevision: optionalRevision(body.baseRevision),
      selectedStateId: requireText(body.selectedStateId, 'selectedStateId'),
      actor,
    })

    return NextResponse.json({ ok: true, result }, responseInit())
  } catch (error) {
    const failure = fileRequestFailure(error, 'file_mutation_failed')
    return fileError(failure.code, failure.message, failure.status)
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

function fileRequestFailure(error: unknown, fallbackCode: string) {
  const detail = recordValue(error)
  const nestedDetail = recordValue(detail?.detail)
  const reportedCode = typeof detail?.code === 'string'
    ? detail.code
    : typeof nestedDetail?.reason === 'string'
      ? nestedDetail.reason
      : null
  const conflictCodes = new Set([
    'base_revision_mismatch',
    'object_blob_upload_required',
    'selected_state_already_merged',
    'selected_state_id_mismatch',
    'selected_state_not_writable',
    'selected_state_revision_mismatch',
    'selected_state_type_mismatch',
  ])
  const code = reportedCode && conflictCodes.has(reportedCode) ? reportedCode : fallbackCode
  return {
    code,
    message: errorMessage(error),
    status: conflictCodes.has(code) ? 409 : 400,
  }
}

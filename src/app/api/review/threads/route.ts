import { NextResponse } from 'next/server'

import {
  type CloudActor,
  configuredCloudBackend,
  missingCloudBackendConfig,
} from '@/lib/cloud-backend'
import { createD1Backend } from '@hopit/backend-d1'
import { cloudActorFromRequest } from '@/lib/request-cloud-actor'
import type { ReviewThread, ReviewThreadComment, ReviewThreadsResponse } from '@/lib/collaboration'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type D1ReviewBackend = {
  listReviewThreads(input: {
    codebaseId: string
    changeSetId?: string | null
    actor: CloudActor
  }): Promise<ReviewThread[]>
  createReviewThread(input: {
    codebaseId: string
    changeSetId: string
    filePath: string
    lineNumber?: number
    baseRevision?: string
    headRevision?: string
    lineFingerprint?: string
    body: string
    createdBy?: string
    actor: CloudActor
  }): Promise<ReviewThread>
  createReviewThreadComment(input: {
    codebaseId: string
    threadId: string
    body: string
    createdBy?: string
    actor: CloudActor
  }): Promise<ReviewThreadComment>
  resolveReviewThread(input: {
    codebaseId: string
    threadId: string
    updatedBy?: string
    actor: CloudActor
  }): Promise<ReviewThread>
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const codebaseId = stringValue(url.searchParams.get('codebaseId'))
  const changeSetId = stringValue(url.searchParams.get('changeSetId'))
  if (!codebaseId) return reviewThreadsError(null, changeSetId, 'codebase_required', 'Expected a codebaseId query parameter.', 400)

  const unavailable = d1Unavailable()
  if (unavailable) return reviewThreadsError(codebaseId, changeSetId, unavailable.code, unavailable.message, unavailable.status)

  try {
    const actor = await cloudActorFromRequest(request, {
      allowBasicFallback: true,
      codebaseId,
      agentCapability: 'read',
    })
    if (!actor) {
      return reviewThreadsError(codebaseId, changeSetId, 'browser_auth_required', 'Reading review threads requires product auth or Basic Auth fallback.', 401)
    }
    const backend = d1ReviewBackend(codebaseId)
    const threads = await backend.listReviewThreads({ codebaseId, changeSetId, actor })
    return NextResponse.json({ ok: true, codebaseId, changeSetId, threads }, responseInit())
  } catch (error) {
    return reviewThreadsError(codebaseId, changeSetId, 'review_threads_read_failed', errorMessage(error), 400)
  }
}

export async function POST(request: Request) {
  const body = await readBody(request)
  const codebaseId = stringValue(body.codebaseId)
  const changeSetId = stringValue(body.changeSetId)
  if (!codebaseId) return reviewThreadsError(null, changeSetId, 'codebase_required', 'Expected codebaseId.', 400)

  const unavailable = d1Unavailable()
  if (unavailable) return reviewThreadsError(codebaseId, changeSetId, unavailable.code, unavailable.message, unavailable.status)

  try {
    const actor = await cloudActorFromRequest(request, {
      codebaseId,
      agentCapability: 'write',
    })
    if (!actor?.userId) {
      return reviewThreadsError(codebaseId, changeSetId, 'browser_auth_required', 'Creating review threads requires product auth.', 401)
    }

    const backend = d1ReviewBackend(codebaseId)
    if (body.type === 'comment') {
      await backend.createReviewThreadComment({
        codebaseId,
        threadId: requireText(body.threadId, 'threadId'),
        body: requireText(body.body, 'body'),
        createdBy: optionalText(body.createdBy),
        actor,
      })
    } else {
      await backend.createReviewThread({
        codebaseId,
        changeSetId: requireText(body.changeSetId, 'changeSetId'),
        filePath: requireText(body.filePath, 'filePath'),
        lineNumber: optionalInteger(body.lineNumber),
        baseRevision: optionalText(body.baseRevision),
        headRevision: optionalText(body.headRevision),
        lineFingerprint: optionalText(body.lineFingerprint),
        body: requireText(body.body, 'body'),
        createdBy: optionalText(body.createdBy),
        actor,
      })
    }
    const threads = await backend.listReviewThreads({ codebaseId, changeSetId, actor })
    return NextResponse.json({ ok: true, codebaseId, changeSetId, threads }, responseInit())
  } catch (error) {
    return reviewThreadsError(codebaseId, changeSetId, 'review_threads_create_failed', errorMessage(error), 400)
  }
}

export async function PATCH(request: Request) {
  const body = await readBody(request)
  const codebaseId = stringValue(body.codebaseId)
  const changeSetId = stringValue(body.changeSetId)
  if (!codebaseId) return reviewThreadsError(null, changeSetId, 'codebase_required', 'Expected codebaseId.', 400)
  if (body.action !== 'resolve') {
    return reviewThreadsError(codebaseId, changeSetId, 'invalid_action', 'Unknown review thread action.', 400)
  }

  const unavailable = d1Unavailable()
  if (unavailable) return reviewThreadsError(codebaseId, changeSetId, unavailable.code, unavailable.message, unavailable.status)

  try {
    const actor = await cloudActorFromRequest(request, {
      codebaseId,
      agentCapability: 'write',
    })
    if (!actor?.userId) {
      return reviewThreadsError(codebaseId, changeSetId, 'browser_auth_required', 'Updating review threads requires product auth.', 401)
    }

    const backend = d1ReviewBackend(codebaseId)
    await backend.resolveReviewThread({
      codebaseId,
      threadId: requireText(body.threadId, 'threadId'),
      updatedBy: optionalText(body.updatedBy),
      actor,
    })
    const threads = await backend.listReviewThreads({ codebaseId, changeSetId, actor })
    return NextResponse.json({ ok: true, codebaseId, changeSetId, threads }, responseInit())
  } catch (error) {
    return reviewThreadsError(codebaseId, changeSetId, 'review_threads_update_failed', errorMessage(error), 400)
  }
}

function d1Unavailable() {
  const missing = missingCloudBackendConfig()
  if (missing.length > 0) {
    return {
      code: 'cloud_backend_unavailable',
      message: `No HopIt cloud backend is configured for review threads. Missing: ${missing.join(', ')}.`,
      status: 503,
    }
  }
  if (configuredCloudBackend() !== 'd1') {
    return {
      code: 'd1_required',
      message: 'Snapshot-anchored review threads require the D1 backend.',
      status: 503,
    }
  }
  return null
}

function reviewThreadsError(
  codebaseId: string | null,
  changeSetId: string | null,
  code: string,
  message: string,
  status: number,
) {
  const body: ReviewThreadsResponse = {
    ok: false,
    codebaseId,
    changeSetId,
    threads: [],
    error: { code, message },
  }

  return NextResponse.json(body, {
    status,
    ...responseInit(),
  })
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null)
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

function responseInit() {
  return {
    headers: {
      'Cache-Control': 'no-store',
    },
  }
}

function requireText(value: unknown, label: string) {
  const text = stringValue(value)
  if (!text) throw new Error(`${label} is required.`)
  return text
}

function optionalText(value: unknown): string | undefined {
  return stringValue(value) ?? undefined
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function d1ReviewBackend(codebaseId: string): D1ReviewBackend {
  return createD1Backend({ 'codebase-id': codebaseId }) as unknown as D1ReviewBackend
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Review thread request failed.'
}

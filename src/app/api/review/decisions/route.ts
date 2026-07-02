import { NextResponse } from 'next/server'

import {
  type CloudActor,
  configuredCloudBackend,
  missingCloudBackendConfig,
} from '@/lib/cloud-backend'
import { createD1Backend } from '@/lib/d1-backend.js'
import { cloudActorFromRequest } from '@/lib/request-cloud-actor'
import type {
  ReviewDecision,
  ReviewDecisionKind,
  ReviewDecisionsResponse,
} from '@/lib/collaboration'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type D1ReviewDecisionBackend = {
  listReviewDecisions(input: {
    codebaseId: string
    changeSetId?: string | null
    actor: CloudActor
  }): Promise<ReviewDecision[]>
  createReviewDecision(input: {
    codebaseId: string
    changeSetId: string
    decision: ReviewDecisionKind
    summary?: string | null
    createdBy?: string
    actor: CloudActor
  }): Promise<ReviewDecision>
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const codebaseId = stringValue(url.searchParams.get('codebaseId'))
  const changeSetId = stringValue(url.searchParams.get('changeSetId'))
  if (!codebaseId) return reviewDecisionsError(null, changeSetId, 'codebase_required', 'Expected a codebaseId query parameter.', 400)

  const unavailable = d1Unavailable()
  if (unavailable) return reviewDecisionsError(codebaseId, changeSetId, unavailable.code, unavailable.message, unavailable.status)

  try {
    const actor = await cloudActorFromRequest(request, {
      allowBasicFallback: true,
      codebaseId,
      agentCapability: 'read',
    })
    if (!actor) {
      return reviewDecisionsError(codebaseId, changeSetId, 'browser_auth_required', 'Reading review decisions requires product auth or Basic Auth fallback.', 401)
    }
    const backend = d1ReviewDecisionBackend(codebaseId)
    const decisions = await backend.listReviewDecisions({ codebaseId, changeSetId, actor })
    return NextResponse.json({ ok: true, codebaseId, changeSetId, decisions }, responseInit())
  } catch (error) {
    return reviewDecisionsError(codebaseId, changeSetId, 'review_decisions_read_failed', errorMessage(error), 400)
  }
}

export async function POST(request: Request) {
  const body = await readBody(request)
  const codebaseId = stringValue(body.codebaseId)
  const changeSetId = stringValue(body.changeSetId)
  if (!codebaseId) return reviewDecisionsError(null, changeSetId, 'codebase_required', 'Expected codebaseId.', 400)

  const unavailable = d1Unavailable()
  if (unavailable) return reviewDecisionsError(codebaseId, changeSetId, unavailable.code, unavailable.message, unavailable.status)

  try {
    const actor = await cloudActorFromRequest(request, {
      codebaseId,
      agentCapability: 'review',
    })
    if (!actor?.userId) {
      return reviewDecisionsError(codebaseId, changeSetId, 'browser_auth_required', 'Creating review decisions requires product auth.', 401)
    }

    const backend = d1ReviewDecisionBackend(codebaseId)
    await backend.createReviewDecision({
      codebaseId,
      changeSetId: requireText(body.changeSetId, 'changeSetId'),
      decision: requireDecision(body.decision),
      summary: optionalText(body.summary),
      createdBy: optionalText(body.createdBy),
      actor,
    })
    const decisions = await backend.listReviewDecisions({ codebaseId, changeSetId, actor })
    return NextResponse.json({ ok: true, codebaseId, changeSetId, decisions }, responseInit())
  } catch (error) {
    return reviewDecisionsError(codebaseId, changeSetId, 'review_decisions_create_failed', errorMessage(error), 400)
  }
}

function d1Unavailable() {
  const missing = missingCloudBackendConfig()
  if (missing.length > 0) {
    return {
      code: 'cloud_backend_unavailable',
      message: `No HopIt cloud backend is configured for review decisions. Missing: ${missing.join(', ')}.`,
      status: 503,
    }
  }
  if (configuredCloudBackend() !== 'd1') {
    return {
      code: 'd1_required',
      message: 'Review decisions require the D1 backend.',
      status: 503,
    }
  }
  return null
}

function reviewDecisionsError(
  codebaseId: string | null,
  changeSetId: string | null,
  code: string,
  message: string,
  status: number,
) {
  const body: ReviewDecisionsResponse = {
    ok: false,
    codebaseId,
    changeSetId,
    decisions: [],
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

function requireDecision(value: unknown): ReviewDecisionKind {
  if (value === 'approved' || value === 'changes-requested' || value === 'commented') return value
  throw new Error('decision must be approved, changes-requested, or commented.')
}

function d1ReviewDecisionBackend(codebaseId: string): D1ReviewDecisionBackend {
  return createD1Backend({ 'codebase-id': codebaseId }) as unknown as D1ReviewDecisionBackend
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Review decision request failed.'
}

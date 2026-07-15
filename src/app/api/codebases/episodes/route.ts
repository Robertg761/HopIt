import { NextResponse } from 'next/server'

import { configuredCloudBackend, missingCloudBackendConfig } from '@/lib/cloud-backend'
import { createD1Backend } from '@hopit/backend-d1'
import { cloudActorFromRequest } from '@/lib/request-cloud-actor'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Trail-episodes route: a thin, read-only wrapper over the backend
 * `listTrailEpisodes` / `readCodebaseSettings` methods in @hopit/backend-d1. It
 * lists the stored episodes for a codebase (labels included, newest first,
 * bounded limit) plus the trail-summaries setting so the dashboard can show the
 * honest "summaries are off" state.
 *
 * There is no summarize-trigger endpoint here: labeling runs from the agent CLI
 * (`hop trail summaries on`), never from a browser request.
 *
 * Authorization mirrors the compare route: the requester must be an
 * authenticated product user, and a `compareRevisions` probe fails closed if
 * they cannot read the codebase before any episode row is returned.
 */

const EPISODE_LIMIT = 200

type EpisodesBackend = {
  compareRevisions(
    leftRevision: number,
    rightRevision: number,
    requester?: Record<string, unknown>,
  ): Promise<{ ok: boolean }>
  listTrailEpisodes(
    codebaseId?: string,
    options?: { limit?: number },
  ): Promise<Array<Record<string, unknown>>>
  readCodebaseSettings(codebaseId?: string): Promise<{
    trailSummariesEnabled?: boolean
    trailSummariesMode?: string
  }>
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const codebaseId = stringValue(url.searchParams.get('codebaseId'))

  if (!codebaseId) {
    return episodesError(null, 'codebase_required', 'Expected a codebaseId query parameter.', 400)
  }

  const unavailable = d1Unavailable()
  if (unavailable) return episodesError(codebaseId, unavailable.code, unavailable.message, unavailable.status)

  let actor
  try {
    actor = await cloudActorFromRequest(request, { codebaseId, agentCapability: 'read' })
  } catch (error) {
    return episodesError(codebaseId, 'episodes_auth_failed', errorMessage(error), 400)
  }
  if (!actor?.userId) {
    return episodesError(codebaseId, 'browser_auth_required', 'Viewing trail episodes requires product auth.', 401)
  }

  const backend = episodesBackend(codebaseId)
  const requester: Record<string, unknown> = {
    codebaseId,
    requesterId: actor.userId,
    sessionId: actor.sessionId ?? null,
  }

  try {
    // Authorize the read first. compareRevisions fails closed if the requester
    // cannot read the codebase; we ignore its (necessarily out-of-range) body.
    await backend.compareRevisions(0, 0, requester)

    const [episodes, settings] = await Promise.all([
      backend.listTrailEpisodes(codebaseId, { limit: EPISODE_LIMIT }),
      backend.readCodebaseSettings(codebaseId),
    ])

    return NextResponse.json(
      {
        ok: true,
        codebaseId,
        mode: 'episodes',
        episodes: newestFirst(episodes),
        summaries: {
          enabled: Boolean(settings?.trailSummariesEnabled),
          mode: settings?.trailSummariesMode === 'diff' ? 'diff' : 'metadata',
        },
      },
      responseInit(),
    )
  } catch (error) {
    return episodesError(codebaseId, 'episodes_read_failed', errorMessage(error), 400)
  }
}

/**
 * The backend lists episodes by ascending revision (bounded to the most recent
 * window); the dashboard wants newest first. Episodes never overlap, so reversing
 * the already-ordered list yields a correct newest-first order.
 */
function newestFirst(episodes: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return Array.isArray(episodes) ? [...episodes].reverse() : []
}

function d1Unavailable() {
  const missing = missingCloudBackendConfig()
  if (missing.length > 0) {
    return {
      code: 'cloud_backend_unavailable',
      message: `No HopIt cloud backend is configured for trail episodes. Missing: ${missing.join(', ')}.`,
      status: 503,
    }
  }
  if (configuredCloudBackend() !== 'd1') {
    return { code: 'd1_required', message: 'Trail episodes require the D1 backend.', status: 503 }
  }
  return null
}

function episodesError(codebaseId: string | null, code: string, message: string, status: number) {
  return NextResponse.json(
    { ok: false, codebaseId, error: { code, message } },
    { status, ...responseInit() },
  )
}

function responseInit() {
  return { headers: { 'Cache-Control': 'no-store' } }
}

function episodesBackend(codebaseId: string): EpisodesBackend {
  return createD1Backend({ 'codebase-id': codebaseId }) as unknown as EpisodesBackend
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The trail episodes request failed.'
}

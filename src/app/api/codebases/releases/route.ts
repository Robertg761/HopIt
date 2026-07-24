import { NextResponse } from 'next/server'

import { configuredCloudBackend, missingCloudBackendConfig } from '@/lib/cloud-backend'
import { createD1Backend } from '@hopit/backend-d1'
import { cloudActorFromRequest } from '@/lib/request-cloud-actor'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Releases route (GR-B4, decisions §9): a thin read-only wrapper over the
 * backend `listReleases` method, mirroring the derived-paths route. There is
 * no mutation endpoint here: releases are created from the agent CLI
 * (`hop release <name> [--notes]`), matching the "managed from the agent"
 * convention Track B's dashboard surfaces use while they stay behind the
 * collaboration-surface freeze (see docs/git-replacement-implementation-plan.md,
 * Track B) -- this surface stays behind the `NEXT_PUBLIC_RELEASES_LIST`
 * client flag until it graduates.
 */

type ReleasesBackend = {
  compareRevisions(
    leftRevision: number,
    rightRevision: number,
    requester?: Record<string, unknown>,
  ): Promise<{ ok: boolean }>
  listReleases(codebaseId?: string): Promise<
    Array<{
      releaseId: string
      name: string
      notes: string | null
      pinnedRevision: number | null
      createdByUserId: string | null
      createdAt: string | null
    }>
  >
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const codebaseId = stringValue(url.searchParams.get('codebaseId'))

  if (!codebaseId) {
    return releasesError(null, 'codebase_required', 'Expected a codebaseId query parameter.', 400)
  }

  const unavailable = d1Unavailable()
  if (unavailable) return releasesError(codebaseId, unavailable.code, unavailable.message, unavailable.status)

  let actor
  try {
    actor = await cloudActorFromRequest(request, { codebaseId, agentCapability: 'read' })
  } catch (error) {
    return releasesError(codebaseId, 'releases_auth_failed', errorMessage(error), 400)
  }
  if (!actor?.userId) {
    return releasesError(codebaseId, 'browser_auth_required', 'Viewing releases requires product auth.', 401)
  }

  const backend = releasesBackend(codebaseId)
  const requester: Record<string, unknown> = {
    codebaseId,
    requesterId: actor.userId,
    sessionId: actor.sessionId ?? null,
  }

  try {
    // Authorize the read first. compareRevisions fails closed if the requester
    // cannot read the codebase; we ignore its (necessarily out-of-range) body.
    await backend.compareRevisions(0, 0, requester)

    const releases = await backend.listReleases(codebaseId)

    return NextResponse.json(
      {
        ok: true,
        codebaseId,
        releases: releases.map((release) => ({
          releaseId: release.releaseId,
          name: release.name,
          notes: release.notes ?? null,
          pinnedRevision: release.pinnedRevision ?? null,
          createdByUserId: release.createdByUserId ?? null,
          createdAt: release.createdAt ?? null,
        })),
      },
      responseInit(),
    )
  } catch (error) {
    return releasesError(codebaseId, 'releases_read_failed', errorMessage(error), 400)
  }
}

function d1Unavailable() {
  const missing = missingCloudBackendConfig()
  if (missing.length > 0) {
    return {
      code: 'cloud_backend_unavailable',
      message: `No HopIt cloud backend is configured for releases. Missing: ${missing.join(', ')}.`,
      status: 503,
    }
  }
  if (configuredCloudBackend() !== 'd1') {
    return { code: 'd1_required', message: 'Releases require the D1 backend.', status: 503 }
  }
  return null
}

function releasesError(codebaseId: string | null, code: string, message: string, status: number) {
  return NextResponse.json(
    { ok: false, codebaseId, error: { code, message } },
    { status, ...responseInit() },
  )
}

function responseInit() {
  return { headers: { 'Cache-Control': 'no-store' } }
}

function releasesBackend(codebaseId: string): ReleasesBackend {
  return createD1Backend({ 'codebase-id': codebaseId }) as unknown as ReleasesBackend
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The releases request failed.'
}

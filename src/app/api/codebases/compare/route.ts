import { NextResponse } from 'next/server'

import { configuredCloudBackend, missingCloudBackendConfig } from '@/lib/cloud-backend'
import { createD1Backend } from '@hopit/backend-d1'
import { cloudActorFromRequest } from '@/lib/request-cloud-actor'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Compare route: thin wrapper over the WS7c reconstruction engine
 * (`compareRevisions` / `listFileVersions` in @hopit/backend-d1). It never
 * re-implements diff logic. Three modes, distinguished by query params:
 *
 *  - No `from`/`to`      → revision enumeration (what the pickers can offer).
 *  - `from` & `to`       → directory compare, metadata only, zero blob bodies.
 *  - `from` & `to` & `path` → one file's line diff (opens exactly two blobs).
 *
 * This is a browser-facing page endpoint: requests without a Clerk session are
 * redirected by middleware, so Clerk auth is the expected path. Every read is
 * authorized by `compareRevisions`, which fails closed if the requester cannot
 * read the codebase.
 */

type CompareBackend = {
  compareRevisions(
    leftRevision: number,
    rightRevision: number,
    requester?: Record<string, unknown>,
  ): Promise<CompareResult>
  listFileVersions(codebaseId?: string): Promise<Array<Record<string, unknown>>>
}

type CompareEntry = {
  path: string
  state: string
  kind: string
  scope: string
  privacyZone: string
  left: unknown
  right: unknown
  body?: unknown
}

type CompareResult = {
  ok: boolean
  error?: { code: string; message: string }
  leftRevision?: number
  rightRevision?: number
  retention?: { min: number; max: number; retainedVersions: number } | null
  summary?: Record<string, number> | null
  entries?: CompareEntry[]
  bodyFetches?: number
  blobCacheHits?: number
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const codebaseId = stringValue(url.searchParams.get('codebaseId'))
  const fromRaw = url.searchParams.get('from')
  const toRaw = url.searchParams.get('to')
  const path = stringValue(url.searchParams.get('path'))

  if (!codebaseId) {
    return compareError(null, 'codebase_required', 'Expected a codebaseId query parameter.', 400)
  }

  const unavailable = d1Unavailable()
  if (unavailable) return compareError(codebaseId, unavailable.code, unavailable.message, unavailable.status)

  let actor
  try {
    actor = await cloudActorFromRequest(request, { codebaseId, agentCapability: 'read' })
  } catch (error) {
    return compareError(codebaseId, 'compare_auth_failed', errorMessage(error), 400)
  }
  if (!actor?.userId) {
    return compareError(codebaseId, 'browser_auth_required', 'Comparing trail steps requires product auth.', 401)
  }

  const backend = compareBackend(codebaseId)
  const requester: Record<string, unknown> = {
    codebaseId,
    requesterId: actor.userId,
    sessionId: actor.sessionId ?? null,
  }

  // Enumeration mode: no revision pair yet, tell the pickers what is selectable.
  if (fromRaw === null && toRaw === null) {
    try {
      // Authorize the read first. compareRevisions fails closed if the requester
      // cannot read the codebase; we ignore its (necessarily out-of-range) body.
      await backend.compareRevisions(0, 0, requester)
      const versions = await backend.listFileVersions(codebaseId)
      const revisions = distinctRevisions(versions)
      const retention =
        revisions.length > 0
          ? { min: revisions[0], max: revisions[revisions.length - 1], retainedVersions: versions.length }
          : null
      return NextResponse.json(
        { ok: true, codebaseId, mode: 'revisions', revisions, retention },
        responseInit(),
      )
    } catch (error) {
      return compareError(codebaseId, 'compare_revisions_read_failed', errorMessage(error), 400)
    }
  }

  const from = integerValue(fromRaw)
  const to = integerValue(toRaw)
  if (from === null || to === null) {
    return compareError(codebaseId, 'revision_pair_required', 'Both from and to must be integer revisions.', 400)
  }

  try {
    if (path) requester.path = path
    const result = await backend.compareRevisions(from, to, requester)

    if (!result.ok) {
      // Honest, non-fatal states (e.g. revision_expired) are surfaced as an
      // error envelope, never fabricated into a fake diff.
      const error = result.error ?? { code: 'compare_failed', message: 'The revisions could not be compared.' }
      return NextResponse.json(
        { ok: false, codebaseId, retention: result.retention ?? null, error },
        { status: 200, ...responseInit() },
      )
    }

    if (path) {
      const entry = (result.entries ?? []).find((candidate) => candidate.path === path) ?? null
      if (!entry) {
        return compareError(codebaseId, 'file_not_found', `No comparable file at ${path} between these steps.`, 404)
      }
      return NextResponse.json(
        {
          ok: true,
          codebaseId,
          mode: 'file',
          leftRevision: result.leftRevision,
          rightRevision: result.rightRevision,
          path,
          entry,
          bodyFetches: result.bodyFetches ?? 0,
          blobCacheHits: result.blobCacheHits ?? 0,
        },
        responseInit(),
      )
    }

    return NextResponse.json(
      {
        ok: true,
        codebaseId,
        mode: 'directory',
        leftRevision: result.leftRevision,
        rightRevision: result.rightRevision,
        retention: result.retention ?? null,
        summary: result.summary ?? null,
        entries: result.entries ?? [],
      },
      responseInit(),
    )
  } catch (error) {
    return compareError(codebaseId, 'compare_failed', errorMessage(error), 400)
  }
}

function distinctRevisions(versions: Array<Record<string, unknown>>): number[] {
  const seen = new Set<number>()
  for (const version of versions) {
    const value = integerValue(version.graphRevision ?? version.graph_revision)
    if (value !== null) seen.add(value)
  }
  return [...seen].sort((a, b) => a - b)
}

function d1Unavailable() {
  const missing = missingCloudBackendConfig()
  if (missing.length > 0) {
    return {
      code: 'cloud_backend_unavailable',
      message: `No HopIt cloud backend is configured for compare. Missing: ${missing.join(', ')}.`,
      status: 503,
    }
  }
  if (configuredCloudBackend() !== 'd1') {
    return { code: 'd1_required', message: 'Compare requires the D1 backend.', status: 503 }
  }
  return null
}

function compareError(codebaseId: string | null, code: string, message: string, status: number) {
  return NextResponse.json(
    { ok: false, codebaseId, error: { code, message } },
    { status, ...responseInit() },
  )
}

function responseInit() {
  return { headers: { 'Cache-Control': 'no-store' } }
}

function compareBackend(codebaseId: string): CompareBackend {
  return createD1Backend({ 'codebase-id': codebaseId }) as unknown as CompareBackend
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function integerValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The compare request failed.'
}

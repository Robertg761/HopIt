import { NextResponse } from 'next/server'

import { configuredCloudBackend, missingCloudBackendConfig } from '@/lib/cloud-backend'
import { createD1Backend } from '@hopit/backend-d1'
import { cloudActorFromRequest } from '@/lib/request-cloud-actor'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Derived-paths route (GR-C1, decisions §6): a thin read-only wrapper over the
 * backend `readCodebaseSettings` method, mirroring the trail-episodes route.
 * Reports the built-in curated derived-path list (never persisted, always the
 * agent's constants.js list) plus the codebase's stored add/remove overrides.
 *
 * There is no mutation endpoint here: overrides are edited from the agent CLI
 * (`hop derived add|remove <path>`), matching the settings dashboard's existing
 * "managed from the agent" convention. This surface stays behind the
 * `NEXT_PUBLIC_DERIVED_PATHS_SETTINGS` flag on the client until the dashboard
 * settings surface graduates out of flag-gating.
 */

type DerivedPathsBackend = {
  compareRevisions(
    leftRevision: number,
    rightRevision: number,
    requester?: Record<string, unknown>,
  ): Promise<{ ok: boolean }>
  readCodebaseSettings(codebaseId?: string): Promise<{
    derivedPathOverrides?: { add?: string[]; remove?: string[] }
  }>
}

// Kept in sync by hand with packages/agent/src/constants.js
// (`curatedDerivedPathRules`); this route never mutates or persists it.
const CURATED_DERIVED_PATH_RULES = [
  'node_modules',
  '.venv',
  'venv',
  'target',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.cache',
  '.turbo',
  '.gradle',
  'vendor/bundle',
  '.vercel',
  'out',
  'coverage',
  'artifacts',
  'DerivedData',
]

export async function GET(request: Request) {
  const url = new URL(request.url)
  const codebaseId = stringValue(url.searchParams.get('codebaseId'))

  if (!codebaseId) {
    return derivedPathsError(null, 'codebase_required', 'Expected a codebaseId query parameter.', 400)
  }

  const unavailable = d1Unavailable()
  if (unavailable) return derivedPathsError(codebaseId, unavailable.code, unavailable.message, unavailable.status)

  let actor
  try {
    actor = await cloudActorFromRequest(request, { codebaseId, agentCapability: 'read' })
  } catch (error) {
    return derivedPathsError(codebaseId, 'derived_paths_auth_failed', errorMessage(error), 400)
  }
  if (!actor?.userId) {
    return derivedPathsError(codebaseId, 'browser_auth_required', 'Viewing derived-path settings requires product auth.', 401)
  }

  const backend = derivedPathsBackend(codebaseId)
  const requester: Record<string, unknown> = {
    codebaseId,
    requesterId: actor.userId,
    sessionId: actor.sessionId ?? null,
  }

  try {
    // Authorize the read first. compareRevisions fails closed if the requester
    // cannot read the codebase; we ignore its (necessarily out-of-range) body.
    await backend.compareRevisions(0, 0, requester)

    const settings = await backend.readCodebaseSettings(codebaseId)

    return NextResponse.json(
      {
        ok: true,
        codebaseId,
        builtin: CURATED_DERIVED_PATH_RULES,
        overrides: {
          add: Array.isArray(settings?.derivedPathOverrides?.add) ? settings.derivedPathOverrides!.add : [],
          remove: Array.isArray(settings?.derivedPathOverrides?.remove) ? settings.derivedPathOverrides!.remove : [],
        },
      },
      responseInit(),
    )
  } catch (error) {
    return derivedPathsError(codebaseId, 'derived_paths_read_failed', errorMessage(error), 400)
  }
}

function d1Unavailable() {
  const missing = missingCloudBackendConfig()
  if (missing.length > 0) {
    return {
      code: 'cloud_backend_unavailable',
      message: `No HopIt cloud backend is configured for derived-path settings. Missing: ${missing.join(', ')}.`,
      status: 503,
    }
  }
  if (configuredCloudBackend() !== 'd1') {
    return { code: 'd1_required', message: 'Derived-path settings require the D1 backend.', status: 503 }
  }
  return null
}

function derivedPathsError(codebaseId: string | null, code: string, message: string, status: number) {
  return NextResponse.json(
    { ok: false, codebaseId, error: { code, message } },
    { status, ...responseInit() },
  )
}

function responseInit() {
  return { headers: { 'Cache-Control': 'no-store' } }
}

function derivedPathsBackend(codebaseId: string): DerivedPathsBackend {
  return createD1Backend({ 'codebase-id': codebaseId }) as unknown as DerivedPathsBackend
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'The derived-path settings request failed.'
}

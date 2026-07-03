import { NextResponse } from 'next/server'

import {
  type CloudActor,
  configuredCloudBackend,
  missingCloudBackendConfig,
} from '@/lib/cloud-backend'
import { createD1Backend } from '@hopit/backend-d1'
import type { KeyGrantStatusResponse } from '@/lib/collaboration'
import { cloudActorFromRequest } from '@/lib/request-cloud-actor'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type KeyRotationState = 'planned' | 'rotating' | 'wrapped' | 'stable' | 'blocked'

type D1KeyBackend = {
  readKeyGrantStatus(input: { codebaseId: string; actor: CloudActor }): Promise<Omit<KeyGrantStatusResponse, 'ok' | 'error'>>
  updateCodebaseKeyringRotationState(input: {
    codebaseId: string
    rotationState: KeyRotationState
    actor: CloudActor
  }): Promise<unknown>
}

export async function GET(request: Request) {
  const codebaseId = new URL(request.url).searchParams.get('codebaseId')?.trim()
  if (!codebaseId) return keyStatusError('codebase_required', 'Expected a codebaseId query parameter.', 400)

  const missing = missingCloudBackendConfig()
  if (missing.length > 0) {
    return keyStatusError('cloud_backend_unavailable', `No HopIt cloud backend is configured for key grants. Missing: ${missing.join(', ')}.`, 503)
  }

  if (configuredCloudBackend() !== 'd1') {
    return keyStatusError('d1_required', 'Key grant status requires the D1 backend.', 503)
  }

  try {
    const actor = await cloudActorFromRequest(request, {
      codebaseId,
      agentCapability: 'admin',
    })
    if (!actor?.userId) {
      return keyStatusError('browser_auth_required', 'Reading key grants requires product auth.', 401)
    }

    const status = await createD1Backend({ 'codebase-id': codebaseId }).readKeyGrantStatus({ codebaseId, actor })
    return NextResponse.json({ ok: true, ...status }, responseInit())
  } catch (error) {
    return keyStatusError('key_status_failed', errorMessage(error), 400)
  }
}

export async function PATCH(request: Request) {
  const body = await readBody(request)
  const codebaseId = stringValue(body.codebaseId)
  if (!codebaseId) return keyStatusError('codebase_required', 'Expected codebaseId.', 400)
  if (body.action !== 'setRotationState') {
    return keyStatusError('invalid_action', 'Unknown key grant action.', 400, codebaseId)
  }

  const missing = missingCloudBackendConfig()
  if (missing.length > 0) {
    return keyStatusError('cloud_backend_unavailable', `No HopIt cloud backend is configured for key grants. Missing: ${missing.join(', ')}.`, 503, codebaseId)
  }

  if (configuredCloudBackend() !== 'd1') {
    return keyStatusError('d1_required', 'Key grant status requires the D1 backend.', 503, codebaseId)
  }

  try {
    const actor = await cloudActorFromRequest(request, {
      codebaseId,
      agentCapability: 'admin',
    })
    if (!actor?.userId) {
      return keyStatusError('browser_auth_required', 'Updating key grants requires product auth.', 401, codebaseId)
    }

    const backend = d1KeyBackend(codebaseId)
    await backend.updateCodebaseKeyringRotationState({
      codebaseId,
      rotationState: requireRotationState(body.rotationState),
      actor,
    })
    const status = await backend.readKeyGrantStatus({ codebaseId, actor })
    return NextResponse.json({ ok: true, ...status }, responseInit())
  } catch (error) {
    return keyStatusError('key_update_failed', errorMessage(error), 400, codebaseId)
  }
}

function keyStatusError(code: string, message: string, status = 400, codebaseId: string | null = null) {
  return NextResponse.json({
    ok: false,
    error: { code, message },
    codebaseId,
    codebaseKeyring: null,
    members: [],
    devices: [],
    userKeyrings: [],
    wrappedKeys: [],
  }, { status, ...responseInit() })
}

function responseInit() {
  return {
    headers: {
      'Cache-Control': 'no-store',
    },
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null)
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function requireRotationState(value: unknown): KeyRotationState {
  if (value === 'planned' || value === 'rotating' || value === 'wrapped' || value === 'stable' || value === 'blocked') {
    return value
  }
  throw new Error('Key rotation state must be planned, rotating, wrapped, stable, or blocked.')
}

function d1KeyBackend(codebaseId: string): D1KeyBackend {
  return createD1Backend({ 'codebase-id': codebaseId }) as unknown as D1KeyBackend
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Key grant request failed.'
}

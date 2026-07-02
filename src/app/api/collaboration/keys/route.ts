import { NextResponse } from 'next/server'

import {
  configuredCloudBackend,
  missingCloudBackendConfig,
} from '@/lib/cloud-backend'
import { createD1Backend } from '@/lib/d1-backend.js'
import { cloudActorFromRequest } from '@/lib/request-cloud-actor'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

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

function keyStatusError(code: string, message: string, status = 400) {
  return NextResponse.json({
    ok: false,
    error: { code, message },
    codebaseId: null,
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Key grant request failed.'
}

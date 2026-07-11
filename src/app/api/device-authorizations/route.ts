import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'

import {
  createCloudDeviceAuthorization,
  missingCloudBackendConfig,
  pollCloudDeviceAuthorization,
} from '@/lib/cloud-backend'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request) {
  const missing = missingCloudBackendConfig()
  if (missing.length > 0) {
    return deviceAuthorizationError('cloud_backend_unavailable', 'HopIt Cloud is unavailable.', 503)
  }

  try {
    const body = await request.json().catch(() => null)
    const record = recordValue(body)
    if (!record) return deviceAuthorizationError('invalid_request', 'Expected a JSON request body.', 400)
    const authorization = await createCloudDeviceAuthorization({
      deviceKey: record.deviceKey,
      requestFingerprint: requestFingerprint(request),
      requestedCodebaseId: optionalText(record.requestedCodebaseId),
      requestedCodebaseName: optionalText(record.requestedCodebaseName),
    }) as Record<string, unknown>
    const userCode = requireText(authorization.userCode, 'userCode')
    const verificationUri = new URL('/device', request.url)
    const verificationUriComplete = new URL(verificationUri)
    verificationUriComplete.searchParams.set('code', userCode)

    return NextResponse.json({
      ok: true,
      ...authorization,
      verificationUri: verificationUri.toString(),
      verificationUriComplete: verificationUriComplete.toString(),
    }, responseInit())
  } catch (error) {
    return deviceAuthorizationError('device_authorization_create_failed', errorMessage(error), 400)
  }
}

export async function GET(request: Request) {
  const missing = missingCloudBackendConfig()
  if (missing.length > 0) {
    return deviceAuthorizationError('cloud_backend_unavailable', 'HopIt Cloud is unavailable.', 503)
  }
  const deviceCode = new URL(request.url).searchParams.get('device_code')?.trim()
  if (!deviceCode) return deviceAuthorizationError('device_code_required', 'device_code is required.', 400)

  try {
    const authorization = await pollCloudDeviceAuthorization(deviceCode) as Record<string, unknown>
    const approved = authorization.status === 'approved'
    return NextResponse.json({
      ok: true,
      ...authorization,
      ...(approved ? {
        requesterId: requireText(authorization.requesterId, 'requesterId'),
        apiBaseUrl: publicAgentApiBaseUrl(),
      } : {}),
    }, responseInit())
  } catch (error) {
    return deviceAuthorizationError('device_authorization_poll_failed', errorMessage(error), 400)
  }
}

function requestFingerprint(request: Request) {
  const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? ''
  const userAgent = request.headers.get('user-agent')?.slice(0, 300) ?? ''
  const secret = process.env.HOPIT_DEVICE_AUTH_FINGERPRINT_SECRET ?? process.env.CLERK_SECRET_KEY ?? 'hopit-device-auth'
  return createHash('sha256').update(`${secret}:${forwardedFor}:${userAgent}`).digest('hex')
}

function publicAgentApiBaseUrl() {
  const value = process.env.HOPIT_D1_API_BASE_URL?.trim()
  if (!value || !/^https:\/\//i.test(value)) {
    throw new Error('HopIt agent API URL is not configured.')
  }
  return value.replace(/\/+$/, '')
}

function requireText(value: unknown, label: string) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} is required.`)
  return value.trim()
}

function optionalText(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Device authorization failed.'
}

function responseInit() {
  return { headers: { 'Cache-Control': 'no-store' } }
}

function deviceAuthorizationError(code: string, message: string, status: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status, ...responseInit() })
}

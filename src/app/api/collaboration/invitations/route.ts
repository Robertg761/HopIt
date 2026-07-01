import { NextResponse } from 'next/server'

import {
  acceptCloudInvitation,
  configuredCloudBackend,
  createCloudInvitation,
  listCloudInvitations,
  missingCloudBackendConfig,
  revokeCloudInvitation,
} from '@/lib/cloud-backend'
import type { InvitationsResponse, PendingInvitation } from '@/lib/collaboration'
import { cloudActorFromRequest } from '@/lib/request-cloud-actor'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request) {
  const codebaseId = codebaseIdFromRequest(request)
  const unavailable = cloudUnavailable('invitations')
  if (unavailable) return invitationError(codebaseId, unavailable.code, unavailable.message, unavailable.status)

  const actor = await cloudActorFromRequest(request)
  if (!actor) {
    return invitationError(codebaseId, 'browser_auth_required', 'Listing invitations requires product auth, not Basic Auth.', 401)
  }

  try {
    const invitations = await listCloudInvitations({ codebaseId, status: 'pending', actor })
    return NextResponse.json(invitationState(codebaseId, {
      authenticated: true,
      pendingInvitations: Array.isArray(invitations) ? invitations.map(mapInvitation) : [],
    }), responseInit())
  } catch (error) {
    return invitationError(codebaseId, 'invitation_list_failed', errorMessage(error), 400)
  }
}

export async function POST(request: Request) {
  const body = await readBody(request)
  const codebaseId = stringValue(body.codebaseId) ?? defaultCodebaseId()
  const unavailable = cloudUnavailable('invitations')
  if (unavailable) return invitationError(codebaseId, unavailable.code, unavailable.message, unavailable.status)

  const actor = await cloudActorFromRequest(request)
  if (!actor) {
    return invitationError(codebaseId, 'browser_auth_required', 'Creating invitations requires product auth, not Basic Auth.', 401)
  }

  try {
    const invitation = await createCloudInvitation({
      codebaseId,
      email: requireText(body.email, 'email'),
      role: invitationRole(body.role),
      expiresAt: optionalText(body.expiresAt),
      actor,
    })
    const invitations = await listCloudInvitations({ codebaseId, status: 'pending', actor })

    return NextResponse.json(
      {
        ...invitationState(codebaseId, {
          authenticated: true,
          pendingInvitations: Array.isArray(invitations) ? invitations.map(mapInvitation) : [],
        }),
        ok: true,
        createdInvitationToken: recordValue(invitation)?.token,
      },
      responseInit(),
    )
  } catch (error) {
    return invitationError(codebaseId, 'invitation_create_failed', errorMessage(error), 400)
  }
}

export async function PATCH(request: Request) {
  const body = await readBody(request)
  const codebaseId = stringValue(body.codebaseId) ?? defaultCodebaseId()

  if (body.action === 'accept') return acceptInvitation(body, codebaseId, request)
  if (body.action === 'revoke') return revokeInvitation(body, codebaseId, request)

  return invitationError(codebaseId, 'unsupported_invitation_action', 'Expected invitation action to be accept or revoke.', 400)
}

async function acceptInvitation(body: Record<string, unknown>, codebaseId: string, request: Request) {
  const unavailable = cloudUnavailable('invitations')
  if (unavailable) return invitationError(codebaseId, unavailable.code, unavailable.message, unavailable.status)

  const actor = await cloudActorFromRequest(request)
  if (!actor) {
    return invitationError(codebaseId, 'browser_auth_required', 'Accepting invitations requires product auth, not Basic Auth.', 401)
  }

  try {
    const result = await acceptCloudInvitation({
      token: requireText(body.token, 'token'),
      actor,
    })
    const acceptedCodebaseId = stringValue(recordValue(result)?.codebaseId) ?? codebaseId
    return NextResponse.json(invitationState(acceptedCodebaseId, { authenticated: true }), responseInit())
  } catch (error) {
    return invitationError(codebaseId, 'invitation_accept_failed', errorMessage(error), 400)
  }
}

async function revokeInvitation(body: Record<string, unknown>, codebaseId: string, request: Request) {
  const unavailable = cloudUnavailable('invitations')
  if (unavailable) return invitationError(codebaseId, unavailable.code, unavailable.message, unavailable.status)

  const actor = await cloudActorFromRequest(request)
  if (!actor) {
    return invitationError(codebaseId, 'browser_auth_required', 'Revoking invitations requires product auth, not Basic Auth.', 401)
  }

  try {
    await revokeCloudInvitation({
      codebaseId,
      invitationId: requireText(body.invitationId, 'invitationId'),
      actor,
    })
    const invitations = await listCloudInvitations({ codebaseId, status: 'pending', actor })

    return NextResponse.json(invitationState(codebaseId, {
      authenticated: true,
      pendingInvitations: Array.isArray(invitations) ? invitations.map(mapInvitation) : [],
    }), responseInit())
  } catch (error) {
    return invitationError(codebaseId, 'invitation_revoke_failed', errorMessage(error), 400)
  }
}

function invitationState(
  codebaseId: string,
  options: { authenticated?: boolean; pendingInvitations?: PendingInvitation[] } = {},
): InvitationsResponse {
  const backend = configuredCloudBackend()
  const hasBackend = backend !== 'unavailable'
  const authReason = options.authenticated ? undefined : 'Product auth is required for invitations.'
  const backendReason = hasBackend ? undefined : 'HopIt cloud backend is not configured for invitations.'
  const enabled = Boolean(hasBackend && options.authenticated)

  return {
    ok: true,
    codebaseId,
    capabilities: {
      backend,
      list: {
        enabled,
        reason: enabled ? undefined : authReason ?? backendReason,
      },
      create: {
        enabled,
        reason: enabled ? undefined : authReason ?? backendReason,
      },
      accept: {
        enabled,
        reason: enabled ? undefined : authReason ?? backendReason,
      },
      revoke: {
        enabled,
        reason: enabled ? undefined : authReason ?? backendReason,
      },
    },
    pendingInvitations: options.pendingInvitations ?? [],
    unavailableReason: enabled ? undefined : authReason ?? backendReason,
  }
}

function invitationError(codebaseId: string, code: string, message: string, status: number) {
  const body: InvitationsResponse = {
    ...invitationState(codebaseId),
    ok: false,
    error: {
      code,
      message,
    },
  }

  return NextResponse.json(body, {
    status,
    ...responseInit(),
  })
}

function cloudUnavailable(feature: string) {
  const missing = missingCloudBackendConfig()
  if (missing.length === 0) return null
  return {
    code: 'cloud_backend_unavailable',
    message: `No HopIt cloud backend is configured for ${feature}. Missing: ${missing.join(', ')}.`,
    status: 503,
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null)
  return recordValue(body) ?? {}
}

function codebaseIdFromRequest(request: Request) {
  const url = new URL(request.url)
  return url.searchParams.get('codebaseId') || defaultCodebaseId()
}

function defaultCodebaseId() {
  return process.env.HOPIT_CODEBASE_ID ?? 'hopit'
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

function optionalText(value: unknown) {
  return stringValue(value) ?? undefined
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function invitationRole(value: unknown): PendingInvitation['role'] {
  if (value === 'maintainer' || value === 'viewer') return value
  return 'member'
}

function mapInvitation(row: Record<string, unknown>): PendingInvitation {
  return {
    id: stringValue(row._id) ?? stringValue(row.id) ?? '',
    email: stringValue(row.normalizedEmail) ?? stringValue(row.email) ?? '',
    role: invitationRole(row.role),
    status: invitationStatus(row.status),
    invitedByUserId: stringValue(row.invitedByUserId) ?? '',
    acceptedByUserId: stringValue(row.acceptedByUserId),
    createdAt: stringValue(row.createdAt) ?? '',
    updatedAt: stringValue(row.updatedAt) ?? '',
    expiresAt: stringValue(row.expiresAt),
    acceptedAt: stringValue(row.acceptedAt),
  }
}

function invitationStatus(value: unknown): PendingInvitation['status'] {
  if (value === 'accepted' || value === 'revoked' || value === 'expired') return value
  return 'pending'
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Invitation request failed.'
}

import { NextResponse } from 'next/server'
import { anyApi } from 'convex/server'

import { convexAuthToken, convexClient, convexUrl } from '@/lib/convex-auth'
import type { InvitationsResponse, PendingInvitation } from '@/lib/collaboration'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request) {
  const codebaseId = codebaseIdFromRequest(request)
  const authToken = await convexAuthToken()

  if (!convexUrl()) {
    return invitationError(codebaseId, 'convex_unavailable', 'Convex is not configured for invitations.', 503)
  }

  if (!authToken) {
    return invitationError(
      codebaseId,
      'browser_auth_required',
      'Listing invitations requires product auth, not Basic Auth.',
      401,
    )
  }

  try {
    const invitations = await convexClient(authToken).query(anyApi.agent.listCodebaseInvitations, {
      codebaseId,
      status: 'pending',
    })
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
  const authToken = await convexAuthToken()

  if (!authToken) {
    return invitationError(
      codebaseId,
      'browser_auth_required',
      'Creating invitations requires product auth, not Basic Auth.',
      401,
    )
  }

  if (!convexUrl()) {
    return invitationError(codebaseId, 'convex_unavailable', 'Convex is not configured for invitations.', 503)
  }

  try {
    const client = convexClient(authToken)
    const invitation = await client.mutation(anyApi.agent.createCodebaseInvitation, {
      codebaseId,
      email: requireText(body.email, 'email'),
      role: invitationRole(body.role),
      expiresAt: optionalText(body.expiresAt),
    })

    const invitations = await client.query(anyApi.agent.listCodebaseInvitations, {
      codebaseId,
      status: 'pending',
    })

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

  if (body.action === 'accept') {
    return acceptInvitation(body, codebaseId)
  }
  if (body.action === 'revoke') {
    return revokeInvitation(body, codebaseId)
  }

  return invitationError(codebaseId, 'unsupported_invitation_action', 'Expected invitation action to be accept or revoke.', 400)
}

async function acceptInvitation(body: Record<string, unknown>, codebaseId: string) {
  const authToken = await convexAuthToken()

  if (!authToken) {
    return invitationError(
      codebaseId,
      'browser_auth_required',
      'Accepting invitations requires product auth, not Basic Auth.',
      401,
    )
  }

  if (!convexUrl()) {
    return invitationError(codebaseId, 'convex_unavailable', 'Convex is not configured for invitations.', 503)
  }

  try {
    const client = convexClient(authToken)
    await client.mutation(anyApi.agent.acceptCodebaseInvitation, {
      token: requireText(body.token, 'token'),
    })

    return NextResponse.json(invitationState(codebaseId, { authenticated: true }), responseInit())
  } catch (error) {
    return invitationError(codebaseId, 'invitation_accept_failed', errorMessage(error), 400)
  }
}

async function revokeInvitation(body: Record<string, unknown>, codebaseId: string) {
  const authToken = await convexAuthToken()

  if (!authToken) {
    return invitationError(
      codebaseId,
      'browser_auth_required',
      'Revoking invitations requires product auth, not Basic Auth.',
      401,
    )
  }

  if (!convexUrl()) {
    return invitationError(codebaseId, 'convex_unavailable', 'Convex is not configured for invitations.', 503)
  }

  try {
    const client = convexClient(authToken)
    await client.mutation(anyApi.agent.revokeCodebaseInvitation, {
      invitationId: requireText(body.invitationId, 'invitationId'),
    })
    const invitations = await client.query(anyApi.agent.listCodebaseInvitations, {
      codebaseId,
      status: 'pending',
    })

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
  const hasConvex = Boolean(convexUrl())
  const authReason = options.authenticated ? undefined : 'Product auth is required for invitations.'
  const enabled = Boolean(hasConvex && options.authenticated)

  return {
    ok: true,
    codebaseId,
    capabilities: {
      backend: hasConvex ? 'convex' : 'unavailable',
      list: {
        enabled,
        reason: enabled ? undefined : authReason ?? 'Convex is not configured for invitations.',
      },
      create: {
        enabled,
        reason: enabled ? undefined : authReason ?? 'Convex is not configured for invitations.',
      },
      accept: {
        enabled,
        reason: enabled ? undefined : authReason ?? 'Convex is not configured for invitations.',
      },
      revoke: {
        enabled,
        reason: enabled ? undefined : authReason ?? 'Convex is not configured for invitations.',
      },
    },
    pendingInvitations: options.pendingInvitations ?? [],
    unavailableReason: enabled ? undefined : authReason,
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

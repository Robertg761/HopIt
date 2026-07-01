import { NextResponse } from 'next/server'

import {
  claimCloudCodebaseOwner,
  configuredCloudBackend,
  listCloudMembers,
  missingCloudBackendConfig,
  removeCloudMember,
  suspendCloudMember,
} from '@/lib/cloud-backend'
import type { CodebaseMember, MembersResponse } from '@/lib/collaboration'
import { cloudActorFromRequest } from '@/lib/request-cloud-actor'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request) {
  const codebaseId = codebaseIdFromRequest(request)
  const unavailable = cloudUnavailable('members')
  if (unavailable) return memberError(codebaseId, unavailable.code, unavailable.message, unavailable.status)

  const actor = await cloudActorFromRequest(request)
  if (!actor) {
    return memberError(codebaseId, 'browser_auth_required', 'Listing members requires product auth, not Basic Auth.', 401)
  }

  try {
    const rows = await listCloudMembers({ codebaseId, actor })
    return NextResponse.json(memberState(codebaseId, {
      authenticated: true,
      members: Array.isArray(rows) ? rows.map(mapMember) : [],
    }), responseInit())
  } catch (error) {
    return memberError(codebaseId, 'member_list_failed', errorMessage(error), 400)
  }
}

export async function POST(request: Request) {
  const body = await readBody(request)
  const codebaseId = stringValue(body.codebaseId) ?? defaultCodebaseId()
  const unavailable = cloudUnavailable('members')
  if (unavailable) return memberError(codebaseId, unavailable.code, unavailable.message, unavailable.status)

  const actor = await cloudActorFromRequest(request)
  if (!actor) {
    return memberError(codebaseId, 'browser_auth_required', 'Claiming ownership requires product auth, not Basic Auth.', 401)
  }
  if (body.action !== 'claimOwner') {
    return memberError(codebaseId, 'unsupported_member_action', 'Expected member action to be claimOwner.', 400)
  }

  try {
    await claimCloudCodebaseOwner({ codebaseId, actor })
    const rows = await listCloudMembers({ codebaseId, actor })
    return NextResponse.json(memberState(codebaseId, {
      authenticated: true,
      members: Array.isArray(rows) ? rows.map(mapMember) : [],
    }), responseInit())
  } catch (error) {
    return memberError(codebaseId, 'owner_claim_failed', errorMessage(error), 400)
  }
}

export async function PATCH(request: Request) {
  const body = await readBody(request)
  const codebaseId = stringValue(body.codebaseId) ?? defaultCodebaseId()
  const unavailable = cloudUnavailable('members')
  if (unavailable) return memberError(codebaseId, unavailable.code, unavailable.message, unavailable.status)

  const actor = await cloudActorFromRequest(request)
  if (!actor) {
    return memberError(codebaseId, 'browser_auth_required', 'Managing members requires product auth, not Basic Auth.', 401)
  }

  try {
    const userId = requireText(body.userId, 'userId')

    if (body.action === 'suspend') {
      await suspendCloudMember({ codebaseId, userId, actor })
    } else if (body.action === 'remove') {
      await removeCloudMember({ codebaseId, userId, actor })
    } else {
      return memberError(codebaseId, 'unsupported_member_action', 'Expected member action to be suspend or remove.', 400)
    }

    const rows = await listCloudMembers({ codebaseId, actor })
    return NextResponse.json(memberState(codebaseId, {
      authenticated: true,
      members: Array.isArray(rows) ? rows.map(mapMember) : [],
    }), responseInit())
  } catch (error) {
    return memberError(codebaseId, 'member_manage_failed', errorMessage(error), 400)
  }
}

function memberState(
  codebaseId: string,
  options: { authenticated?: boolean; members?: CodebaseMember[] } = {},
): MembersResponse {
  const backend = configuredCloudBackend()
  const hasBackend = backend !== 'unavailable'
  const authReason = options.authenticated ? undefined : 'Product auth is required for member management.'
  const backendReason = hasBackend ? undefined : 'HopIt cloud backend is not configured for members.'
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
      claimOwner: {
        enabled,
        reason: enabled ? undefined : authReason ?? backendReason,
      },
      suspend: {
        enabled,
        reason: enabled ? undefined : authReason ?? backendReason,
      },
      remove: {
        enabled,
        reason: enabled ? undefined : authReason ?? backendReason,
      },
    },
    members: options.members ?? [],
    unavailableReason: enabled ? undefined : authReason ?? backendReason,
  }
}

function memberError(codebaseId: string, code: string, message: string, status: number) {
  const body: MembersResponse = {
    ...memberState(codebaseId),
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

function mapMember(row: Record<string, unknown>): CodebaseMember {
  const profile = recordValue(row.profile)
  const userId = stringValue(row.userId) ?? documentId(row)
  const role = memberRole(row.role)

  return {
    id: documentId(row),
    userId,
    name: stringValue(profile?.displayName) ?? stringValue(profile?.primaryEmail) ?? userId,
    email: stringValue(profile?.primaryEmail),
    role,
    status: row.status === 'suspended' ? 'suspended' : 'active',
    source: stringValue(row.source) ?? 'membership',
    isOwner: role === 'owner',
    joinedAt: stringValue(row.joinedAt) ?? stringValue(row.createdAt),
    avatarUrl: stringValue(profile?.avatarUrl),
  }
}

function documentId(row: Record<string, unknown>) {
  return stringValue(row._id) ?? stringValue(row.id) ?? ''
}

function memberRole(value: unknown): CodebaseMember['role'] {
  if (value === 'owner' || value === 'maintainer' || value === 'member' || value === 'viewer') return value
  return 'member'
}

function requireText(value: unknown, label: string) {
  const text = stringValue(value)
  if (!text) throw new Error(`${label} is required.`)
  return text
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Member request failed.'
}

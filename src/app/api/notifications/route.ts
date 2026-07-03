import { NextResponse } from 'next/server'

import {
  type CloudActor,
  configuredCloudBackend,
  missingCloudBackendConfig,
} from '@/lib/cloud-backend'
import { createD1Backend } from '@hopit/backend-d1'
import type { NotificationItem, NotificationsResponse } from '@/lib/collaboration'
import { cloudActorFromRequest } from '@/lib/request-cloud-actor'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type D1NotificationsBackend = {
  listNotifications(input: {
    codebaseId: string
    actor: CloudActor
    limit?: number
    unreadOnly?: boolean
  }): Promise<NotificationItem[]>
  markNotificationRead(input: {
    codebaseId: string
    notificationId: string
    actor: CloudActor
  }): Promise<NotificationItem | null>
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const codebaseId = stringValue(url.searchParams.get('codebaseId'))
  const unreadOnly = url.searchParams.get('unread') === '1'
  if (!codebaseId) return notificationsError(null, 'codebase_required', 'Expected a codebaseId query parameter.', 400)

  const unavailable = d1Unavailable()
  if (unavailable) return notificationsError(codebaseId, unavailable.code, unavailable.message, unavailable.status)

  try {
    const actor = await cloudActorFromRequest(request, {
      allowBasicFallback: true,
      codebaseId,
      agentCapability: 'read',
    })
    if (!actor) {
      return notificationsError(codebaseId, 'browser_auth_required', 'Reading notifications requires product auth or Basic Auth fallback.', 401)
    }
    const backend = d1NotificationsBackend(codebaseId)
    const notifications = await backend.listNotifications({ codebaseId, actor, unreadOnly })
    return NextResponse.json({ ok: true, codebaseId, notifications }, responseInit())
  } catch (error) {
    return notificationsError(codebaseId, 'notifications_read_failed', errorMessage(error), 400)
  }
}

export async function PATCH(request: Request) {
  const body = await readBody(request)
  const codebaseId = stringValue(body.codebaseId)
  if (!codebaseId) return notificationsError(null, 'codebase_required', 'Expected codebaseId.', 400)
  if (body.action !== 'markRead') {
    return notificationsError(codebaseId, 'invalid_action', 'Unknown notification action.', 400)
  }

  const unavailable = d1Unavailable()
  if (unavailable) return notificationsError(codebaseId, unavailable.code, unavailable.message, unavailable.status)

  try {
    const actor = await cloudActorFromRequest(request, {
      codebaseId,
      agentCapability: 'read',
    })
    if (!actor?.userId) {
      return notificationsError(codebaseId, 'browser_auth_required', 'Updating notifications requires product auth.', 401)
    }

    const backend = d1NotificationsBackend(codebaseId)
    await backend.markNotificationRead({
      codebaseId,
      notificationId: requireText(body.notificationId, 'notificationId'),
      actor,
    })
    const notifications = await backend.listNotifications({ codebaseId, actor })
    return NextResponse.json({ ok: true, codebaseId, notifications }, responseInit())
  } catch (error) {
    return notificationsError(codebaseId, 'notifications_update_failed', errorMessage(error), 400)
  }
}

function d1Unavailable() {
  const missing = missingCloudBackendConfig()
  if (missing.length > 0) {
    return {
      code: 'cloud_backend_unavailable',
      message: `No HopIt cloud backend is configured for notifications. Missing: ${missing.join(', ')}.`,
      status: 503,
    }
  }
  if (configuredCloudBackend() !== 'd1') {
    return {
      code: 'd1_required',
      message: 'Notifications require the D1 backend.',
      status: 503,
    }
  }
  return null
}

function notificationsError(
  codebaseId: string | null,
  code: string,
  message: string,
  status: number,
) {
  const body: NotificationsResponse = {
    ok: false,
    codebaseId,
    notifications: [],
    error: { code, message },
  }

  return NextResponse.json(body, {
    status,
    ...responseInit(),
  })
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null)
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
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

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function d1NotificationsBackend(codebaseId: string): D1NotificationsBackend {
  return createD1Backend({ 'codebase-id': codebaseId }) as unknown as D1NotificationsBackend
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Notification request failed.'
}

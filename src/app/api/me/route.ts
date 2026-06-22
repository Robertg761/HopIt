import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { anyApi } from 'convex/server'

import { shouldUseClerkAuth } from '@/lib/auth-config'
import { convexAuthToken, convexClient, isConvexConfigured } from '@/lib/convex-auth'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (!shouldUseClerkAuth()) {
    return NextResponse.json(
      {
        authProvider: 'none',
        user: null,
      },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    )
  }

  const authState = await auth()
  if (!authState.userId) {
    return NextResponse.json(
      {
        authProvider: 'clerk',
        user: null,
      },
      {
        status: 401,
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    )
  }

  const user = await currentUser()
  const accountSync = await syncConvexAccount()

  return NextResponse.json(
    {
      authProvider: 'clerk',
      user: {
        id: authState.userId,
        sessionId: authState.sessionId,
        name: user?.fullName ?? user?.username ?? null,
        email: user?.primaryEmailAddress?.emailAddress ?? null,
        emailVerified: user?.primaryEmailAddress?.verification?.status === 'verified',
        imageUrl: user?.imageUrl ?? null,
      },
      account: accountSync.account,
      convex: {
        configured: isConvexConfigured(),
        accountSynced: accountSync.ok,
        error: accountSync.error,
      },
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  )
}

async function syncConvexAccount() {
  if (!isConvexConfigured()) {
    return { ok: false, account: null, error: 'Convex is not configured.' }
  }

  const authToken = await convexAuthToken()
  if (!authToken) {
    return { ok: false, account: null, error: 'Convex auth token is unavailable.' }
  }

  try {
    const account = await convexClient(authToken).mutation(anyApi.agent.upsertViewer, {})
    return { ok: true, account: accountSummary(account), error: undefined }
  } catch (error) {
    return { ok: false, account: null, error: errorMessage(error) }
  }
}

function accountSummary(value: unknown) {
  const account = recordValue(value)
  if (!account) return null

  return {
    userId: stringValue(account.userId),
    primaryEmail: stringValue(account.primaryEmail),
    displayName: stringValue(account.displayName),
    avatarUrl: stringValue(account.avatarUrl),
    currentAuthEmailVerified: account.currentAuthEmailVerified === true,
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Convex account sync failed.'
}

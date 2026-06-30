import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'

import { shouldUseClerkAuth } from '@/lib/auth-config'
import { hasValidBasicAuthFallbackCredentials } from '@/lib/basic-auth-fallback'
import { configuredCloudBackend, upsertCloudUser } from '@/lib/cloud-backend'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
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

  if (hasValidBasicAuthFallbackCredentials(request.headers)) {
    const cloudBackend = configuredCloudBackend()
    return NextResponse.json(
      {
        authProvider: 'basic',
        user: null,
        cloud: {
          backend: cloudBackend,
          configured: cloudBackend !== 'unavailable',
          accountSynced: false,
        },
        convex: {
          configured: cloudBackend === 'convex',
          accountSynced: false,
        },
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
  const accountSync = await syncCloudAccount({
    userId: authState.userId,
    primaryEmail: user?.primaryEmailAddress?.emailAddress ?? null,
    displayName: user?.fullName ?? user?.username ?? null,
    avatarUrl: user?.imageUrl ?? null,
    emailVerified: user?.primaryEmailAddress?.verification?.status === 'verified',
  })
  const cloudBackend = configuredCloudBackend()

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
      cloud: {
        backend: cloudBackend,
        configured: cloudBackend !== 'unavailable',
        accountSynced: accountSync.ok,
        error: accountSync.error,
      },
      convex: {
        configured: cloudBackend === 'convex',
        accountSynced: cloudBackend === 'convex' ? accountSync.ok : false,
        error: cloudBackend === 'convex' ? accountSync.error : undefined,
      },
    },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  )
}

async function syncCloudAccount(input: {
  userId: string
  primaryEmail: string | null
  displayName: string | null
  avatarUrl: string | null
  emailVerified: boolean
}) {
  if (configuredCloudBackend() === 'unavailable') {
    return { ok: false, account: null, error: 'No HopIt cloud backend is configured.' }
  }
  try {
    const account = await upsertCloudUser(input)
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
  return error instanceof Error ? error.message : 'Cloud account sync failed.'
}

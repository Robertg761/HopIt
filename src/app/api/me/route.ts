import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'

import { shouldUseClerkAuth } from '@/lib/auth-config'
import { hasValidBasicAuthFallbackCredentials } from '@/lib/basic-auth-fallback'
import {
  bootstrapCloudAccount,
  configuredCloudBackend,
  upsertCloudUser,
  type CloudActor,
} from '@/lib/cloud-backend'

export const dynamic = 'force-dynamic'

type AuthenticatedCloudActor = CloudActor & {
  userId: string
  primaryEmail: string | null
  displayName: string | null
  avatarUrl: string | null
}

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
  const actor: AuthenticatedCloudActor = {
    userId: authState.userId,
    sessionId: authState.sessionId,
    primaryEmail: user?.primaryEmailAddress?.emailAddress ?? null,
    displayName: user?.fullName ?? user?.username ?? null,
    avatarUrl: user?.imageUrl ?? null,
    currentAuthEmailVerified: user?.primaryEmailAddress?.verification?.status === 'verified',
  }
  const accountSync = await syncCloudAccount(actor)
  const accountBootstrap = accountSync.ok
    ? await bootstrapAccount(actor)
    : { ok: false, error: accountSync.error, codebases: [], claimed: [], failed: [] }
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
        bootstrap: accountBootstrap,
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
  sessionId?: string | null
  primaryEmail: string | null
  displayName: string | null
  avatarUrl: string | null
  currentAuthEmailVerified?: boolean
  emailVerified?: boolean
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

async function bootstrapAccount(actor: CloudActor) {
  if (!actor.userId || configuredCloudBackend() === 'unavailable') {
    return { ok: false, codebases: [], claimed: [], failed: [], error: 'No HopIt cloud backend is configured.' }
  }

  try {
    const result = await bootstrapCloudAccount(actor)
    return bootstrapSummary(result)
  } catch (error) {
    return {
      ok: false,
      codebases: [],
      claimed: [],
      failed: [],
      error: errorMessage(error),
    }
  }
}

function bootstrapSummary(value: unknown) {
  const result = recordValue(value)
  const codebases = Array.isArray(result?.codebases) ? result.codebases.map(bootstrapCodebaseSummary) : []
  const claimed = Array.isArray(result?.claimed) ? result.claimed.map(bootstrapCodebaseSummary) : []
  const failed = Array.isArray(result?.failed) ? result.failed.map(bootstrapCodebaseSummary) : []

  return {
    ok: result?.ok === true,
    ownerId: stringValue(result?.ownerId),
    codebases,
    claimed,
    failed,
    error: stringValue(result?.error),
  }
}

function bootstrapCodebaseSummary(value: unknown) {
  const row = recordValue(value)
  return {
    codebaseId: stringValue(row?.codebaseId),
    status: stringValue(row?.status),
    ownerId: stringValue(row?.ownerId),
    error: stringValue(row?.error),
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

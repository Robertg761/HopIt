import { auth, currentUser } from '@clerk/nextjs/server'

import { hasValidBasicAuthFallbackCredentials } from '@/lib/basic-auth-fallback'
import type { CloudActor } from '@/lib/cloud-backend'

export async function cloudActorFromRequest(
  request: Request,
  { allowBasicFallback = false } = {},
): Promise<CloudActor | null> {
  if (allowBasicFallback && hasValidBasicAuthFallbackCredentials(request.headers)) return {}
  if (hasValidBasicAuthFallbackCredentials(request.headers)) return null

  const authState = await auth()
  if (!authState.userId) return null

  const user = await currentUser()
  return {
    userId: authState.userId,
    primaryEmail: user?.primaryEmailAddress?.emailAddress ?? null,
    displayName: user?.fullName ?? user?.username ?? null,
    avatarUrl: user?.imageUrl ?? null,
    currentAuthEmailVerified: user?.primaryEmailAddress?.verification?.status === 'verified',
  }
}

import { auth, currentUser } from '@clerk/nextjs/server'

import { hasValidBasicAuthFallbackCredentials } from '@/lib/basic-auth-fallback'
import { configuredCloudBackend } from '@/lib/cloud-backend'
import { createD1Backend } from '@hopit/backend-d1'
import type { CloudActor } from '@/lib/cloud-backend'

type CloudActorOptions = {
  allowBasicFallback?: boolean
  codebaseId?: string | null
  agentCapability?: 'read' | 'write' | 'sync' | 'watch' | 'invite' | 'review' | 'merge' | 'release' | 'admin'
}

export async function cloudActorFromRequest(
  request: Request,
  { allowBasicFallback = false, codebaseId = null, agentCapability = 'read' }: CloudActorOptions = {},
): Promise<CloudActor | null> {
  if (allowBasicFallback && hasValidBasicAuthFallbackCredentials(request.headers)) return {}
  if (hasValidBasicAuthFallbackCredentials(request.headers)) return null

  const agentSessionToken = agentSessionTokenFromHeaders(request.headers)
  if (agentSessionToken) {
    if (!codebaseId || configuredCloudBackend() !== 'd1') return null
    const backend = createD1Backend({ 'codebase-id': codebaseId, 'session-token': agentSessionToken })
    const access = await backend.requireD1AgentAccess(codebaseId, { sessionToken: agentSessionToken }, agentCapability, { touch: true })
    return {
      userId: access.userId,
      sessionId: access.session?.session_id ?? null,
    }
  }

  const authState = await auth()
  if (!authState.userId) return null

  const user = await currentUser()
  return {
    userId: authState.userId,
    sessionId: authState.sessionId,
    primaryEmail: user?.primaryEmailAddress?.emailAddress ?? null,
    displayName: user?.fullName ?? user?.username ?? null,
    avatarUrl: user?.imageUrl ?? null,
    currentAuthEmailVerified: user?.primaryEmailAddress?.verification?.status === 'verified',
  }
}

function agentSessionTokenFromHeaders(headers: Headers) {
  const explicit = headers.get('x-hopit-agent-session-token')?.trim()
  if (explicit?.startsWith('hst_')) return explicit

  const authorization = headers.get('authorization')?.trim()
  const match = authorization?.match(/^Bearer\s+(.+)$/i)
  const token = match?.[1]?.trim()
  return token?.startsWith('hst_') ? token : null
}

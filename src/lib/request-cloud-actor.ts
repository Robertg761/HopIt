import { auth, currentUser } from '@clerk/nextjs/server'

import { agentSessionTokenFromHeaders } from '@/lib/agent-session-token'
import { isMultiTenant } from '@/lib/auth-config'
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
  // The basic-auth fallback resolves to an empty wildcard actor ({}) that
  // downstream visibility code treats as an unscoped bypass. This is acceptable for a
  // single locked-down operator, a tenant bypass under multi-tenancy (§1.4 /
  // decision 10). When the flag is on this branch is unreachable both because
  // shouldAllowBasicAuthFallback() forces the credential check false AND because
  // this explicit guard refuses to mint {} regardless, so no config combination
  // can produce an empty actor with tenancy on.
  if (!isMultiTenant()) {
    if (allowBasicFallback && hasValidBasicAuthFallbackCredentials(request.headers)) return {}
    if (hasValidBasicAuthFallbackCredentials(request.headers)) return null
  }

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

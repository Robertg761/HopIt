import { anyApi } from 'convex/server'

import { convexAuthToken, convexClient, convexUrl, isConvexConfigured } from '@/lib/convex-auth'
import { createD1Backend, d1CloudServiceType, isD1Configured } from '@/lib/d1-backend.js'

export type CloudBackendKind = 'd1' | 'convex' | 'unavailable'

export type CloudActor = {
  userId?: string | null
  primaryEmail?: string | null
  displayName?: string | null
  avatarUrl?: string | null
  currentAuthEmailVerified?: boolean
  emailVerified?: boolean
}

export type CloudRequester = {
  requesterUserId?: string | null
  requesterSessionId?: string | null
}

export function configuredCloudBackend(): CloudBackendKind {
  const preferred = process.env.HOPIT_CLOUD_BACKEND?.trim()
  if (preferred === 'd1' || preferred === 'cloudflare-d1') return 'd1'
  if (preferred === 'convex') return 'convex'
  if (isD1Configured()) return 'd1'
  if (isConvexConfigured()) return 'convex'
  return 'unavailable'
}

export function cloudBackendName() {
  const backend = configuredCloudBackend()
  if (backend === 'd1') return d1CloudServiceType
  return backend
}

export function missingCloudBackendConfig() {
  const backend = configuredCloudBackend()
  if (backend === 'd1') {
    const missing: string[] = []
    if (!process.env.HOPIT_D1_ACCOUNT_ID && !process.env.CLOUDFLARE_ACCOUNT_ID) {
      missing.push('HOPIT_D1_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID')
    }
    if (!process.env.HOPIT_D1_DATABASE_ID) missing.push('HOPIT_D1_DATABASE_ID')
    if (!process.env.HOPIT_D1_API_TOKEN && !process.env.CLOUDFLARE_API_TOKEN) {
      missing.push('HOPIT_D1_API_TOKEN or CLOUDFLARE_API_TOKEN')
    }
    return missing
  }
  if (backend === 'convex') {
    const missing: string[] = []
    if (!convexUrl()) missing.push('HOPIT_CONVEX_URL or NEXT_PUBLIC_CONVEX_URL')
    if (!process.env.HOPIT_AGENT_TOKEN) missing.push('HOPIT_AGENT_TOKEN')
    return missing
  }
  return ['HOPIT_CLOUD_BACKEND=d1 plus HOPIT_D1_* values']
}

export async function readCloudAgentDashboard(requester: CloudRequester = {}, codebaseId = process.env.HOPIT_CODEBASE_ID ?? 'hopit') {
  const backend = configuredCloudBackend()
  if (backend === 'd1') {
    return d1Backend({ 'codebase-id': codebaseId }).readDashboard({
      codebaseId,
      requesterUserId: requester.requesterUserId,
      requesterSessionId: requester.requesterSessionId,
    })
  }
  if (backend === 'convex') {
    const authToken = process.env.HOPIT_AGENT_TOKEN
    return convexClient(null).query(anyApi.agent.dashboard, {
      codebaseId,
      token: authToken,
      requesterUserId: requester.requesterUserId,
      requesterSessionId: requester.requesterSessionId,
    })
  }
  throw new Error('No HopIt cloud backend is configured.')
}

export async function listCloudCodebases(actor: CloudActor) {
  const backend = configuredCloudBackend()
  if (backend === 'd1') return d1Backend().listCodebases(actor)
  if (backend === 'convex') {
    const authToken = await convexAuthToken()
    return convexClient(authToken).query(anyApi.agent.listCodebases, {})
  }
  throw new Error('No HopIt cloud backend is configured for codebases.')
}

export async function createCloudCodebase(input: {
  name: string
  codebaseId?: string
  description?: string
  actor: CloudActor
}) {
  const backend = configuredCloudBackend()
  if (backend === 'd1') return d1Backend().createCodebase(input)
  if (backend === 'convex') {
    const authToken = await convexAuthToken()
    return convexClient(authToken).mutation(anyApi.agent.createCodebase, {
      name: input.name,
      codebaseId: input.codebaseId,
      description: input.description,
    })
  }
  throw new Error('No HopIt cloud backend is configured for codebases.')
}

export async function updateCloudCodebase(input: {
  codebaseId: string
  name?: string
  visibility?: 'private' | 'team-visible' | 'review-visible'
  actor: CloudActor
}) {
  const backend = configuredCloudBackend()
  if (backend === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }).updateCodebase(input)
  if (backend === 'convex') {
    const authToken = await convexAuthToken()
    return convexClient(authToken).mutation(anyApi.agent.updateCodebase, {
      codebaseId: input.codebaseId,
      name: input.name,
      visibility: input.visibility,
    })
  }
  throw new Error('No HopIt cloud backend is configured for codebases.')
}

export async function deleteCloudCodebase(input: { codebaseId: string; actor: CloudActor }) {
  const backend = configuredCloudBackend()
  if (backend === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }).deleteCodebase(input)
  if (backend === 'convex') {
    const authToken = await convexAuthToken()
    return convexClient(authToken).mutation(anyApi.agent.deleteCodebase, { codebaseId: input.codebaseId })
  }
  throw new Error('No HopIt cloud backend is configured for codebases.')
}

export async function readCloudTextFile(input: { codebaseId: string; path: string; actor: CloudActor }) {
  const backend = configuredCloudBackend()
  if (backend === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }).readTextFile(input)
  if (backend === 'convex') {
    const authToken = await convexAuthToken()
    return convexClient(authToken).query(anyApi.agent.readTextFile, {
      codebaseId: input.codebaseId,
      path: input.path,
    })
  }
  throw new Error('No HopIt cloud backend is configured for file reads.')
}

export async function mutateCloudTextFile(input: {
  codebaseId: string
  path: string
  content: string
  baseRevision?: number | null
  actor: CloudActor
}) {
  const backend = configuredCloudBackend()
  if (backend === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }).mutateTextFile(input)
  if (backend === 'convex') {
    const authToken = await convexAuthToken()
    return convexClient(authToken).mutation(anyApi.agent.mutateTextFile, {
      codebaseId: input.codebaseId,
      path: input.path,
      content: input.content,
      baseRevision: input.baseRevision,
    })
  }
  throw new Error('No HopIt cloud backend is configured for file edits.')
}

export async function listCloudActionJobs(input: { codebaseId: string; limit?: number; actor: CloudActor }) {
  const backend = configuredCloudBackend()
  if (backend === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }).listActionJobs(input)
  if (backend === 'convex') {
    const authToken = await convexAuthToken()
    return convexClient(authToken).query(anyApi.agent.listActionJobs, {
      codebaseId: input.codebaseId,
      limit: input.limit,
    })
  }
  throw new Error('No HopIt cloud backend is configured for actions.')
}

export async function createCloudActionJob(input: {
  codebaseId: string
  kind: 'lint' | 'test' | 'build'
  actor: CloudActor
}) {
  const backend = configuredCloudBackend()
  if (backend === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }).createActionJob(input)
  if (backend === 'convex') {
    const authToken = await convexAuthToken()
    return convexClient(authToken).mutation(anyApi.agent.createActionJob, {
      codebaseId: input.codebaseId,
      kind: input.kind,
    })
  }
  throw new Error('No HopIt cloud backend is configured for actions.')
}

export async function listCloudMembers(input: {
  codebaseId: string
  status?: 'active' | 'suspended'
  actor: CloudActor
}) {
  const backend = configuredCloudBackend()
  if (backend === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }).listMembers(input)
  if (backend === 'convex') {
    const authToken = await convexAuthToken()
    return convexClient(authToken).query(anyApi.agent.listCodebaseMembers, {
      codebaseId: input.codebaseId,
      status: input.status,
    })
  }
  throw new Error('No HopIt cloud backend is configured for members.')
}

export async function claimCloudCodebaseOwner(input: { codebaseId: string; actor: CloudActor }) {
  const backend = configuredCloudBackend()
  if (backend === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }).claimCodebaseOwner(input)
  if (backend === 'convex') {
    const authToken = await convexAuthToken()
    return convexClient(authToken).mutation(anyApi.agent.claimCodebaseOwner, { codebaseId: input.codebaseId })
  }
  throw new Error('No HopIt cloud backend is configured for members.')
}

export async function suspendCloudMember(input: { codebaseId: string; userId: string; actor: CloudActor }) {
  const backend = configuredCloudBackend()
  if (backend === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }).suspendMember(input)
  if (backend === 'convex') {
    const authToken = await convexAuthToken()
    return convexClient(authToken).mutation(anyApi.agent.suspendCodebaseMember, {
      codebaseId: input.codebaseId,
      userId: input.userId,
    })
  }
  throw new Error('No HopIt cloud backend is configured for members.')
}

export async function removeCloudMember(input: { codebaseId: string; userId: string; actor: CloudActor }) {
  const backend = configuredCloudBackend()
  if (backend === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }).removeMember(input)
  if (backend === 'convex') {
    const authToken = await convexAuthToken()
    return convexClient(authToken).mutation(anyApi.agent.removeCodebaseMember, {
      codebaseId: input.codebaseId,
      userId: input.userId,
    })
  }
  throw new Error('No HopIt cloud backend is configured for members.')
}

export async function listCloudInvitations(input: {
  codebaseId: string
  status?: 'pending' | 'accepted' | 'revoked' | 'expired'
  actor: CloudActor
}) {
  const backend = configuredCloudBackend()
  if (backend === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }).listInvitations(input)
  if (backend === 'convex') {
    const authToken = await convexAuthToken()
    return convexClient(authToken).query(anyApi.agent.listCodebaseInvitations, {
      codebaseId: input.codebaseId,
      status: input.status,
    })
  }
  throw new Error('No HopIt cloud backend is configured for invitations.')
}

export async function createCloudInvitation(input: {
  codebaseId: string
  email: string
  role: 'maintainer' | 'member' | 'viewer'
  expiresAt?: string
  actor: CloudActor
}) {
  const backend = configuredCloudBackend()
  if (backend === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }).createInvitation(input)
  if (backend === 'convex') {
    const authToken = await convexAuthToken()
    return convexClient(authToken).mutation(anyApi.agent.createCodebaseInvitation, {
      codebaseId: input.codebaseId,
      email: input.email,
      role: input.role,
      expiresAt: input.expiresAt,
    })
  }
  throw new Error('No HopIt cloud backend is configured for invitations.')
}

export async function acceptCloudInvitation(input: { token: string; actor: CloudActor }) {
  const backend = configuredCloudBackend()
  if (backend === 'd1') return d1Backend().acceptInvitation(input)
  if (backend === 'convex') {
    const authToken = await convexAuthToken()
    return convexClient(authToken).mutation(anyApi.agent.acceptCodebaseInvitation, {
      token: input.token,
    })
  }
  throw new Error('No HopIt cloud backend is configured for invitations.')
}

export async function revokeCloudInvitation(input: { codebaseId: string; invitationId: string; actor: CloudActor }) {
  const backend = configuredCloudBackend()
  if (backend === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }).revokeInvitation(input)
  if (backend === 'convex') {
    const authToken = await convexAuthToken()
    return convexClient(authToken).mutation(anyApi.agent.revokeCodebaseInvitation, {
      invitationId: input.invitationId,
    })
  }
  throw new Error('No HopIt cloud backend is configured for invitations.')
}

export async function listCloudWorkItems(input: { codebaseId: string; actor: CloudActor }) {
  const backend = configuredCloudBackend()
  if (backend === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }).listWorkItems(input)
  if (backend === 'convex') {
    const authToken = await convexAuthToken()
    const args = convexReadArgs({ codebaseId: input.codebaseId }, authToken)
    const client = convexClient(authToken)
    const [issues, discussions, releases] = await Promise.all([
      client.query(anyApi.collaboration.listIssues, args),
      client.query(anyApi.collaboration.listDiscussions, args),
      client.query(anyApi.collaboration.listReleases, args),
    ])
    return { issues, discussions, releases }
  }
  throw new Error('No HopIt cloud backend is configured for collaboration.')
}

export async function createCloudWorkItem(input: Record<string, unknown> & { codebaseId: string; actor: CloudActor }) {
  const backend = configuredCloudBackend()
  if (backend === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }).createWorkItem(input)
  if (backend === 'convex') {
    const authToken = await convexAuthToken()
    const client = convexClient(authToken)
    const { actor: _actor, type: _type, ...args } = input
    if (input.type === 'issue') {
      return client.mutation(anyApi.collaboration.createIssue, args)
    }
    if (input.type === 'discussion') {
      return client.mutation(anyApi.collaboration.createDiscussion, args)
    }
    if (input.type === 'release') {
      return client.mutation(anyApi.collaboration.createRelease, args)
    }
    throw new Error('Expected type to be issue, discussion, or release.')
  }
  throw new Error('No HopIt cloud backend is configured for collaboration.')
}

export async function updateCloudWorkItem(input: Record<string, unknown> & { codebaseId: string; actor: CloudActor }) {
  const backend = configuredCloudBackend()
  if (backend === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }).updateWorkItem(input)
  if (backend === 'convex') {
    const authToken = await convexAuthToken()
    const client = convexClient(authToken)
    const { action: _action, codebaseId: _codebaseId, actor: _actor, ...args } = input
    if (input.action === 'setIssueStatus') return client.mutation(anyApi.collaboration.setIssueStatus, args)
    if (input.action === 'setDiscussionStatus') return client.mutation(anyApi.collaboration.setDiscussionStatus, args)
    if (input.action === 'publishRelease') return client.mutation(anyApi.collaboration.publishRelease, args)
    throw new Error('Unknown collaboration update action.')
  }
  throw new Error('No HopIt cloud backend is configured for collaboration.')
}

export async function upsertCloudUser(input: CloudActor & {
  avatarUrl?: string | null
  emailVerified?: boolean
}) {
  const backend = configuredCloudBackend()
  if (backend === 'd1') {
    return d1Backend().upsertUser({
      userId: input.userId,
      primaryEmail: input.primaryEmail,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      emailVerified: input.emailVerified,
    })
  }
  if (backend === 'convex') {
    const authToken = await convexAuthToken()
    if (!authToken) throw new Error('Convex auth token is unavailable.')
    return convexClient(authToken).mutation(anyApi.agent.upsertViewer, {})
  }
  throw new Error('No HopIt cloud backend is configured for account sync.')
}

function d1Backend(options: Record<string, unknown> = {}): any {
  return createD1Backend(options)
}

function convexReadArgs<T extends Record<string, unknown>>(value: T, authToken: string | null) {
  if (authToken) return value
  const token = process.env.HOPIT_AGENT_TOKEN
  return token ? { ...value, token } : value
}

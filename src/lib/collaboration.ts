export type CollaborationBackend = 'd1' | 'convex' | 'unavailable'

export type CollaborationActionCapability = {
  enabled: boolean
  reason?: string
}

export type CollaborationCapabilities = {
  backend: CollaborationBackend
  read: CollaborationActionCapability
  createIssue: CollaborationActionCapability
  updateIssue: CollaborationActionCapability
  createDiscussion: CollaborationActionCapability
  updateDiscussion: CollaborationActionCapability
  createRelease: CollaborationActionCapability
  publishRelease: CollaborationActionCapability
  createProject: CollaborationActionCapability
  updateProject: CollaborationActionCapability
}

export type InvitationCapabilities = {
  backend: CollaborationBackend
  list: CollaborationActionCapability
  create: CollaborationActionCapability
  accept: CollaborationActionCapability
  revoke: CollaborationActionCapability
}

export type MemberCapabilities = {
  backend: CollaborationBackend
  list: CollaborationActionCapability
  claimOwner: CollaborationActionCapability
  suspend: CollaborationActionCapability
  remove: CollaborationActionCapability
}

export type CollaborationError = {
  code: string
  message: string
}

export type CollaborationComment = {
  id: string
  body: string
  createdBy: string
  updatedBy: string | null
  createdAt: string
  updatedAt: string
}

export type CollaborationIssue = {
  id: string
  number: number
  title: string
  body: string | null
  status: 'open' | 'closed'
  priority: 'low' | 'medium' | 'high' | null
  labels: string[]
  assigneeIds: string[]
  linkedChangeSetId: string | null
  linkedReleaseId: string | null
  createdBy: string
  updatedBy: string | null
  createdAt: string
  updatedAt: string
  closedAt: string | null
  comments: CollaborationComment[]
}

export type CollaborationDiscussion = {
  id: string
  number: number
  title: string
  body: string
  category: 'general' | 'ideas' | 'q-and-a' | 'announcements'
  status: 'open' | 'answered' | 'locked' | 'closed'
  labels: string[]
  linkedIssueIds: string[]
  linkedChangeSetId: string | null
  createdBy: string
  updatedBy: string | null
  createdAt: string
  updatedAt: string
  closedAt: string | null
  comments: CollaborationComment[]
}

export type CollaborationRelease = {
  id: string
  number: number
  version: string
  title: string
  notes: string
  status: 'draft' | 'published' | 'archived'
  target: {
    type: 'main' | 'snapshot' | 'change-set' | 'git'
    id: string
    revision: number | null
  }
  createdBy: string
  updatedBy: string | null
  createdAt: string
  updatedAt: string
  publishedAt: string | null
}

export type CollaborationProjectColumn = {
  id: string
  name: string
}

export type CollaborationProjectItem = {
  id: string
  projectId: string
  item: {
    type?: 'issue' | 'discussion' | 'release' | 'note'
    id?: string
    title?: string
    body?: string | null
    version?: string
  }
  columnId: string
  position: number
  createdBy: string
  updatedBy: string | null
  createdAt: string
  updatedAt: string
}

export type CollaborationProject = {
  id: string
  number: number
  name: string
  description: string | null
  status: 'active' | 'archived'
  columns: CollaborationProjectColumn[]
  items: CollaborationProjectItem[]
  createdBy: string
  updatedBy: string | null
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

export type PendingInvitation = {
  id: string
  email: string
  role: 'maintainer' | 'member' | 'viewer'
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  invitedByUserId: string
  acceptedByUserId: string | null
  createdAt: string
  updatedAt: string
  expiresAt: string | null
  acceptedAt: string | null
}

export type CodebaseMember = {
  id: string
  userId: string
  name: string
  email: string | null
  role: 'owner' | 'maintainer' | 'member' | 'viewer'
  status: 'active' | 'suspended'
  source: string
  isOwner: boolean
  joinedAt: string | null
  avatarUrl: string | null
}

export type WorkItemsResponse = {
  ok: boolean
  codebaseId: string | null
  capabilities: CollaborationCapabilities
  issues: CollaborationIssue[]
  discussions: CollaborationDiscussion[]
  releases: CollaborationRelease[]
  projects: CollaborationProject[]
  error?: CollaborationError
}

export type InvitationsResponse = {
  ok: boolean
  codebaseId: string | null
  capabilities: InvitationCapabilities
  pendingInvitations: PendingInvitation[]
  createdInvitationToken?: string
  unavailableReason?: string
  error?: CollaborationError
}

export type MembersResponse = {
  ok: boolean
  codebaseId: string | null
  capabilities: MemberCapabilities
  members: CodebaseMember[]
  unavailableReason?: string
  error?: CollaborationError
}

export type KeyGrantStatusResponse = {
  ok: boolean
  codebaseId: string | null
  codebaseKeyring: {
    codebaseId: string
    repoContentKeyId: string
    ownerPrivateKeyId: string
    gitInternalsKeyId: string
    defaultSecretKeyId: string
    rotationState: string | null
    createdAt: string
    updatedAt: string
  } | null
  members: Array<{
    userId: string
    role: string
    status: string
  }>
  devices: Array<{
    deviceId: string
    userId: string
    displayName: string | null
    platform: string | null
    encryptionPublicKeyAlgorithm: string
    encryptionPublicKeyEncoding: string
    signingPublicKeyAlgorithm: string | null
    signingPublicKeyEncoding: string | null
    status: string
    createdAt: string
    trustedAt: string | null
    revokedAt: string | null
    lastSeenAt: string | null
  }>
  userKeyrings: Array<{
    userId: string
    vaultKeyId: string
    currentVersion: number
    status: string
    recoveryConfigured: boolean
    createdAt: string
    updatedAt: string
  }>
  wrappedKeys: Array<{
    wrapId: string
    wrappedKeyId: string
    wrappedKeyType: string
    keyVersion: number
    recipientType: string
    recipientId: string
    codebaseId: string | null
    zoneId: string | null
    wrappingKeyId: string | null
    wrappingPublicKeyId: string | null
    algorithm: string
    createdByUserId: string | null
    createdByDeviceId: string | null
    createdAt: string
    expiresAt: string | null
    revokedAt: string | null
    status: string
  }>
  error?: CollaborationError
}

export type CreateIssueInput = {
  type: 'issue'
  codebaseId: string
  title: string
  body?: string
  priority?: CollaborationIssue['priority']
  labels?: string[]
  linkedChangeSetId?: string
  linkedReleaseId?: string
  createdBy: string
}

export type CreateDiscussionInput = {
  type: 'discussion'
  codebaseId: string
  title: string
  body: string
  category?: CollaborationDiscussion['category']
  labels?: string[]
  linkedChangeSetId?: string
  createdBy: string
}

export type CreateReleaseInput = {
  type: 'release'
  codebaseId: string
  version: string
  title: string
  notes: string
  status?: CollaborationRelease['status']
  target?: CollaborationRelease['target']
  createdBy: string
}

export type CreateProjectInput = {
  type: 'project'
  codebaseId: string
  name: string
  description?: string
  columns?: CollaborationProjectColumn[]
  createdBy: string
}

export type CreateProjectItemInput = {
  type: 'projectItem'
  codebaseId: string
  projectId: string
  item: CollaborationProjectItem['item']
  columnId?: string
  position?: number
  createdBy: string
}

export type CreateIssueCommentInput = {
  type: 'issueComment'
  codebaseId: string
  issueId: string
  body: string
  createdBy: string
}

export type CreateDiscussionCommentInput = {
  type: 'discussionComment'
  codebaseId: string
  discussionId: string
  body: string
  createdBy: string
}

export type CreateCollaborationInput =
  | CreateIssueInput
  | CreateDiscussionInput
  | CreateReleaseInput
  | CreateProjectInput
  | CreateProjectItemInput
  | CreateIssueCommentInput
  | CreateDiscussionCommentInput

export type UpdateCollaborationInput =
  | {
      action: 'setIssueStatus'
      codebaseId: string
      issueId: string
      status: CollaborationIssue['status']
      updatedBy: string
    }
  | {
      action: 'setDiscussionStatus'
      codebaseId: string
      discussionId: string
      status: CollaborationDiscussion['status']
      updatedBy: string
    }
  | {
      action: 'publishRelease'
      codebaseId: string
      releaseId: string
      updatedBy: string
    }
  | {
      action: 'archiveProject'
      codebaseId: string
      projectId: string
      updatedBy: string
    }
  | {
      action: 'moveProjectItem'
      codebaseId: string
      projectItemId: string
      columnId?: string
      position?: number
      updatedBy: string
    }

export type CreateInvitationInput = {
  codebaseId: string
  email: string
  role: PendingInvitation['role']
}

export type AcceptInvitationInput = {
  codebaseId: string
  token: string
}

export type RevokeInvitationInput = {
  codebaseId: string
  invitationId: string
}

export type ClaimOwnerInput = {
  codebaseId: string
}

export type MutateMemberInput = {
  codebaseId: string
  userId: string
}

export async function fetchWorkItems(codebaseId: string): Promise<WorkItemsResponse> {
  return readJson<WorkItemsResponse>(`/api/collaboration/work-items?codebaseId=${encodeURIComponent(codebaseId)}`, {
    cache: 'no-store',
  }, workItemsFallback(codebaseId))
}

export async function createCollaborationItem(input: CreateCollaborationInput): Promise<WorkItemsResponse> {
  return readJson<WorkItemsResponse>('/api/collaboration/work-items', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  }, workItemsFallback(input.codebaseId))
}

export async function updateCollaborationItem(input: UpdateCollaborationInput): Promise<WorkItemsResponse> {
  return readJson<WorkItemsResponse>('/api/collaboration/work-items', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  }, workItemsFallback(input.codebaseId))
}

export async function fetchInvitations(codebaseId: string): Promise<InvitationsResponse> {
  return readJson<InvitationsResponse>(`/api/collaboration/invitations?codebaseId=${encodeURIComponent(codebaseId)}`, {
    cache: 'no-store',
  }, invitationsFallback(codebaseId))
}

export async function fetchMembers(codebaseId: string): Promise<MembersResponse> {
  return readJson<MembersResponse>(`/api/collaboration/members?codebaseId=${encodeURIComponent(codebaseId)}`, {
    cache: 'no-store',
  }, membersFallback(codebaseId))
}

export async function fetchKeyGrantStatus(codebaseId: string): Promise<KeyGrantStatusResponse> {
  return readJson<KeyGrantStatusResponse>(`/api/collaboration/keys?codebaseId=${encodeURIComponent(codebaseId)}`, {
    cache: 'no-store',
  }, keyGrantStatusFallback(codebaseId))
}

export async function createInvitation(input: CreateInvitationInput): Promise<InvitationsResponse> {
  return readJson<InvitationsResponse>('/api/collaboration/invitations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  }, invitationsFallback(input.codebaseId))
}

export async function acceptInvitation(input: AcceptInvitationInput): Promise<InvitationsResponse> {
  return readJson<InvitationsResponse>('/api/collaboration/invitations', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: 'accept',
      ...input,
    }),
  }, invitationsFallback(input.codebaseId))
}

export async function revokeInvitation(input: RevokeInvitationInput): Promise<InvitationsResponse> {
  return readJson<InvitationsResponse>('/api/collaboration/invitations', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: 'revoke',
      ...input,
    }),
  }, invitationsFallback(input.codebaseId))
}

export async function claimCodebaseOwner(input: ClaimOwnerInput): Promise<MembersResponse> {
  return readJson<MembersResponse>('/api/collaboration/members', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: 'claimOwner',
      ...input,
    }),
  }, membersFallback(input.codebaseId))
}

export async function suspendCodebaseMember(input: MutateMemberInput): Promise<MembersResponse> {
  return readJson<MembersResponse>('/api/collaboration/members', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: 'suspend',
      ...input,
    }),
  }, membersFallback(input.codebaseId))
}

export async function removeCodebaseMember(input: MutateMemberInput): Promise<MembersResponse> {
  return readJson<MembersResponse>('/api/collaboration/members', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: 'remove',
      ...input,
    }),
  }, membersFallback(input.codebaseId))
}

async function readJson<T>(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  fallback: (response: Response) => T,
): Promise<T> {
  const response = await fetch(input, init)
  const body = (await response.json().catch(() => null)) as T | null

  if (body) return body

  return fallback(response)
}

function workItemsFallback(codebaseId: string): (response: Response) => WorkItemsResponse {
  return (response) => {
    const reason = responseMessage(response)

    return {
      ok: false,
      codebaseId,
      capabilities: {
        backend: 'unavailable',
        read: disabled(reason),
        createIssue: disabled(reason),
        updateIssue: disabled(reason),
        createDiscussion: disabled(reason),
        updateDiscussion: disabled(reason),
        createRelease: disabled(reason),
        publishRelease: disabled(reason),
        createProject: disabled(reason),
        updateProject: disabled(reason),
      },
      issues: [],
      discussions: [],
      releases: [],
      projects: [],
      error: {
        code: `http_${response.status}`,
        message: reason,
      },
    }
  }
}

function invitationsFallback(codebaseId: string): (response: Response) => InvitationsResponse {
  return (response) => {
    const reason = responseMessage(response)

    return {
      ok: false,
      codebaseId,
      capabilities: {
        backend: 'unavailable',
        list: disabled(reason),
        create: disabled(reason),
        accept: disabled(reason),
        revoke: disabled(reason),
      },
      pendingInvitations: [],
      unavailableReason: reason,
      error: {
        code: `http_${response.status}`,
        message: reason,
      },
    }
  }
}

function membersFallback(codebaseId: string): (response: Response) => MembersResponse {
  return (response) => {
    const reason = responseMessage(response)

    return {
      ok: false,
      codebaseId,
      capabilities: {
        backend: 'unavailable',
        list: disabled(reason),
        claimOwner: disabled(reason),
        suspend: disabled(reason),
        remove: disabled(reason),
      },
      members: [],
      unavailableReason: reason,
      error: {
        code: `http_${response.status}`,
        message: reason,
      },
    }
  }
}

function keyGrantStatusFallback(codebaseId: string): (response: Response) => KeyGrantStatusResponse {
  return (response) => {
    const reason = responseMessage(response)

    return {
      ok: false,
      codebaseId,
      codebaseKeyring: null,
      members: [],
      devices: [],
      userKeyrings: [],
      wrappedKeys: [],
      error: {
        code: `http_${response.status}`,
        message: reason,
      },
    }
  }
}

function disabled(reason: string): CollaborationActionCapability {
  return {
    enabled: false,
    reason,
  }
}

function responseMessage(response: Response) {
  return response.statusText || `Collaboration request returned ${response.status}.`
}

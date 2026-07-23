import { ApiFetchError, apiErrorFromUnknown, apiFetch, apiPayloadFromError } from './client/api'

export type CollaborationBackend = 'd1' | 'unavailable'

export type CollaborationActionCapability = {
  enabled: boolean
  reason?: string
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

export type ReviewThreadStatus = 'open' | 'resolved'

export type ReviewThreadComment = {
  id: string
  body: string
  createdBy: string
  updatedBy: string | null
  createdAt: string
  updatedAt: string
}

export type ReviewThread = {
  id: string
  codebaseId: string
  changeSetId: string
  filePath: string
  lineNumber: number | null
  baseRevision: string | null
  headRevision: string | null
  lineFingerprint: string | null
  status: ReviewThreadStatus
  createdBy: string
  updatedBy: string | null
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
  comments: ReviewThreadComment[]
}

export type ReviewThreadsResponse = {
  ok: boolean
  codebaseId: string | null
  changeSetId: string | null
  threads: ReviewThread[]
  error?: CollaborationError
}

export type ReviewDecisionKind = 'approved' | 'changes-requested' | 'commented'

export type ReviewDecision = {
  id: string
  codebaseId: string
  changeSetId: string
  decision: ReviewDecisionKind
  summary: string | null
  createdBy: string
  createdAt: string
}

export type ReviewDecisionsResponse = {
  ok: boolean
  codebaseId: string | null
  changeSetId: string | null
  decisions: ReviewDecision[]
  error?: CollaborationError
}

export type NotificationItem = {
  id: string
  codebaseId: string
  recipientUserId: string | null
  kind: string
  title: string
  body: string
  href: string | null
  readAt: string | null
  createdAt: string
}

export type NotificationsResponse = {
  ok: boolean
  codebaseId: string | null
  notifications: NotificationItem[]
  error?: CollaborationError
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

export type UpdateKeyRotationInput = {
  codebaseId: string
  rotationState: 'planned' | 'rotating' | 'wrapped' | 'stable' | 'blocked'
}

export type CreateReviewThreadInput = {
  codebaseId: string
  changeSetId: string
  filePath: string
  lineNumber?: number | null
  baseRevision?: string | null
  headRevision?: string | null
  lineFingerprint?: string | null
  body: string
  createdBy: string
}

export type CreateReviewThreadCommentInput = {
  codebaseId: string
  changeSetId?: string | null
  threadId: string
  body: string
  createdBy: string
}

export type ResolveReviewThreadInput = {
  codebaseId: string
  changeSetId?: string | null
  threadId: string
  updatedBy: string
}

export type CreateReviewDecisionInput = {
  codebaseId: string
  changeSetId: string
  decision: ReviewDecisionKind
  summary?: string | null
  createdBy: string
}

export type MarkNotificationReadInput = {
  codebaseId: string
  notificationId: string
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

export async function updateCodebaseKeyRotation(input: UpdateKeyRotationInput): Promise<KeyGrantStatusResponse> {
  return readJson<KeyGrantStatusResponse>('/api/collaboration/keys', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: 'setRotationState',
      ...input,
    }),
  }, keyGrantStatusFallback(input.codebaseId))
}

export async function fetchReviewThreads(
  codebaseId: string,
  changeSetId?: string | null,
): Promise<ReviewThreadsResponse> {
  const params = new URLSearchParams({ codebaseId })
  if (changeSetId) params.set('changeSetId', changeSetId)
  return readJson<ReviewThreadsResponse>(`/api/review/threads?${params.toString()}`, {
    cache: 'no-store',
  }, reviewThreadsFallback(codebaseId, changeSetId ?? null))
}

export async function createReviewThread(input: CreateReviewThreadInput): Promise<ReviewThreadsResponse> {
  return readJson<ReviewThreadsResponse>('/api/review/threads', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  }, reviewThreadsFallback(input.codebaseId, input.changeSetId))
}

export async function createReviewThreadComment(input: CreateReviewThreadCommentInput): Promise<ReviewThreadsResponse> {
  return readJson<ReviewThreadsResponse>('/api/review/threads', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type: 'comment',
      ...input,
    }),
  }, reviewThreadsFallback(input.codebaseId, null))
}

export async function resolveReviewThread(input: ResolveReviewThreadInput): Promise<ReviewThreadsResponse> {
  return readJson<ReviewThreadsResponse>('/api/review/threads', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: 'resolve',
      ...input,
    }),
  }, reviewThreadsFallback(input.codebaseId, null))
}

export async function fetchReviewDecisions(
  codebaseId: string,
  changeSetId?: string | null,
): Promise<ReviewDecisionsResponse> {
  const params = new URLSearchParams({ codebaseId })
  if (changeSetId) params.set('changeSetId', changeSetId)
  return readJson<ReviewDecisionsResponse>(`/api/review/decisions?${params.toString()}`, {
    cache: 'no-store',
  }, reviewDecisionsFallback(codebaseId, changeSetId ?? null))
}

export async function createReviewDecision(input: CreateReviewDecisionInput): Promise<ReviewDecisionsResponse> {
  return readJson<ReviewDecisionsResponse>('/api/review/decisions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  }, reviewDecisionsFallback(input.codebaseId, input.changeSetId))
}

export async function fetchNotifications(codebaseId: string): Promise<NotificationsResponse> {
  return readJson<NotificationsResponse>(`/api/notifications?codebaseId=${encodeURIComponent(codebaseId)}`, {
    cache: 'no-store',
  }, notificationsFallback(codebaseId))
}

export async function markNotificationRead(input: MarkNotificationReadInput): Promise<NotificationsResponse> {
  return readJson<NotificationsResponse>('/api/notifications', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      action: 'markRead',
      ...input,
    }),
  }, notificationsFallback(input.codebaseId))
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
  fallback: (response: Pick<Response, 'status' | 'statusText'>) => T,
): Promise<T> {
  try {
    return await apiFetch<T>(input, { ...init, allowErrorEnvelope: true })
  } catch (error) {
    const payload = apiPayloadFromError<T>(error)
    if (payload) return payload
    return fallback(responseFromError(error))
  }
}

function reviewThreadsFallback(codebaseId: string, changeSetId: string | null): (response: Pick<Response, 'status' | 'statusText'>) => ReviewThreadsResponse {
  return (response) => {
    const reason = responseMessage(response)

    return {
      ok: false,
      codebaseId,
      changeSetId,
      threads: [],
      error: {
        code: `http_${response.status}`,
        message: reason,
      },
    }
  }
}

function reviewDecisionsFallback(codebaseId: string, changeSetId: string | null): (response: Pick<Response, 'status' | 'statusText'>) => ReviewDecisionsResponse {
  return (response) => {
    const reason = responseMessage(response)

    return {
      ok: false,
      codebaseId,
      changeSetId,
      decisions: [],
      error: {
        code: `http_${response.status}`,
        message: reason,
      },
    }
  }
}

function notificationsFallback(codebaseId: string): (response: Pick<Response, 'status' | 'statusText'>) => NotificationsResponse {
  return (response) => {
    const reason = responseMessage(response)

    return {
      ok: false,
      codebaseId,
      notifications: [],
      error: {
        code: `http_${response.status}`,
        message: reason,
      },
    }
  }
}

function invitationsFallback(codebaseId: string): (response: Pick<Response, 'status' | 'statusText'>) => InvitationsResponse {
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

function membersFallback(codebaseId: string): (response: Pick<Response, 'status' | 'statusText'>) => MembersResponse {
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

function keyGrantStatusFallback(codebaseId: string): (response: Pick<Response, 'status' | 'statusText'>) => KeyGrantStatusResponse {
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

function responseMessage(response: Pick<Response, 'status' | 'statusText'>) {
  return response.statusText || `Collaboration request returned ${response.status}.`
}

function responseFromError(error: unknown): Pick<Response, 'status' | 'statusText'> {
  const details = apiErrorFromUnknown(error, 'Collaboration request failed.')
  return {
    status: error instanceof ApiFetchError && error.status !== null ? error.status : 0,
    statusText: details.message,
  }
}

import { createD1Backend, d1CloudServiceType, isD1Configured } from '@hopit/backend-d1'
import { applyLocalProductionEnvFallback } from '@/lib/local-production-env'

applyLocalProductionEnvFallback()

const defaultD1ApiBaseUrl = 'https://api.cloudflare.com/client/v4'
const reportedMissingD1Config = new Set<string>()

export type CloudBackendKind = 'd1' | 'unavailable'

export type CloudActor = {
  userId?: string | null
  sessionId?: string | null
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
  if (preferred === 'd1' || preferred === 'cloudflare-d1') {
    if (isD1Configured()) return 'd1'
    logMissingD1ConfigOnce()
    return 'unavailable'
  }
  if (preferred) return 'unavailable'
  if (isD1Configured()) return 'd1'
  if (hasPartialD1Config()) logMissingD1ConfigOnce()
  return 'unavailable'
}

export function cloudBackendName() {
  const backend = configuredCloudBackend()
  if (backend === 'd1') return d1CloudServiceType
  return backend
}

export function missingCloudBackendConfig() {
  if (isD1Configured()) return []

  const missing: string[] = []
  if (usesD1ProxyBaseUrl()) {
    if (!process.env.HOPIT_D1_API_TOKEN && !process.env.CLOUDFLARE_API_TOKEN && !process.env.HOPIT_AGENT_SESSION_TOKEN) {
      missing.push('HOPIT_D1_API_TOKEN, CLOUDFLARE_API_TOKEN, or HOPIT_AGENT_SESSION_TOKEN')
    }
    return missing
  }
  if (!process.env.HOPIT_D1_ACCOUNT_ID && !process.env.CLOUDFLARE_ACCOUNT_ID) {
    missing.push('HOPIT_D1_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID')
  }
  if (!process.env.HOPIT_D1_DATABASE_ID) missing.push('HOPIT_D1_DATABASE_ID')
  if (!process.env.HOPIT_D1_API_TOKEN && !process.env.CLOUDFLARE_API_TOKEN) {
    missing.push('HOPIT_D1_API_TOKEN or CLOUDFLARE_API_TOKEN')
  }
  if (missing.length === 0) missing.push('HOPIT_CLOUD_BACKEND=d1 plus HOPIT_D1_* values')
  return missing
}

function usesD1ProxyBaseUrl() {
  const baseUrl = process.env.HOPIT_D1_API_BASE_URL?.trim().replace(/\/+$/, '')
  return Boolean(baseUrl && baseUrl !== defaultD1ApiBaseUrl)
}

function hasPartialD1Config() {
  return [
    'HOPIT_D1_ACCOUNT_ID',
    'CLOUDFLARE_ACCOUNT_ID',
    'HOPIT_D1_DATABASE_ID',
    'HOPIT_D1_API_TOKEN',
    'CLOUDFLARE_API_TOKEN',
    'HOPIT_AGENT_SESSION_TOKEN',
    'HOPIT_D1_API_BASE_URL',
  ].some((name) => Boolean(process.env[name]?.trim()))
}

function logMissingD1ConfigOnce() {
  const missing = missingCloudBackendConfig()
  const key = missing.join('|') || 'unknown'
  if (reportedMissingD1Config.has(key)) return
  reportedMissingD1Config.add(key)
  console.warn(`[HopIt cloud] Cloudflare D1 backend is unavailable. Missing: ${missing.join(', ')}.`)
}

export async function readCloudAgentDashboard(requester: CloudRequester = {}, codebaseId = process.env.HOPIT_CODEBASE_ID ?? 'hopit') {
  if (configuredCloudBackend() === 'd1') {
    return d1Backend({ 'codebase-id': codebaseId }, requester).readDashboard({
      codebaseId,
      requesterUserId: requester.requesterUserId,
      requesterSessionId: requester.requesterSessionId,
    })
  }
  throw new Error('No HopIt cloud backend is configured.')
}

export async function listCloudCodebases(actor: CloudActor) {
  if (configuredCloudBackend() === 'd1') return d1Backend({}, actor).listCodebases(actor)
  throw new Error('No HopIt cloud backend is configured for codebases.')
}

export async function createCloudCodebase(input: {
  name: string
  codebaseId?: string
  description?: string
  actor: CloudActor
}) {
  if (configuredCloudBackend() === 'd1') return d1Backend({}, input.actor).createCodebase(input)
  throw new Error('No HopIt cloud backend is configured for codebases.')
}

export async function updateCloudCodebase(input: {
  codebaseId: string
  name?: string
  visibility?: 'private' | 'team-visible' | 'review-visible'
  actor: CloudActor
}) {
  if (configuredCloudBackend() === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }, input.actor).updateCodebase(input)
  throw new Error('No HopIt cloud backend is configured for codebases.')
}

export async function deleteCloudCodebase(input: { codebaseId: string; actor: CloudActor }) {
  if (configuredCloudBackend() === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }, input.actor).deleteCodebase(input)
  throw new Error('No HopIt cloud backend is configured for codebases.')
}

export async function readCloudTextFile(input: { codebaseId: string; path: string; actor: CloudActor }) {
  if (configuredCloudBackend() === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }, input.actor).readTextFile(input)
  throw new Error('No HopIt cloud backend is configured for file reads.')
}

export async function mutateCloudTextFile(input: {
  codebaseId: string
  path: string
  content: string
  baseRevision?: number | null
  selectedStateId?: string
  actor: CloudActor
}) {
  if (configuredCloudBackend() === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }, input.actor).mutateTextFile(input)
  throw new Error('No HopIt cloud backend is configured for file edits.')
}

export async function listCloudActionJobs(input: { codebaseId: string; limit?: number; actor: CloudActor }) {
  if (configuredCloudBackend() === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }, input.actor).listActionJobs(input)
  throw new Error('No HopIt cloud backend is configured for actions.')
}

export async function createCloudActionJob(input: {
  codebaseId: string
  kind: 'lint' | 'test' | 'build'
  actor: CloudActor
}) {
  if (configuredCloudBackend() === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }, input.actor).createActionJob(input)
  throw new Error('No HopIt cloud backend is configured for actions.')
}

export async function listCloudMembers(input: {
  codebaseId: string
  status?: 'active' | 'suspended'
  actor: CloudActor
}) {
  if (configuredCloudBackend() === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }, input.actor).listMembers(input)
  throw new Error('No HopIt cloud backend is configured for members.')
}

export async function claimCloudCodebaseOwner(input: { codebaseId: string; actor: CloudActor }) {
  if (configuredCloudBackend() === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }).claimCodebaseOwner(input)
  throw new Error('No HopIt cloud backend is configured for members.')
}

export async function bootstrapCloudAccount(actor: CloudActor) {
  if (configuredCloudBackend() === 'd1') return d1Backend().bootstrapAccount(actor)
  throw new Error('No HopIt cloud backend is configured for account bootstrap.')
}

export async function suspendCloudMember(input: { codebaseId: string; userId: string; actor: CloudActor }) {
  if (configuredCloudBackend() === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }, input.actor).suspendMember(input)
  throw new Error('No HopIt cloud backend is configured for members.')
}

export async function removeCloudMember(input: { codebaseId: string; userId: string; actor: CloudActor }) {
  if (configuredCloudBackend() === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }, input.actor).removeMember(input)
  throw new Error('No HopIt cloud backend is configured for members.')
}

export async function listCloudInvitations(input: {
  codebaseId: string
  status?: 'pending' | 'accepted' | 'revoked' | 'expired'
  actor: CloudActor
}) {
  if (configuredCloudBackend() === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }, input.actor).listInvitations(input)
  throw new Error('No HopIt cloud backend is configured for invitations.')
}

export async function createCloudInvitation(input: {
  codebaseId: string
  email: string
  role: 'maintainer' | 'member' | 'viewer'
  expiresAt?: string
  actor: CloudActor
}) {
  if (configuredCloudBackend() === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }, input.actor).createInvitation(input)
  throw new Error('No HopIt cloud backend is configured for invitations.')
}

export async function acceptCloudInvitation(input: { token: string; actor: CloudActor }) {
  if (configuredCloudBackend() === 'd1') return d1Backend().acceptInvitation(input)
  throw new Error('No HopIt cloud backend is configured for invitations.')
}

export async function revokeCloudInvitation(input: { codebaseId: string; invitationId: string; actor: CloudActor }) {
  if (configuredCloudBackend() === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }, input.actor).revokeInvitation(input)
  throw new Error('No HopIt cloud backend is configured for invitations.')
}

export async function listCloudWorkItems(input: { codebaseId: string; actor: CloudActor }) {
  if (configuredCloudBackend() === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }, input.actor).listWorkItems(input)
  throw new Error('No HopIt cloud backend is configured for collaboration.')
}

export async function createCloudWorkItem(input: Record<string, unknown> & { codebaseId: string; actor: CloudActor }) {
  if (configuredCloudBackend() === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }, input.actor).createWorkItem(input)
  throw new Error('No HopIt cloud backend is configured for collaboration.')
}

export async function updateCloudWorkItem(input: Record<string, unknown> & { codebaseId: string; actor: CloudActor }) {
  if (configuredCloudBackend() === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }, input.actor).updateWorkItem(input)
  throw new Error('No HopIt cloud backend is configured for collaboration.')
}

export async function upsertCloudUser(input: CloudActor & {
  avatarUrl?: string | null
  emailVerified?: boolean
}) {
  if (configuredCloudBackend() === 'd1') {
    return d1Backend({}, input).upsertUser({
      userId: input.userId,
      primaryEmail: input.primaryEmail,
      displayName: input.displayName,
      avatarUrl: input.avatarUrl,
      emailVerified: input.emailVerified ?? input.currentAuthEmailVerified,
    })
  }
  throw new Error('No HopIt cloud backend is configured for account sync.')
}

// Tenant auto-provision (Phase 3 §2e signup funnel). Ensures the authenticated
// user has a free tenant row on their first authenticated request — no card, no
// owner-email gate. Idempotent, so it is safe to call on every dashboard load.
// Deliberately actor-less (d1Backend() with no server-actor id) so the write
// rides the admin proxy token: the server-actor firewall forbids tenant_usage
// mutation, and this is an account-ensure step keyed by the caller's own verified
// user id, not a cross-tenant surface. Returns null (a no-op) with the flag off,
// keeping single-tenant behavior byte-for-byte.
export async function provisionCloudTenant(actor: CloudActor) {
  if (!actor.userId || configuredCloudBackend() !== 'd1') return null
  return d1Backend().ensureTenant({ tenantId: actor.userId })
}

export async function applyCloudBillingEvent(input: Record<string, unknown>) {
  if (configuredCloudBackend() === 'd1') return d1Backend().applyBillingEvent(input)
  throw new Error('No HopIt cloud backend is configured for billing.')
}

export async function readCloudTenantSubscription(tenantId: string) {
  if (configuredCloudBackend() === 'd1') return d1Backend().readTenantSubscription({ tenantId })
  throw new Error('No HopIt cloud backend is configured for billing.')
}

export async function readCloudSubscriptionByProviderCustomer(provider: string, providerCustomerId: string) {
  if (configuredCloudBackend() === 'd1') {
    return d1Backend().readSubscriptionByProviderCustomer({ provider, providerCustomerId })
  }
  throw new Error('No HopIt cloud backend is configured for billing.')
}

export async function readCloudTenantUsage(tenantId: string) {
  if (configuredCloudBackend() === 'd1') return d1Backend().readTenantUsage({ tenantId })
  throw new Error('No HopIt cloud backend is configured for billing.')
}

export async function createCloudDeviceAuthorization(input: Record<string, unknown>) {
  if (configuredCloudBackend() === 'd1') return d1Backend().createDeviceAuthorization(input)
  throw new Error('No HopIt cloud backend is configured for device authorization.')
}

export async function pollCloudDeviceAuthorization(deviceCode: string) {
  if (configuredCloudBackend() === 'd1') return d1Backend().pollDeviceAuthorization(deviceCode)
  throw new Error('No HopIt cloud backend is configured for device authorization.')
}

export async function readCloudDeviceAuthorization(userCode: string) {
  if (configuredCloudBackend() === 'd1') return d1Backend().readDeviceAuthorizationForApproval(userCode)
  throw new Error('No HopIt cloud backend is configured for device authorization.')
}

export async function approveCloudDeviceAuthorization(input: {
  userCode: string
  codebaseId: string
  actor: CloudActor
}) {
  if (configuredCloudBackend() === 'd1') return d1Backend({ 'codebase-id': input.codebaseId }).approveDeviceAuthorization(input)
  throw new Error('No HopIt cloud backend is configured for device authorization.')
}

// When HOPIT_MULTITENANT is on, tenant-data calls carry the authenticated user's
// id so the backend client presents a per-request server-actor credential the
// Worker re-checks against codebase ownership/membership (Phase 3 Stage 1a), in
// place of the omnipotent proxy token. Actor-less/administrative flows (device
// authorization, owner-claim bootstrap, invitation-by-token) intentionally omit
// the actor and keep using the proxy token. With the flag off this option is
// inert and the proxy path is unchanged.
function d1Backend(options: Record<string, unknown> = {}, actor?: CloudActor | CloudRequester | null): any {
  const merged: Record<string, unknown> = { ...options }
  const userId = actorUserId(actor)
  if (userId && merged['server-actor-user-id'] === undefined) {
    merged['server-actor-user-id'] = userId
  }
  return createD1Backend(merged)
}

function actorUserId(actor?: CloudActor | CloudRequester | null): string | null {
  if (!actor) return null
  if ('userId' in actor && actor.userId) return actor.userId
  if ('requesterUserId' in actor && actor.requesterUserId) return actor.requesterUserId
  return null
}

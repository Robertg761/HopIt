import { NextResponse } from 'next/server'
import { anyApi } from 'convex/server'

import { convexAuthToken, convexClient, convexUrl } from '@/lib/convex-auth'
import type {
  CollaborationCapabilities,
  CollaborationDiscussion,
  CollaborationIssue,
  CollaborationRelease,
  WorkItemsResponse,
} from '@/lib/collaboration'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request) {
  const codebaseId = codebaseIdFromRequest(request)
  const authToken = await convexAuthToken()
  const unavailable = unavailableReason('read', Boolean(authToken))
  if (unavailable) return workItemsUnavailable(codebaseId, unavailable)

  try {
    return NextResponse.json(await readWorkItems(codebaseId, authToken), responseInit())
  } catch (error) {
    return workItemsError(codebaseId, 'collaboration_read_failed', errorMessage(error), 502)
  }
}

export async function POST(request: Request) {
  const unavailable = unavailableReason('write')
  const body = await readBody(request)
  const codebaseId = stringValue(body.codebaseId) ?? defaultCodebaseId()

  if (unavailable) return workItemsUnavailable(codebaseId, unavailable)

  try {
    const authToken = await convexAuthToken()
    if (!authToken) {
      return workItemsError(codebaseId, 'browser_auth_required', 'Creating collaboration items requires product auth.', 401)
    }
    const client = convexClient(authToken)
    const createdBy = optionalText(body.createdBy)

    if (body.type === 'issue') {
      await client.mutation(
        anyApi.collaboration.createIssue,
        {
          codebaseId,
          title: requireText(body.title, 'title'),
          body: optionalText(body.body),
          priority: optionalIssuePriority(body.priority),
          labels: stringArray(body.labels),
          linkedChangeSetId: optionalText(body.linkedChangeSetId),
          linkedReleaseId: optionalText(body.linkedReleaseId),
          createdBy,
        },
      )
    } else if (body.type === 'discussion') {
      await client.mutation(
        anyApi.collaboration.createDiscussion,
        {
          codebaseId,
          title: requireText(body.title, 'title'),
          body: requireText(body.body, 'body'),
          category: optionalDiscussionCategory(body.category),
          labels: stringArray(body.labels),
          linkedChangeSetId: optionalText(body.linkedChangeSetId),
          createdBy,
        },
      )
    } else if (body.type === 'release') {
      await client.mutation(
        anyApi.collaboration.createRelease,
        {
          codebaseId,
          version: requireText(body.version, 'version'),
          title: requireText(body.title, 'title'),
          notes: requireText(body.notes, 'notes'),
          status: optionalReleaseStatus(body.status),
          target: releaseTarget(body.target),
          createdBy,
        },
      )
    } else {
      return workItemsError(codebaseId, 'invalid_type', 'Expected type to be issue, discussion, or release.', 400)
    }

    return NextResponse.json(await readWorkItems(codebaseId, authToken), responseInit())
  } catch (error) {
    return workItemsError(codebaseId, 'collaboration_create_failed', errorMessage(error), 400)
  }
}

export async function PATCH(request: Request) {
  const unavailable = unavailableReason('write')
  const body = await readBody(request)
  const codebaseId = stringValue(body.codebaseId) ?? defaultCodebaseId()

  if (unavailable) return workItemsUnavailable(codebaseId, unavailable)

  try {
    const authToken = await convexAuthToken()
    if (!authToken) {
      return workItemsError(codebaseId, 'browser_auth_required', 'Updating collaboration items requires product auth.', 401)
    }
    const client = convexClient(authToken)
    const updatedBy = optionalText(body.updatedBy)

    if (body.action === 'setIssueStatus') {
      await client.mutation(
        anyApi.collaboration.setIssueStatus,
        {
          issueId: requireText(body.issueId, 'issueId'),
          status: issueStatus(body.status),
          updatedBy,
        },
      )
    } else if (body.action === 'setDiscussionStatus') {
      await client.mutation(
        anyApi.collaboration.setDiscussionStatus,
        {
          discussionId: requireText(body.discussionId, 'discussionId'),
          status: discussionStatus(body.status),
          updatedBy,
        },
      )
    } else if (body.action === 'publishRelease') {
      await client.mutation(
        anyApi.collaboration.publishRelease,
        {
          releaseId: requireText(body.releaseId, 'releaseId'),
          updatedBy,
        },
      )
    } else {
      return workItemsError(codebaseId, 'invalid_action', 'Unknown collaboration update action.', 400)
    }

    return NextResponse.json(await readWorkItems(codebaseId, authToken), responseInit())
  } catch (error) {
    return workItemsError(codebaseId, 'collaboration_update_failed', errorMessage(error), 400)
  }
}

async function readWorkItems(
  codebaseId: string,
  providedAuthToken?: string | null,
): Promise<WorkItemsResponse> {
  const authToken = providedAuthToken ?? await convexAuthToken()
  const client = convexClient(authToken)
  const args = readArgs({ codebaseId }, authToken)
  const [issues, discussions, releases] = await Promise.all([
    client.query(anyApi.collaboration.listIssues, args),
    client.query(anyApi.collaboration.listDiscussions, args),
    client.query(anyApi.collaboration.listReleases, args),
  ])

  return {
    ok: true,
    codebaseId,
    capabilities: collaborationCapabilities(Boolean(authToken)),
    issues: Array.isArray(issues) ? issues.map(mapIssue) : [],
    discussions: Array.isArray(discussions) ? discussions.map(mapDiscussion) : [],
    releases: Array.isArray(releases) ? releases.map(mapRelease) : [],
  }
}

function mapIssue(row: Record<string, unknown>): CollaborationIssue {
  return {
    id: documentId(row),
    number: numberValue(row.number) ?? 0,
    title: stringValue(row.title) ?? 'Untitled issue',
    body: stringValue(row.body),
    status: row.status === 'closed' ? 'closed' : 'open',
    priority: issuePriorityOrNull(row.priority),
    labels: stringArray(row.labels),
    assigneeIds: stringArray(row.assigneeIds),
    linkedChangeSetId: stringValue(row.linkedChangeSetId),
    linkedReleaseId: stringValue(row.linkedReleaseId),
    createdBy: stringValue(row.createdBy) ?? 'unknown',
    updatedBy: stringValue(row.updatedBy),
    createdAt: stringValue(row.createdAt) ?? '',
    updatedAt: stringValue(row.updatedAt) ?? '',
    closedAt: stringValue(row.closedAt),
  }
}

function mapDiscussion(row: Record<string, unknown>): CollaborationDiscussion {
  return {
    id: documentId(row),
    number: numberValue(row.number) ?? 0,
    title: stringValue(row.title) ?? 'Untitled discussion',
    body: stringValue(row.body) ?? '',
    category: discussionCategory(row.category),
    status: discussionStatus(row.status),
    labels: stringArray(row.labels),
    linkedIssueIds: stringArray(row.linkedIssueIds),
    linkedChangeSetId: stringValue(row.linkedChangeSetId),
    createdBy: stringValue(row.createdBy) ?? 'unknown',
    updatedBy: stringValue(row.updatedBy),
    createdAt: stringValue(row.createdAt) ?? '',
    updatedAt: stringValue(row.updatedAt) ?? '',
    closedAt: stringValue(row.closedAt),
  }
}

function mapRelease(row: Record<string, unknown>): CollaborationRelease {
  const target = recordValue(row.target)

  return {
    id: documentId(row),
    number: numberValue(row.number) ?? 0,
    version: stringValue(row.version) ?? 'unversioned',
    title: stringValue(row.title) ?? 'Untitled release',
    notes: stringValue(row.notes) ?? '',
    status: releaseStatus(row.status),
    target: {
      type: releaseTargetType(target?.type),
      id: stringValue(target?.id) ?? 'main',
      revision: numberValue(target?.revision),
    },
    createdBy: stringValue(row.createdBy) ?? 'unknown',
    updatedBy: stringValue(row.updatedBy),
    createdAt: stringValue(row.createdAt) ?? '',
    updatedAt: stringValue(row.updatedAt) ?? '',
    publishedAt: stringValue(row.publishedAt),
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null)
  return recordValue(body) ?? {}
}

function codebaseIdFromRequest(request: Request) {
  const url = new URL(request.url)
  return url.searchParams.get('codebaseId') || defaultCodebaseId()
}

function defaultCodebaseId() {
  return process.env.HOPIT_CODEBASE_ID ?? 'hopit'
}

function unavailableReason(mode: 'read' | 'write', hasAuth = false) {
  if (!convexUrl()) return 'Convex is not configured for collaboration reads.'
  if (mode === 'read' && !hasAuth && !process.env.HOPIT_AGENT_TOKEN && process.env.HOPIT_ALLOW_UNAUTHENTICATED_AGENT !== '1') {
    return 'HOPIT_AGENT_TOKEN is required for unauthenticated server-side collaboration reads.'
  }
  return null
}

function collaborationCapabilities(hasAuth = false): CollaborationCapabilities {
  const readUnavailable = unavailableReason('read', hasAuth)
  const read = readUnavailable ? { enabled: false, reason: readUnavailable } : { enabled: true }
  const write = hasAuth
    ? { enabled: true }
    : { enabled: false, reason: 'Product auth is required for collaboration writes.' }

  return {
    backend: readUnavailable ? 'unavailable' : 'convex',
    read,
    createIssue: write,
    updateIssue: write,
    createDiscussion: write,
    updateDiscussion: write,
    createRelease: write,
    publishRelease: write,
  }
}

function workItemsUnavailable(codebaseId: string, reason: string) {
  return workItemsError(codebaseId, 'collaboration_unavailable', reason, 503)
}

function workItemsError(codebaseId: string, code: string, message: string, status: number) {
  const body: WorkItemsResponse = {
    ok: false,
    codebaseId,
    capabilities: collaborationCapabilities(),
    issues: [],
    discussions: [],
    releases: [],
    error: {
      code,
      message,
    },
  }

  return NextResponse.json(body, {
    status,
    ...responseInit(),
  })
}

function responseInit() {
  return {
    headers: {
      'Cache-Control': 'no-store',
    },
  }
}

function readArgs<T extends Record<string, unknown>>(value: T, authToken: string | null) {
  if (authToken) return value
  const token = process.env.HOPIT_AGENT_TOKEN
  return token ? { ...value, token } : value
}

function documentId(row: Record<string, unknown>) {
  return stringValue(row._id) ?? stringValue(row.id) ?? ''
}

function requireText(value: unknown, label: string) {
  const text = stringValue(value)
  if (!text) throw new Error(`${label} is required.`)
  return text
}

function optionalText(value: unknown) {
  return stringValue(value) ?? undefined
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)))
    : []
}

function optionalIssuePriority(value: unknown) {
  const priority = issuePriorityOrNull(value)
  return priority ?? undefined
}

function issuePriorityOrNull(value: unknown): CollaborationIssue['priority'] {
  return value === 'low' || value === 'medium' || value === 'high' ? value : null
}

function issueStatus(value: unknown): CollaborationIssue['status'] {
  if (value === 'closed' || value === 'open') return value
  throw new Error('Issue status must be open or closed.')
}

function optionalDiscussionCategory(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined
  return discussionCategory(value)
}

function discussionCategory(value: unknown): CollaborationDiscussion['category'] {
  if (value === 'ideas' || value === 'q-and-a' || value === 'announcements') return value
  return 'general'
}

function discussionStatus(value: unknown): CollaborationDiscussion['status'] {
  if (value === 'answered' || value === 'locked' || value === 'closed') return value
  return 'open'
}

function optionalReleaseStatus(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined
  return releaseStatus(value)
}

function releaseStatus(value: unknown): CollaborationRelease['status'] {
  if (value === 'published' || value === 'archived') return value
  return 'draft'
}

function releaseTarget(value: unknown) {
  const target = recordValue(value)
  if (!target) return undefined

  return {
    type: releaseTargetType(target.type),
    id: stringValue(target.id) ?? 'main',
    revision: numberValue(target.revision) ?? undefined,
  }
}

function releaseTargetType(value: unknown): CollaborationRelease['target']['type'] {
  if (value === 'snapshot' || value === 'change-set' || value === 'git') return value
  return 'main'
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Collaboration request failed.'
}

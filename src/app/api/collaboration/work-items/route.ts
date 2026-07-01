import { NextResponse } from 'next/server'

import {
  configuredCloudBackend,
  createCloudWorkItem,
  listCloudWorkItems,
  missingCloudBackendConfig,
  updateCloudWorkItem,
  type CloudActor,
} from '@/lib/cloud-backend'
import type {
  CollaborationCapabilities,
  CollaborationDiscussion,
  CollaborationIssue,
  CollaborationRelease,
  WorkItemsResponse,
} from '@/lib/collaboration'
import { cloudActorFromRequest } from '@/lib/request-cloud-actor'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request) {
  const codebaseId = codebaseIdFromRequest(request)
  const unavailable = cloudUnavailable('collaboration reads')
  if (unavailable) return workItemsUnavailable(codebaseId, unavailable.message)

  const actor = await readActor(request)
  if (!actor) {
    return workItemsError(codebaseId, 'browser_auth_required', 'Reading collaboration items requires product auth or Basic Auth fallback.', 401)
  }

  try {
    return NextResponse.json(await readWorkItems(codebaseId, actor), responseInit())
  } catch (error) {
    return workItemsError(codebaseId, 'collaboration_read_failed', errorMessage(error), 502)
  }
}

export async function POST(request: Request) {
  const body = await readBody(request)
  const codebaseId = stringValue(body.codebaseId) ?? defaultCodebaseId()
  const unavailable = cloudUnavailable('collaboration writes')
  if (unavailable) return workItemsUnavailable(codebaseId, unavailable.message)

  const actor = await cloudActorFromRequest(request)
  if (!actor?.userId) {
    return workItemsError(codebaseId, 'browser_auth_required', 'Creating collaboration items requires product auth.', 401)
  }

  try {
    const createdBy = optionalText(body.createdBy)

    if (body.type === 'issue') {
      await createCloudWorkItem({
        type: 'issue',
        codebaseId,
        title: requireText(body.title, 'title'),
        body: optionalText(body.body),
        priority: optionalIssuePriority(body.priority),
        labels: stringArray(body.labels),
        linkedChangeSetId: optionalText(body.linkedChangeSetId),
        linkedReleaseId: optionalText(body.linkedReleaseId),
        createdBy,
        actor,
      })
    } else if (body.type === 'discussion') {
      await createCloudWorkItem({
        type: 'discussion',
        codebaseId,
        title: requireText(body.title, 'title'),
        body: requireText(body.body, 'body'),
        category: optionalDiscussionCategory(body.category),
        labels: stringArray(body.labels),
        linkedChangeSetId: optionalText(body.linkedChangeSetId),
        createdBy,
        actor,
      })
    } else if (body.type === 'release') {
      await createCloudWorkItem({
        type: 'release',
        codebaseId,
        version: requireText(body.version, 'version'),
        title: requireText(body.title, 'title'),
        notes: requireText(body.notes, 'notes'),
        status: optionalReleaseStatus(body.status),
        target: releaseTarget(body.target),
        createdBy,
        actor,
      })
    } else {
      return workItemsError(codebaseId, 'invalid_type', 'Expected type to be issue, discussion, or release.', 400)
    }

    return NextResponse.json(await readWorkItems(codebaseId, actor), responseInit())
  } catch (error) {
    return workItemsError(codebaseId, 'collaboration_create_failed', errorMessage(error), 400)
  }
}

export async function PATCH(request: Request) {
  const body = await readBody(request)
  const codebaseId = stringValue(body.codebaseId) ?? defaultCodebaseId()
  const unavailable = cloudUnavailable('collaboration writes')
  if (unavailable) return workItemsUnavailable(codebaseId, unavailable.message)

  const actor = await cloudActorFromRequest(request)
  if (!actor?.userId) {
    return workItemsError(codebaseId, 'browser_auth_required', 'Updating collaboration items requires product auth.', 401)
  }

  try {
    const updatedBy = optionalText(body.updatedBy)

    if (body.action === 'setIssueStatus') {
      await updateCloudWorkItem({
        action: 'setIssueStatus',
        codebaseId,
        issueId: requireText(body.issueId, 'issueId'),
        status: issueStatus(body.status),
        updatedBy,
        actor,
      })
    } else if (body.action === 'setDiscussionStatus') {
      await updateCloudWorkItem({
        action: 'setDiscussionStatus',
        codebaseId,
        discussionId: requireText(body.discussionId, 'discussionId'),
        status: discussionStatus(body.status),
        updatedBy,
        actor,
      })
    } else if (body.action === 'publishRelease') {
      await updateCloudWorkItem({
        action: 'publishRelease',
        codebaseId,
        releaseId: requireText(body.releaseId, 'releaseId'),
        updatedBy,
        actor,
      })
    } else {
      return workItemsError(codebaseId, 'invalid_action', 'Unknown collaboration update action.', 400)
    }

    return NextResponse.json(await readWorkItems(codebaseId, actor), responseInit())
  } catch (error) {
    return workItemsError(codebaseId, 'collaboration_update_failed', errorMessage(error), 400)
  }
}

async function readActor(request: Request): Promise<CloudActor | null> {
  const actor = await cloudActorFromRequest(request, { allowBasicFallback: true })
  if (actor) return actor
  if (configuredCloudBackend() === 'convex' && process.env.HOPIT_AGENT_TOKEN) return {}
  return null
}

async function readWorkItems(codebaseId: string, actor: CloudActor): Promise<WorkItemsResponse> {
  const items = await listCloudWorkItems({ codebaseId, actor })
  const itemRows = recordValue(items) ?? {}

  return {
    ok: true,
    codebaseId,
    capabilities: collaborationCapabilities(Boolean(actor.userId)),
    issues: Array.isArray(itemRows.issues) ? itemRows.issues.map(mapIssue) : [],
    discussions: Array.isArray(itemRows.discussions) ? itemRows.discussions.map(mapDiscussion) : [],
    releases: Array.isArray(itemRows.releases) ? itemRows.releases.map(mapRelease) : [],
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

function cloudUnavailable(feature: string) {
  const missing = missingCloudBackendConfig()
  if (missing.length === 0) return null
  return {
    message: `No HopIt cloud backend is configured for ${feature}. Missing: ${missing.join(', ')}.`,
  }
}

function collaborationCapabilities(hasAuth = false): CollaborationCapabilities {
  const backend = configuredCloudBackend()
  const hasBackend = backend !== 'unavailable'
  const read = hasBackend
    ? { enabled: true }
    : { enabled: false, reason: 'HopIt cloud backend is not configured for collaboration reads.' }
  const write = hasAuth && hasBackend
    ? { enabled: true }
    : { enabled: false, reason: hasBackend ? 'Product auth is required for collaboration writes.' : 'HopIt cloud backend is not configured for collaboration writes.' }

  return {
    backend,
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

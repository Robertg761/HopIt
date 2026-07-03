import { integerOrNull, integerValue, parseJson, parseStringArray, stringOrNull, uniqueStrings } from './base.js'

export function mapD1Issue(row, comments = []) {
  if (!row) return null
  return {
    _id: row.issue_id,
    id: row.issue_id,
    codebaseId: row.codebase_id,
    number: integerValue(row.number, 0),
    title: stringOrNull(row.title) ?? 'Untitled issue',
    body: stringOrNull(row.body),
    status: row.status === 'closed' ? 'closed' : 'open',
    priority: issuePriorityOrNull(row.priority),
    labels: parseStringArray(row.labels_json),
    assigneeIds: parseStringArray(row.assignee_ids_json),
    linkedChangeSetId: stringOrNull(row.linked_change_set_id),
    linkedReleaseId: stringOrNull(row.linked_release_id),
    createdBy: stringOrNull(row.created_by) ?? 'unknown',
    updatedBy: stringOrNull(row.updated_by),
    createdAt: stringOrNull(row.created_at) ?? '',
    updatedAt: stringOrNull(row.updated_at) ?? '',
    closedAt: stringOrNull(row.closed_at),
    comments,
  }
}

export function mapD1IssueComment(row) {
  if (!row) return null
  return {
    _id: row.comment_id,
    id: row.comment_id,
    codebaseId: row.codebase_id,
    issueId: row.issue_id,
    body: stringOrNull(row.body) ?? '',
    createdBy: stringOrNull(row.created_by) ?? 'unknown',
    updatedBy: stringOrNull(row.updated_by),
    createdAt: stringOrNull(row.created_at) ?? '',
    updatedAt: stringOrNull(row.updated_at) ?? '',
  }
}

export function mapD1Discussion(row, comments = []) {
  if (!row) return null
  return {
    _id: row.discussion_id,
    id: row.discussion_id,
    codebaseId: row.codebase_id,
    number: integerValue(row.number, 0),
    title: stringOrNull(row.title) ?? 'Untitled discussion',
    body: stringOrNull(row.body) ?? '',
    category: discussionCategory(row.category),
    status: discussionStatus(row.status),
    labels: parseStringArray(row.labels_json),
    linkedIssueIds: parseStringArray(row.linked_issue_ids_json),
    linkedChangeSetId: stringOrNull(row.linked_change_set_id),
    createdBy: stringOrNull(row.created_by) ?? 'unknown',
    updatedBy: stringOrNull(row.updated_by),
    createdAt: stringOrNull(row.created_at) ?? '',
    updatedAt: stringOrNull(row.updated_at) ?? '',
    closedAt: stringOrNull(row.closed_at),
    comments,
  }
}

export function mapD1DiscussionComment(row) {
  if (!row) return null
  return {
    _id: row.comment_id,
    id: row.comment_id,
    codebaseId: row.codebase_id,
    discussionId: row.discussion_id,
    body: stringOrNull(row.body) ?? '',
    createdBy: stringOrNull(row.created_by) ?? 'unknown',
    updatedBy: stringOrNull(row.updated_by),
    createdAt: stringOrNull(row.created_at) ?? '',
    updatedAt: stringOrNull(row.updated_at) ?? '',
  }
}

export function mapD1Release(row, assets = []) {
  if (!row) return null
  const target = parseJson(row.target_json, null)
  return {
    _id: row.release_id,
    id: row.release_id,
    codebaseId: row.codebase_id,
    number: integerValue(row.number, 0),
    version: stringOrNull(row.version) ?? 'unversioned',
    title: stringOrNull(row.title) ?? 'Untitled release',
    notes: stringOrNull(row.notes) ?? '',
    status: releaseStatus(row.status),
    target: normalizeReleaseTarget(target),
    createdBy: stringOrNull(row.created_by) ?? 'unknown',
    updatedBy: stringOrNull(row.updated_by),
    createdAt: stringOrNull(row.created_at) ?? '',
    updatedAt: stringOrNull(row.updated_at) ?? '',
    publishedAt: stringOrNull(row.published_at),
    assets,
  }
}

export function mapD1ReleaseAsset(row) {
  if (!row) return null
  return {
    _id: row.asset_id,
    id: row.asset_id,
    releaseId: row.release_id,
    name: stringOrNull(row.name) ?? 'Unnamed asset',
    kind: releaseAssetKind(row.kind),
    url: stringOrNull(row.url),
    size: integerValue(row.size, null),
    checksum: stringOrNull(row.checksum),
    createdBy: stringOrNull(row.created_by) ?? 'unknown',
    createdAt: stringOrNull(row.created_at) ?? '',
  }
}

export function mapD1ReviewThread(row, comments = []) {
  if (!row) return null
  return {
    _id: row.thread_id,
    id: row.thread_id,
    codebaseId: row.codebase_id,
    changeSetId: row.change_set_id,
    filePath: row.file_path,
    lineNumber: integerValue(row.line_number, null),
    baseRevision: stringOrNull(row.base_revision),
    headRevision: stringOrNull(row.head_revision),
    lineFingerprint: stringOrNull(row.line_fingerprint),
    status: row.status === 'resolved' ? 'resolved' : 'open',
    createdBy: stringOrNull(row.created_by) ?? 'unknown',
    updatedBy: stringOrNull(row.updated_by),
    createdAt: stringOrNull(row.created_at) ?? '',
    updatedAt: stringOrNull(row.updated_at) ?? '',
    resolvedAt: stringOrNull(row.resolved_at),
    comments,
  }
}

export function mapD1ReviewThreadComment(row) {
  if (!row) return null
  return {
    _id: row.comment_id,
    id: row.comment_id,
    threadId: row.thread_id,
    body: stringOrNull(row.body) ?? '',
    createdBy: stringOrNull(row.created_by) ?? 'unknown',
    updatedBy: stringOrNull(row.updated_by),
    createdAt: stringOrNull(row.created_at) ?? '',
    updatedAt: stringOrNull(row.updated_at) ?? '',
  }
}

export function mapD1ReviewDecision(row) {
  if (!row) return null
  return {
    _id: row.decision_id,
    id: row.decision_id,
    codebaseId: row.codebase_id,
    changeSetId: row.change_set_id,
    decision: reviewDecision(row.decision),
    summary: stringOrNull(row.summary),
    createdBy: stringOrNull(row.created_by) ?? 'unknown',
    createdAt: stringOrNull(row.created_at) ?? '',
  }
}

export function mapD1Notification(row) {
  if (!row) return null
  return {
    _id: row.notification_id,
    id: row.notification_id,
    codebaseId: row.codebase_id,
    recipientUserId: stringOrNull(row.recipient_user_id),
    kind: notificationKind(row.kind),
    title: stringOrNull(row.title) ?? 'Notification',
    body: stringOrNull(row.body) ?? '',
    href: stringOrNull(row.href),
    readAt: stringOrNull(row.read_at),
    createdAt: stringOrNull(row.created_at) ?? '',
  }
}

export function mapD1Project(row, items = []) {
  if (!row) return null
  return {
    _id: row.project_id,
    id: row.project_id,
    codebaseId: row.codebase_id,
    number: integerValue(row.number, 0),
    name: stringOrNull(row.name) ?? 'Untitled project',
    description: stringOrNull(row.description),
    status: projectStatus(row.status),
    columns: normalizeProjectColumns(parseJson(row.columns_json, [])),
    items,
    createdBy: stringOrNull(row.created_by) ?? 'unknown',
    updatedBy: stringOrNull(row.updated_by),
    createdAt: stringOrNull(row.created_at) ?? '',
    updatedAt: stringOrNull(row.updated_at) ?? '',
    archivedAt: stringOrNull(row.archived_at),
  }
}

export function mapD1ProjectItem(row) {
  if (!row) return null
  const item = parseJson(row.item_json, {})
  return {
    _id: row.project_item_id,
    id: row.project_item_id,
    codebaseId: row.codebase_id,
    projectId: row.project_id,
    item: typeof item === 'object' && item !== null && !Array.isArray(item) ? item : {},
    columnId: row.column_id,
    position: typeof row.position === 'number' && Number.isFinite(row.position) ? row.position : 0,
    createdBy: stringOrNull(row.created_by) ?? 'unknown',
    updatedBy: stringOrNull(row.updated_by),
    createdAt: stringOrNull(row.created_at) ?? '',
    updatedAt: stringOrNull(row.updated_at) ?? '',
  }
}

export function issuePriorityOrNull(value) {
  return value === 'low' || value === 'medium' || value === 'high' ? value : null
}

export function issueStatus(value) {
  if (value === 'closed' || value === 'open') return value
  throw new Error('Issue status must be open or closed.')
}

export function discussionCategory(value) {
  if (value === 'ideas' || value === 'q-and-a' || value === 'announcements') return value
  return 'general'
}

export function discussionStatus(value) {
  if (value === 'answered' || value === 'locked' || value === 'closed') return value
  return 'open'
}

export function releaseStatus(value) {
  if (value === 'published' || value === 'archived') return value
  return 'draft'
}

export function releaseAssetKind(value) {
  if (value === 'archive' || value === 'binary' || value === 'source' || value === 'checksum' || value === 'installer') {
    return value
  }
  return 'other'
}

export function reviewDecision(value) {
  if (value === 'approved' || value === 'changes-requested' || value === 'commented') return value
  throw new Error('Review decision must be approved, changes-requested, or commented.')
}

export function notificationKind(value) {
  const text = stringOrNull(value)
  if (!text) throw new Error('Notification kind is required.')
  if (!/^[a-z0-9_.:-]{3,80}$/.test(text)) {
    throw new Error('Notification kind may only contain letters, numbers, dots, underscores, colons, and dashes.')
  }
  return text
}

export function reviewDecisionTitle(decision) {
  if (decision === 'approved') return 'Change set approved'
  if (decision === 'changes-requested') return 'Changes requested'
  return 'Review comment recorded'
}

export function reviewDecisionBody(decision, reviewer, summary) {
  const note = stringOrNull(summary)
  const base =
    decision === 'approved'
      ? `${reviewer} approved the change set.`
      : decision === 'changes-requested'
        ? `${reviewer} requested changes.`
        : `${reviewer} recorded a review comment.`
  return note ? `${base} ${note}` : base
}

export function reviewHref(codebaseId, changeSetId) {
  const params = new URLSearchParams()
  const normalizedChangeSetId = stringOrNull(changeSetId)
  if (normalizedChangeSetId) params.set('changeSetId', normalizedChangeSetId)
  const query = params.toString()
  return `/codebases/${encodeURIComponent(codebaseId)}/review${query ? `?${query}` : ''}`
}

export function workItemHref(codebaseId, kind, itemId) {
  return `/codebases/${encodeURIComponent(codebaseId)}/work-items/${encodeURIComponent(kind)}/${encodeURIComponent(itemId)}`
}

export function projectStatus(value) {
  return value === 'archived' ? 'archived' : 'active'
}

export function normalizeProjectColumns(value) {
  const source = Array.isArray(value) && value.length > 0
    ? value
    : [
        { id: 'todo', name: 'Todo' },
        { id: 'in-progress', name: 'In progress' },
        { id: 'done', name: 'Done' },
      ]
  const columns = []
  const seen = new Set()
  for (const column of source) {
    const id = stringOrNull(column?.id)
    const name = stringOrNull(column?.name)
    if (!id || !name || seen.has(id)) continue
    if (!/^[a-z0-9](?:[a-z0-9_.:-]{0,62}[a-z0-9])?$/.test(id)) continue
    columns.push({ id, name })
    seen.add(id)
  }
  if (columns.length === 0) return normalizeProjectColumns(null)
  return columns.slice(0, 12)
}

export function normalizeProjectColumnId(value, columns) {
  const id = stringOrNull(value) ?? columns[0]?.id
  if (!id || !columns.some((column) => column.id === id)) {
    throw new Error('Project column was not found.')
  }
  return id
}

export function normalizeProjectPosition(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function projectItemType(value) {
  if (value === 'issue' || value === 'discussion' || value === 'release' || value === 'note') return value
  throw new Error('Project item type must be issue, discussion, release, or note.')
}

export function normalizeReleaseTarget(value) {
  const target = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const type = target.type === 'snapshot' || target.type === 'change-set' || target.type === 'git'
    ? target.type
    : 'main'
  return {
    type,
    id: stringOrNull(target.id) ?? 'main',
    revision: integerOrNull(target.revision),
  }
}

export function collaborationScope(value) {
  if (value === 'issue' || value === 'project' || value === 'discussion' || value === 'release') return value
  throw new Error('Unknown collaboration counter scope.')
}

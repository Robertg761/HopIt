import { integerValue, stringOrNull } from './base.js'

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


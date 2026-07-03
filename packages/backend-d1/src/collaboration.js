import { randomBytes, randomUUID } from 'node:crypto'
import { privacyZoneForPath, privacyZoneIdForPath, scopeForPath } from '@hopit/core/privacy-zone'
import { defineBackendMethods } from './method-support.js'
import { d1CloudServiceType, d1AuthorizationToken, schemaCacheKey, usesCloudflareD1Api, usesScopedD1SessionAuth } from './config.js'
import { d1SchemaStatements } from './schema.js'
import { summarizeAccessContext, normalizeEmail, backendErrorMessage, normalizeFutureTimestamp, normalizePositiveInteger, nullablePositiveInteger, nullableNonNegativeInteger, actorAuditId, requireTextValue, uniqueStrings, parseStringArray, normalizeRole, graphMemberCount, countPathScopes, assertSafeGraphPath, hashText, byteLength, parseJson, stringifyJson, stringOrNull, integerOrNull, integerValue, boundedLimit, requireAuthenticatedActor, requireVerifiedEmailActor, requireOwnerClaimActor, isBootstrapOwnerMember, claimedOwnerValue, graphFromRows, codebaseRowToRecord, codebaseRecordFromGraph, fileRowToEntry, normalizeGraph, normalizeFileEntry, normalizeVisibilityContract, normalizeOptionalVisibility, normalizeVisibilityValue, summarizeCodebaseHead, summarizeCodebaseRemoteUpdate, buildStatus, buildSyncHealth, buildRefreshHealth, mapD1AgentEvent, latestEventOf, applyJournalEntryToCloud, hasCapability, visibilityContextForGraph, filterVisibleGraphForRequester, filterVisibleGraphForAccess, canRequesterSeePath, canRead, canWrite, permissionsForRole, accessContextForCodebaseHead, memberSelectSql, mapD1Member, mapD1Invitation, invitationRole, invitationStatusOrNull, isInvitationExpired, invitationStatusForRead, hashInvitationToken, createAgentSessionId, createAgentSessionToken, hashAgentSessionToken, normalizeAgentSessionId, assertReusableAgentSession, normalizeAgentSessionCapabilities, agentSessionStatusOrNull, agentSessionHasCapability, codebaseCapabilityForAgentCapability, agentCapabilityForCodebaseCapability, isExpiredTimestamp, summarizeAgentSession, normalizeKeyEntityId, assertDevicePublicKeyDescriptor, looksLikePem, assertSameDevicePublicKeys, assertSameCodebaseKeyring, wrappedKeyType, wrappedKeyRecipientType, capabilityForWrappedKey, isPrivateZoneId, assertWrappedKeyEnvelope, assertSameWrappedKey, effectiveWrappedKeyStatus, canActorReadWrappedKey, createWrappedKeyId, summarizeDeviceKey, summarizeUserKeyring, summarizeCodebaseKeyring, summarizeWrappedKey, deviceKeyStatusOrNull, keyRotationState, mapD1Issue, mapD1IssueComment, mapD1Discussion, mapD1DiscussionComment, mapD1Release, mapD1ReleaseAsset, mapD1ReviewThread, mapD1ReviewThreadComment, mapD1ReviewDecision, mapD1Notification, mapD1Project, mapD1ProjectItem, issuePriorityOrNull, issueStatus, discussionCategory, discussionStatus, releaseStatus, releaseAssetKind, reviewDecision, notificationKind, reviewDecisionTitle, reviewDecisionBody, reviewHref, workItemHref, projectStatus, normalizeProjectColumns, normalizeProjectColumnId, normalizeProjectPosition, projectItemType, normalizeReleaseTarget, collaborationScope, actionCommandForKind, summarizeActionJob, actionSummary, capOutput } from './helpers/index.js'

/** @typedef {import('@hopit/core').CloudGraph} CloudGraph */
/** @typedef {import('@hopit/core').AgentSession} AgentSession */

export function attachCollaborationMethods(Backend) {
  defineBackendMethods(Backend, {
  async listWorkItems({ codebaseId, actor = {} }) {
    await this.requireGraphCapability(codebaseId, actor, 'read')
    const [issues, issueComments, discussions, discussionComments, releases, releaseAssets, projects, projectItems] = await Promise.all([
      this.query(`select * from issues where codebase_id = ? order by created_at desc, number desc`, [codebaseId]),
      this.query(`select * from issue_comments where codebase_id = ? order by created_at asc`, [codebaseId]),
      this.query(`select * from discussions where codebase_id = ? order by created_at desc, number desc`, [codebaseId]),
      this.query(`select * from discussion_comments where codebase_id = ? order by created_at asc`, [codebaseId]),
      this.query(`select * from releases where codebase_id = ? order by created_at desc, number desc`, [codebaseId]),
      this.query(`select * from release_assets where codebase_id = ? order by created_at asc`, [codebaseId]),
      this.query(`select * from projects where codebase_id = ? order by created_at desc, number desc`, [codebaseId]),
      this.query(`select * from project_items where codebase_id = ? order by project_id asc, position asc, created_at asc`, [codebaseId]),
    ])
    const commentsByIssueId = new Map()
    for (const comment of issueComments) {
      const list = commentsByIssueId.get(comment.issue_id) ?? []
      list.push(mapD1IssueComment(comment))
      commentsByIssueId.set(comment.issue_id, list)
    }
    const commentsByDiscussionId = new Map()
    for (const comment of discussionComments) {
      const list = commentsByDiscussionId.get(comment.discussion_id) ?? []
      list.push(mapD1DiscussionComment(comment))
      commentsByDiscussionId.set(comment.discussion_id, list)
    }
    const assetsByReleaseId = new Map()
    for (const asset of releaseAssets) {
      const list = assetsByReleaseId.get(asset.release_id) ?? []
      list.push(mapD1ReleaseAsset(asset))
      assetsByReleaseId.set(asset.release_id, list)
    }
    const itemsByProjectId = new Map()
    for (const item of projectItems) {
      const list = itemsByProjectId.get(item.project_id) ?? []
      list.push(mapD1ProjectItem(item))
      itemsByProjectId.set(item.project_id, list)
    }
    return {
      issues: issues.map((issue) => mapD1Issue(issue, commentsByIssueId.get(issue.issue_id) ?? [])),
      discussions: discussions.map((discussion) => mapD1Discussion(discussion, commentsByDiscussionId.get(discussion.discussion_id) ?? [])),
      releases: releases.map((release) => mapD1Release(release, assetsByReleaseId.get(release.release_id) ?? [])),
      projects: projects.map((project) => mapD1Project(project, itemsByProjectId.get(project.project_id) ?? [])),
    }
  },

  async createWorkItem(input) {
    const actor = requireAuthenticatedActor(input.actor, 'Creating collaboration items requires product auth.')
    if (input.type === 'issue') return this.createIssue({ ...input, actor })
    if (input.type === 'discussion') return this.createDiscussion({ ...input, actor })
    if (input.type === 'release') return this.createRelease({ ...input, actor })
    if (input.type === 'releaseAsset') return this.createReleaseAsset({ ...input, actor })
    if (input.type === 'project') return this.createProject({ ...input, actor })
    if (input.type === 'projectItem') return this.addProjectItem({ ...input, actor })
    if (input.type === 'issueComment') return this.createIssueComment({ ...input, actor })
    if (input.type === 'discussionComment') return this.createDiscussionComment({ ...input, actor })
    throw new Error('Expected type to be issue, discussion, release, releaseAsset, project, projectItem, issueComment, or discussionComment.')
  },

  async updateWorkItem(input) {
    const actor = requireAuthenticatedActor(input.actor, 'Updating collaboration items requires product auth.')
    if (input.action === 'setIssueStatus') return this.setIssueStatus({ ...input, actor })
    if (input.action === 'setDiscussionStatus') return this.setDiscussionStatus({ ...input, actor })
    if (input.action === 'publishRelease') return this.publishRelease({ ...input, actor })
    if (input.action === 'archiveProject') return this.archiveProject({ ...input, actor })
    if (input.action === 'moveProjectItem') return this.moveProjectItem({ ...input, actor })
    throw new Error('Unknown collaboration update action.')
  },

  async createIssue({ codebaseId, title, body, priority, labels, assigneeIds, linkedChangeSetId, linkedReleaseId, createdBy, actor }) {
    await this.requireGraphCapability(codebaseId, actor, 'write')
    const now = new Date().toISOString()
    const number = await this.allocateCollaborationNumber(codebaseId, 'issue', now)
    const issueId = `iss_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    await this.query(
      `insert into issues (
        issue_id, codebase_id, number, title, body, status, priority, labels_json, assignee_ids_json,
        linked_change_set_id, linked_release_id, created_by, created_at, updated_at
      ) values (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        issueId,
        codebaseId,
        number,
        requireTextValue(title, 'Issue title'),
        stringOrNull(body),
        issuePriorityOrNull(priority),
        stringifyJson(uniqueStrings(labels)),
        stringifyJson(uniqueStrings(assigneeIds)),
        stringOrNull(linkedChangeSetId),
        stringOrNull(linkedReleaseId),
        actorAuditId(actor, createdBy, 'Issue creator'),
        now,
        now,
      ],
    )
    return mapD1Issue(await this.first(`select * from issues where issue_id = ?`, [issueId]))
  },

  async setIssueStatus({ issueId, status, updatedBy, actor }) {
    const issue = await this.first(`select * from issues where issue_id = ? limit 1`, [issueId])
    if (!issue) throw new Error('Issue not found.')
    await this.requireGraphCapability(issue.codebase_id, actor, 'write')
    const now = new Date().toISOString()
    const nextStatus = issueStatus(status)
    await this.query(
      `update issues set status = ?, updated_by = ?, updated_at = ?, closed_at = ? where issue_id = ?`,
      [nextStatus, actorAuditId(actor, updatedBy, 'Issue updater'), now, nextStatus === 'closed' ? now : null, issueId],
    )
    return mapD1Issue(await this.first(`select * from issues where issue_id = ?`, [issueId]))
  },

  async createIssueComment({ issueId, body, createdBy, actor }) {
    const issue = await this.first(`select * from issues where issue_id = ? limit 1`, [issueId])
    if (!issue) throw new Error('Issue not found.')
    await this.requireGraphCapability(issue.codebase_id, actor, 'write')
    const now = new Date().toISOString()
    const commentId = `icom_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    const author = actorAuditId(actor, createdBy, 'Issue comment creator')
    await this.query(
      `insert into issue_comments (
        comment_id, codebase_id, issue_id, body, created_by, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?)`,
      [commentId, issue.codebase_id, issueId, requireTextValue(body, 'Issue comment body'), author, now, now],
    )
    await this.query(
      `update issues set updated_by = ?, updated_at = ? where issue_id = ?`,
      [author, now, issueId],
    )
    return mapD1IssueComment(await this.first(`select * from issue_comments where comment_id = ?`, [commentId]))
  },

  async createDiscussion({ codebaseId, title, body, category, labels, linkedIssueIds, linkedChangeSetId, createdBy, actor }) {
    await this.requireGraphCapability(codebaseId, actor, 'write')
    const now = new Date().toISOString()
    const number = await this.allocateCollaborationNumber(codebaseId, 'discussion', now)
    const discussionId = `dis_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    await this.query(
      `insert into discussions (
        discussion_id, codebase_id, number, title, body, category, status, labels_json,
        linked_issue_ids_json, linked_change_set_id, created_by, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
      [
        discussionId,
        codebaseId,
        number,
        requireTextValue(title, 'Discussion title'),
        requireTextValue(body, 'Discussion body'),
        discussionCategory(category),
        stringifyJson(uniqueStrings(labels)),
        stringifyJson(uniqueStrings(linkedIssueIds)),
        stringOrNull(linkedChangeSetId),
        actorAuditId(actor, createdBy, 'Discussion creator'),
        now,
        now,
      ],
    )
    return mapD1Discussion(await this.first(`select * from discussions where discussion_id = ?`, [discussionId]))
  },

  async setDiscussionStatus({ discussionId, status, updatedBy, actor }) {
    const discussion = await this.first(`select * from discussions where discussion_id = ? limit 1`, [discussionId])
    if (!discussion) throw new Error('Discussion not found.')
    await this.requireGraphCapability(discussion.codebase_id, actor, 'write')
    const now = new Date().toISOString()
    const nextStatus = discussionStatus(status)
    await this.query(
      `update discussions set status = ?, updated_by = ?, updated_at = ?, closed_at = ? where discussion_id = ?`,
      [nextStatus, actorAuditId(actor, updatedBy, 'Discussion updater'), now, nextStatus === 'closed' ? now : null, discussionId],
    )
    return mapD1Discussion(await this.first(`select * from discussions where discussion_id = ?`, [discussionId]))
  },

  async createDiscussionComment({ discussionId, body, createdBy, actor }) {
    const discussion = await this.first(`select * from discussions where discussion_id = ? limit 1`, [discussionId])
    if (!discussion) throw new Error('Discussion not found.')
    if (discussion.status === 'locked') throw new Error('Locked discussions cannot accept new comments.')
    await this.requireGraphCapability(discussion.codebase_id, actor, 'write')
    const now = new Date().toISOString()
    const commentId = `dcom_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    const author = actorAuditId(actor, createdBy, 'Discussion comment creator')
    await this.query(
      `insert into discussion_comments (
        comment_id, codebase_id, discussion_id, body, created_by, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?)`,
      [commentId, discussion.codebase_id, discussionId, requireTextValue(body, 'Discussion comment body'), author, now, now],
    )
    await this.query(
      `update discussions set updated_by = ?, updated_at = ? where discussion_id = ?`,
      [author, now, discussionId],
    )
    return mapD1DiscussionComment(await this.first(`select * from discussion_comments where comment_id = ?`, [commentId]))
  },

  async createRelease({ codebaseId, version, title, notes, status, target, createdBy, actor }) {
    await this.requireGraphCapability(codebaseId, actor, 'release')
    const normalizedVersion = requireTextValue(version, 'Release version')
    const existing = await this.first(
      `select release_id from releases where codebase_id = ? and version = ? limit 1`,
      [codebaseId, normalizedVersion],
    )
    if (existing) throw new Error(`Release ${normalizedVersion} already exists for ${codebaseId}.`)
    const now = new Date().toISOString()
    const nextStatus = releaseStatus(status)
    const number = await this.allocateCollaborationNumber(codebaseId, 'release', now)
    const releaseId = `rel_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    await this.query(
      `insert into releases (
        release_id, codebase_id, number, version, title, notes, status, target_json,
        created_by, created_at, updated_at, published_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        releaseId,
        codebaseId,
        number,
        normalizedVersion,
        requireTextValue(title, 'Release title'),
        requireTextValue(notes, 'Release notes'),
        nextStatus,
        stringifyJson(normalizeReleaseTarget(target)),
        actorAuditId(actor, createdBy, 'Release creator'),
        now,
        now,
        nextStatus === 'published' ? now : null,
      ],
    )
    return mapD1Release(await this.first(`select * from releases where release_id = ?`, [releaseId]), [])
  },

  async publishRelease({ releaseId, updatedBy, actor }) {
    const release = await this.first(`select * from releases where release_id = ? limit 1`, [releaseId])
    if (!release) throw new Error('Release not found.')
    await this.requireGraphCapability(release.codebase_id, actor, 'release')
    const now = new Date().toISOString()
    await this.query(
      `update releases set status = 'published', updated_by = ?, updated_at = ?, published_at = ? where release_id = ?`,
      [actorAuditId(actor, updatedBy, 'Release publisher'), now, now, releaseId],
    )
    const assets = await this.query(`select * from release_assets where release_id = ? order by created_at asc`, [releaseId])
    return mapD1Release(await this.first(`select * from releases where release_id = ?`, [releaseId]), assets.map(mapD1ReleaseAsset))
  },

  async createReleaseAsset({ codebaseId, releaseId, name, kind, url, size, checksum, createdBy, actor }) {
    const release = codebaseId
      ? await this.first(`select * from releases where codebase_id = ? and release_id = ? limit 1`, [codebaseId, releaseId])
      : await this.first(`select * from releases where release_id = ? limit 1`, [releaseId])
    if (!release) throw new Error('Release not found.')
    if (codebaseId && release.codebase_id !== codebaseId) throw new Error('Release does not belong to the selected codebase.')
    await this.requireGraphCapability(release.codebase_id, actor, 'release')
    const now = new Date().toISOString()
    const assetId = `asset_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    await this.query(
      `insert into release_assets (
        asset_id, codebase_id, release_id, name, kind, url, size, checksum, created_by, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        assetId,
        release.codebase_id,
        releaseId,
        requireTextValue(name, 'Release asset name'),
        releaseAssetKind(kind),
        stringOrNull(url),
        nullableNonNegativeInteger(size, 'Release asset size'),
        stringOrNull(checksum),
        actorAuditId(actor, createdBy, 'Release asset creator'),
        now,
      ],
    )
    await this.query(
      `update releases set updated_by = ?, updated_at = ? where codebase_id = ? and release_id = ?`,
      [actorAuditId(actor, createdBy, 'Release asset updater'), now, release.codebase_id, releaseId],
    )
    await this.createNotification({
      codebaseId: release.codebase_id,
      kind: 'release.asset_attached',
      title: 'Release asset attached',
      body: `${requireTextValue(name, 'Release asset name')} was attached to ${release.version}.`,
      href: workItemHref(release.codebase_id, 'releases', releaseId),
      createdAt: now,
    })
    return mapD1ReleaseAsset(await this.first(`select * from release_assets where codebase_id = ? and asset_id = ?`, [release.codebase_id, assetId]))
  },

  async createProject({ codebaseId, name, description, columns, createdBy, actor }) {
    await this.requireGraphCapability(codebaseId, actor, 'write')
    const now = new Date().toISOString()
    const number = await this.allocateCollaborationNumber(codebaseId, 'project', now)
    const projectId = `prj_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    const normalizedColumns = normalizeProjectColumns(columns)
    await this.query(
      `insert into projects (
        project_id, codebase_id, number, name, description, status, columns_json,
        created_by, created_at, updated_at
      ) values (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      [
        projectId,
        codebaseId,
        number,
        requireTextValue(name, 'Project name'),
        stringOrNull(description),
        stringifyJson(normalizedColumns),
        actorAuditId(actor, createdBy, 'Project creator'),
        now,
        now,
      ],
    )
    return mapD1Project(await this.first(`select * from projects where project_id = ?`, [projectId]), [])
  },

  async archiveProject({ projectId, updatedBy, actor }) {
    const project = await this.first(`select * from projects where project_id = ? limit 1`, [projectId])
    if (!project) throw new Error('Project not found.')
    await this.requireGraphCapability(project.codebase_id, actor, 'write')
    const now = new Date().toISOString()
    await this.query(
      `update projects set status = 'archived', updated_by = ?, updated_at = ?, archived_at = ? where project_id = ?`,
      [actorAuditId(actor, updatedBy, 'Project archiver'), now, now, projectId],
    )
    const items = await this.query(`select * from project_items where project_id = ? order by position asc, created_at asc`, [projectId])
    return mapD1Project(await this.first(`select * from projects where project_id = ?`, [projectId]), items.map(mapD1ProjectItem))
  },

  async addProjectItem({ projectId, item, columnId, position, createdBy, actor }) {
    const project = await this.first(`select * from projects where project_id = ? limit 1`, [projectId])
    if (!project) throw new Error('Project not found.')
    if (project.status !== 'active') throw new Error('Archived projects cannot accept new items.')
    await this.requireGraphCapability(project.codebase_id, actor, 'write')
    const columns = normalizeProjectColumns(parseJson(project.columns_json, []))
    const targetColumnId = normalizeProjectColumnId(columnId, columns)
    const normalizedItem = await this.normalizeProjectItem(project.codebase_id, item)
    const nextPosition = normalizeProjectPosition(position) ?? await this.nextProjectItemPosition(projectId, targetColumnId)
    const now = new Date().toISOString()
    const projectItemId = `pitem_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    await this.query(
      `insert into project_items (
        project_item_id, codebase_id, project_id, item_json, column_id, position,
        created_by, updated_by, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectItemId,
        project.codebase_id,
        projectId,
        stringifyJson(normalizedItem),
        targetColumnId,
        nextPosition,
        actorAuditId(actor, createdBy, 'Project item creator'),
        actorAuditId(actor, createdBy, 'Project item updater'),
        now,
        now,
      ],
    )
    return mapD1ProjectItem(await this.first(`select * from project_items where project_item_id = ?`, [projectItemId]))
  },

  async moveProjectItem({ projectItemId, columnId, position, updatedBy, actor }) {
    const existing = await this.first(`select * from project_items where project_item_id = ? limit 1`, [projectItemId])
    if (!existing) throw new Error('Project item not found.')
    const project = await this.first(`select * from projects where project_id = ? limit 1`, [existing.project_id])
    if (!project) throw new Error('Project not found.')
    if (project.status !== 'active') throw new Error('Archived project items cannot be moved.')
    await this.requireGraphCapability(project.codebase_id, actor, 'write')
    const columns = normalizeProjectColumns(parseJson(project.columns_json, []))
    const targetColumnId = normalizeProjectColumnId(columnId ?? existing.column_id, columns)
    const nextPosition = normalizeProjectPosition(position) ?? await this.nextProjectItemPosition(project.project_id, targetColumnId)
    const now = new Date().toISOString()
    await this.query(
      `update project_items set column_id = ?, position = ?, updated_by = ?, updated_at = ? where project_item_id = ?`,
      [targetColumnId, nextPosition, actorAuditId(actor, updatedBy, 'Project item updater'), now, projectItemId],
    )
    return mapD1ProjectItem(await this.first(`select * from project_items where project_item_id = ?`, [projectItemId]))
  },

  async nextProjectItemPosition(projectId, columnId) {
    const row = await this.first(
      `select max(position) as max_position from project_items where project_id = ? and column_id = ?`,
      [projectId, columnId],
    )
    const current = typeof row?.max_position === 'number' && Number.isFinite(row.max_position) ? row.max_position : 0
    return current + 1
  },

  async normalizeProjectItem(codebaseId, value) {
    const item = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
    const type = projectItemType(item.type)
    if (type === 'note') {
      return {
        type,
        title: requireTextValue(item.title, 'Project note title'),
        body: stringOrNull(item.body),
      }
    }

    const id = requireTextValue(item.id, 'Project item id')
    if (type === 'issue') {
      const row = await this.first(`select issue_id, title from issues where codebase_id = ? and issue_id = ? limit 1`, [codebaseId, id])
      if (!row) throw new Error(`Issue ${id} was not found in ${codebaseId}.`)
      return { type, id, title: row.title }
    }
    if (type === 'discussion') {
      const row = await this.first(`select discussion_id, title from discussions where codebase_id = ? and discussion_id = ? limit 1`, [codebaseId, id])
      if (!row) throw new Error(`Discussion ${id} was not found in ${codebaseId}.`)
      return { type, id, title: row.title }
    }
    const row = await this.first(`select release_id, title, version from releases where codebase_id = ? and release_id = ? limit 1`, [codebaseId, id])
    if (!row) throw new Error(`Release ${id} was not found in ${codebaseId}.`)
    return { type, id, title: row.title, version: row.version }
  },

  async listReviewThreads({ codebaseId, changeSetId = null, actor = {} }) {
    await this.requireGraphCapability(codebaseId, actor, 'read')
    const normalizedChangeSetId = stringOrNull(changeSetId)
    const threads = normalizedChangeSetId
      ? await this.query(
          `select * from review_threads where codebase_id = ? and change_set_id = ? order by updated_at desc, created_at desc`,
          [codebaseId, normalizedChangeSetId],
        )
      : await this.query(
          `select * from review_threads where codebase_id = ? order by updated_at desc, created_at desc limit 100`,
          [codebaseId],
        )
    if (threads.length === 0) return []
    const threadIds = threads.map((thread) => thread.thread_id)
    const comments = await this.query(
      `select * from review_thread_comments where codebase_id = ? and thread_id in (${threadIds.map(() => '?').join(', ')}) order by created_at asc`,
      [codebaseId, ...threadIds],
    )
    const commentsByThreadId = new Map()
    for (const comment of comments) {
      const list = commentsByThreadId.get(comment.thread_id) ?? []
      list.push(mapD1ReviewThreadComment(comment))
      commentsByThreadId.set(comment.thread_id, list)
    }
    return threads.map((thread) => mapD1ReviewThread(thread, commentsByThreadId.get(thread.thread_id) ?? []))
  },

  async createReviewThread({
    codebaseId,
    changeSetId,
    filePath,
    lineNumber,
    baseRevision,
    headRevision,
    lineFingerprint,
    body,
    createdBy,
    actor,
  }) {
    await this.requireGraphCapability(codebaseId, actor, 'write')
    const normalizedPath = requireTextValue(filePath, 'Review file path')
    const file = await this.first(`select path from files where codebase_id = ? and path = ? limit 1`, [codebaseId, normalizedPath])
    if (!file) throw new Error(`Review file ${normalizedPath} was not found in ${codebaseId}.`)
    const now = new Date().toISOString()
    const threadId = `rthr_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    const commentId = `rcom_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    const author = actorAuditId(actor, createdBy, 'Review thread creator')
    await this.query(
      `insert into review_threads (
        thread_id, codebase_id, change_set_id, file_path, line_number, base_revision,
        head_revision, line_fingerprint, status, created_by, updated_by, created_at, updated_at, resolved_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, null)`,
      [
        threadId,
        codebaseId,
        requireTextValue(changeSetId, 'Review change set id'),
        normalizedPath,
        nullablePositiveInteger(lineNumber, 'Review line number'),
        stringOrNull(baseRevision),
        stringOrNull(headRevision),
        stringOrNull(lineFingerprint),
        author,
        author,
        now,
        now,
      ],
    )
    await this.query(
      `insert into review_thread_comments (
        comment_id, codebase_id, thread_id, body, created_by, updated_by, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [commentId, codebaseId, threadId, requireTextValue(body, 'Review comment body'), author, author, now, now],
    )
    await this.appendEvent({
      codebaseId,
      event: 'review.thread_opened',
      detail: { threadId, changeSetId, path: normalizedPath, lineNumber: nullablePositiveInteger(lineNumber, 'Review line number') },
      source: 'browser',
    })
    await this.createNotification({
      codebaseId,
      kind: 'review.thread_opened',
      title: 'Review thread opened',
      body: `${author} opened a review thread on ${normalizedPath}.`,
      href: reviewHref(codebaseId, changeSetId),
      createdAt: now,
    })
    return mapD1ReviewThread(
      await this.first(`select * from review_threads where codebase_id = ? and thread_id = ?`, [codebaseId, threadId]),
      [mapD1ReviewThreadComment(await this.first(`select * from review_thread_comments where codebase_id = ? and comment_id = ?`, [codebaseId, commentId]))],
    )
  },

  async createReviewThreadComment({ codebaseId, threadId, body, createdBy, actor }) {
    const normalizedCodebaseId = stringOrNull(codebaseId)
    const thread = normalizedCodebaseId
      ? await this.first(`select * from review_threads where codebase_id = ? and thread_id = ? limit 1`, [normalizedCodebaseId, threadId])
      : await this.first(`select * from review_threads where thread_id = ? limit 1`, [threadId])
    if (!thread) throw new Error('Review thread not found.')
    await this.requireGraphCapability(thread.codebase_id, actor, 'write')
    if (thread.status !== 'open') throw new Error('Resolved review threads cannot accept new comments.')
    const now = new Date().toISOString()
    const commentId = `rcom_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    const author = actorAuditId(actor, createdBy, 'Review comment creator')
    await this.query(
      `insert into review_thread_comments (
        comment_id, codebase_id, thread_id, body, created_by, updated_by, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [commentId, thread.codebase_id, threadId, requireTextValue(body, 'Review comment body'), author, author, now, now],
    )
    await this.query(
      `update review_threads set updated_by = ?, updated_at = ? where codebase_id = ? and thread_id = ?`,
      [author, now, thread.codebase_id, threadId],
    )
    await this.createNotification({
      codebaseId: thread.codebase_id,
      kind: 'review.comment_added',
      title: 'Review comment added',
      body: `${author} replied to ${thread.file_path}.`,
      href: reviewHref(thread.codebase_id, thread.change_set_id),
      createdAt: now,
    })
    return mapD1ReviewThreadComment(await this.first(`select * from review_thread_comments where codebase_id = ? and comment_id = ?`, [thread.codebase_id, commentId]))
  },

  async resolveReviewThread({ codebaseId, threadId, updatedBy, actor }) {
    const normalizedCodebaseId = stringOrNull(codebaseId)
    const thread = normalizedCodebaseId
      ? await this.first(`select * from review_threads where codebase_id = ? and thread_id = ? limit 1`, [normalizedCodebaseId, threadId])
      : await this.first(`select * from review_threads where thread_id = ? limit 1`, [threadId])
    if (!thread) throw new Error('Review thread not found.')
    await this.requireGraphCapability(thread.codebase_id, actor, 'write')
    const now = new Date().toISOString()
    await this.query(
      `update review_threads set status = 'resolved', updated_by = ?, updated_at = ?, resolved_at = ? where codebase_id = ? and thread_id = ?`,
      [actorAuditId(actor, updatedBy, 'Review thread resolver'), now, now, thread.codebase_id, threadId],
    )
    const resolver = actorAuditId(actor, updatedBy, 'Review thread resolver')
    await this.appendEvent({
      codebaseId: thread.codebase_id,
      event: 'review.thread_resolved',
      detail: { threadId, changeSetId: thread.change_set_id, path: thread.file_path, lineNumber: thread.line_number ?? null },
      source: 'browser',
    })
    await this.createNotification({
      codebaseId: thread.codebase_id,
      kind: 'review.thread_resolved',
      title: 'Review thread resolved',
      body: `${resolver} resolved a review thread on ${thread.file_path}.`,
      href: reviewHref(thread.codebase_id, thread.change_set_id),
      createdAt: now,
    })
    const comments = await this.query(
      `select * from review_thread_comments where codebase_id = ? and thread_id = ? order by created_at asc`,
      [thread.codebase_id, threadId],
    )
    return mapD1ReviewThread(
      await this.first(`select * from review_threads where codebase_id = ? and thread_id = ?`, [thread.codebase_id, threadId]),
      comments.map(mapD1ReviewThreadComment),
    )
  },

  async listReviewDecisions({ codebaseId, changeSetId = null, actor = {} }) {
    await this.requireGraphCapability(codebaseId, actor, 'read')
    const normalizedChangeSetId = stringOrNull(changeSetId)
    const rows = normalizedChangeSetId
      ? await this.query(
          `select * from review_decisions where codebase_id = ? and change_set_id = ? order by created_at desc`,
          [codebaseId, normalizedChangeSetId],
        )
      : await this.query(
          `select * from review_decisions where codebase_id = ? order by created_at desc limit 100`,
          [codebaseId],
        )
    return rows.map(mapD1ReviewDecision).filter(Boolean)
  },

  async createReviewDecision({ codebaseId, changeSetId, decision, summary, createdBy, actor = {} }) {
    await this.requireGraphCapability(codebaseId, actor, 'review')
    const normalizedChangeSetId = requireTextValue(changeSetId, 'Review change set id')
    const nextDecision = reviewDecision(decision)
    const now = new Date().toISOString()
    const decisionId = `rdec_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    const reviewer = actorAuditId(actor, createdBy, 'Review decision creator')
    await this.query(
      `insert into review_decisions (
        decision_id, codebase_id, change_set_id, decision, summary, created_by, created_at
      ) values (?, ?, ?, ?, ?, ?, ?)`,
      [
        decisionId,
        codebaseId,
        normalizedChangeSetId,
        nextDecision,
        stringOrNull(summary),
        reviewer,
        now,
      ],
    )
    await this.appendEvent({
      codebaseId,
      event: 'review.decision_recorded',
      detail: { decisionId, changeSetId: normalizedChangeSetId, decision: nextDecision },
      at: now,
      source: 'browser',
    })
    await this.createNotification({
      codebaseId,
      kind: `review.${nextDecision}`,
      title: reviewDecisionTitle(nextDecision),
      body: reviewDecisionBody(nextDecision, reviewer, summary),
      href: reviewHref(codebaseId, normalizedChangeSetId),
      createdAt: now,
    })
    return mapD1ReviewDecision(await this.first(`select * from review_decisions where codebase_id = ? and decision_id = ?`, [codebaseId, decisionId]))
  },

  async listNotifications({ codebaseId, actor = {}, limit = 20, unreadOnly = false }) {
    await this.requireGraphCapability(codebaseId, actor, 'read')
    const userId = stringOrNull(actor.userId)
    const maxRows = boundedLimit(limit, 50)
    const unreadSql = unreadOnly ? ` and read_at is null` : ''
    const rows = userId
      ? await this.query(
          `select * from notifications
           where codebase_id = ? and (recipient_user_id is null or recipient_user_id = ?)${unreadSql}
           order by created_at desc, notification_id desc limit ?`,
          [codebaseId, userId, maxRows],
        )
      : await this.query(
          `select * from notifications
           where codebase_id = ? and recipient_user_id is null${unreadSql}
           order by created_at desc, notification_id desc limit ?`,
          [codebaseId, maxRows],
        )
    return rows.map(mapD1Notification).filter(Boolean)
  },

  async createNotification({ codebaseId, recipientUserId = null, kind, title, body, href = null, createdAt = new Date().toISOString() }) {
    if (!codebaseId) return null
    await this.ensureSchema()
    const notificationId = `notif_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
    await this.query(
      `insert into notifications (
        notification_id, codebase_id, recipient_user_id, kind, title, body, href, read_at, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, null, ?)`,
      [
        notificationId,
        codebaseId,
        stringOrNull(recipientUserId),
        notificationKind(kind),
        requireTextValue(title, 'Notification title'),
        requireTextValue(body, 'Notification body'),
        stringOrNull(href),
        createdAt,
      ],
    )
    return mapD1Notification(await this.first(`select * from notifications where codebase_id = ? and notification_id = ?`, [codebaseId, notificationId]))
  },

  async markNotificationRead({ codebaseId, notificationId, actor = {} }) {
    await this.requireGraphCapability(codebaseId, actor, 'read')
    const userId = requireTextValue(actor?.userId, 'Notification reader')
    const now = new Date().toISOString()
    await this.query(
      `update notifications
       set read_at = ?
       where codebase_id = ? and notification_id = ? and (recipient_user_id is null or recipient_user_id = ?)`,
      [now, codebaseId, requireTextValue(notificationId, 'Notification id'), userId],
    )
    return mapD1Notification(await this.first(`select * from notifications where codebase_id = ? and notification_id = ?`, [codebaseId, notificationId]))
  },

  async allocateCollaborationNumber(codebaseId, scope, now = new Date().toISOString()) {
    const normalizedScope = collaborationScope(scope)
    const existing = await this.first(
      `select next_number from collaboration_counters where codebase_id = ? and scope = ? limit 1`,
      [codebaseId, normalizedScope],
    )
    if (existing) {
      const nextNumber = integerValue(existing.next_number, 1)
      await this.query(
        `update collaboration_counters set next_number = ?, updated_at = ? where codebase_id = ? and scope = ?`,
        [nextNumber + 1, now, codebaseId, normalizedScope],
      )
      return nextNumber
    }
    await this.query(
      `insert into collaboration_counters (codebase_id, scope, next_number, updated_at) values (?, ?, 2, ?)`,
      [codebaseId, normalizedScope, now],
    )
    return 1
  },
  })
}

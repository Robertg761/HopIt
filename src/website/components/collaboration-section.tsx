'use client'

import * as React from 'react'
import {
  AlertCircle,
  Archive,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleDot,
  Columns3,
  GitPullRequest,
  KanbanSquare,
  Loader2,
  MessageCirclePlus,
  MessageSquareText,
  PackageCheck,
  Plus,
  RefreshCcw,
  Rocket,
  Search,
  Tag,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  createCollaborationItem,
  fetchWorkItems,
  updateCollaborationItem,
  type CollaborationDiscussion,
  type CollaborationIssue,
  type CollaborationProject,
  type CollaborationProjectItem,
  type CollaborationRelease,
  type CollaborationReleaseAsset,
  type WorkItemsResponse,
} from '@/lib/collaboration'
import type { AgentStatusSnapshot } from '@/website/lib/agent-status'
import { cn } from '@/lib/utils'

type CollaborationSectionProps = {
  status: AgentStatusSnapshot
}

type CollaborationTab = 'issues' | 'discussions' | 'projects' | 'releases'

type WorkItemFilter = 'active' | 'all' | 'closed'

type ReleaseAssetDraft = {
  name: string
  kind: CollaborationReleaseAsset['kind']
  url: string
  checksum: string
  size: string
}

type FormState = {
  issueTitle: string
  issueBody: string
  issuePriority: 'low' | 'medium' | 'high'
  issueLabels: string
  discussionTitle: string
  discussionBody: string
  discussionCategory: CollaborationDiscussion['category']
  discussionLabels: string
  releaseVersion: string
  releaseTitle: string
  releaseNotes: string
  projectName: string
  projectDescription: string
  projectItemTitle: string
  projectItemBody: string
}

const initialFormState: FormState = {
  issueTitle: '',
  issueBody: '',
  issuePriority: 'medium',
  issueLabels: '',
  discussionTitle: '',
  discussionBody: '',
  discussionCategory: 'general',
  discussionLabels: '',
  releaseVersion: '',
  releaseTitle: '',
  releaseNotes: '',
  projectName: '',
  projectDescription: '',
  projectItemTitle: '',
  projectItemBody: '',
}

export function CollaborationSection({ status }: CollaborationSectionProps) {
  const [tab, setTab] = React.useState<CollaborationTab>('issues')
  const [query, setQuery] = React.useState('')
  const [itemFilter, setItemFilter] = React.useState<WorkItemFilter>('active')
  const [workItems, setWorkItems] = React.useState<WorkItemsResponse | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [form, setForm] = React.useState<FormState>(initialFormState)
  const [commentDrafts, setCommentDrafts] = React.useState<Record<string, string>>({})
  const [message, setMessage] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState<string | null>(null)

  const codebaseId = status.codebaseId
  const actorId = status.requester.id ?? 'browser-ui'
  const canWrite = hasPermission(status, 'write')
  const canRelease = hasPermission(status, 'release')

  const loadWorkItems = React.useCallback(async () => {
    if (!codebaseId) {
      setWorkItems(null)
      return
    }

    setLoading(true)
    try {
      setWorkItems(await fetchWorkItems(codebaseId))
    } catch (error) {
      setWorkItems({
        ok: false,
        codebaseId,
        capabilities: unavailableCapabilities('Collaboration request failed.'),
        issues: [],
        discussions: [],
        releases: [],
        projects: [],
        error: {
          code: 'work_items_fetch_failed',
          message: error instanceof Error ? error.message : 'Collaboration request failed.',
        },
      })
    } finally {
      setLoading(false)
    }
  }, [codebaseId])

  React.useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadWorkItems()
    }, 0)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [loadWorkItems])

  const issueCreateReason = disabledReason({
    codebaseId,
    roleAllowed: canWrite,
    capability: workItems?.capabilities.createIssue,
    loading,
    roleReason: 'Current role cannot create issues.',
  })
  const discussionCreateReason = disabledReason({
    codebaseId,
    roleAllowed: canWrite,
    capability: workItems?.capabilities.createDiscussion,
    loading,
    roleReason: 'Current role cannot create discussions.',
  })
  const releaseCreateReason = disabledReason({
    codebaseId,
    roleAllowed: canRelease,
    capability: workItems?.capabilities.createRelease,
    loading,
    roleReason: 'Current role cannot draft releases.',
  })
  const projectCreateReason = disabledReason({
    codebaseId,
    roleAllowed: canWrite,
    capability: workItems?.capabilities.createProject,
    loading,
    roleReason: 'Current role cannot create projects.',
  })
  const issueUpdateReason = disabledReason({
    codebaseId,
    roleAllowed: canWrite,
    capability: workItems?.capabilities.updateIssue,
    loading,
    roleReason: 'Current role cannot update issues.',
  })
  const discussionUpdateReason = disabledReason({
    codebaseId,
    roleAllowed: canWrite,
    capability: workItems?.capabilities.updateDiscussion,
    loading,
    roleReason: 'Current role cannot update discussions.',
  })
  const releasePublishReason = disabledReason({
    codebaseId,
    roleAllowed: canRelease,
    capability: workItems?.capabilities.publishRelease,
    loading,
    roleReason: 'Current role cannot publish releases.',
  })
  const releaseAssetCreateReason = disabledReason({
    codebaseId,
    roleAllowed: canRelease,
    capability: workItems?.capabilities.createReleaseAsset,
    loading,
    roleReason: 'Current role cannot attach release assets.',
  })
  const projectUpdateReason = disabledReason({
    codebaseId,
    roleAllowed: canWrite,
    capability: workItems?.capabilities.updateProject,
    loading,
    roleReason: 'Current role cannot update projects.',
  })

  async function createIssue(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!codebaseId || issueCreateReason || !form.issueTitle.trim()) return

    setSubmitting('create-issue')
    setMessage(null)
    const result = await createCollaborationItem({
      type: 'issue',
      codebaseId,
      title: form.issueTitle,
      body: form.issueBody,
      priority: form.issuePriority,
      labels: labelsFromInput(form.issueLabels),
      linkedChangeSetId: status.activeChangeSetId === 'None' ? undefined : status.activeChangeSetId,
      createdBy: actorId,
    })
    setWorkItems(result)
    setMessage(result.ok ? 'Issue created.' : (result.error?.message ?? 'Issue create failed.'))
    if (result.ok) {
      setForm((current) => ({ ...current, issueTitle: '', issueBody: '', issueLabels: '' }))
    }
    setSubmitting(null)
  }

  async function createDiscussion(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!codebaseId || discussionCreateReason || !form.discussionTitle.trim() || !form.discussionBody.trim()) return

    setSubmitting('create-discussion')
    setMessage(null)
    const result = await createCollaborationItem({
      type: 'discussion',
      codebaseId,
      title: form.discussionTitle,
      body: form.discussionBody,
      category: form.discussionCategory,
      labels: labelsFromInput(form.discussionLabels),
      linkedChangeSetId: status.activeChangeSetId === 'None' ? undefined : status.activeChangeSetId,
      createdBy: actorId,
    })
    setWorkItems(result)
    setMessage(result.ok ? 'Discussion created.' : (result.error?.message ?? 'Discussion create failed.'))
    if (result.ok) {
      setForm((current) => ({ ...current, discussionTitle: '', discussionBody: '', discussionLabels: '' }))
    }
    setSubmitting(null)
  }

  async function createRelease(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (
      !codebaseId ||
      releaseCreateReason ||
      !form.releaseVersion.trim() ||
      !form.releaseTitle.trim() ||
      !form.releaseNotes.trim()
    ) {
      return
    }

    setSubmitting('create-release')
    setMessage(null)
    const result = await createCollaborationItem({
      type: 'release',
      codebaseId,
      version: form.releaseVersion,
      title: form.releaseTitle,
      notes: form.releaseNotes,
      status: 'draft',
      target: {
        type: 'main',
        id: status.mainId === 'None' ? 'main' : status.mainId,
        revision: revisionNumber(status.mainRevision),
      },
      createdBy: actorId,
    })
    setWorkItems(result)
    setMessage(result.ok ? 'Release drafted.' : (result.error?.message ?? 'Release create failed.'))
    if (result.ok) {
      setForm((current) => ({ ...current, releaseVersion: '', releaseTitle: '', releaseNotes: '' }))
    }
    setSubmitting(null)
  }

  async function createProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!codebaseId || projectCreateReason || !form.projectName.trim()) return

    setSubmitting('create-project')
    setMessage(null)
    const result = await createCollaborationItem({
      type: 'project',
      codebaseId,
      name: form.projectName,
      description: form.projectDescription,
      createdBy: actorId,
    })
    setWorkItems(result)
    setMessage(result.ok ? 'Project created.' : (result.error?.message ?? 'Project create failed.'))
    if (result.ok) {
      setForm((current) => ({ ...current, projectName: '', projectDescription: '' }))
    }
    setSubmitting(null)
  }

  async function addProjectNote(project: CollaborationProject, columnId: string, title: string, body: string) {
    if (!codebaseId || projectUpdateReason || !title.trim()) return

    setSubmitting(`project-note-${project.id}`)
    setMessage(null)
    const result = await createCollaborationItem({
      type: 'projectItem',
      codebaseId,
      projectId: project.id,
      columnId,
      item: {
        type: 'note',
        title,
        body,
      },
      createdBy: actorId,
    })
    setWorkItems(result)
    setMessage(result.ok ? 'Project card added.' : (result.error?.message ?? 'Project card create failed.'))
    setSubmitting(null)
  }

  async function setIssueStatus(issue: CollaborationIssue, nextStatus: CollaborationIssue['status']) {
    if (!codebaseId || issueUpdateReason) return

    setSubmitting(`issue-${issue.id}`)
    setMessage(null)
    const result = await updateCollaborationItem({
      action: 'setIssueStatus',
      codebaseId,
      issueId: issue.id,
      status: nextStatus,
      updatedBy: actorId,
    })
    setWorkItems(result)
    setMessage(result.ok ? `Issue ${nextStatus}.` : (result.error?.message ?? 'Issue update failed.'))
    setSubmitting(null)
  }

  async function addIssueComment(issue: CollaborationIssue) {
    const body = commentDrafts[issue.id]?.trim()
    if (!codebaseId || issueUpdateReason || !body) return

    setSubmitting(`issue-comment-${issue.id}`)
    setMessage(null)
    const result = await createCollaborationItem({
      type: 'issueComment',
      codebaseId,
      issueId: issue.id,
      body,
      createdBy: actorId,
    })
    setWorkItems(result)
    setMessage(result.ok ? 'Issue comment added.' : (result.error?.message ?? 'Issue comment failed.'))
    if (result.ok) {
      setCommentDrafts((current) => ({ ...current, [issue.id]: '' }))
    }
    setSubmitting(null)
  }

  async function setDiscussionStatus(
    discussion: CollaborationDiscussion,
    nextStatus: CollaborationDiscussion['status'],
  ) {
    if (!codebaseId || discussionUpdateReason) return

    setSubmitting(`discussion-${discussion.id}`)
    setMessage(null)
    const result = await updateCollaborationItem({
      action: 'setDiscussionStatus',
      codebaseId,
      discussionId: discussion.id,
      status: nextStatus,
      updatedBy: actorId,
    })
    setWorkItems(result)
    setMessage(result.ok ? `Discussion ${nextStatus}.` : (result.error?.message ?? 'Discussion update failed.'))
    setSubmitting(null)
  }

  async function addDiscussionComment(discussion: CollaborationDiscussion) {
    const body = commentDrafts[discussion.id]?.trim()
    if (!codebaseId || discussionUpdateReason || !body) return

    setSubmitting(`discussion-comment-${discussion.id}`)
    setMessage(null)
    const result = await createCollaborationItem({
      type: 'discussionComment',
      codebaseId,
      discussionId: discussion.id,
      body,
      createdBy: actorId,
    })
    setWorkItems(result)
    setMessage(result.ok ? 'Discussion comment added.' : (result.error?.message ?? 'Discussion comment failed.'))
    if (result.ok) {
      setCommentDrafts((current) => ({ ...current, [discussion.id]: '' }))
    }
    setSubmitting(null)
  }

  async function publishRelease(release: CollaborationRelease) {
    if (!codebaseId || releasePublishReason) return

    setSubmitting(`release-${release.id}`)
    setMessage(null)
    const result = await updateCollaborationItem({
      action: 'publishRelease',
      codebaseId,
      releaseId: release.id,
      updatedBy: actorId,
    })
    setWorkItems(result)
    setMessage(result.ok ? 'Release published.' : (result.error?.message ?? 'Release publish failed.'))
    setSubmitting(null)
  }

  async function addReleaseAsset(release: CollaborationRelease, draft: ReleaseAssetDraft) {
    if (!codebaseId || releaseAssetCreateReason || !draft.name.trim()) return

    const parsedSize = draft.size.trim() ? Number(draft.size.trim()) : undefined
    if (parsedSize !== undefined && (!Number.isInteger(parsedSize) || parsedSize < 0)) {
      setMessage('Release asset size must be a non-negative integer.')
      return
    }

    setSubmitting(`release-asset-${release.id}`)
    setMessage(null)
    const result = await createCollaborationItem({
      type: 'releaseAsset',
      codebaseId,
      releaseId: release.id,
      name: draft.name,
      kind: draft.kind,
      url: draft.url,
      checksum: draft.checksum,
      size: parsedSize,
      createdBy: actorId,
    })
    setWorkItems(result)
    setMessage(result.ok ? 'Release asset attached.' : (result.error?.message ?? 'Release asset failed.'))
    setSubmitting(null)
  }

  async function moveProjectItem(
    project: CollaborationProject,
    item: CollaborationProjectItem,
    direction: -1 | 1,
  ) {
    if (!codebaseId || projectUpdateReason) return
    const columnIndex = project.columns.findIndex((column) => column.id === item.columnId)
    const nextColumn = project.columns[columnIndex + direction]
    if (!nextColumn) return

    setSubmitting(`project-item-${item.id}`)
    setMessage(null)
    const result = await updateCollaborationItem({
      action: 'moveProjectItem',
      codebaseId,
      projectItemId: item.id,
      columnId: nextColumn.id,
      updatedBy: actorId,
    })
    setWorkItems(result)
    setMessage(result.ok ? 'Project card moved.' : (result.error?.message ?? 'Project card move failed.'))
    setSubmitting(null)
  }

  async function archiveProject(project: CollaborationProject) {
    if (!codebaseId || projectUpdateReason) return

    setSubmitting(`project-${project.id}`)
    setMessage(null)
    const result = await updateCollaborationItem({
      action: 'archiveProject',
      codebaseId,
      projectId: project.id,
      updatedBy: actorId,
    })
    setWorkItems(result)
    setMessage(result.ok ? 'Project archived.' : (result.error?.message ?? 'Project archive failed.'))
    setSubmitting(null)
  }

  const issues = workItems?.issues ?? []
  const discussions = workItems?.discussions ?? []
  const releases = workItems?.releases ?? []
  const projects = workItems?.projects ?? []
  const openIssues = issues.filter((issue) => issue.status === 'open').length
  const activeDiscussions = discussions.filter((discussion) => discussion.status === 'open').length
  const draftReleases = releases.filter((release) => release.status === 'draft').length
  const activeProjects = projects.filter((project) => project.status === 'active').length
  const filteredIssues = React.useMemo(
    () => filterIssues(issues, itemFilter, query),
    [issues, itemFilter, query],
  )
  const filteredDiscussions = React.useMemo(
    () => filterDiscussions(discussions, itemFilter, query),
    [discussions, itemFilter, query],
  )
  const filteredReleases = React.useMemo(
    () => filterReleases(releases, itemFilter, query),
    [releases, itemFilter, query],
  )
  const filteredProjects = React.useMemo(
    () => filterProjects(projects, itemFilter, query),
    [projects, itemFilter, query],
  )
  const filterCounts = workItemFilterCounts(tab, issues, discussions, releases, projects)
  const visibleCount =
    tab === 'issues'
      ? filteredIssues.length
      : tab === 'discussions'
        ? filteredDiscussions.length
        : tab === 'projects'
          ? filteredProjects.length
          : filteredReleases.length
  const totalCount =
    tab === 'issues'
      ? issues.length
      : tab === 'discussions'
        ? discussions.length
        : tab === 'projects'
          ? projects.length
          : releases.length

  return (
    <section className="panel-surface overflow-hidden rounded-xl border border-border shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border/60 p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-grape/10 text-grape">
              <GitPullRequest className="size-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold">Collaboration</h2>
              <p className="truncate text-xs text-muted-foreground">
                {codebaseId ?? 'No codebase'} - issues, discussions, projects, releases
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MetricChip label="Open issues" value={openIssues.toString()} active={openIssues > 0} />
          <MetricChip label="Discussions" value={activeDiscussions.toString()} active={activeDiscussions > 0} />
          <MetricChip label="Projects" value={activeProjects.toString()} active={activeProjects > 0} />
          <MetricChip label="Draft releases" value={draftReleases.toString()} active={draftReleases > 0} />
        </div>
      </div>

      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <TabList
            tab={tab}
            setTab={setTab}
            counts={{
              issues: issues.length,
              discussions: discussions.length,
              projects: projects.length,
              releases: releases.length,
            }}
          />
          <div className="flex items-center gap-2">
            {message ? (
              <span className="line-clamp-1 text-[11px] text-muted-foreground">{message}</span>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={loading || !codebaseId}
              className="h-8 rounded-lg text-xs"
              onClick={() => void loadWorkItems()}
            >
              <RefreshCcw className={cn('size-3.5', loading && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </div>
        <div className="mt-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-card px-3 py-1.5 focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/10 lg:max-w-sm lg:flex-1">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${tab}`}
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between lg:flex-1">
            <WorkItemFilterTabs
              tab={tab}
              filter={itemFilter}
              counts={filterCounts}
              onChange={setItemFilter}
            />
            <span className="text-[11px] text-muted-foreground">
              Showing {visibleCount} of {totalCount}
            </span>
          </div>
        </div>
      </div>

      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(300px,0.6fr)]">
        <div className="min-w-0">
          {loading ? (
            <StateNotice icon={Loader2} title="Loading collaboration objects" detail="Reading cloud work-item functions." spinning />
          ) : workItems?.error ? (
            <StateNotice icon={AlertCircle} title="Collaboration unavailable" detail={workItems.error.message} />
          ) : tab === 'issues' ? (
            <IssuesList
              codebaseId={codebaseId}
              issues={filteredIssues}
              emptyDetail={issues.length === 0 ? 'Create the first codebase issue.' : 'No issues match this filter.'}
              disabledReason={issueUpdateReason}
              submitting={submitting}
              commentDrafts={commentDrafts}
              onCommentDraftChange={(issue, value) => setCommentDrafts((current) => ({ ...current, [issue.id]: value }))}
              onSetStatus={(issue, nextStatus) => void setIssueStatus(issue, nextStatus)}
              onAddComment={(issue) => void addIssueComment(issue)}
            />
          ) : tab === 'discussions' ? (
            <DiscussionsList
              codebaseId={codebaseId}
              discussions={filteredDiscussions}
              emptyDetail={
                discussions.length === 0
                  ? 'Start the first design or coordination thread.'
                  : 'No discussions match this filter.'
              }
              disabledReason={discussionUpdateReason}
              submitting={submitting}
              commentDrafts={commentDrafts}
              onCommentDraftChange={(discussion, value) => setCommentDrafts((current) => ({ ...current, [discussion.id]: value }))}
              onSetStatus={(discussion, nextStatus) => void setDiscussionStatus(discussion, nextStatus)}
              onAddComment={(discussion) => void addDiscussionComment(discussion)}
            />
          ) : tab === 'projects' ? (
            <ProjectsList
              codebaseId={codebaseId}
              projects={filteredProjects}
              emptyDetail={projects.length === 0 ? 'Create the first project board.' : 'No projects match this filter.'}
              disabledReason={projectUpdateReason}
              submitting={submitting}
              onAddNote={(project, columnId, title, body) => void addProjectNote(project, columnId, title, body)}
              onMoveItem={(project, item, direction) => void moveProjectItem(project, item, direction)}
              onArchive={(project) => void archiveProject(project)}
            />
          ) : (
            <ReleasesList
              codebaseId={codebaseId}
              releases={filteredReleases}
              emptyDetail={releases.length === 0 ? 'Draft the first release against Main.' : 'No releases match this filter.'}
              disabledReason={releasePublishReason}
              assetDisabledReason={releaseAssetCreateReason}
              submitting={submitting}
              onPublish={(release) => void publishRelease(release)}
              onAddAsset={(release, draft) => void addReleaseAsset(release, draft)}
            />
          )}
        </div>

        <div className="space-y-3">
          <WorkContextCard
            status={status}
            tab={tab}
            visibleCount={visibleCount}
            totalCount={totalCount}
          />
          {tab === 'issues' ? (
            <IssueForm
              form={form}
              disabledReason={issueCreateReason}
              submitting={submitting === 'create-issue'}
              setForm={setForm}
              onSubmit={createIssue}
            />
          ) : tab === 'discussions' ? (
            <DiscussionForm
              form={form}
              disabledReason={discussionCreateReason}
              submitting={submitting === 'create-discussion'}
              setForm={setForm}
              onSubmit={createDiscussion}
            />
          ) : tab === 'projects' ? (
            <ProjectForm
              form={form}
              disabledReason={projectCreateReason}
              submitting={submitting === 'create-project'}
              setForm={setForm}
              onSubmit={createProject}
            />
          ) : (
            <ReleaseForm
              form={form}
              disabledReason={releaseCreateReason}
              submitting={submitting === 'create-release'}
              setForm={setForm}
              onSubmit={createRelease}
            />
          )}
        </div>
      </div>
    </section>
  )
}

function TabList({
  tab,
  setTab,
  counts,
}: {
  tab: CollaborationTab
  setTab: (tab: CollaborationTab) => void
  counts: Record<CollaborationTab, number>
}) {
  const tabs: Array<{ id: CollaborationTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: 'issues', label: 'Issues', icon: CircleDot },
    { id: 'discussions', label: 'Discussions', icon: MessageSquareText },
    { id: 'projects', label: 'Projects', icon: KanbanSquare },
    { id: 'releases', label: 'Releases', icon: PackageCheck },
  ]

  return (
    <div className="flex items-center gap-1 overflow-x-auto rounded-lg border border-border/60 bg-muted/40 p-0.5 scroll-thin">
      {tabs.map((item) => {
        const Icon = item.icon
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={cn(
              'flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-semibold transition cursor-pointer border border-transparent',
              tab === item.id
                ? 'bg-card text-primary shadow-sm border-border/40'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon className="size-3.5" />
            {item.label}
            <span className="rounded bg-muted px-1.5 py-0.5 text-[9.5px] font-mono font-bold leading-none">{counts[item.id]}</span>
          </button>
        )
      })}
    </div>
  )
}

function WorkItemFilterTabs({
  tab,
  filter,
  counts,
  onChange,
}: {
  tab: CollaborationTab
  filter: WorkItemFilter
  counts: Record<WorkItemFilter, number>
  onChange: (filter: WorkItemFilter) => void
}) {
  const labels = filterLabels(tab)

  return (
    <div className="flex items-center gap-1 overflow-x-auto rounded-lg border border-border/60 bg-muted/50 p-0.5 scroll-thin">
      {(['active', 'all', 'closed'] as const).map((item) => (
        <button
          key={item}
          type="button"
          onClick={() => onChange(item)}
          className={cn(
            'flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition',
            filter === item
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {labels[item]}
          <span className="rounded bg-muted px-1 text-[10px]">{counts[item]}</span>
        </button>
      ))}
    </div>
  )
}

function WorkContextCard({
  status,
  tab,
  visibleCount,
  totalCount,
}: {
  status: AgentStatusSnapshot
  tab: CollaborationTab
  visibleCount: number
  totalCount: number
}) {
  const releaseTargetIsAccepted = status.mergeState === 'merged' || status.reviewState !== 'open'
  const hasHiddenScope = status.hiddenFileCount > 0

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold">
        <GitPullRequest className="size-3.5 text-grape" />
        Work context
      </p>
      <dl className="mt-3 space-y-2 text-[11px]">
        <ContextDatum label="Codebase" value={status.codebaseId ?? 'No codebase'} />
        <ContextDatum label="Active change set" value={status.activeChangeSetId} />
        <ContextDatum label="Main" value={status.mainRevision} />
        <ContextDatum label="Visible in list" value={`${visibleCount} / ${totalCount}`} />
        {tab === 'releases' ? (
          <ContextDatum
            label="Release target"
            value={releaseTargetIsAccepted ? 'Main accepted state' : 'Review still open'}
            highlight={!releaseTargetIsAccepted}
          />
        ) : null}
        <ContextDatum
          label="Private scope"
          value={`${status.hiddenFileCount} hidden`}
          highlight={hasHiddenScope}
        />
      </dl>
    </div>
  )
}

function ContextDatum({
  label,
  value,
  highlight = false,
}: {
  label: string
  value: string
  highlight?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 truncate font-medium', highlight && 'text-hop-amber')}>{value}</dd>
    </div>
  )
}

function IssuesList({
  codebaseId,
  issues,
  emptyDetail,
  disabledReason,
  submitting,
  commentDrafts,
  onCommentDraftChange,
  onSetStatus,
  onAddComment,
}: {
  codebaseId: string | null
  issues: CollaborationIssue[]
  emptyDetail: string
  disabledReason: string | null
  submitting: string | null
  commentDrafts: Record<string, string>
  onCommentDraftChange: (issue: CollaborationIssue, value: string) => void
  onSetStatus: (issue: CollaborationIssue, status: CollaborationIssue['status']) => void
  onAddComment: (issue: CollaborationIssue) => void
}) {
  if (issues.length === 0) {
    return <StateNotice icon={CircleDot} title="No issues" detail={emptyDetail} />
  }

  return (
    <ol className="grid gap-3 lg:grid-cols-2">
      {issues.map((issue) => {
        const isSubmitting = submitting === `issue-${issue.id}`
        return (
          <li key={issue.id} className="rounded-lg border border-border/60 bg-muted/20 p-3">
            <ItemHeader
              icon={CircleDot}
              title={issue.title}
              number={issue.number}
              status={issue.status}
              tone={issue.status === 'open' ? 'active' : 'neutral'}
              href={workItemHref(codebaseId, 'issues', issue)}
            />
            {issue.body ? <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{issue.body}</p> : null}
            <ItemMeta
              items={[
                issue.priority ?? 'no priority',
                issue.linkedChangeSetId ? `change set ${issue.linkedChangeSetId}` : null,
                `${issue.comments.length} comments`,
                `updated ${formatDate(issue.updatedAt)}`,
              ]}
            />
            <LabelRow labels={issue.labels} />
            <CommentThread
              comments={issue.comments}
              draft={commentDrafts[issue.id] ?? ''}
              disabledReason={disabledReason}
              submitting={submitting === `issue-comment-${issue.id}`}
              onDraftChange={(value) => onCommentDraftChange(issue, value)}
              onSubmit={() => onAddComment(issue)}
            />
            <div className="mt-3 flex justify-end">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(disabledReason) || isSubmitting}
                className="h-8 rounded-lg text-xs"
                onClick={() => onSetStatus(issue, issue.status === 'open' ? 'closed' : 'open')}
              >
                {isSubmitting ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
                {issue.status === 'open' ? 'Close' : 'Reopen'}
              </Button>
            </div>
            {disabledReason ? <p className="mt-2 text-[11px] text-muted-foreground">{disabledReason}</p> : null}
          </li>
        )
      })}
    </ol>
  )
}

function DiscussionsList({
  codebaseId,
  discussions,
  emptyDetail,
  disabledReason,
  submitting,
  commentDrafts,
  onCommentDraftChange,
  onSetStatus,
  onAddComment,
}: {
  codebaseId: string | null
  discussions: CollaborationDiscussion[]
  emptyDetail: string
  disabledReason: string | null
  submitting: string | null
  commentDrafts: Record<string, string>
  onCommentDraftChange: (discussion: CollaborationDiscussion, value: string) => void
  onSetStatus: (discussion: CollaborationDiscussion, status: CollaborationDiscussion['status']) => void
  onAddComment: (discussion: CollaborationDiscussion) => void
}) {
  if (discussions.length === 0) {
    return <StateNotice icon={MessageSquareText} title="No discussions" detail={emptyDetail} />
  }

  return (
    <ol className="grid gap-3 lg:grid-cols-2">
      {discussions.map((discussion) => {
        const isSubmitting = submitting === `discussion-${discussion.id}`
        return (
          <li key={discussion.id} className="rounded-lg border border-border/60 bg-muted/20 p-3">
            <ItemHeader
              icon={MessageSquareText}
              title={discussion.title}
              number={discussion.number}
              status={discussion.status}
              tone={discussion.status === 'open' ? 'active' : 'neutral'}
              href={workItemHref(codebaseId, 'discussions', discussion)}
            />
            <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{discussion.body}</p>
            <ItemMeta items={[discussion.category, `${discussion.comments.length} comments`, `updated ${formatDate(discussion.updatedAt)}`]} />
            <LabelRow labels={discussion.labels} />
            <CommentThread
              comments={discussion.comments}
              draft={commentDrafts[discussion.id] ?? ''}
              disabledReason={disabledReason}
              submitting={submitting === `discussion-comment-${discussion.id}`}
              onDraftChange={(value) => onCommentDraftChange(discussion, value)}
              onSubmit={() => onAddComment(discussion)}
            />
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(disabledReason) || isSubmitting}
                className="h-8 rounded-lg text-xs"
                onClick={() => onSetStatus(discussion, discussion.status === 'answered' ? 'open' : 'answered')}
              >
                {isSubmitting ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
                {discussion.status === 'answered' ? 'Reopen' : 'Answer'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(disabledReason) || isSubmitting}
                className="h-8 rounded-lg text-xs"
                onClick={() => onSetStatus(discussion, discussion.status === 'closed' ? 'open' : 'closed')}
              >
                {discussion.status === 'closed' ? 'Reopen' : 'Close'}
              </Button>
            </div>
            {disabledReason ? <p className="mt-2 text-[11px] text-muted-foreground">{disabledReason}</p> : null}
          </li>
        )
      })}
    </ol>
  )
}

function CommentThread({
  comments,
  draft,
  disabledReason,
  submitting,
  onDraftChange,
  onSubmit,
}: {
  comments: Array<{ id: string; body: string; createdBy: string; createdAt: string }>
  draft: string
  disabledReason: string | null
  submitting: boolean
  onDraftChange: (value: string) => void
  onSubmit: () => void
}) {
  const recentComments = comments.slice(-3)

  return (
    <div className="mt-3 rounded-lg bg-card/70 p-2 ring-1 ring-border/50">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
          <MessageCirclePlus className="size-3 text-hop" />
          Comments
        </p>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{comments.length}</span>
      </div>
      {recentComments.length > 0 ? (
        <ol className="mt-2 space-y-1.5">
          {recentComments.map((comment) => (
            <li key={comment.id} className="rounded-md bg-muted/50 px-2 py-1.5">
              <p className="line-clamp-2 text-[11px] text-foreground">{comment.body}</p>
              <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                {comment.createdBy} - {formatDate(comment.createdAt)}
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-[11px] text-muted-foreground">No comments yet.</p>
      )}
      <div className="mt-2 grid gap-1.5">
        <textarea
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          disabled={Boolean(disabledReason) || submitting}
          rows={2}
          placeholder="Add a comment"
          className={cn(inputClassName, 'h-auto resize-none py-2 text-xs')}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={Boolean(disabledReason) || submitting || !draft.trim()}
          className="h-8 justify-start rounded-lg text-xs"
          onClick={onSubmit}
        >
          {submitting ? <Loader2 className="size-3.5 animate-spin" /> : <MessageCirclePlus className="size-3.5" />}
          Add comment
        </Button>
      </div>
    </div>
  )
}

function ProjectsList({
  codebaseId,
  projects,
  emptyDetail,
  disabledReason,
  submitting,
  onAddNote,
  onMoveItem,
  onArchive,
}: {
  codebaseId: string | null
  projects: CollaborationProject[]
  emptyDetail: string
  disabledReason: string | null
  submitting: string | null
  onAddNote: (project: CollaborationProject, columnId: string, title: string, body: string) => void
  onMoveItem: (project: CollaborationProject, item: CollaborationProjectItem, direction: -1 | 1) => void
  onArchive: (project: CollaborationProject) => void
}) {
  const [drafts, setDrafts] = React.useState<Record<string, { title: string; body: string }>>({})

  if (projects.length === 0) {
    return <StateNotice icon={KanbanSquare} title="No projects" detail={emptyDetail} />
  }

  return (
    <ol className="grid gap-4">
      {projects.map((project) => {
        const firstColumn = project.columns[0]
        const draft = drafts[project.id] ?? { title: '', body: '' }
        const isSubmitting = submitting === `project-${project.id}` || submitting === `project-note-${project.id}`

        return (
          <li key={project.id} className="rounded-lg border border-border/60 bg-muted/20 p-3">
            <div className="flex flex-col gap-3 border-b border-border/60 pb-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <ItemHeader
                  icon={KanbanSquare}
                  title={project.name}
                  number={project.number}
                  status={project.status}
                  tone={project.status === 'active' ? 'active' : 'neutral'}
                  href={workItemHref(codebaseId, 'projects', project)}
                />
                {project.description ? (
                  <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{project.description}</p>
                ) : null}
                <ItemMeta items={[`${project.items.length} cards`, `updated ${formatDate(project.updatedAt)}`]} />
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(disabledReason) || isSubmitting || project.status === 'archived'}
                className="h-8 shrink-0 justify-start rounded-lg text-xs"
                onClick={() => onArchive(project)}
              >
                {submitting === `project-${project.id}` ? <Loader2 className="size-3.5 animate-spin" /> : <Archive className="size-3.5" />}
                Archive
              </Button>
            </div>

            {project.status === 'active' && firstColumn ? (
              <div className="mt-3 grid gap-2 rounded-lg bg-card/70 p-2 ring-1 ring-border/50 sm:grid-cols-[minmax(0,1fr)_auto]">
                <div className="grid gap-2 sm:grid-cols-2">
                  <input
                    value={draft.title}
                    onChange={(event) => setDrafts((current) => ({
                      ...current,
                      [project.id]: { ...draft, title: event.target.value },
                    }))}
                    disabled={Boolean(disabledReason) || isSubmitting}
                    placeholder="Card title"
                    className={inputClassName}
                  />
                  <input
                    value={draft.body}
                    onChange={(event) => setDrafts((current) => ({
                      ...current,
                      [project.id]: { ...draft, body: event.target.value },
                    }))}
                    disabled={Boolean(disabledReason) || isSubmitting}
                    placeholder="Card note"
                    className={inputClassName}
                  />
                </div>
                <Button
                  type="button"
                  size="sm"
                  disabled={Boolean(disabledReason) || isSubmitting || !draft.title.trim()}
                  className="h-9 justify-start rounded-lg text-xs"
                  onClick={() => {
                    onAddNote(project, firstColumn.id, draft.title, draft.body)
                    setDrafts((current) => ({ ...current, [project.id]: { title: '', body: '' } }))
                  }}
                >
                  {submitting === `project-note-${project.id}` ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                  Add card
                </Button>
              </div>
            ) : null}

            <div className="mt-3 grid gap-3 xl:grid-cols-3">
              {project.columns.map((column, columnIndex) => {
                const columnItems = project.items
                  .filter((item) => item.columnId === column.id)
                  .sort((a, b) => a.position - b.position)

                return (
                  <div key={column.id} className="min-w-0 rounded-lg bg-card p-2.5 ring-1 ring-border/50">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-xs font-semibold">{column.name}</p>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{columnItems.length}</span>
                    </div>
                    {columnItems.length > 0 ? (
                      <ol className="mt-2 space-y-2">
                        {columnItems.map((item) => (
                          <ProjectCard
                            key={item.id}
                            project={project}
                            item={item}
                            columnIndex={columnIndex}
                            disabledReason={disabledReason}
                            submitting={submitting === `project-item-${item.id}`}
                            onMoveItem={onMoveItem}
                          />
                        ))}
                      </ol>
                    ) : (
                      <p className="mt-2 rounded-md bg-muted/50 px-2 py-3 text-center text-[11px] text-muted-foreground">
                        Empty
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
            {disabledReason ? <p className="mt-2 text-[11px] text-muted-foreground">{disabledReason}</p> : null}
          </li>
        )
      })}
    </ol>
  )
}

function ProjectCard({
  project,
  item,
  columnIndex,
  disabledReason,
  submitting,
  onMoveItem,
}: {
  project: CollaborationProject
  item: CollaborationProjectItem
  columnIndex: number
  disabledReason: string | null
  submitting: boolean
  onMoveItem: (project: CollaborationProject, item: CollaborationProjectItem, direction: -1 | 1) => void
}) {
  const itemTitle = item.item.version ? `${item.item.version}: ${item.item.title ?? 'Untitled'}` : item.item.title ?? item.item.id ?? 'Untitled card'
  const canMoveLeft = columnIndex > 0
  const canMoveRight = columnIndex < project.columns.length - 1

  return (
    <li className="rounded-lg bg-muted/50 p-2 ring-1 ring-border/40">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="line-clamp-2 text-xs font-semibold">{itemTitle}</p>
          {item.item.body ? <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{item.item.body}</p> : null}
          <p className="mt-1 text-[10px] text-muted-foreground">{item.item.type ?? 'note'} - updated {formatDate(item.updatedAt)}</p>
        </div>
        {submitting ? <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" /> : null}
      </div>
      <div className="mt-2 flex justify-end gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={Boolean(disabledReason) || submitting || !canMoveLeft}
          className="h-7 rounded-md px-2"
          onClick={() => onMoveItem(project, item, -1)}
        >
          <ArrowLeft className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={Boolean(disabledReason) || submitting || !canMoveRight}
          className="h-7 rounded-md px-2"
          onClick={() => onMoveItem(project, item, 1)}
        >
          <ArrowRight className="size-3.5" />
        </Button>
      </div>
    </li>
  )
}

function ReleasesList({
  codebaseId,
  releases,
  emptyDetail,
  disabledReason,
  assetDisabledReason,
  submitting,
  onPublish,
  onAddAsset,
}: {
  codebaseId: string | null
  releases: CollaborationRelease[]
  emptyDetail: string
  disabledReason: string | null
  assetDisabledReason: string | null
  submitting: string | null
  onPublish: (release: CollaborationRelease) => void
  onAddAsset: (release: CollaborationRelease, draft: ReleaseAssetDraft) => void
}) {
  const [assetDrafts, setAssetDrafts] = React.useState<Record<string, ReleaseAssetDraft>>({})

  if (releases.length === 0) {
    return <StateNotice icon={PackageCheck} title="No releases" detail={emptyDetail} />
  }

  return (
    <ol className="grid gap-3 lg:grid-cols-2">
      {releases.map((release) => {
        const isSubmitting = submitting === `release-${release.id}`
        const assetSubmitting = submitting === `release-asset-${release.id}`
        const assetDraft = assetDrafts[release.id] ?? defaultReleaseAssetDraft()
        return (
          <li key={release.id} className="rounded-lg border border-border/60 bg-muted/20 p-3">
            <ItemHeader
              icon={Rocket}
              title={`${release.version}: ${release.title}`}
              number={release.number}
              status={release.status}
              tone={release.status === 'published' ? 'active' : 'neutral'}
              href={workItemHref(codebaseId, 'releases', release)}
            />
            <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{release.notes}</p>
            <ItemMeta
              items={[
                `${release.target.type} ${release.target.id}`,
                release.target.revision === null ? null : `rev ${release.target.revision}`,
                `${release.assets.length} assets`,
                `updated ${formatDate(release.updatedAt)}`,
              ]}
            />
            {release.assets.length > 0 ? (
              <ol className="mt-3 space-y-1.5 rounded-lg bg-card/70 p-2 ring-1 ring-border/50">
                {release.assets.map((asset) => (
                  <li key={asset.id} className="flex min-w-0 items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1.5">
                    <div className="min-w-0">
                      <p className="truncate text-[11px] font-semibold">{asset.name}</p>
                      <p className="truncate text-[10px] text-muted-foreground">
                        {asset.kind}{asset.size !== null ? ` - ${formatBytes(asset.size)}` : ''}
                      </p>
                    </div>
                    {asset.url ? (
                      <a
                        href={asset.url}
                        target="_blank"
                        rel="noreferrer"
                        className="shrink-0 rounded-md bg-card px-1.5 py-0.5 text-[10px] text-primary ring-1 ring-border/60"
                      >
                        Open
                      </a>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : null}
            <div className="mt-3 rounded-lg bg-card/70 p-2 ring-1 ring-border/50">
              <p className="text-[11px] font-semibold text-muted-foreground">Attach release asset</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <input
                  value={assetDraft.name}
                  onChange={(event) => setAssetDrafts((current) => ({
                    ...current,
                    [release.id]: { ...assetDraft, name: event.target.value },
                  }))}
                  disabled={Boolean(assetDisabledReason) || assetSubmitting}
                  placeholder="Asset name"
                  className={inputClassName}
                />
                <select
                  value={assetDraft.kind}
                  onChange={(event) => setAssetDrafts((current) => ({
                    ...current,
                    [release.id]: { ...assetDraft, kind: event.target.value as CollaborationReleaseAsset['kind'] },
                  }))}
                  disabled={Boolean(assetDisabledReason) || assetSubmitting}
                  className={inputClassName}
                >
                  <option value="archive">archive</option>
                  <option value="binary">binary</option>
                  <option value="source">source</option>
                  <option value="checksum">checksum</option>
                  <option value="installer">installer</option>
                  <option value="other">other</option>
                </select>
                <input
                  value={assetDraft.url}
                  onChange={(event) => setAssetDrafts((current) => ({
                    ...current,
                    [release.id]: { ...assetDraft, url: event.target.value },
                  }))}
                  disabled={Boolean(assetDisabledReason) || assetSubmitting}
                  placeholder="URL"
                  className={inputClassName}
                />
                <input
                  value={assetDraft.checksum}
                  onChange={(event) => setAssetDrafts((current) => ({
                    ...current,
                    [release.id]: { ...assetDraft, checksum: event.target.value },
                  }))}
                  disabled={Boolean(assetDisabledReason) || assetSubmitting}
                  placeholder="Checksum"
                  className={inputClassName}
                />
                <input
                  value={assetDraft.size}
                  onChange={(event) => setAssetDrafts((current) => ({
                    ...current,
                    [release.id]: { ...assetDraft, size: event.target.value },
                  }))}
                  disabled={Boolean(assetDisabledReason) || assetSubmitting}
                  inputMode="numeric"
                  placeholder="Size in bytes"
                  className={inputClassName}
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={Boolean(assetDisabledReason) || assetSubmitting || !assetDraft.name.trim()}
                  className="h-9 justify-start rounded-lg text-xs"
                  onClick={() => {
                    onAddAsset(release, assetDraft)
                    setAssetDrafts((current) => ({ ...current, [release.id]: defaultReleaseAssetDraft() }))
                  }}
                >
                  {assetSubmitting ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                  Attach
                </Button>
              </div>
              {assetDisabledReason ? <p className="mt-2 text-[11px] text-muted-foreground">{assetDisabledReason}</p> : null}
            </div>
            <div className="mt-3 flex justify-end">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(disabledReason) || isSubmitting || release.status === 'published'}
                className="h-8 rounded-lg text-xs"
                onClick={() => onPublish(release)}
              >
                {isSubmitting ? <Loader2 className="size-3.5 animate-spin" /> : <Rocket className="size-3.5" />}
                Publish
              </Button>
            </div>
            {disabledReason ? <p className="mt-2 text-[11px] text-muted-foreground">{disabledReason}</p> : null}
          </li>
        )
      })}
    </ol>
  )
}

function IssueForm({
  form,
  disabledReason,
  submitting,
  setForm,
  onSubmit,
}: {
  form: FormState
  disabledReason: string | null
  submitting: boolean
  setForm: React.Dispatch<React.SetStateAction<FormState>>
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}) {
  return (
    <ObjectForm title="New issue" icon={Plus} disabledReason={disabledReason} onSubmit={onSubmit}>
      <TextInput
        value={form.issueTitle}
        onChange={(value) => setForm((current) => ({ ...current, issueTitle: value }))}
        disabled={Boolean(disabledReason) || submitting}
        placeholder="Issue title"
      />
      <TextArea
        value={form.issueBody}
        onChange={(value) => setForm((current) => ({ ...current, issueBody: value }))}
        disabled={Boolean(disabledReason) || submitting}
        placeholder="Body"
      />
      <select
        value={form.issuePriority}
        onChange={(event) => setForm((current) => ({ ...current, issuePriority: event.target.value as FormState['issuePriority'] }))}
        disabled={Boolean(disabledReason) || submitting}
        className={inputClassName}
      >
        <option value="low">low priority</option>
        <option value="medium">medium priority</option>
        <option value="high">high priority</option>
      </select>
      <TextInput
        value={form.issueLabels}
        onChange={(value) => setForm((current) => ({ ...current, issueLabels: value }))}
        disabled={Boolean(disabledReason) || submitting}
        placeholder="labels, comma separated"
      />
      <SubmitButton disabled={Boolean(disabledReason) || submitting || !form.issueTitle.trim()} submitting={submitting}>
        Create issue
      </SubmitButton>
    </ObjectForm>
  )
}

function DiscussionForm({
  form,
  disabledReason,
  submitting,
  setForm,
  onSubmit,
}: {
  form: FormState
  disabledReason: string | null
  submitting: boolean
  setForm: React.Dispatch<React.SetStateAction<FormState>>
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}) {
  return (
    <ObjectForm title="New discussion" icon={MessageSquareText} disabledReason={disabledReason} onSubmit={onSubmit}>
      <TextInput
        value={form.discussionTitle}
        onChange={(value) => setForm((current) => ({ ...current, discussionTitle: value }))}
        disabled={Boolean(disabledReason) || submitting}
        placeholder="Discussion title"
      />
      <TextArea
        value={form.discussionBody}
        onChange={(value) => setForm((current) => ({ ...current, discussionBody: value }))}
        disabled={Boolean(disabledReason) || submitting}
        placeholder="Body"
      />
      <select
        value={form.discussionCategory}
        onChange={(event) =>
          setForm((current) => ({ ...current, discussionCategory: event.target.value as CollaborationDiscussion['category'] }))
        }
        disabled={Boolean(disabledReason) || submitting}
        className={inputClassName}
      >
        <option value="general">general</option>
        <option value="ideas">ideas</option>
        <option value="q-and-a">q-and-a</option>
        <option value="announcements">announcements</option>
      </select>
      <TextInput
        value={form.discussionLabels}
        onChange={(value) => setForm((current) => ({ ...current, discussionLabels: value }))}
        disabled={Boolean(disabledReason) || submitting}
        placeholder="labels, comma separated"
      />
      <SubmitButton
        disabled={Boolean(disabledReason) || submitting || !form.discussionTitle.trim() || !form.discussionBody.trim()}
        submitting={submitting}
      >
        Create discussion
      </SubmitButton>
    </ObjectForm>
  )
}

function ReleaseForm({
  form,
  disabledReason,
  submitting,
  setForm,
  onSubmit,
}: {
  form: FormState
  disabledReason: string | null
  submitting: boolean
  setForm: React.Dispatch<React.SetStateAction<FormState>>
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}) {
  return (
    <ObjectForm title="New release" icon={PackageCheck} disabledReason={disabledReason} onSubmit={onSubmit}>
      <TextInput
        value={form.releaseVersion}
        onChange={(value) => setForm((current) => ({ ...current, releaseVersion: value }))}
        disabled={Boolean(disabledReason) || submitting}
        placeholder="v0.1.0"
      />
      <TextInput
        value={form.releaseTitle}
        onChange={(value) => setForm((current) => ({ ...current, releaseTitle: value }))}
        disabled={Boolean(disabledReason) || submitting}
        placeholder="Release title"
      />
      <TextArea
        value={form.releaseNotes}
        onChange={(value) => setForm((current) => ({ ...current, releaseNotes: value }))}
        disabled={Boolean(disabledReason) || submitting}
        placeholder="Notes"
      />
      <SubmitButton
        disabled={
          Boolean(disabledReason) ||
          submitting ||
          !form.releaseVersion.trim() ||
          !form.releaseTitle.trim() ||
          !form.releaseNotes.trim()
        }
        submitting={submitting}
      >
        Draft release
      </SubmitButton>
    </ObjectForm>
  )
}

function ProjectForm({
  form,
  disabledReason,
  submitting,
  setForm,
  onSubmit,
}: {
  form: FormState
  disabledReason: string | null
  submitting: boolean
  setForm: React.Dispatch<React.SetStateAction<FormState>>
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}) {
  return (
    <ObjectForm title="New project" icon={Columns3} disabledReason={disabledReason} onSubmit={onSubmit}>
      <TextInput
        value={form.projectName}
        onChange={(value) => setForm((current) => ({ ...current, projectName: value }))}
        disabled={Boolean(disabledReason) || submitting}
        placeholder="Project name"
      />
      <TextArea
        value={form.projectDescription}
        onChange={(value) => setForm((current) => ({ ...current, projectDescription: value }))}
        disabled={Boolean(disabledReason) || submitting}
        placeholder="Description"
      />
      <SubmitButton disabled={Boolean(disabledReason) || submitting || !form.projectName.trim()} submitting={submitting}>
        Create project
      </SubmitButton>
    </ObjectForm>
  )
}

function ObjectForm({
  title,
  icon: Icon,
  disabledReason,
  onSubmit,
  children,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  disabledReason: string | null
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
  children: React.ReactNode
}) {
  return (
    <form onSubmit={onSubmit} className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold">
        <Icon className="size-3.5 text-hop" />
        {title}
      </p>
      <div className="mt-3 grid gap-2">{children}</div>
      {disabledReason ? <p className="mt-2 text-[11px] text-muted-foreground">{disabledReason}</p> : null}
    </form>
  )
}

function TextInput({
  value,
  onChange,
  disabled,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  disabled: boolean
  placeholder: string
}) {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      placeholder={placeholder}
      className={inputClassName}
    />
  )
}

function TextArea({
  value,
  onChange,
  disabled,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  disabled: boolean
  placeholder: string
}) {
  return (
    <textarea
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      placeholder={placeholder}
      rows={4}
      className={cn(inputClassName, 'h-auto resize-none py-2')}
    />
  )
}

function SubmitButton({
  disabled,
  submitting,
  children,
}: {
  disabled: boolean
  submitting: boolean
  children: React.ReactNode
}) {
  return (
    <Button type="submit" size="sm" disabled={disabled} className="justify-start rounded-lg">
      {submitting ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
      {children}
    </Button>
  )
}

function ItemHeader({
  icon: Icon,
  title,
  number,
  status,
  tone,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  number: number
  status: string
  tone: 'active' | 'neutral'
  href?: string | null
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
          <Icon className="size-3.5 shrink-0 text-hop" />
          {href ? (
            <a href={href} className="truncate transition hover:text-primary">
              {title}
            </a>
          ) : (
            <span className="truncate">{title}</span>
          )}
        </div>
        <p className="mt-0.5 text-[10.5px] text-muted-foreground">#{number}</p>
      </div>
      <span
        className={cn(
          'shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset',
          tone === 'active'
            ? 'bg-hop/10 text-hop ring-hop/20'
            : 'bg-muted text-muted-foreground ring-border/60',
        )}
      >
        {status}
      </span>
    </div>
  )
}

function ItemMeta({ items }: { items: Array<string | null> }) {
  const visibleItems = items.filter((item): item is string => Boolean(item))

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {visibleItems.map((item) => (
        <span key={item} className="rounded-md bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground ring-1 ring-border/50">
          {item}
        </span>
      ))}
    </div>
  )
}

function LabelRow({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {labels.map((label) => (
        <span key={label} className="flex items-center gap-1 rounded-md bg-grape/10 px-1.5 py-0.5 text-[10px] text-grape">
          <Tag className="size-2.5" />
          {label}
        </span>
      ))}
    </div>
  )
}

function workItemHref(
  codebaseId: string | null,
  kind: 'issues' | 'discussions' | 'releases' | 'projects',
  item: { id: string },
) {
  if (!codebaseId) return null
  return `/codebases/${encodeURIComponent(codebaseId)}/work-items/${kind}/${encodeURIComponent(item.id)}`
}

function StateNotice({
  icon: Icon,
  title,
  detail,
  spinning = false,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  detail: string
  spinning?: boolean
}) {
  return (
    <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 p-6 text-center">
      <Icon className={cn('mx-auto size-5 text-muted-foreground', spinning && 'animate-spin')} />
      <p className="mt-2 text-sm font-medium">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  )
}

function MetricChip({ label, value, active }: { label: string; value: string; active: boolean }) {
  return (
    <div
      className={cn(
        'min-w-0 rounded-lg px-3 py-2 border transition duration-200',
        active ? 'bg-primary/8 text-primary border-primary/20 shadow-sm' : 'bg-muted/40 text-muted-foreground border-border/60',
      )}
    >
      <p className="truncate text-[9.5px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-xs font-bold text-foreground">{value}</p>
    </div>
  )
}

function filterIssues(
  issues: CollaborationIssue[],
  filter: WorkItemFilter,
  query: string,
) {
  const normalizedQuery = normalizeQuery(query)

  return issues.filter((issue) => {
    if (filter === 'active' && issue.status !== 'open') return false
    if (filter === 'closed' && issue.status !== 'closed') return false
    return queryMatches(
      normalizedQuery,
      issue.title,
      issue.body,
      issue.priority,
      issue.status,
      `#${issue.number}`,
      issue.linkedChangeSetId,
      issue.linkedReleaseId,
      ...issue.labels,
      ...issue.assigneeIds,
    )
  })
}

function filterDiscussions(
  discussions: CollaborationDiscussion[],
  filter: WorkItemFilter,
  query: string,
) {
  const normalizedQuery = normalizeQuery(query)

  return discussions.filter((discussion) => {
    if (filter === 'active' && discussion.status !== 'open') return false
    if (filter === 'closed' && discussion.status === 'open') return false
    return queryMatches(
      normalizedQuery,
      discussion.title,
      discussion.body,
      discussion.category,
      discussion.status,
      `#${discussion.number}`,
      discussion.linkedChangeSetId,
      ...discussion.labels,
      ...discussion.linkedIssueIds,
    )
  })
}

function filterReleases(
  releases: CollaborationRelease[],
  filter: WorkItemFilter,
  query: string,
) {
  const normalizedQuery = normalizeQuery(query)

  return releases.filter((release) => {
    if (filter === 'active' && release.status !== 'draft') return false
    if (filter === 'closed' && release.status === 'draft') return false
    return queryMatches(
      normalizedQuery,
      release.version,
      release.title,
      release.notes,
      release.status,
      release.target.type,
      release.target.id,
      release.target.revision === null ? null : `rev ${release.target.revision}`,
      `#${release.number}`,
      ...release.assets.flatMap((asset) => [asset.name, asset.kind, asset.url, asset.checksum]),
    )
  })
}

function filterProjects(
  projects: CollaborationProject[],
  filter: WorkItemFilter,
  query: string,
) {
  const normalizedQuery = normalizeQuery(query)

  return projects.filter((project) => {
    if (filter === 'active' && project.status !== 'active') return false
    if (filter === 'closed' && project.status !== 'archived') return false
    return queryMatches(
      normalizedQuery,
      project.name,
      project.description,
      project.status,
      `#${project.number}`,
      ...project.columns.map((column) => column.name),
      ...project.items.map((item) => item.item.title ?? item.item.id ?? item.item.type ?? ''),
    )
  })
}

function workItemFilterCounts(
  tab: CollaborationTab,
  issues: CollaborationIssue[],
  discussions: CollaborationDiscussion[],
  releases: CollaborationRelease[],
  projects: CollaborationProject[],
): Record<WorkItemFilter, number> {
  if (tab === 'issues') {
    return {
      active: issues.filter((issue) => issue.status === 'open').length,
      all: issues.length,
      closed: issues.filter((issue) => issue.status === 'closed').length,
    }
  }

  if (tab === 'discussions') {
    return {
      active: discussions.filter((discussion) => discussion.status === 'open').length,
      all: discussions.length,
      closed: discussions.filter((discussion) => discussion.status !== 'open').length,
    }
  }

  if (tab === 'projects') {
    return {
      active: projects.filter((project) => project.status === 'active').length,
      all: projects.length,
      closed: projects.filter((project) => project.status === 'archived').length,
    }
  }

  return {
    active: releases.filter((release) => release.status === 'draft').length,
    all: releases.length,
    closed: releases.filter((release) => release.status !== 'draft').length,
  }
}

function filterLabels(tab: CollaborationTab): Record<WorkItemFilter, string> {
  if (tab === 'issues') return { active: 'Open', all: 'All', closed: 'Closed' }
  if (tab === 'discussions') return { active: 'Open', all: 'All', closed: 'Closed/answered' }
  if (tab === 'projects') return { active: 'Active', all: 'All', closed: 'Archived' }
  return { active: 'Draft', all: 'All', closed: 'Published' }
}

function normalizeQuery(value: string) {
  return value.trim().toLowerCase()
}

function queryMatches(normalizedQuery: string, ...values: Array<string | null | undefined>) {
  if (!normalizedQuery) return true
  return values
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase().includes(normalizedQuery))
}

function labelsFromInput(value: string) {
  return Array.from(new Set(value.split(',').map((label) => label.trim()).filter(Boolean)))
}

function disabledReason({
  codebaseId,
  roleAllowed,
  capability,
  loading,
  roleReason,
}: {
  codebaseId: string | null
  roleAllowed: boolean
  capability: { enabled: boolean; reason?: string } | undefined
  loading: boolean
  roleReason: string
}) {
  if (!codebaseId) return 'No codebase is selected.'
  if (!roleAllowed) return roleReason
  if (loading) return 'Collaboration capabilities are loading.'
  if (!capability) return 'Collaboration capabilities are not loaded.'
  if (!capability.enabled) return capability.reason ?? 'Collaboration action is unavailable.'
  return null
}

function hasPermission(status: AgentStatusSnapshot, permission: string) {
  return status.requester.permissions.includes(permission)
}

function unavailableCapabilities(reason: string): WorkItemsResponse['capabilities'] {
  const action = { enabled: false, reason }

  return {
    backend: 'unavailable',
    read: action,
    createIssue: action,
    updateIssue: action,
    createDiscussion: action,
    updateDiscussion: action,
    createRelease: action,
    createReleaseAsset: action,
    publishRelease: action,
    createProject: action,
    updateProject: action,
  }
}

function revisionNumber(revision: string) {
  const match = revision.match(/\d+/)
  return match ? Number(match[0]) : null
}

function formatDate(value: string) {
  const time = new Date(value).getTime()
  if (!value || Number.isNaN(time)) return 'unknown'

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(time)
}

function formatBytes(value: number | null | undefined) {
  if (!value) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`
}

function defaultReleaseAssetDraft(): ReleaseAssetDraft {
  return {
    name: '',
    kind: 'archive',
    url: '',
    checksum: '',
    size: '',
  }
}

const inputClassName =
  'h-9 rounded-lg border border-border/60 bg-card px-3 text-sm outline-none transition placeholder:text-muted-foreground focus:border-hop/40 focus:ring-2 focus:ring-hop/20 disabled:cursor-not-allowed disabled:opacity-60'

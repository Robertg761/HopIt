'use client'

import * as React from 'react'
import {
  AlertCircle,
  CheckCircle2,
  CircleDot,
  GitPullRequest,
  Loader2,
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
  type CollaborationRelease,
  type WorkItemsResponse,
} from '@/lib/collaboration'
import type { AgentStatusSnapshot } from '@/lib/agent-status'
import { cn } from '@/lib/utils'

type CollaborationSectionProps = {
  status: AgentStatusSnapshot
}

type CollaborationTab = 'issues' | 'discussions' | 'releases'

type WorkItemFilter = 'active' | 'all' | 'closed'

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
}

export function CollaborationSection({ status }: CollaborationSectionProps) {
  const [tab, setTab] = React.useState<CollaborationTab>('issues')
  const [query, setQuery] = React.useState('')
  const [itemFilter, setItemFilter] = React.useState<WorkItemFilter>('active')
  const [workItems, setWorkItems] = React.useState<WorkItemsResponse | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [form, setForm] = React.useState<FormState>(initialFormState)
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

  const issues = workItems?.issues ?? []
  const discussions = workItems?.discussions ?? []
  const releases = workItems?.releases ?? []
  const openIssues = issues.filter((issue) => issue.status === 'open').length
  const activeDiscussions = discussions.filter((discussion) => discussion.status === 'open').length
  const draftReleases = releases.filter((release) => release.status === 'draft').length
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
  const filterCounts = workItemFilterCounts(tab, issues, discussions, releases)
  const visibleCount =
    tab === 'issues'
      ? filteredIssues.length
      : tab === 'discussions'
        ? filteredDiscussions.length
        : filteredReleases.length
  const totalCount =
    tab === 'issues'
      ? issues.length
      : tab === 'discussions'
        ? discussions.length
        : releases.length

  return (
    <section className="panel-surface overflow-hidden rounded-lg border border-border/70 shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border/60 p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-grape/10 text-grape">
              <GitPullRequest className="size-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold">Collaboration</h2>
              <p className="truncate text-xs text-muted-foreground">
                {codebaseId ?? 'No codebase'} - issues, discussions, releases
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <MetricChip label="Open issues" value={openIssues.toString()} active={openIssues > 0} />
          <MetricChip label="Discussions" value={activeDiscussions.toString()} active={activeDiscussions > 0} />
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
          <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-card px-2.5 py-2 lg:max-w-sm lg:flex-1">
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
            <StateNotice icon={Loader2} title="Loading collaboration objects" detail="Reading Convex work-item functions." spinning />
          ) : workItems?.error ? (
            <StateNotice icon={AlertCircle} title="Collaboration unavailable" detail={workItems.error.message} />
          ) : tab === 'issues' ? (
            <IssuesList
              issues={filteredIssues}
              emptyDetail={issues.length === 0 ? 'Create the first codebase issue.' : 'No issues match this filter.'}
              disabledReason={issueUpdateReason}
              submitting={submitting}
              onSetStatus={(issue, nextStatus) => void setIssueStatus(issue, nextStatus)}
            />
          ) : tab === 'discussions' ? (
            <DiscussionsList
              discussions={filteredDiscussions}
              emptyDetail={
                discussions.length === 0
                  ? 'Start the first design or coordination thread.'
                  : 'No discussions match this filter.'
              }
              disabledReason={discussionUpdateReason}
              submitting={submitting}
              onSetStatus={(discussion, nextStatus) => void setDiscussionStatus(discussion, nextStatus)}
            />
          ) : (
            <ReleasesList
              releases={filteredReleases}
              emptyDetail={releases.length === 0 ? 'Draft the first release against Main.' : 'No releases match this filter.'}
              disabledReason={releasePublishReason}
              submitting={submitting}
              onPublish={(release) => void publishRelease(release)}
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
    { id: 'releases', label: 'Releases', icon: PackageCheck },
  ]

  return (
    <div className="flex items-center gap-1 overflow-x-auto rounded-lg border border-border/60 bg-muted/50 p-0.5 scroll-thin">
      {tabs.map((item) => {
        const Icon = item.icon
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={cn(
              'flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition',
              tab === item.id
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-3.5" />
            {item.label}
            <span className="rounded bg-muted px-1 text-[10px]">{counts[item.id]}</span>
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
  issues,
  emptyDetail,
  disabledReason,
  submitting,
  onSetStatus,
}: {
  issues: CollaborationIssue[]
  emptyDetail: string
  disabledReason: string | null
  submitting: string | null
  onSetStatus: (issue: CollaborationIssue, status: CollaborationIssue['status']) => void
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
            />
            {issue.body ? <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{issue.body}</p> : null}
            <ItemMeta
              items={[
                issue.priority ?? 'no priority',
                issue.linkedChangeSetId ? `change set ${issue.linkedChangeSetId}` : null,
                `updated ${formatDate(issue.updatedAt)}`,
              ]}
            />
            <LabelRow labels={issue.labels} />
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
  discussions,
  emptyDetail,
  disabledReason,
  submitting,
  onSetStatus,
}: {
  discussions: CollaborationDiscussion[]
  emptyDetail: string
  disabledReason: string | null
  submitting: string | null
  onSetStatus: (discussion: CollaborationDiscussion, status: CollaborationDiscussion['status']) => void
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
            />
            <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{discussion.body}</p>
            <ItemMeta items={[discussion.category, `updated ${formatDate(discussion.updatedAt)}`]} />
            <LabelRow labels={discussion.labels} />
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

function ReleasesList({
  releases,
  emptyDetail,
  disabledReason,
  submitting,
  onPublish,
}: {
  releases: CollaborationRelease[]
  emptyDetail: string
  disabledReason: string | null
  submitting: string | null
  onPublish: (release: CollaborationRelease) => void
}) {
  if (releases.length === 0) {
    return <StateNotice icon={PackageCheck} title="No releases" detail={emptyDetail} />
  }

  return (
    <ol className="grid gap-3 lg:grid-cols-2">
      {releases.map((release) => {
        const isSubmitting = submitting === `release-${release.id}`
        return (
          <li key={release.id} className="rounded-lg border border-border/60 bg-muted/20 p-3">
            <ItemHeader
              icon={Rocket}
              title={`${release.version}: ${release.title}`}
              number={release.number}
              status={release.status}
              tone={release.status === 'published' ? 'active' : 'neutral'}
            />
            <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{release.notes}</p>
            <ItemMeta
              items={[
                `${release.target.type} ${release.target.id}`,
                release.target.revision === null ? null : `rev ${release.target.revision}`,
                `updated ${formatDate(release.updatedAt)}`,
              ]}
            />
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
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  number: number
  status: string
  tone: 'active' | 'neutral'
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
          <Icon className="size-3.5 shrink-0 text-hop" />
          <span className="truncate">{title}</span>
        </p>
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
        'min-w-0 rounded-lg px-2.5 py-2 ring-1 ring-inset',
        active ? 'bg-grape/10 text-grape ring-grape/20' : 'bg-muted/35 text-muted-foreground ring-border/60',
      )}
    >
      <p className="truncate text-[10.5px]">{label}</p>
      <p className="mt-1 truncate text-xs font-semibold text-foreground">{value}</p>
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
    )
  })
}

function workItemFilterCounts(
  tab: CollaborationTab,
  issues: CollaborationIssue[],
  discussions: CollaborationDiscussion[],
  releases: CollaborationRelease[],
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

  return {
    active: releases.filter((release) => release.status === 'draft').length,
    all: releases.length,
    closed: releases.filter((release) => release.status !== 'draft').length,
  }
}

function filterLabels(tab: CollaborationTab): Record<WorkItemFilter, string> {
  if (tab === 'issues') return { active: 'Open', all: 'All', closed: 'Closed' }
  if (tab === 'discussions') return { active: 'Open', all: 'All', closed: 'Closed/answered' }
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
    publishRelease: action,
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

const inputClassName =
  'h-9 rounded-lg border border-border/60 bg-card px-3 text-sm outline-none transition placeholder:text-muted-foreground focus:border-hop/40 focus:ring-2 focus:ring-hop/20 disabled:cursor-not-allowed disabled:opacity-60'

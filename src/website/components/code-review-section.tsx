'use client'

import * as React from 'react'
import {
  AlertTriangle,
  Code2,
  FileDiff,
  FileCode2,
  GitCompareArrows,
  GitMerge,
  GitPullRequest,
  History,
  Lock,
  Loader2,
  MessageSquareText,
  RefreshCcw,
  Search,
  ShieldCheck,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  createCollaborationItem,
  createReviewThread,
  createReviewThreadComment,
  fetchWorkItems,
  fetchReviewThreads,
  resolveReviewThread,
  type CollaborationIssue,
  type ReviewThread,
  type WorkItemsResponse,
} from '@/lib/collaboration'
import type { AgentFile, AgentStatusSnapshot } from '@/website/lib/agent-status'

type CodeReviewSectionProps = {
  status: AgentStatusSnapshot
}

type ReviewFileFilter = 'changed' | 'shared' | 'private'

type ReviewFileState = 'changed' | 'same-as-main' | 'unknown' | 'private'

type ReviewFileRow = {
  file: AgentFile
  state: ReviewFileState
}

export function CodeReviewSection({ status }: CodeReviewSectionProps) {
  const mainRevision = revisionNumber(status.mainRevision)
  const reviewRows = React.useMemo(
    () => reviewFileRows(status.files, mainRevision),
    [mainRevision, status.files],
  )
  const [fileFilter, setFileFilter] = React.useState<ReviewFileFilter>('shared')
  const [fileQuery, setFileQuery] = React.useState('')
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null)
  const [selectedLine, setSelectedLine] = React.useState<number | null>(null)
  const [followupMessage, setFollowupMessage] = React.useState<string | null>(null)
  const [creatingFollowup, setCreatingFollowup] = React.useState(false)
  const [workItems, setWorkItems] = React.useState<WorkItemsResponse | null>(null)
  const [loadingThreads, setLoadingThreads] = React.useState(false)
  const [reviewThreads, setReviewThreads] = React.useState<ReviewThread[]>([])
  const [loadingAnchoredThreads, setLoadingAnchoredThreads] = React.useState(false)
  const [threadDraft, setThreadDraft] = React.useState('')
  const [threadMessage, setThreadMessage] = React.useState<string | null>(null)
  const [creatingThread, setCreatingThread] = React.useState(false)
  const [commentDrafts, setCommentDrafts] = React.useState<Record<string, string>>({})
  const [commentingIssueId, setCommentingIssueId] = React.useState<string | null>(null)
  const [threadCommentDrafts, setThreadCommentDrafts] = React.useState<Record<string, string>>({})
  const [commentingThreadId, setCommentingThreadId] = React.useState<string | null>(null)
  const [resolvingThreadId, setResolvingThreadId] = React.useState<string | null>(null)
  const filteredRows = React.useMemo(
    () => filterReviewRows(reviewRows, fileFilter, fileQuery),
    [fileFilter, fileQuery, reviewRows],
  )
  const selectedRow =
    filteredRows.find((row) => row.file.path === selectedPath) ?? filteredRows[0] ?? null
  const selectedFile = selectedRow?.file ?? null
  const selectedLineForFile = selectedPath === selectedFile?.path ? selectedLine : null
  const privateFileCount = reviewRows.filter((row) => row.file.scope === 'owner-private').length
  const sharedFileCount = reviewRows.filter((row) => row.file.scope === 'shared').length
  const changedFileCount = reviewRows.filter((row) => row.state === 'changed').length
  const reviewEvents = status.events.filter((event) =>
    isReviewHistoryEvent(event.label),
  )
  const reviewIssues = React.useMemo(
    () => reviewLinkedIssues(workItems?.issues ?? [], status.activeChangeSetId),
    [status.activeChangeSetId, workItems?.issues],
  )
  const selectedFileThreads = React.useMemo(
    () => reviewThreads.filter((thread) => thread.filePath === selectedFile?.path),
    [reviewThreads, selectedFile?.path],
  )
  const canWrite = status.requester.permissions.includes('write')
  const canCreateFollowup =
    Boolean(status.codebaseId) &&
    selectedFile?.scope === 'shared' &&
    canWrite
  const canCreateAnchoredThread =
    Boolean(status.codebaseId) &&
    status.activeChangeSetId !== 'None' &&
    selectedFile?.scope === 'shared' &&
    canWrite

  const loadReviewThreads = React.useCallback(async () => {
    if (!status.codebaseId) {
      setWorkItems(null)
      return
    }

    setLoadingThreads(true)
    try {
      setWorkItems(await fetchWorkItems(status.codebaseId))
    } finally {
      setLoadingThreads(false)
    }
  }, [status.codebaseId])

  React.useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadReviewThreads()
    }, 0)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [loadReviewThreads])

  const loadAnchoredThreads = React.useCallback(async () => {
    if (!status.codebaseId) {
      setReviewThreads([])
      return
    }

    setLoadingAnchoredThreads(true)
    try {
      const result = await fetchReviewThreads(
        status.codebaseId,
        status.activeChangeSetId === 'None' ? null : status.activeChangeSetId,
      )
      setReviewThreads(result.threads)
    } finally {
      setLoadingAnchoredThreads(false)
    }
  }, [status.activeChangeSetId, status.codebaseId])

  React.useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadAnchoredThreads()
    }, 0)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [loadAnchoredThreads])

  async function createFollowupIssue() {
    if (!status.codebaseId || !selectedFile || !canCreateFollowup) return

    setCreatingFollowup(true)
    setFollowupMessage(null)
    const lineSuffix = selectedLineForFile ? `:${selectedLineForFile}` : ''
    try {
      const result = await createCollaborationItem({
        type: 'issue',
        codebaseId: status.codebaseId,
        title: `Review ${selectedFile.path}${lineSuffix}`,
        body: [
          `Path: ${selectedFile.path}${lineSuffix}`,
          `Active change set: ${status.activeChangeSetId}`,
          `Base: ${status.mainRevision}`,
          `Head: ${status.cloudRevision}`,
          `File revision: ${selectedFile.revision ?? 'unknown'}`,
          `Review state: ${status.reviewState}`,
        ].join('\n'),
        priority: selectedRow?.state === 'changed' ? 'medium' : 'low',
        labels: ['review', 'code-browser'],
        linkedChangeSetId: status.activeChangeSetId === 'None' ? undefined : status.activeChangeSetId,
        createdBy: status.requester.id ?? 'browser-ui',
      })
      setFollowupMessage(result.ok ? 'Follow-up issue created.' : (result.error?.message ?? 'Issue create failed.'))
      if (result.ok) setWorkItems(result)
    } catch (error) {
      setFollowupMessage(error instanceof Error ? error.message : 'Issue create failed.')
    } finally {
      setCreatingFollowup(false)
    }
  }

  async function addReviewComment(issue: CollaborationIssue) {
    const body = commentDrafts[issue.id]?.trim()
    if (!status.codebaseId || !body || !status.requester.permissions.includes('write')) return

    setCommentingIssueId(issue.id)
    setFollowupMessage(null)
    try {
      const result = await createCollaborationItem({
        type: 'issueComment',
        codebaseId: status.codebaseId,
        issueId: issue.id,
        body,
        createdBy: status.requester.id ?? 'browser-ui',
      })
      setWorkItems(result)
      setFollowupMessage(result.ok ? 'Review comment added.' : (result.error?.message ?? 'Review comment failed.'))
      if (result.ok) {
        setCommentDrafts((current) => ({ ...current, [issue.id]: '' }))
      }
    } catch (error) {
      setFollowupMessage(error instanceof Error ? error.message : 'Review comment failed.')
    } finally {
      setCommentingIssueId(null)
    }
  }

  async function createAnchoredThread() {
    const body = threadDraft.trim()
    if (!status.codebaseId || !selectedFile || !canCreateAnchoredThread || !body) return

    setCreatingThread(true)
    setThreadMessage(null)
    try {
      const result = await createReviewThread({
        codebaseId: status.codebaseId,
        changeSetId: status.activeChangeSetId,
        filePath: selectedFile.path,
        lineNumber: selectedLineForFile,
        baseRevision: status.mainRevision,
        headRevision: status.cloudRevision,
        lineFingerprint: reviewLineFingerprint(selectedFile, selectedLineForFile),
        body,
        createdBy: status.requester.id ?? 'browser-ui',
      })
      setReviewThreads(result.threads)
      setThreadMessage(result.ok ? 'Inline review thread created.' : (result.error?.message ?? 'Review thread failed.'))
      if (result.ok) setThreadDraft('')
    } catch (error) {
      setThreadMessage(error instanceof Error ? error.message : 'Review thread failed.')
    } finally {
      setCreatingThread(false)
    }
  }

  async function addThreadComment(thread: ReviewThread) {
    const body = threadCommentDrafts[thread.id]?.trim()
    if (!status.codebaseId || !body || !canWrite) return

    setCommentingThreadId(thread.id)
    setThreadMessage(null)
    try {
      const result = await createReviewThreadComment({
        codebaseId: status.codebaseId,
        changeSetId: status.activeChangeSetId === 'None' ? null : status.activeChangeSetId,
        threadId: thread.id,
        body,
        createdBy: status.requester.id ?? 'browser-ui',
      })
      setReviewThreads(result.threads)
      setThreadMessage(result.ok ? 'Inline review comment added.' : (result.error?.message ?? 'Review comment failed.'))
      if (result.ok) {
        setThreadCommentDrafts((current) => ({ ...current, [thread.id]: '' }))
      }
    } catch (error) {
      setThreadMessage(error instanceof Error ? error.message : 'Review comment failed.')
    } finally {
      setCommentingThreadId(null)
    }
  }

  async function resolveThread(thread: ReviewThread) {
    if (!status.codebaseId || !canWrite) return

    setResolvingThreadId(thread.id)
    setThreadMessage(null)
    try {
      const result = await resolveReviewThread({
        codebaseId: status.codebaseId,
        changeSetId: status.activeChangeSetId === 'None' ? null : status.activeChangeSetId,
        threadId: thread.id,
        updatedBy: status.requester.id ?? 'browser-ui',
      })
      setReviewThreads(result.threads)
      setThreadMessage(result.ok ? 'Inline review thread resolved.' : (result.error?.message ?? 'Review resolve failed.'))
    } catch (error) {
      setThreadMessage(error instanceof Error ? error.message : 'Review resolve failed.')
    } finally {
      setResolvingThreadId(null)
    }
  }

  return (
    <section className="panel-surface overflow-hidden rounded-xl border border-border shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border/60 p-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-md bg-ink text-ink-foreground">
              <Code2 className="size-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold">Code review</h2>
              <p className="text-xs text-muted-foreground">
                {status.activeChangeSetId} against {status.mainRevision}
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <ReviewMetric
            icon={GitPullRequest}
            label="Review"
            value={status.reviewState}
            tone={status.reviewState === 'open' ? 'active' : 'neutral'}
          />
          <ReviewMetric
            icon={GitCompareArrows}
            label="Files"
            value={changedFileCount.toString()}
            tone={changedFileCount > 0 ? 'active' : 'neutral'}
          />
          <ReviewMetric
            icon={MessageSquareText}
            label="Follow-ups"
            value={canCreateFollowup ? 'Issue ready' : 'Read-only'}
            tone={canCreateFollowup ? 'active' : 'neutral'}
          />
          <ReviewMetric
            icon={GitMerge}
            label="Merge"
            value={status.mergeState}
            tone={status.mergeState === 'merged' ? 'active' : 'neutral'}
          />
        </div>
      </div>

      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(240px,0.85fr)_minmax(0,1.6fr)_minmax(250px,0.8fr)]">
        <div className="min-w-0 rounded-lg border border-border/60 bg-muted/20">
          <div className="border-b border-border/60 px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="flex min-w-0 items-center gap-1.5 text-xs font-semibold">
                <FileCode2 className="size-3.5 text-hop" />
                <span className="truncate">Review files</span>
              </p>
              <span className="shrink-0 rounded-md bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground ring-1 ring-border/60">
                {filteredRows.length}
              </span>
            </div>
            <div className="mt-2 flex items-center gap-1 rounded-md border border-border/60 bg-card px-2 py-1.5">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                value={fileQuery}
                onChange={(event) => setFileQuery(event.target.value)}
                placeholder="Filter paths"
                className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="mt-2 grid grid-cols-3 gap-1">
              <FileFilterButton
                active={fileFilter === 'changed'}
                label="Changed"
                count={changedFileCount}
                onClick={() => setFileFilter('changed')}
              />
              <FileFilterButton
                active={fileFilter === 'shared'}
                label="Shared"
                count={sharedFileCount}
                onClick={() => setFileFilter('shared')}
              />
              <FileFilterButton
                active={fileFilter === 'private'}
                label="Private"
                count={privateFileCount}
                onClick={() => setFileFilter('private')}
              />
            </div>
          </div>
          {filteredRows.length > 0 ? (
            <div className="max-h-[360px] overflow-auto p-2 scroll-thin">
              {filteredRows.map((row) => (
                <button
                  key={row.file.path}
                  type="button"
                  onClick={() => {
                    setSelectedPath(row.file.path)
                    setSelectedLine(null)
                  }}
                  className={cn(
                    'mb-1 w-full rounded-md px-2.5 py-2 text-left transition',
                    selectedFile?.path === row.file.path
                      ? 'bg-card text-foreground ring-1 ring-hop/30'
                      : 'text-muted-foreground hover:bg-card/70 hover:text-foreground',
                  )}
                >
                  <span className="flex min-w-0 items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium">{row.file.name}</span>
                    <ReviewFileBadge state={row.state} />
                  </span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10.5px]">
                    <span className="truncate">{row.file.directory}</span>
                    <span className="shrink-0">rev {row.file.revision ?? 'n/a'}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="p-4 text-sm">
              <p className="font-medium">No files match this view</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {status.state === 'offline'
                  ? 'Local status is offline.'
                  : 'Try another filter or search term.'}
              </p>
            </div>
          )}
        </div>

        <div className="min-w-0 overflow-hidden rounded-lg border border-border/60 bg-background/60">
          <div className="flex flex-col gap-2 border-b border-border/60 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="truncate font-mono text-xs font-semibold">
                {selectedFile?.path ?? 'No file selected'}
              </p>
              <p className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
                Base {status.mainRevision} · Head {status.cloudRevision}
                {selectedLineForFile ? ` · line ${selectedLineForFile}` : ''}
              </p>
            </div>
            {selectedRow ? <ReviewFileBadge state={selectedRow.state} size="lg" /> : null}
          </div>
          <CodePreview
            file={selectedFile}
            selectedLine={selectedLineForFile}
            onSelectLine={(line) => {
              if (selectedFile) setSelectedPath(selectedFile.path)
              setSelectedLine(line)
            }}
          />
        </div>

        <div className="space-y-3">
          <SelectedFileCard
            row={selectedRow}
            selectedLine={selectedLineForFile}
            status={status}
            canCreateFollowup={canCreateFollowup}
            creatingFollowup={creatingFollowup}
            followupMessage={followupMessage}
            onCreateFollowup={() => void createFollowupIssue()}
          />
          <AnchoredReviewThreadsCard
            threads={selectedFileThreads}
            totalThreads={reviewThreads.length}
            selectedFile={selectedFile}
            selectedLine={selectedLineForFile}
            loading={loadingAnchoredThreads}
            canCreate={canCreateAnchoredThread}
            canComment={canWrite}
            draft={threadDraft}
            message={threadMessage}
            creating={creatingThread}
            commentDrafts={threadCommentDrafts}
            commentingThreadId={commentingThreadId}
            resolvingThreadId={resolvingThreadId}
            onDraftChange={setThreadDraft}
            onCreate={() => void createAnchoredThread()}
            onRefresh={() => void loadAnchoredThreads()}
            onCommentDraftChange={(thread, value) => setThreadCommentDrafts((current) => ({ ...current, [thread.id]: value }))}
            onAddComment={(thread) => void addThreadComment(thread)}
            onResolve={(thread) => void resolveThread(thread)}
          />
          <ReviewThreadsCard
            issues={reviewIssues}
            loading={loadingThreads}
            canComment={canWrite}
            commentDrafts={commentDrafts}
            commentingIssueId={commentingIssueId}
            onRefresh={() => void loadReviewThreads()}
            onCommentDraftChange={(issue, value) => setCommentDrafts((current) => ({ ...current, [issue.id]: value }))}
            onAddComment={(issue) => void addReviewComment(issue)}
          />
          <ReviewStateCard status={status} privateFileCount={privateFileCount} />
          <HistoryCard events={reviewEvents} />
        </div>
      </div>
    </section>
  )
}

function FileFilterButton({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean
  label: string
  count: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'min-w-0 rounded-md px-1.5 py-1 text-[10.5px] font-medium transition',
        active
          ? 'bg-hop/10 text-hop ring-1 ring-hop/20'
          : 'bg-card text-muted-foreground ring-1 ring-border/50 hover:text-foreground',
      )}
    >
      <span className="block truncate">{label}</span>
      <span className="block text-[10px] opacity-70">{count}</span>
    </button>
  )
}

function ReviewFileBadge({
  state,
  size = 'sm',
}: {
  state: ReviewFileState
  size?: 'sm' | 'lg'
}) {
  const labels: Record<ReviewFileState, string> = {
    changed: 'changed',
    'same-as-main': 'main',
    unknown: 'visible',
    private: 'private',
  }

  return (
    <span
      className={cn(
        'shrink-0 rounded-md font-medium ring-1 ring-inset',
        size === 'lg' ? 'px-2 py-1 text-[11px]' : 'px-1.5 py-0.5 text-[10px]',
        state === 'changed'
          ? 'bg-hop/10 text-hop ring-hop/20'
          : state === 'private'
            ? 'bg-hop-amber/10 text-hop-amber ring-hop-amber/20'
            : 'bg-muted text-muted-foreground ring-border/60',
      )}
    >
      {labels[state]}
    </span>
  )
}

function SelectedFileCard({
  row,
  selectedLine,
  status,
  canCreateFollowup,
  creatingFollowup,
  followupMessage,
  onCreateFollowup,
}: {
  row: ReviewFileRow | null
  selectedLine: number | null
  status: AgentStatusSnapshot
  canCreateFollowup: boolean
  creatingFollowup: boolean
  followupMessage: string | null
  onCreateFollowup: () => void
}) {
  const file = row?.file ?? null

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold">
        <FileDiff className="size-3.5 text-hop" />
        File context
      </p>
      {file ? (
        <>
          <dl className="mt-3 space-y-2 text-[11px]">
            <ReviewDatum label="Path" value={selectedLine ? `${file.path}:${selectedLine}` : file.path} />
            <ReviewDatum label="Directory" value={file.directory} />
            <ReviewDatum label="Scope" value={file.scope} highlight={file.scope === 'owner-private'} />
            <ReviewDatum label="Revision" value={file.revision?.toString() ?? 'unknown'} />
            <ReviewDatum label="Hash" value={file.hash ?? 'unavailable'} />
          </dl>
          <div className="mt-3 rounded-lg bg-card p-2.5 ring-1 ring-border/50">
            <p className="text-[11px] font-medium">Review anchor</p>
            <p className="mt-1 break-words font-mono text-[10.5px] text-muted-foreground">
              {status.activeChangeSetId} · {status.mainRevision} to {status.cloudRevision}
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canCreateFollowup || creatingFollowup}
              className="mt-2 h-8 w-full justify-start rounded-lg text-xs"
              onClick={onCreateFollowup}
            >
              {creatingFollowup ? <Loader2 className="size-3.5 animate-spin" /> : <MessageSquareText className="size-3.5" />}
              Create follow-up issue
            </Button>
            {!canCreateFollowup ? (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Follow-up issues require write access to a shared file.
              </p>
            ) : null}
            {followupMessage ? (
              <p className="mt-2 rounded-md bg-muted/60 px-2 py-1.5 text-[11px] text-muted-foreground">
                {followupMessage}
              </p>
            ) : null}
          </div>
        </>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">Select a visible file to inspect review metadata.</p>
      )}
    </div>
  )
}

function ReviewMetric({ icon: Icon, label, value, tone }: ReviewMetricProps) {
  return (
    <div
      className={cn(
        'min-w-0 rounded-lg px-3 py-2 border transition duration-200',
        tone === 'active'
          ? 'bg-primary/8 text-primary border-primary/20 shadow-sm'
          : 'bg-muted/40 text-muted-foreground border-border/60',
      )}
    >
      <p className="flex items-center gap-1.5 text-[9.5px] font-bold tracking-wide uppercase text-muted-foreground">
        <Icon className="size-3 shrink-0 text-primary" />
        <span className="truncate">{label}</span>
      </p>
      <p className="mt-1 truncate text-xs font-bold text-foreground">{value}</p>
    </div>
  )
}

function AnchoredReviewThreadsCard({
  threads,
  totalThreads,
  selectedFile,
  selectedLine,
  loading,
  canCreate,
  canComment,
  draft,
  message,
  creating,
  commentDrafts,
  commentingThreadId,
  resolvingThreadId,
  onDraftChange,
  onCreate,
  onRefresh,
  onCommentDraftChange,
  onAddComment,
  onResolve,
}: {
  threads: ReviewThread[]
  totalThreads: number
  selectedFile: AgentFile | null
  selectedLine: number | null
  loading: boolean
  canCreate: boolean
  canComment: boolean
  draft: string
  message: string | null
  creating: boolean
  commentDrafts: Record<string, string>
  commentingThreadId: string | null
  resolvingThreadId: string | null
  onDraftChange: (value: string) => void
  onCreate: () => void
  onRefresh: () => void
  onCommentDraftChange: (thread: ReviewThread, value: string) => void
  onAddComment: (thread: ReviewThread) => void
  onResolve: (thread: ReviewThread) => void
}) {
  const openThreads = threads.filter((thread) => thread.status === 'open')

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold">
          <MessageSquareText className="size-3.5 text-hop" />
          Inline threads
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={loading}
          className="h-7 rounded-md px-2 text-[11px]"
          onClick={onRefresh}
        >
          <RefreshCcw className={cn('size-3.5', loading && 'animate-spin')} />
          {totalThreads}
        </Button>
      </div>

      <div className="mt-3 rounded-lg bg-card p-2.5 ring-1 ring-border/50">
        <p className="text-[11px] font-medium">
          {selectedFile ? selectedFile.path : 'No file selected'}
          {selectedLine ? `:${selectedLine}` : ''}
        </p>
        <textarea
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          disabled={!canCreate || creating}
          rows={3}
          placeholder="Start an inline review thread"
          className="mt-2 h-auto w-full resize-none rounded-lg border border-border/60 bg-muted/40 px-2 py-1.5 text-xs outline-none transition placeholder:text-muted-foreground focus:border-hop/40 focus:ring-2 focus:ring-hop/20 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <Button
          type="button"
          size="sm"
          disabled={!canCreate || creating || !draft.trim()}
          className="mt-2 h-8 w-full justify-start rounded-lg text-xs"
          onClick={onCreate}
        >
          {creating ? <Loader2 className="size-3.5 animate-spin" /> : <MessageSquareText className="size-3.5" />}
          Start thread
        </Button>
        {!canCreate ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Inline threads require write access, a selected shared file, and an active change set.
          </p>
        ) : null}
        {message ? (
          <p className="mt-2 rounded-md bg-muted/60 px-2 py-1.5 text-[11px] text-muted-foreground">{message}</p>
        ) : null}
      </div>

      {loading ? (
        <p className="mt-2 text-xs text-muted-foreground">Loading inline review threads.</p>
      ) : threads.length > 0 ? (
        <ol className="mt-3 max-h-72 space-y-2 overflow-auto scroll-thin">
          {threads.map((thread) => {
            const draftValue = commentDrafts[thread.id] ?? ''
            const isCommenting = commentingThreadId === thread.id
            const isResolving = resolvingThreadId === thread.id
            const recentComments = thread.comments.slice(-2)

            return (
              <li key={thread.id} className="rounded-lg bg-card p-2.5 ring-1 ring-border/50">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold">
                      {thread.filePath}{thread.lineNumber ? `:${thread.lineNumber}` : ''}
                    </p>
                    <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                      {thread.status} - {thread.comments.length} comments
                    </p>
                  </div>
                  <span className={cn(
                    'shrink-0 rounded-md px-1.5 py-0.5 text-[10px] ring-1 ring-inset',
                    thread.status === 'open'
                      ? 'bg-hop/10 text-hop ring-hop/20'
                      : 'bg-muted text-muted-foreground ring-border/60',
                  )}>
                    {thread.status}
                  </span>
                </div>
                {recentComments.length > 0 ? (
                  <ol className="mt-2 space-y-1.5">
                    {recentComments.map((comment) => (
                      <li key={comment.id} className="rounded-md bg-muted/50 px-2 py-1.5">
                        <p className="line-clamp-2 text-[11px]">{comment.body}</p>
                        <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                          {comment.createdBy} - {formatDate(comment.createdAt)}
                        </p>
                      </li>
                    ))}
                  </ol>
                ) : null}
                {thread.status === 'open' ? (
                  <div className="mt-2 grid gap-1.5">
                    <textarea
                      value={draftValue}
                      onChange={(event) => onCommentDraftChange(thread, event.target.value)}
                      disabled={!canComment || isCommenting}
                      rows={2}
                      placeholder="Reply to thread"
                      className="h-auto resize-none rounded-lg border border-border/60 bg-muted/40 px-2 py-1.5 text-xs outline-none transition placeholder:text-muted-foreground focus:border-hop/40 focus:ring-2 focus:ring-hop/20 disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <div className="flex gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!canComment || isCommenting || !draftValue.trim()}
                        className="h-7 flex-1 justify-start rounded-md text-[11px]"
                        onClick={() => onAddComment(thread)}
                      >
                        {isCommenting ? <Loader2 className="size-3.5 animate-spin" /> : <MessageSquareText className="size-3.5" />}
                        Reply
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!canComment || isResolving}
                        className="h-7 rounded-md px-2 text-[11px]"
                        onClick={() => onResolve(thread)}
                      >
                        {isResolving ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
                        Resolve
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          {openThreads.length === 0 ? 'No inline threads for this file yet.' : 'No matching inline threads.'}
        </p>
      )}
    </div>
  )
}

function ReviewThreadsCard({
  issues,
  loading,
  canComment,
  commentDrafts,
  commentingIssueId,
  onRefresh,
  onCommentDraftChange,
  onAddComment,
}: {
  issues: CollaborationIssue[]
  loading: boolean
  canComment: boolean
  commentDrafts: Record<string, string>
  commentingIssueId: string | null
  onRefresh: () => void
  onCommentDraftChange: (issue: CollaborationIssue, value: string) => void
  onAddComment: (issue: CollaborationIssue) => void
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold">
          <MessageSquareText className="size-3.5 text-hop" />
          Review comments
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={loading}
          className="h-7 rounded-md px-2 text-[11px]"
          onClick={onRefresh}
        >
          <RefreshCcw className={cn('size-3.5', loading && 'animate-spin')} />
        </Button>
      </div>
      {loading ? (
        <p className="mt-2 text-xs text-muted-foreground">Loading review threads.</p>
      ) : issues.length > 0 ? (
        <ol className="mt-3 space-y-2">
          {issues.slice(0, 5).map((issue) => {
            const draft = commentDrafts[issue.id] ?? ''
            const isSubmitting = commentingIssueId === issue.id
            const recentComments = issue.comments.slice(-2)

            return (
              <li key={issue.id} className="rounded-lg bg-card p-2.5 ring-1 ring-border/50">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="line-clamp-2 text-xs font-semibold">#{issue.number} {issue.title}</p>
                    <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                      {issue.status} - {issue.comments.length} comments
                    </p>
                  </div>
                  <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {issue.priority ?? 'review'}
                  </span>
                </div>
                {recentComments.length > 0 ? (
                  <ol className="mt-2 space-y-1.5">
                    {recentComments.map((comment) => (
                      <li key={comment.id} className="rounded-md bg-muted/50 px-2 py-1.5">
                        <p className="line-clamp-2 text-[11px]">{comment.body}</p>
                        <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                          {comment.createdBy} - {formatDate(comment.createdAt)}
                        </p>
                      </li>
                    ))}
                  </ol>
                ) : null}
                <div className="mt-2 grid gap-1.5">
                  <textarea
                    value={draft}
                    onChange={(event) => onCommentDraftChange(issue, event.target.value)}
                    disabled={!canComment || isSubmitting}
                    rows={2}
                    placeholder="Add review comment"
                    className="h-auto resize-none rounded-lg border border-border/60 bg-muted/40 px-2 py-1.5 text-xs outline-none transition placeholder:text-muted-foreground focus:border-hop/40 focus:ring-2 focus:ring-hop/20 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!canComment || isSubmitting || !draft.trim()}
                    className="h-7 justify-start rounded-md text-[11px]"
                    onClick={() => onAddComment(issue)}
                  >
                    {isSubmitting ? <Loader2 className="size-3.5 animate-spin" /> : <MessageSquareText className="size-3.5" />}
                    Comment
                  </Button>
                </div>
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">No durable review follow-ups yet.</p>
      )}
    </div>
  )
}

function CodePreview({
  file,
  selectedLine,
  onSelectLine,
}: {
  file: AgentFile | null
  selectedLine: number | null
  onSelectLine: (line: number) => void
}) {
  if (!file) {
    return (
      <div className="flex min-h-[330px] items-center justify-center p-6 text-center">
        <p className="text-sm text-muted-foreground">No preview available.</p>
      </div>
    )
  }

  if (!file.contentPreview) {
    return (
      <div className="flex min-h-[330px] items-center justify-center p-6 text-center">
        <div>
          <Lock className="mx-auto size-5 text-muted-foreground" />
          <p className="mt-2 text-sm font-bold text-foreground">Metadata only</p>
          <p className="mt-1 text-xs text-muted-foreground">
            This path is not rendered in the review preview.
          </p>
        </div>
      </div>
    )
  }

  const lines = file.contentPreview.split('\n').slice(0, 80)

  return (
    <div className="max-h-[420px] overflow-auto bg-slate-950 text-slate-100 rounded-lg border border-border/40 scroll-thin shadow-inner">
      <div className="min-w-full p-4 font-mono text-[11px] leading-relaxed">
        {lines.map((line, index) => {
          const lineNumber = index + 1
          const isActive = selectedLine === lineNumber

          return (
            <button
              key={`${file.path}-${lineNumber}`}
              type="button"
              onClick={() => onSelectLine(lineNumber)}
              className={cn(
                'grid w-full grid-cols-[2.5rem_minmax(0,1fr)] gap-3.5 rounded px-2.5 py-0.5 text-left transition duration-150 cursor-pointer',
                isActive
                  ? 'bg-primary/20 text-white border-l-2 border-primary font-medium'
                  : 'hover:bg-white/8 text-slate-100',
              )}
            >
              <span className={cn(
                'select-none text-right font-semibold',
                isActive ? 'text-primary' : 'text-slate-400'
              )}>{lineNumber}</span>
              <code className="min-w-0 whitespace-pre-wrap break-words">{line || ' '}</code>
            </button>
          )
        })}
        {file.contentPreviewTruncated ? (
          <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-3.5 px-2.5 py-1 text-hop-amber">
            <span className="select-none text-right text-slate-400">...</span>
            <span className="font-semibold text-[10px] uppercase tracking-wider">Preview truncated</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

type ReviewMetricProps = {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  tone: 'active' | 'neutral'
}

function ReviewStateCard({
  status,
  privateFileCount,
}: {
  status: AgentStatusSnapshot
  privateFileCount: number
}) {
  const conflicted = status.conflictState !== 'none' && status.conflictState !== 'Unavailable'
  const hasPendingWrites = status.pendingWrites > 0 || status.failedWrites > 0

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold">
        {conflicted ? (
          <AlertTriangle className="size-3.5 text-destructive" />
        ) : (
          <ShieldCheck className="size-3.5 text-hop" />
        )}
        Review readiness
      </p>
      <dl className="mt-3 space-y-2 text-[11px]">
        <ReviewDatum label="Visibility" value={status.visibility} />
        <ReviewDatum label="Conflict" value={status.conflictState} highlight={conflicted} />
        <ReviewDatum
          label="Writes"
          value={`${status.pendingWrites} pending / ${status.failedWrites} failed`}
          highlight={hasPendingWrites}
        />
        <ReviewDatum label="Remote update" value={status.remoteUpdateState} />
        <ReviewDatum label="Private paths" value={`${privateFileCount} metadata only`} />
      </dl>
    </div>
  )
}

function ReviewDatum({
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
      <dd className={cn('min-w-0 truncate font-medium', highlight && 'text-destructive')}>
        {value}
      </dd>
    </div>
  )
}

function HistoryCard({ events }: { events: AgentStatusSnapshot['events'] }) {
  const visibleEvents = events.slice(0, 4)

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold">
        <History className="size-3.5 text-grape" />
        History signals
      </p>
      {visibleEvents.length > 0 ? (
        <ol className="mt-3 space-y-2">
          {visibleEvents.map((event) => (
            <li key={event.id} className="rounded-lg bg-card px-2.5 py-2 ring-1 ring-border/50">
              <div className="flex items-start justify-between gap-2">
                <span className="truncate font-mono text-[10px] font-medium">{event.label}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{event.when}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{event.detail}</p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">No review history yet.</p>
      )}
    </div>
  )
}

function reviewFileRows(files: AgentFile[], mainRevision: number | null): ReviewFileRow[] {
  return files
    .map((file) => ({
      file,
      state: reviewStateForFile(file, mainRevision),
    }))
    .sort((a, b) => {
      if (a.state === 'changed' && b.state !== 'changed') return -1
      if (a.state !== 'changed' && b.state === 'changed') return 1
      if (a.file.scope !== b.file.scope) return a.file.scope === 'shared' ? -1 : 1
      return a.file.path.localeCompare(b.file.path)
    })
}

function filterReviewRows(
  rows: ReviewFileRow[],
  filter: ReviewFileFilter,
  query: string,
): ReviewFileRow[] {
  const normalizedQuery = query.trim().toLowerCase()

  return rows.filter((row) => {
    if (filter === 'changed' && row.state !== 'changed') return false
    if (filter === 'shared' && row.file.scope !== 'shared') return false
    if (filter === 'private' && row.file.scope !== 'owner-private') return false
    return matchesReviewQuery(row.file, normalizedQuery)
  })
}

function reviewStateForFile(file: AgentFile, mainRevision: number | null): ReviewFileState {
  if (file.scope === 'owner-private') return 'private'
  if (mainRevision === null || typeof file.revision !== 'number') return 'unknown'
  return file.revision > mainRevision ? 'changed' : 'same-as-main'
}

function matchesReviewQuery(file: AgentFile, normalizedQuery: string) {
  if (!normalizedQuery) return true
  return `${file.path} ${file.directory} ${file.name}`.toLowerCase().includes(normalizedQuery)
}

function isReviewHistoryEvent(label: string) {
  return /review|merge|merged|conflict|remote[-_.]update|sync|acknowledged/.test(label.toLowerCase())
}

function reviewLinkedIssues(issues: CollaborationIssue[], activeChangeSetId: string) {
  return issues
    .filter((issue) => {
      if (issue.labels.includes('review') || issue.labels.includes('code-browser')) return true
      return activeChangeSetId !== 'None' && issue.linkedChangeSetId === activeChangeSetId
    })
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt))
}

function reviewLineFingerprint(file: AgentFile, line: number | null) {
  return [
    file.hash ?? 'hash-unavailable',
    file.revision?.toString() ?? 'rev-unavailable',
    line?.toString() ?? 'file',
  ].join(':')
}

function formatDate(value: string) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return 'unknown'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function revisionNumber(revision: string) {
  const match = revision.match(/\d+/)
  return match ? Number(match[0]) : null
}

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
  Search,
  ShieldCheck,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { createCollaborationItem } from '@/lib/collaboration'
import type { AgentFile, AgentStatusSnapshot } from '@/lib/agent-status'

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
  const canCreateFollowup =
    Boolean(status.codebaseId) &&
    selectedFile?.scope === 'shared' &&
    status.requester.permissions.includes('write')

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
    } catch (error) {
      setFollowupMessage(error instanceof Error ? error.message : 'Issue create failed.')
    } finally {
      setCreatingFollowup(false)
    }
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border/60 p-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-ink text-ink-foreground">
              <Code2 className="size-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold tracking-tight">Code review</h2>
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
        <div className="min-w-0 rounded-xl border border-border/60 bg-muted/20">
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
            <div className="mt-2 flex items-center gap-1 rounded-lg border border-border/60 bg-card px-2 py-1.5">
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
                    'mb-1 w-full rounded-lg px-2.5 py-2 text-left transition',
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

        <div className="min-w-0 overflow-hidden rounded-xl border border-border/60 bg-background/60">
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
    <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
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
        'min-w-0 rounded-lg px-2.5 py-2 ring-1 ring-inset',
        tone === 'active'
          ? 'bg-hop/10 text-hop ring-hop/20'
          : 'bg-muted/35 text-muted-foreground ring-border/60',
      )}
    >
      <p className="flex items-center gap-1.5 text-[10.5px]">
        <Icon className="size-3 shrink-0" />
        <span className="truncate">{label}</span>
      </p>
      <p className="mt-1 truncate text-xs font-semibold text-foreground">{value}</p>
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
          <p className="mt-2 text-sm font-medium">Metadata only</p>
          <p className="mt-1 text-xs text-muted-foreground">
            This path is not rendered in the review preview.
          </p>
        </div>
      </div>
    )
  }

  const lines = file.contentPreview.split('\n').slice(0, 80)

  return (
    <div className="max-h-[420px] overflow-auto bg-ink text-ink-foreground scroll-thin">
      <div className="min-w-full p-3 font-mono text-[11px] leading-relaxed">
        {lines.map((line, index) => {
          const lineNumber = index + 1

          return (
            <button
              key={`${file.path}-${lineNumber}`}
              type="button"
              onClick={() => onSelectLine(lineNumber)}
              className={cn(
                'grid w-full grid-cols-[2.25rem_minmax(0,1fr)] gap-3 rounded px-1 text-left transition',
                selectedLine === lineNumber && 'bg-hop/15 text-white',
              )}
            >
              <span className="select-none text-right text-ink-foreground/35">{lineNumber}</span>
              <code className="min-w-0 whitespace-pre-wrap break-words">{line || ' '}</code>
            </button>
          )
        })}
        {file.contentPreviewTruncated ? (
          <div className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-3 px-1 text-hop-amber">
            <span className="select-none text-right text-ink-foreground/35">...</span>
            <span>Preview truncated</span>
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
    <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
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
    <div className="rounded-xl border border-border/60 bg-muted/20 p-3">
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

function revisionNumber(revision: string) {
  const match = revision.match(/\d+/)
  return match ? Number(match[0]) : null
}

'use client'

import * as React from 'react'
import {
  AlertTriangle,
  Code2,
  FileCode2,
  GitCompareArrows,
  GitMerge,
  GitPullRequest,
  History,
  Lock,
  MessageSquareText,
  ShieldCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AgentFile, AgentStatusSnapshot } from '@/lib/agent-status'

type CodeReviewSectionProps = {
  status: AgentStatusSnapshot
}

export function CodeReviewSection({ status }: CodeReviewSectionProps) {
  const mainRevision = revisionNumber(status.mainRevision)
  const reviewFiles = React.useMemo(
    () => reviewableFiles(status.files, mainRevision),
    [mainRevision, status.files],
  )
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null)
  const selectedFile =
    reviewFiles.find((file) => file.path === selectedPath) ?? reviewFiles[0] ?? null
  const privateFileCount = status.files.filter((file) => file.scope === 'owner-private').length
  const changedFileCount = reviewFiles.filter((file) =>
    mainRevision === null ? true : (file.revision ?? 0) > mainRevision,
  ).length
  const reviewEvents = status.events.filter((event) =>
    /review|merged|conflict|remote-update|sync|acknowledged/.test(event.label),
  )

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
            label="Comments"
            value="Planned"
            tone="neutral"
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
          <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2.5">
            <p className="flex min-w-0 items-center gap-1.5 text-xs font-semibold">
              <FileCode2 className="size-3.5 text-hop" />
              <span className="truncate">Review files</span>
            </p>
            <span className="shrink-0 rounded-md bg-card px-1.5 py-0.5 text-[10px] text-muted-foreground ring-1 ring-border/60">
              {reviewFiles.length}
            </span>
          </div>
          {reviewFiles.length > 0 ? (
            <div className="max-h-[360px] overflow-auto p-2 scroll-thin">
              {reviewFiles.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => setSelectedPath(file.path)}
                  className={cn(
                    'mb-1 w-full rounded-lg px-2.5 py-2 text-left transition',
                    selectedFile?.path === file.path
                      ? 'bg-card text-foreground ring-1 ring-hop/30'
                      : 'text-muted-foreground hover:bg-card/70 hover:text-foreground',
                  )}
                >
                  <span className="block truncate text-xs font-medium">{file.name}</span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10.5px]">
                    <span className="truncate">{file.directory}</span>
                    <span className="shrink-0">rev {file.revision ?? 'n/a'}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="p-4 text-sm">
              <p className="font-medium">No shared files visible</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {status.state === 'offline'
                  ? 'Local status is offline.'
                  : 'The current visible graph has no shared review paths.'}
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
              </p>
            </div>
            {selectedFile ? (
              <span className="shrink-0 rounded-md bg-hop/10 px-1.5 py-0.5 text-[10px] font-medium text-hop">
                {formatBytes(selectedFile.size)}
              </span>
            ) : null}
          </div>
          <CodePreview file={selectedFile} />
        </div>

        <div className="space-y-3">
          <ReviewStateCard status={status} privateFileCount={privateFileCount} />
          <HistoryCard events={reviewEvents} />
        </div>
      </div>
    </section>
  )
}

type ReviewMetricProps = {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  tone: 'active' | 'neutral'
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

function CodePreview({ file }: { file: AgentFile | null }) {
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
      <pre className="min-w-full p-3 text-[11px] leading-relaxed">
        {lines.map((line, index) => (
          <code key={`${file.path}-${index}`} className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-3">
            <span className="select-none text-right text-ink-foreground/35">{index + 1}</span>
            <span className="min-w-0 whitespace-pre-wrap break-words">{line || ' '}</span>
          </code>
        ))}
        {file.contentPreviewTruncated ? (
          <code className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-3 text-hop-amber">
            <span className="select-none text-right text-ink-foreground/35">...</span>
            <span>Preview truncated</span>
          </code>
        ) : null}
      </pre>
    </div>
  )
}

function ReviewStateCard({
  status,
  privateFileCount,
}: {
  status: AgentStatusSnapshot
  privateFileCount: number
}) {
  const conflicted = status.conflictState !== 'none' && status.conflictState !== 'Unavailable'

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

function reviewableFiles(files: AgentFile[], mainRevision: number | null) {
  const sharedFiles = files.filter((file) => file.scope === 'shared')
  const changedFiles =
    mainRevision === null
      ? []
      : sharedFiles.filter((file) => typeof file.revision === 'number' && file.revision > mainRevision)

  return (changedFiles.length > 0 ? changedFiles : sharedFiles).sort((a, b) =>
    a.path.localeCompare(b.path),
  )
}

function revisionNumber(revision: string) {
  const match = revision.match(/\d+/)
  return match ? Number(match[0]) : null
}

function formatBytes(bytes: number | null) {
  if (bytes === null) return 'unknown'
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

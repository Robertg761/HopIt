'use client'

import * as React from 'react'
import { ArrowDownLeft, ArrowUpRight, Files, GitPullRequest } from 'lucide-react'

import { Badge, type BadgeTone } from '@/components/ui/badge'
import type { AgentStatusSnapshot } from '@/lib/client/agent-status'
import { formatCount } from '@/lib/client/format'

function reviewTone(reviewState: string): BadgeTone {
  return reviewState === 'open' ? 'iris' : 'outline'
}

export function StatTiles({ status }: { status: AgentStatusSnapshot }) {
  const behind = status.remoteBehindByRevisions

  return (
    <section aria-label="Workspace at a glance" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile label="Files" icon={Files}>
        <strong className="text-2xl font-semibold tabular-nums">{formatCount(status.fileCount)}</strong>
        <span className="text-xs text-muted-foreground">
          {status.hiddenFileCount > 0 ? `+${formatCount(status.hiddenFileCount)} private` : 'Tracked'}
        </span>
      </StatTile>
      <StatTile label="Pending writes" icon={ArrowUpRight}>
        <strong className="text-2xl font-semibold tabular-nums">{formatCount(status.pendingWrites)}</strong>
        <span className="text-xs text-muted-foreground">
          {status.failedWrites > 0 ? `${formatCount(status.failedWrites)} failed` : 'Journal clear'}
        </span>
      </StatTile>
      <StatTile label="Behind remote" icon={ArrowDownLeft}>
        <strong className="text-2xl font-semibold tabular-nums">{behind === null ? '—' : formatCount(behind)}</strong>
        <span className="text-xs text-muted-foreground">
          {behind && behind > 0 ? `${behind === 1 ? 'revision' : 'revisions'} behind` : 'Up to date'}
        </span>
      </StatTile>
      <StatTile label="Review" icon={GitPullRequest}>
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          <Badge tone={reviewTone(status.reviewState)}>{status.reviewState}</Badge>
          <Badge tone={status.mergeState === 'merged' ? 'hop' : 'outline'}>{status.mergeState}</Badge>
        </div>
        <span className="text-xs text-muted-foreground">
          {status.conflictState === 'none' ? 'No conflicts' : status.conflictState}
        </span>
      </StatTile>
    </section>
  )
}

function StatTile({
  label,
  icon: Icon,
  children,
}: {
  label: string
  icon: typeof Files
  children: React.ReactNode
}) {
  return (
    <article className="rounded-md border border-border bg-card p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Icon className="size-3.5 text-muted-foreground" aria-hidden />
      </div>
      <div className="flex flex-col gap-1">{children}</div>
    </article>
  )
}

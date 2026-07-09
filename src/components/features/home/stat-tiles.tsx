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
      <StatTile index="01" label="Files in view" icon={Files} accent="lime">
        <strong>{formatCount(status.fileCount)}</strong>
        <span>{status.hiddenFileCount > 0 ? `+${formatCount(status.hiddenFileCount)} private` : 'Ready everywhere'}</span>
      </StatTile>
      <StatTile index="02" label="Writes in flight" icon={ArrowUpRight} accent="orange">
        <strong>{formatCount(status.pendingWrites)}</strong>
        <span>{status.failedWrites > 0 ? `${formatCount(status.failedWrites)} need attention` : 'Journal is clear'}</span>
      </StatTile>
      <StatTile index="03" label="Remote distance" icon={ArrowDownLeft} accent="blue">
        <strong>{behind === null ? '—' : formatCount(behind)}</strong>
        <span>{behind && behind > 0 ? `${behind === 1 ? 'revision' : 'revisions'} behind` : 'Right on pace'}</span>
      </StatTile>
      <StatTile index="04" label="Review gate" icon={GitPullRequest} accent="ink">
        <div className="flex flex-wrap gap-1.5 pt-2">
          <Badge tone={reviewTone(status.reviewState)}>{status.reviewState}</Badge>
          <Badge tone={status.mergeState === 'merged' ? 'hop' : 'outline'}>{status.mergeState}</Badge>
        </div>
        <span>{status.conflictState === 'none' ? 'No conflicts' : status.conflictState}</span>
      </StatTile>
    </section>
  )
}

function StatTile({
  index,
  label,
  icon: Icon,
  accent,
  children,
}: {
  index: string
  label: string
  icon: typeof Files
  accent: 'lime' | 'orange' | 'blue' | 'ink'
  children: React.ReactNode
}) {
  const accentClass = {
    lime: 'bg-[var(--signal)] text-[#17352e]',
    orange: 'bg-[var(--signal-orange)] text-white',
    blue: 'bg-iris text-white',
    ink: 'bg-foreground text-background',
  }[accent]

  return (
    <article className="relative min-h-32 overflow-hidden rounded-[1.25rem] border border-border bg-card/90 p-4 sm:p-5">
      <div className="flex items-center justify-between">
        <span className="mono-label text-muted-foreground">{index} / {label}</span>
        <span className={`grid size-7 place-items-center rounded-full ${accentClass}`}>
          <Icon className="size-3.5" />
        </span>
      </div>
      <div className="mt-4 flex flex-col gap-1 [&_strong]:font-display [&_strong]:text-[2.35rem] [&_strong]:font-normal [&_strong]:leading-none [&_strong]:tracking-[-0.04em] [&>span]:text-[0.68rem] [&>span]:text-muted-foreground">
        {children}
      </div>
    </article>
  )
}

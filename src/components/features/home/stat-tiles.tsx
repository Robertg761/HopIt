'use client'

import * as React from 'react'

import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import type { AgentStatusSnapshot } from '@/lib/client/agent-status'
import { formatCount } from '@/lib/client/format'

function reviewTone(reviewState: string): BadgeTone {
  return reviewState === 'open' ? 'iris' : 'outline'
}

function mergeTone(mergeState: string): BadgeTone {
  if (mergeState === 'merged') return 'hop'
  if (mergeState.includes('conflict')) return 'danger'
  return 'outline'
}

/** Grid of four workspace stat tiles: files, pending writes, behind remote, review. */
export function StatTiles({ status }: { status: AgentStatusSnapshot }) {
  const behind = status.remoteBehindByRevisions

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatTile label="Files">
        <span className="text-xl font-semibold tracking-tight">
          {formatCount(status.fileCount)}
        </span>
        {status.hiddenFileCount > 0 ? (
          <span className="text-xs text-muted-foreground">
            +{formatCount(status.hiddenFileCount)} private
          </span>
        ) : null}
      </StatTile>

      <StatTile label="Pending writes">
        <span className="text-xl font-semibold tracking-tight">
          {formatCount(status.pendingWrites)}
        </span>
        {status.failedWrites > 0 ? (
          <Badge tone="danger">{formatCount(status.failedWrites)} failed</Badge>
        ) : null}
      </StatTile>

      <StatTile label="Behind remote">
        <span className="text-xl font-semibold tracking-tight">
          {behind === null ? '—' : formatCount(behind)}
        </span>
        {behind !== null && behind > 0 ? (
          <span className="text-xs text-muted-foreground">
            revision{behind === 1 ? '' : 's'}
          </span>
        ) : null}
      </StatTile>

      <StatTile label="Review">
        <Badge tone={reviewTone(status.reviewState)}>{status.reviewState}</Badge>
        <Badge tone={mergeTone(status.mergeState)}>{status.mergeState}</Badge>
      </StatTile>
    </div>
  )
}

function StatTile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Card className="p-5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-2 flex min-h-7 flex-wrap items-baseline gap-2">{children}</div>
    </Card>
  )
}

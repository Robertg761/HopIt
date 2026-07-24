'use client'

// GR-A3 (decisions §1: divergence surfaces). Same-owner multi-device
// divergences shown device-labeled and side by side, mirroring
// `file-inspector.tsx`'s single-file preview pattern. Resolution is
// pick-or-combine only: no automatic line-level merge exists anywhere in
// HopIt, so this panel never attempts to render or reconcile a diff -- it
// only offers "keep local" / "keep cloud" (a hand-combined file counts as
// "keep local" once the user has edited it locally).
import * as React from 'react'
import { GitPullRequestArrow } from 'lucide-react'

import type { AgentDivergence } from '@/lib/client/agent-status'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export function DivergencePanel({
  divergences,
  onResolve,
  resolvingPath,
}: {
  divergences: AgentDivergence[]
  onResolve: (path: string, keep: 'local' | 'cloud') => void
  resolvingPath: string | null
}) {
  if (divergences.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <GitPullRequestArrow className="size-4 text-amber-soft-foreground" aria-hidden />
          {divergences.length} open divergence{divergences.length === 1 ? '' : 's'}
        </CardTitle>
        <CardDescription>
          Both devices edited these files while apart. Pick a side, or combine by hand and keep local -- no
          automatic merge happens here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {divergences.map((divergence) => (
          <DivergenceRow
            key={divergence.path}
            divergence={divergence}
            onResolve={onResolve}
            resolving={resolvingPath === divergence.path}
          />
        ))}
      </CardContent>
    </Card>
  )
}

function DivergenceRow({
  divergence,
  onResolve,
  resolving,
}: {
  divergence: AgentDivergence
  onResolve: (path: string, keep: 'local' | 'cloud') => void
  resolving: boolean
}) {
  const localLabel = divergence.localDeviceName ?? 'This device'
  const cloudLabel = divergence.cloudDeviceName ?? 'Cloud'

  return (
    <div className="rounded-lg border border-border p-3" data-testid="divergence-row">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="truncate font-mono text-xs font-medium" title={divergence.path}>
          {divergence.path}
        </span>
        <Badge tone="amber">{reasonLabel(divergence.reason)}</Badge>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <DivergenceSide label={localLabel} caption={`${localLabel} version`} hash={divergence.localHash} />
        <DivergenceSide label={cloudLabel} caption={`${cloudLabel} version`} hash={divergence.cloudHash} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={resolving}
          onClick={() => onResolve(divergence.path, 'local')}
        >
          Keep {localLabel}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={resolving}
          onClick={() => onResolve(divergence.path, 'cloud')}
        >
          Keep {cloudLabel}
        </Button>
        {divergence.ageMs !== null ? (
          <span className="ml-auto text-xs text-muted-foreground">{ageLabel(divergence.ageMs)}</span>
        ) : null}
      </div>
    </div>
  )
}

function DivergenceSide({
  label,
  caption,
  hash,
}: {
  label: string
  caption: string
  hash: string | null
}) {
  return (
    <div className="rounded-md bg-muted/40 p-2.5">
      <p className="text-xs font-medium">{label}</p>
      <p className="mt-1 text-xs text-muted-foreground" title={caption}>
        {hash ? `hash ${hash.slice(0, 12)}…` : 'Deleted on this side'}
      </p>
    </div>
  )
}

function reasonLabel(reason: string | null) {
  if (reason === 'delete_vs_edit' || reason === 'edit_vs_delete') return 'Delete vs edit'
  if (reason === 'content_differs') return 'Content differs'
  return 'Diverged'
}

function ageLabel(ageMs: number) {
  const seconds = Math.round(ageMs / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

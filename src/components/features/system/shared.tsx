'use client'

import * as React from 'react'

import { Badge, type BadgeTone } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/** Label/value pair on the card grid. */
export function InfoRow({
  label,
  children,
  mono,
}: {
  label: string
  children: React.ReactNode
  mono?: boolean
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('mt-0.5 text-sm', mono && 'truncate font-mono text-xs leading-5')}>{children}</dd>
    </div>
  )
}

/** Compact stat for the sync counters row. */
export function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: number
  tone?: 'neutral' | 'amber' | 'danger' | 'hop'
}) {
  const valueClass =
    tone === 'danger' && value > 0
      ? 'text-danger'
      : tone === 'amber' && value > 0
        ? 'text-amber'
        : tone === 'hop'
          ? 'text-hop'
          : 'text-foreground'
  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('mt-0.5 text-sm font-semibold tabular-nums', valueClass)}>{value}</p>
    </div>
  )
}

export function StateBadge({ value, tone = 'neutral' }: { value: string; tone?: BadgeTone }) {
  return <Badge tone={tone}>{value}</Badge>
}

/** Truncated monospace value with the full text on hover. */
export function MonoId({
  value,
  className,
}: {
  value: string | null | undefined
  className?: string
}) {
  if (!value) return <span className="text-xs text-muted-foreground">—</span>
  return (
    <span className={cn('inline-block max-w-full truncate align-bottom font-mono text-xs', className)} title={value}>
      {value}
    </span>
  )
}

/** Read-only caption for settings-style cards. */
export function ManagedCaption({ children }: { children?: React.ReactNode }) {
  return (
    <p className="text-xs text-muted-foreground/80">
      {children ?? 'Managed by the agent and backend — read-only here.'}
    </p>
  )
}

export function QuietNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
      {children}
    </p>
  )
}

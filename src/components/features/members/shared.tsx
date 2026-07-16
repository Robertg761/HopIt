'use client'

import * as React from 'react'

import { Badge, type BadgeTone } from '@/components/ui/badge'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/client/format'
import { cn } from '@/lib/utils'
import { humanizeApiError } from '@/lib/client/errors'

export function roleTone(role: string): BadgeTone {
  if (role === 'owner') return 'hop'
  if (role === 'maintainer') return 'iris'
  if (role === 'member') return 'neutral'
  return 'outline'
}

export function RoleBadge({ role }: { role: string }) {
  return <Badge tone={roleTone(role)}>{role}</Badge>
}

export function RelativeTime({ value }: { value: string | null | undefined }) {
  return <span title={formatAbsoluteTime(value)}>{formatRelativeTime(value)}</span>
}

export function MonoId({
  value,
  className,
}: {
  value: string | null | undefined
  className?: string
}) {
  if (!value) return <span className="text-xs text-muted-foreground">Not available</span>
  return (
    <span
      className={cn('inline-block max-w-44 truncate align-bottom font-mono text-xs', className)}
      title={value}
    >
      {value}
    </span>
  )
}

export function CardNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
      {children}
    </p>
  )
}

export function errorText(error: { message?: string } | undefined, fallback: string): string {
  return error?.message && error.message.length > 0 ? humanizeApiError(error.message) : fallback
}

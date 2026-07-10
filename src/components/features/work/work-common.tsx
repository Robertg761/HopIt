'use client'

import * as React from 'react'
import Link from 'next/link'
import { ArrowLeft, CloudOff, Lock } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { type BadgeTone } from '@/components/ui/badge'
import { Dialog } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useToast } from '@/hooks/use-toast'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/client/format'
import { humanizeApiError } from '@/lib/client/errors'
import {
  fetchWorkItems,
  type CollaborationActionCapability,
  type CollaborationDiscussion,
  type CollaborationIssue,
  type CollaborationRelease,
  type WorkItemsResponse,
} from '@/lib/collaboration'

export type WorkItemKind = 'issue' | 'discussion' | 'release' | 'project'

export function workItemHref(codebaseId: string, kind: WorkItemKind, id: string): string {
  return `/codebases/${encodeURIComponent(codebaseId)}/work-items/${kind}/${encodeURIComponent(id)}`
}

export type RunWorkMutation = (options: {
  key: string
  label: string
  run: () => Promise<WorkItemsResponse>
  successTitle?: string
}) => Promise<boolean>

export type WorkItemsController = {
  data: WorkItemsResponse | null
  loading: boolean
  busyKey: string | null
  runMutation: RunWorkMutation
}

export type WorkTabProps = {
  codebaseId: string
  actorId: string
  data: WorkItemsResponse
  busyKey: string | null
  runMutation: RunWorkMutation
  createOpen: boolean
  onCreateOpenChange: (open: boolean) => void
}

type WorkItemsResult = {
  codebaseId: string
  data: WorkItemsResponse | null
}

export function useWorkItemsController(codebaseId: string | null): WorkItemsController {
  const { toast } = useToast()
  const [result, setResult] = React.useState<WorkItemsResult | null>(null)
  const [busyKey, setBusyKey] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!codebaseId) return
    let cancelled = false
    fetchWorkItems(codebaseId)
      .then((response) => {
        if (!cancelled) setResult({ codebaseId, data: response })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setResult({ codebaseId, data: null })
        toast({
          title: 'Failed to load work items',
          description: errorMessage(error),
          variant: 'destructive',
        })
      })
    return () => {
      cancelled = true
    }
  }, [codebaseId, toast])

  const data = codebaseId && result?.codebaseId === codebaseId ? result.data : null
  const loading = Boolean(codebaseId) && (result === null || result.codebaseId !== codebaseId)

  const runMutation = React.useCallback<RunWorkMutation>(
    async ({ key, label, run, successTitle }) => {
      setBusyKey(key)
      try {
        const response = await run()
        if (response.ok) {
          if (codebaseId) setResult({ codebaseId, data: response })
          if (successTitle) toast({ title: successTitle })
          return true
        }
        if (response.error?.code === 'browser_auth_required') {
          toast({ title: 'Sign in required', description: `Sign in to ${label}.` })
        } else {
          toast({
            title: `Couldn't ${label}`,
            description: response.error?.message ?? 'The collaboration request failed.',
            variant: 'destructive',
          })
        }
        return false
      } catch (error) {
        toast({ title: `Couldn't ${label}`, description: errorMessage(error), variant: 'destructive' })
        return false
      } finally {
        setBusyKey(null)
      }
    },
    [codebaseId, toast],
  )

  return { data, loading, busyKey, runMutation }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed.'
}

export function capabilityProps(capability: CollaborationActionCapability | undefined): {
  disabled: boolean
  title: string | undefined
} {
  const enabled = capability?.enabled === true
  return {
    disabled: !enabled,
    title: enabled ? undefined : capability?.reason ?? 'Not available.',
  }
}

export const PRIORITY_TONE: Record<'low' | 'medium' | 'high', BadgeTone> = {
  high: 'danger',
  medium: 'amber',
  low: 'neutral',
}

export const ISSUE_STATUS_TONE: Record<CollaborationIssue['status'], BadgeTone> = {
  open: 'hop',
  closed: 'neutral',
}

export const DISCUSSION_CATEGORY_TONE: Record<CollaborationDiscussion['category'], BadgeTone> = {
  general: 'neutral',
  ideas: 'iris',
  'q-and-a': 'info',
  announcements: 'amber',
}

export const DISCUSSION_STATUS_TONE: Record<CollaborationDiscussion['status'], BadgeTone> = {
  open: 'hop',
  answered: 'iris',
  locked: 'neutral',
  closed: 'neutral',
}

export const RELEASE_STATUS_TONE: Record<CollaborationRelease['status'], BadgeTone> = {
  draft: 'amber',
  published: 'hop',
  archived: 'neutral',
}

export function BackToWorkItemsButton({ codebaseId }: { codebaseId?: string }) {
  const href = codebaseId
    ? `/codebases/${encodeURIComponent(codebaseId)}/issues`
    : '/work-items'
  return (
    <Button asChild variant="ghost" size="sm">
      <Link href={href}>
        <ArrowLeft className="size-3.5" />
        Issues
      </Link>
    </Button>
  )
}

export function RelativeTime({ value, className }: { value: string | null; className?: string }) {
  return (
    <span
      title={formatAbsoluteTime(value) || undefined}
      className={className ?? 'shrink-0 text-xs text-muted-foreground'}
    >
      {formatRelativeTime(value)}
    </span>
  )
}

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  )
}

export function WorkItemsUnavailable({ response }: { response: WorkItemsResponse }) {
  const code = response.error?.code
  if (code === 'browser_auth_required') {
    return (
      <EmptyState
        icon={Lock}
        title="Sign in required"
        description="Sign in to view issues, discussions, projects, and releases for this codebase."
      />
    )
  }
  if (code === 'd1_required' || code === 'cloud_backend_unavailable') {
    return (
      <EmptyState
        icon={CloudOff}
        title="Not available on this backend"
        description={humanizeApiError(response.error?.message) || 'Work items need the hosted collaboration backend.'}
      />
    )
  }
  return (
    <EmptyState
      icon={CloudOff}
      title="Work items unavailable"
      description={humanizeApiError(response.error?.message) || 'The collaboration backend did not return work items.'}
    />
  )
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  busy,
  destructive,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  busy: boolean
  destructive?: boolean
  onConfirm: () => void
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            size="sm"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <Spinner className="size-3.5" /> : null}
            {confirmLabel}
          </Button>
        </>
      }
    />
  )
}

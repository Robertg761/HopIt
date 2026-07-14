'use client'

import * as React from 'react'
import { Hammer, ListChecks, RotateCw, TestTube2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { RelativeTime } from '@/components/features/members/shared'
import { apiFetch } from '@/lib/client/api'

import { QuietNote } from './shared'

type ActionJob = {
  id: string
  kind: string
  status: string
  exitCode: number | null
  createdAt: string | null
}

type ActionJobKind = 'lint' | 'test' | 'build'

const QUEUE_BUTTONS: Array<{ kind: ActionJobKind; label: string; icon: LucideIcon }> = [
  { kind: 'lint', label: 'Lint', icon: ListChecks },
  { kind: 'test', label: 'Test', icon: TestTube2 },
  { kind: 'build', label: 'Build', icon: Hammer },
]

export function ActionJobsCard({ codebaseId }: { codebaseId: string | null }) {
  const [jobs, setJobs] = React.useState<ActionJob[]>([])
  const [loading, setLoading] = React.useState(true)
  const [note, setNote] = React.useState<string | null>(null)
  const [queueing, setQueueing] = React.useState<ActionJobKind | null>(null)

  const load = React.useCallback(async () => {
    if (!codebaseId) return
    try {
      const body: unknown = await apiFetch(`/api/actions?codebaseId=${encodeURIComponent(codebaseId)}`, {
        allowErrorEnvelope: true,
      })
      const record = asRecord(body)
      if (!record || record.ok === false) {
        setJobs([])
        setNote(quietFailureNote(record))
      } else {
        setNote(null)
        setJobs(narrowJobs(record.jobs))
      }
    } catch {
      setJobs([])
      setNote('Action jobs are unavailable right now.')
    } finally {
      setLoading(false)
    }
  }, [codebaseId])

  React.useEffect(() => {
    void load()
  }, [load])

  const showSkeleton = loading && codebaseId !== null
  const effectiveNote = codebaseId ? note : 'Select a codebase to see its action jobs.'

  async function queue(kind: ActionJobKind) {
    if (!codebaseId) return
    setQueueing(kind)
    try {
      const body: unknown = await apiFetch('/api/actions', {
        method: 'POST',
        allowErrorEnvelope: true,
        body: JSON.stringify({ codebaseId, kind }),
      })
      const record = asRecord(body)
      if (!record || record.ok === false) {
        setNote(quietFailureNote(record))
      } else {
        setNote(null)
        await load()
      }
    } catch {
      setNote('Action jobs are unavailable right now.')
    } finally {
      setQueueing(null)
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <CardTitle>Action jobs</CardTitle>
          <CardDescription>Lint, test, and build runs for this codebase.</CardDescription>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Refresh action jobs" onClick={() => void load()}>
          <RotateCw />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {QUEUE_BUTTONS.map(({ kind, label, icon: Icon }) => (
            <Button
              key={kind}
              variant="outline"
              size="sm"
              disabled={!codebaseId || queueing !== null}
              onClick={() => void queue(kind)}
            >
              {queueing === kind ? <Spinner className="size-3.5" /> : <Icon className="size-4" />}
              {label}
            </Button>
          ))}
        </div>
        {effectiveNote ? <QuietNote>{effectiveNote}</QuietNote> : null}
        {showSkeleton ? (
          <Skeleton className="h-16 w-full" />
        ) : jobs.length === 0 ? (
          !effectiveNote ? <p className="text-xs text-muted-foreground">No action jobs yet.</p> : null
        ) : (
          <div className="space-y-1">
            {jobs.map((job) => (
              <div
                key={job.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/50"
              >
                <span className="text-sm font-medium capitalize">{job.kind}</span>
                <Badge tone={statusTone(job.status)}>{job.status}</Badge>
                {job.exitCode !== null ? (
                  <span className="font-mono text-xs text-muted-foreground">exit {job.exitCode}</span>
                ) : null}
                <span className="ml-auto text-xs text-muted-foreground">
                  <RelativeTime value={job.createdAt} />
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function statusTone(status: string): BadgeTone {
  if (status === 'succeeded' || status === 'completed' || status === 'passed') return 'hop'
  if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'canceled') return 'danger'
  if (status === 'running' || status === 'queued' || status === 'pending') return 'amber'
  return 'neutral'
}

function quietFailureNote(record: Record<string, unknown> | null): string {
  const error = asRecord(record?.error)
  const code = typeof error?.code === 'string' ? error.code : null
  if (code === 'browser_auth_required') return 'Sign in to view and queue action jobs.'
  return 'Action jobs are not available on this backend.'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function narrowJobs(value: unknown): ActionJob[] {
  if (!Array.isArray(value)) return []
  const jobs: ActionJob[] = []
  for (const [index, entry] of value.entries()) {
    const record = asRecord(entry)
    if (!record) continue
    jobs.push({
      id: typeof record.id === 'string' ? record.id : `job-${index}`,
      kind: typeof record.kind === 'string' ? record.kind : 'unknown',
      status: typeof record.status === 'string' ? record.status : 'unknown',
      exitCode: typeof record.exitCode === 'number' && Number.isFinite(record.exitCode) ? record.exitCode : null,
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : null,
    })
  }
  return jobs
}

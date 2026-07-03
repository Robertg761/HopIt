'use client'

import * as React from 'react'
import Link from 'next/link'
import { CheckCircle2, CircleDot, MessageSquare } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Select } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import {
  createCollaborationItem,
  updateCollaborationItem,
  type CollaborationIssue,
} from '@/lib/collaboration'
import {
  PRIORITY_TONE,
  RelativeTime,
  capabilityProps,
  workItemHref,
  type RunWorkMutation,
  type WorkTabProps,
} from './work-common'

type IssueFilter = 'open' | 'all' | 'closed'

const FILTER_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'all', label: 'All' },
  { value: 'closed', label: 'Closed' },
] as const

export function parseLabels(value: string): string[] | undefined {
  const labels = value
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean)
  return labels.length > 0 ? labels : undefined
}

export function IssuesTab({
  codebaseId,
  actorId,
  data,
  busyKey,
  runMutation,
  createOpen,
  onCreateOpenChange,
}: WorkTabProps) {
  const [query, setQuery] = React.useState('')
  const [filter, setFilter] = React.useState<IssueFilter>('open')

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    return data.issues
      .filter((issue) => (filter === 'all' ? true : issue.status === filter))
      .filter((issue) => {
        if (!needle) return true
        return (
          issue.title.toLowerCase().includes(needle) ||
          `#${issue.number}`.includes(needle) ||
          issue.labels.some((label) => label.toLowerCase().includes(needle))
        )
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }, [data.issues, filter, query])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search issues…"
          aria-label="Search issues"
          className="max-w-xs"
        />
        <Segmented value={filter} onChange={setFilter} options={FILTER_OPTIONS} aria-label="Filter issues" />
      </div>
      {filtered.length === 0 ? (
        <EmptyState
          icon={CircleDot}
          title={data.issues.length === 0 ? 'No issues yet' : 'No matching issues'}
          description={
            data.issues.length === 0
              ? 'Track bugs and tasks for this codebase by opening the first issue.'
              : 'Try a different search or status filter.'
          }
        />
      ) : (
        <Card className="p-2">
          <ul className="space-y-0.5">
            {filtered.map((issue) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                codebaseId={codebaseId}
                actorId={actorId}
                busyKey={busyKey}
                runMutation={runMutation}
                updateDisabled={capabilityProps(data.capabilities.updateIssue)}
              />
            ))}
          </ul>
        </Card>
      )}
      <NewIssueDialog
        open={createOpen}
        onOpenChange={onCreateOpenChange}
        codebaseId={codebaseId}
        actorId={actorId}
        busy={busyKey === 'create-issue'}
        runMutation={runMutation}
      />
    </div>
  )
}

function IssueRow({
  issue,
  codebaseId,
  actorId,
  busyKey,
  runMutation,
  updateDisabled,
}: {
  issue: CollaborationIssue
  codebaseId: string
  actorId: string
  busyKey: string | null
  runMutation: RunWorkMutation
  updateDisabled: { disabled: boolean; title: string | undefined }
}) {
  const open = issue.status === 'open'
  const toggleKey = `issue-status-${issue.id}`
  const busy = busyKey === toggleKey

  return (
    <li className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-muted/50">
      {open ? (
        <CircleDot aria-label="Open issue" className="size-4 shrink-0 text-hop" />
      ) : (
        <CheckCircle2 aria-label="Closed issue" className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="shrink-0 font-mono text-xs text-muted-foreground">#{issue.number}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={workItemHref(codebaseId, 'issue', issue.id)}
            className="rounded-sm text-sm font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {issue.title}
          </Link>
          {issue.priority ? <Badge tone={PRIORITY_TONE[issue.priority]}>{issue.priority}</Badge> : null}
          {issue.labels.map((label) => (
            <Badge key={label} tone="outline">
              {label}
            </Badge>
          ))}
        </div>
      </div>
      {issue.comments.length > 0 ? (
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <MessageSquare className="size-3.5" aria-hidden />
          {issue.comments.length}
        </span>
      ) : null}
      <RelativeTime value={issue.updatedAt} />
      <Button
        variant="ghost"
        size="sm"
        disabled={updateDisabled.disabled || busy}
        title={updateDisabled.title}
        onClick={() =>
          void runMutation({
            key: toggleKey,
            label: open ? 'close the issue' : 'reopen the issue',
            run: () =>
              updateCollaborationItem({
                action: 'setIssueStatus',
                codebaseId,
                issueId: issue.id,
                status: open ? 'closed' : 'open',
                updatedBy: actorId,
              }),
            successTitle: open ? `Issue #${issue.number} closed` : `Issue #${issue.number} reopened`,
          })
        }
      >
        {busy ? <Spinner className="size-3.5" /> : null}
        {open ? 'Close' : 'Reopen'}
      </Button>
    </li>
  )
}

function NewIssueDialog({
  open,
  onOpenChange,
  codebaseId,
  actorId,
  busy,
  runMutation,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  codebaseId: string
  actorId: string
  busy: boolean
  runMutation: RunWorkMutation
}) {
  const [title, setTitle] = React.useState('')
  const [body, setBody] = React.useState('')
  const [priority, setPriority] = React.useState<'' | 'low' | 'medium' | 'high'>('')
  const [labels, setLabels] = React.useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = title.trim()
    if (!trimmed) return
    const ok = await runMutation({
      key: 'create-issue',
      label: 'create the issue',
      run: () =>
        createCollaborationItem({
          type: 'issue',
          codebaseId,
          title: trimmed,
          body: body.trim() || undefined,
          priority: priority || undefined,
          labels: parseLabels(labels),
          createdBy: actorId,
        }),
      successTitle: 'Issue created',
    })
    if (ok) {
      setTitle('')
      setBody('')
      setPriority('')
      setLabels('')
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New issue" description="Track a bug or task for this codebase.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Title" htmlFor="new-issue-title">
          <Input
            id="new-issue-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Something is broken…"
            required
            autoFocus
          />
        </Field>
        <Field label="Body" htmlFor="new-issue-body">
          <Textarea
            id="new-issue-body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Steps to reproduce, expected behavior…"
            rows={4}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority" htmlFor="new-issue-priority">
            <Select
              id="new-issue-priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value as '' | 'low' | 'medium' | 'high')}
            >
              <option value="">None</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </Select>
          </Field>
          <Field label="Labels" htmlFor="new-issue-labels" hint="Comma-separated">
            <Input
              id="new-issue-labels"
              value={labels}
              onChange={(event) => setLabels(event.target.value)}
              placeholder="bug, sync"
            />
          </Field>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy || !title.trim()}>
            {busy ? <Spinner className="size-3.5" /> : null}
            Create issue
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

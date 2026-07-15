'use client'

import * as React from 'react'
import Link from 'next/link'
import { CheckCircle2, ChevronDown, Lock, MessageSquare, MessagesSquare } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
  type CollaborationDiscussion,
} from '@/lib/collaboration'
import {
  DISCUSSION_CATEGORY_TONE,
  RelativeTime,
  capabilityProps,
  workItemHref,
  type RunWorkMutation,
  type WorkTabProps,
} from './work-common'

type DiscussionFilter = 'open' | 'all' | 'closed'
type DiscussionCategory = CollaborationDiscussion['category']

export const DISCUSSION_STATUS_ACTIONS = ['open', 'answered', 'closed'] as const

const FILTER_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'all', label: 'All' },
  { value: 'closed', label: 'Closed' },
] as const

export function DiscussionsTab({
  codebaseId,
  actorId,
  data,
  busyKey,
  runMutation,
  createOpen,
  onCreateOpenChange,
}: WorkTabProps) {
  const [query, setQuery] = React.useState('')
  const [filter, setFilter] = React.useState<DiscussionFilter>('open')

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    return data.discussions
      .filter((discussion) => {
        if (filter === 'all') return true
        if (filter === 'open') return discussion.status === 'open' || discussion.status === 'answered'
        return discussion.status === 'closed' || discussion.status === 'locked'
      })
      .filter((discussion) => {
        if (!needle) return true
        return (
          discussion.title.toLowerCase().includes(needle) ||
          `#${discussion.number}`.includes(needle) ||
          discussion.category.includes(needle)
        )
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }, [data.discussions, filter, query])

  const updateDisabled = capabilityProps(data.capabilities.updateDiscussion)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search discussions…"
          aria-label="Search discussions"
          className="max-w-xs"
        />
        <Segmented value={filter} onChange={setFilter} options={FILTER_OPTIONS} aria-label="Filter discussions" />
      </div>
      {filtered.length === 0 ? (
        <EmptyState
          icon={MessagesSquare}
          title={data.discussions.length === 0 ? 'No discussions yet' : 'No matching discussions'}
          description={
            data.discussions.length === 0
              ? 'Start a conversation about ideas, questions, or announcements.'
              : 'Try a different search or status filter.'
          }
        />
      ) : (
        <Card className="p-2">
          <ul className="space-y-0.5">
            {filtered.map((discussion) => (
              <DiscussionRow
                key={discussion.id}
                discussion={discussion}
                codebaseId={codebaseId}
                actorId={actorId}
                busyKey={busyKey}
                runMutation={runMutation}
                updateDisabled={updateDisabled}
              />
            ))}
          </ul>
        </Card>
      )}
      <NewDiscussionDialog
        open={createOpen}
        onOpenChange={onCreateOpenChange}
        codebaseId={codebaseId}
        actorId={actorId}
        busy={busyKey === 'create-discussion'}
        runMutation={runMutation}
      />
    </div>
  )
}

function DiscussionStatusIcon({ status }: { status: CollaborationDiscussion['status'] }) {
  if (status === 'open') return <MessagesSquare aria-label="Open discussion" className="size-4 shrink-0 text-hop" />
  if (status === 'answered') return <CheckCircle2 aria-label="Answered discussion" className="size-4 shrink-0 text-iris" />
  if (status === 'locked') return <Lock aria-label="Locked discussion" className="size-4 shrink-0 text-muted-foreground" />
  return <CheckCircle2 aria-label="Closed discussion" className="size-4 shrink-0 text-muted-foreground" />
}

function DiscussionRow({
  discussion,
  codebaseId,
  actorId,
  busyKey,
  runMutation,
  updateDisabled,
}: {
  discussion: CollaborationDiscussion
  codebaseId: string
  actorId: string
  busyKey: string | null
  runMutation: RunWorkMutation
  updateDisabled: { disabled: boolean; title: string | undefined }
}) {
  const statusKey = `discussion-status-${discussion.id}`
  const busy = busyKey === statusKey

  return (
    <li className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-muted/50">
      <DiscussionStatusIcon status={discussion.status} />
      <span className="shrink-0 font-mono text-xs text-muted-foreground">#{discussion.number}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={workItemHref(codebaseId, 'discussion', discussion.id)}
            className="rounded-sm text-sm font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {discussion.title}
          </Link>
          <Badge tone={DISCUSSION_CATEGORY_TONE[discussion.category]}>{discussion.category}</Badge>
          {discussion.labels.map((label) => (
            <Badge key={label} tone="outline">
              {label}
            </Badge>
          ))}
        </div>
      </div>
      {discussion.comments.length > 0 ? (
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <MessageSquare className="size-3.5" aria-hidden />
          {discussion.comments.length}
        </span>
      ) : null}
      <RelativeTime value={discussion.updatedAt} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" disabled={updateDisabled.disabled || busy} title={updateDisabled.title}>
            {busy ? <Spinner className="size-3.5" /> : null}
            Status
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {DISCUSSION_STATUS_ACTIONS.map((status) => (
            <DropdownMenuItem
              key={status}
              disabled={discussion.status === status}
              onSelect={() =>
                void runMutation({
                  key: statusKey,
                  label: `mark the discussion as ${status}`,
                  run: () =>
                    updateCollaborationItem({
                      action: 'setDiscussionStatus',
                      codebaseId,
                      discussionId: discussion.id,
                      status,
                      updatedBy: actorId,
                    }),
                  successTitle: `Discussion marked ${status}`,
                })
              }
              className="capitalize"
            >
              {status}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

function NewDiscussionDialog({
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
  const [category, setCategory] = React.useState<DiscussionCategory>('general')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!title.trim() || !body.trim()) return
    const ok = await runMutation({
      key: 'create-discussion',
      label: 'start the discussion',
      run: () =>
        createCollaborationItem({
          type: 'discussion',
          codebaseId,
          title: title.trim(),
          body: body.trim(),
          category,
          createdBy: actorId,
        }),
      successTitle: 'Discussion started',
    })
    if (ok) {
      setTitle('')
      setBody('')
      setCategory('general')
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New discussion" description="Start a conversation with the team.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Title" htmlFor="new-discussion-title">
          <Input
            id="new-discussion-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What do you want to talk about?"
            required
            autoFocus
          />
        </Field>
        <Field label="Body" htmlFor="new-discussion-body">
          <Textarea
            id="new-discussion-body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Add some context…"
            rows={4}
            required
          />
        </Field>
        <Field label="Category" htmlFor="new-discussion-category">
          <Select
            id="new-discussion-category"
            value={category}
            onChange={(event) => setCategory(event.target.value as DiscussionCategory)}
          >
            <option value="general">General</option>
            <option value="ideas">Ideas</option>
            <option value="q-and-a">Q&amp;A</option>
            <option value="announcements">Announcements</option>
          </Select>
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy || !title.trim() || !body.trim()}>
            {busy ? <Spinner className="size-3.5" /> : null}
            Start discussion
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

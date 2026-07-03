'use client'

import * as React from 'react'
import { Check, MessageSquarePlus } from 'lucide-react'

import type { ReviewThread } from '@/lib/collaboration'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/client/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { BACKEND_UNAVAILABLE_NOTE, QuietNote } from './review-shared'
import type { ReviewData } from './use-review-data'

export type ThreadAnchor = {
  filePath: string
  lineNumber: number | null
  baseRevision: string
  headRevision: string
  lineFingerprint: string
}

export function ThreadPanel({
  anchor,
  threads,
  review,
  composerDisabledReason,
}: {
  anchor: ThreadAnchor | null
  threads: ReviewThread[]
  review: ReviewData
  composerDisabledReason: string | null
}) {
  const [draft, setDraft] = React.useState('')
  const [commentDrafts, setCommentDrafts] = React.useState<Record<string, string>>({})
  const filePath = anchor?.filePath ?? null
  const selectedLine = anchor?.lineNumber ?? null

  async function submitThread() {
    if (!draft.trim() || !anchor) return
    const created = await review.createThread({ ...anchor, body: draft.trim() })
    if (created) setDraft('')
  }

  async function submitComment(threadId: string) {
    const body = commentDrafts[threadId]?.trim()
    if (!body) return
    const added = await review.addThreadComment(threadId, body)
    if (added) setCommentDrafts((current) => ({ ...current, [threadId]: '' }))
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Inline threads</CardTitle>
        <CardDescription>
          {filePath ? (
            <span className="font-mono">{filePath}</span>
          ) : (
            'Select a file to see its review threads.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        {review.threadsUnavailable ? (
          <QuietNote>{BACKEND_UNAVAILABLE_NOTE}</QuietNote>
        ) : review.threadsLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : (
          <>
            {threads.length === 0 && filePath ? (
              <QuietNote>No threads on this file yet.</QuietNote>
            ) : null}
            {threads.map((thread) => (
              <ThreadItem
                key={thread.id}
                thread={thread}
                review={review}
                commentDraft={commentDrafts[thread.id] ?? ''}
                onCommentDraftChange={(value) =>
                  setCommentDrafts((current) => ({ ...current, [thread.id]: value }))
                }
                onSubmitComment={() => void submitComment(thread.id)}
              />
            ))}
            {filePath ? (
              <div className="border-t border-border pt-4">
                <Field
                  label={`New thread at ${filePath}${selectedLine !== null ? `:${selectedLine}` : ' (whole file)'}`}
                  htmlFor="review-new-thread"
                  hint={composerDisabledReason ?? undefined}
                >
                  <Textarea
                    id="review-new-thread"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="Leave a review comment…"
                    disabled={composerDisabledReason !== null}
                  />
                </Field>
                <Button
                  size="sm"
                  className="mt-2"
                  onClick={() => void submitThread()}
                  disabled={
                    composerDisabledReason !== null || review.creatingThread || !draft.trim()
                  }
                >
                  {review.creatingThread ? <Spinner className="size-3.5" /> : <MessageSquarePlus />}
                  Start thread
                </Button>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function ThreadItem({
  thread,
  review,
  commentDraft,
  onCommentDraftChange,
  onSubmitComment,
}: {
  thread: ReviewThread
  review: ReviewData
  commentDraft: string
  onCommentDraftChange: (value: string) => void
  onSubmitComment: () => void
}) {
  const resolving = review.resolvingThreadId === thread.id
  const commenting = review.commentingThreadId === thread.id

  return (
    <div className="space-y-3 rounded-lg bg-muted/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={thread.status === 'open' ? 'iris' : 'neutral'}>{thread.status}</Badge>
        <span className="font-mono text-xs text-muted-foreground">
          {thread.lineNumber !== null ? `L${thread.lineNumber}` : 'whole file'}
        </span>
        <span
          className="ml-auto text-xs text-muted-foreground"
          title={formatAbsoluteTime(thread.createdAt)}
        >
          {formatRelativeTime(thread.createdAt)}
        </span>
        {thread.status === 'open' ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void review.resolveThread(thread.id)}
            disabled={resolving}
          >
            {resolving ? <Spinner className="size-3.5" /> : <Check />}
            Resolve
          </Button>
        ) : null}
      </div>
      <ul className="space-y-2">
        {thread.comments.map((comment) => (
          <li key={comment.id} className="text-sm">
            <p className="whitespace-pre-wrap leading-relaxed">{comment.body}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              <span className="font-mono">{comment.createdBy}</span>
              {' · '}
              <span title={formatAbsoluteTime(comment.createdAt)}>
                {formatRelativeTime(comment.createdAt)}
              </span>
            </p>
          </li>
        ))}
      </ul>
      {thread.status === 'open' ? (
        <div className="flex items-end gap-2">
          <Textarea
            aria-label="Reply to thread"
            value={commentDraft}
            onChange={(event) => onCommentDraftChange(event.target.value)}
            placeholder="Reply…"
            className="min-h-9"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={onSubmitComment}
            disabled={commenting || !commentDraft.trim()}
          >
            {commenting ? <Spinner className="size-3.5" /> : null}
            Reply
          </Button>
        </div>
      ) : null}
    </div>
  )
}

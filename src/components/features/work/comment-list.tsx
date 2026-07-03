'use client'

import * as React from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import type { CollaborationActionCapability, CollaborationComment } from '@/lib/collaboration'
import { RelativeTime, capabilityProps } from './work-common'

export function CommentList({
  comments,
  capability,
  busy,
  onSubmit,
}: {
  comments: CollaborationComment[]
  capability: CollaborationActionCapability
  busy: boolean
  onSubmit: (body: string) => Promise<boolean>
}) {
  const [body, setBody] = React.useState('')
  const composer = capabilityProps(capability)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = body.trim()
    if (!trimmed) return
    const ok = await onSubmit(trimmed)
    if (ok) setBody('')
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Comments ({comments.length})</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {comments.length === 0 ? (
          <p className="text-xs text-muted-foreground">No comments yet.</p>
        ) : (
          <ul className="space-y-4">
            {comments.map((comment) => (
              <li key={comment.id} className="space-y-1 border-b border-border pb-4 last:border-b-0 last:pb-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-foreground">{comment.createdBy}</span>
                  <RelativeTime value={comment.createdAt} />
                </div>
                <p className="whitespace-pre-wrap text-sm text-foreground">{comment.body}</p>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={submit} className="space-y-2">
          <Textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Add a comment…"
            aria-label="Add a comment"
            rows={3}
            disabled={composer.disabled}
          />
          {composer.title ? <p className="text-xs text-muted-foreground">{composer.title}</p> : null}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={composer.disabled || busy || !body.trim()}>
              {busy ? <Spinner className="size-3.5" /> : null}
              Comment
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

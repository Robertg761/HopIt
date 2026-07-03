'use client'

import * as React from 'react'

import { PageScaffold } from '@/components/shell/page-scaffold'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import {
  createCollaborationItem,
  updateCollaborationItem,
  type CollaborationDiscussion,
  type CollaborationIssue,
  type WorkItemsResponse,
} from '@/lib/collaboration'
import { CommentList } from './comment-list'
import { DISCUSSION_STATUS_ACTIONS } from './discussions-tab'
import {
  BackToWorkItemsButton,
  DISCUSSION_CATEGORY_TONE,
  DISCUSSION_STATUS_TONE,
  ISSUE_STATUS_TONE,
  PRIORITY_TONE,
  RelativeTime,
  capabilityProps,
  type RunWorkMutation,
} from './work-common'

type ThreadDetailProps = {
  codebaseId: string
  actorId: string
  capabilities: WorkItemsResponse['capabilities']
  busyKey: string | null
  runMutation: RunWorkMutation
}

export function IssueDetailPage({
  issue,
  codebaseId,
  actorId,
  capabilities,
  busyKey,
  runMutation,
}: ThreadDetailProps & { issue: CollaborationIssue }) {
  const open = issue.status === 'open'
  const toggleProps = capabilityProps(capabilities.updateIssue)
  const toggleKey = `issue-status-${issue.id}`

  return (
    <PageScaffold
      title={`#${issue.number} ${issue.title}`}
      actions={
        <>
          <BackToWorkItemsButton />
          <Button
            variant="outline"
            size="sm"
            disabled={toggleProps.disabled || busyKey === toggleKey}
            title={toggleProps.title}
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
                successTitle: open ? 'Issue closed' : 'Issue reopened',
              })
            }
          >
            {busyKey === toggleKey ? <Spinner className="size-3.5" /> : null}
            {open ? 'Close issue' : 'Reopen issue'}
          </Button>
        </>
      }
    >
      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={ISSUE_STATUS_TONE[issue.status]}>{issue.status}</Badge>
            {issue.priority ? <Badge tone={PRIORITY_TONE[issue.priority]}>{issue.priority}</Badge> : null}
            {issue.labels.map((label) => (
              <Badge key={label} tone="outline">
                {label}
              </Badge>
            ))}
            <span className="font-mono text-xs text-muted-foreground">{issue.createdBy}</span>
            <RelativeTime value={issue.createdAt} />
          </div>
          <p className="whitespace-pre-wrap text-sm text-foreground">{issue.body || 'No description provided.'}</p>
        </CardContent>
      </Card>
      <CommentList
        comments={issue.comments}
        capability={capabilities.updateIssue}
        busy={busyKey === `comment-${issue.id}`}
        onSubmit={(body) =>
          runMutation({
            key: `comment-${issue.id}`,
            label: 'add the comment',
            run: () =>
              createCollaborationItem({
                type: 'issueComment',
                codebaseId,
                issueId: issue.id,
                body,
                createdBy: actorId,
              }),
          })
        }
      />
    </PageScaffold>
  )
}

export function DiscussionDetailPage({
  discussion,
  codebaseId,
  actorId,
  capabilities,
  busyKey,
  runMutation,
}: ThreadDetailProps & { discussion: CollaborationDiscussion }) {
  return (
    <PageScaffold
      title={`#${discussion.number} ${discussion.title}`}
      actions={
        <>
          <BackToWorkItemsButton />
          <DiscussionStatusButtons
            discussion={discussion}
            codebaseId={codebaseId}
            actorId={actorId}
            capabilities={capabilities}
            busyKey={busyKey}
            runMutation={runMutation}
          />
        </>
      }
    >
      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={DISCUSSION_STATUS_TONE[discussion.status]}>{discussion.status}</Badge>
            <Badge tone={DISCUSSION_CATEGORY_TONE[discussion.category]}>{discussion.category}</Badge>
            {discussion.labels.map((label) => (
              <Badge key={label} tone="outline">
                {label}
              </Badge>
            ))}
            <span className="font-mono text-xs text-muted-foreground">{discussion.createdBy}</span>
            <RelativeTime value={discussion.createdAt} />
          </div>
          <p className="whitespace-pre-wrap text-sm text-foreground">{discussion.body}</p>
        </CardContent>
      </Card>
      <CommentList
        comments={discussion.comments}
        capability={capabilities.updateDiscussion}
        busy={busyKey === `comment-${discussion.id}`}
        onSubmit={(body) =>
          runMutation({
            key: `comment-${discussion.id}`,
            label: 'add the comment',
            run: () =>
              createCollaborationItem({
                type: 'discussionComment',
                codebaseId,
                discussionId: discussion.id,
                body,
                createdBy: actorId,
              }),
          })
        }
      />
    </PageScaffold>
  )
}

function DiscussionStatusButtons({
  discussion,
  codebaseId,
  actorId,
  capabilities,
  busyKey,
  runMutation,
}: ThreadDetailProps & { discussion: CollaborationDiscussion }) {
  const updateProps = capabilityProps(capabilities.updateDiscussion)
  const statusKey = `discussion-status-${discussion.id}`

  return (
    <div className="flex items-center gap-1.5">
      {DISCUSSION_STATUS_ACTIONS.map((status) => (
        <Button
          key={status}
          variant="outline"
          size="sm"
          className="capitalize"
          disabled={updateProps.disabled || busyKey === statusKey || discussion.status === status}
          title={updateProps.title}
          onClick={() =>
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
        >
          {busyKey === statusKey ? <Spinner className="size-3.5" /> : null}
          {status}
        </Button>
      ))}
    </div>
  )
}

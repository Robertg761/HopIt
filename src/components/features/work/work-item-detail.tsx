'use client'

import * as React from 'react'
import Link from 'next/link'
import { SearchX } from 'lucide-react'

import { PageScaffold } from '@/components/shell/page-scaffold'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useWorkspace } from '@/components/workspace/workspace-provider'
import type {
  CollaborationDiscussion,
  CollaborationIssue,
  CollaborationProject,
  CollaborationRelease,
  WorkItemsResponse,
} from '@/lib/collaboration'
import { ProjectDetailSection, ReleaseDetailSection } from './detail-sections'
import { DiscussionDetailPage, IssueDetailPage } from './thread-detail'
import { BackToWorkItemsButton, WorkItemsUnavailable, useWorkItemsController } from './work-common'

type Resolved =
  | { kind: 'issue'; issue: CollaborationIssue }
  | { kind: 'discussion'; discussion: CollaborationDiscussion }
  | { kind: 'release'; release: CollaborationRelease }
  | { kind: 'project'; project: CollaborationProject }
  | null

function resolveWorkItem(data: WorkItemsResponse, kind: string, itemId: string): Resolved {
  if (kind === 'issue') {
    const issue = data.issues.find((entry) => entry.id === itemId)
    return issue ? { kind, issue } : null
  }
  if (kind === 'discussion') {
    const discussion = data.discussions.find((entry) => entry.id === itemId)
    return discussion ? { kind, discussion } : null
  }
  if (kind === 'release') {
    const release = data.releases.find((entry) => entry.id === itemId)
    return release ? { kind, release } : null
  }
  if (kind === 'project') {
    const project = data.projects.find((entry) => entry.id === itemId)
    return project ? { kind, project } : null
  }
  return null
}

export function WorkItemDetail({
  codebaseId,
  kind,
  itemId,
}: {
  codebaseId: string
  kind: string
  itemId: string
}) {
  const { actorId } = useWorkspace()
  const { data, loading, busyKey, runMutation } = useWorkItemsController(codebaseId)

  const back = <BackToWorkItemsButton codebaseId={codebaseId} />
  const issuesHref = `/codebases/${encodeURIComponent(codebaseId)}/issues`

  if (loading) {
    return (
      <PageScaffold title="Work item" actions={back}>
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </PageScaffold>
    )
  }

  if (!data) {
    return (
      <PageScaffold title="Work item" actions={back}>
        <EmptyState
          icon={SearchX}
          title="Work items unavailable"
          description="The collaboration backend did not return work items for this repository."
        />
      </PageScaffold>
    )
  }

  if (!data.ok) {
    return (
      <PageScaffold title="Work item" actions={back}>
        <WorkItemsUnavailable response={data} />
      </PageScaffold>
    )
  }

  const resolved = resolveWorkItem(data, kind, itemId)
  if (!resolved) {
    return (
      <PageScaffold title="Work item" actions={back}>
        <EmptyState
          icon={SearchX}
          title="Work item not found"
          description="This item may have been removed, or the link points at a different repository."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href={issuesHref}>Back to issues</Link>
            </Button>
          }
        />
      </PageScaffold>
    )
  }

  const shared = {
    codebaseId,
    actorId,
    capabilities: data.capabilities,
    busyKey,
    runMutation,
  }

  if (resolved.kind === 'issue') {
    return <IssueDetailPage issue={resolved.issue} {...shared} />
  }

  if (resolved.kind === 'discussion') {
    return <DiscussionDetailPage discussion={resolved.discussion} {...shared} />
  }

  if (resolved.kind === 'release') {
    return (
      <PageScaffold
        title={`${resolved.release.version} ${resolved.release.title}`}
        actions={back}
      >
        <ReleaseDetailSection release={resolved.release} {...shared} />
      </PageScaffold>
    )
  }

  return (
    <PageScaffold
      title={resolved.project.name}
      description={resolved.project.description ?? undefined}
      actions={back}
    >
      <ProjectDetailSection project={resolved.project} {...shared} />
    </PageScaffold>
  )
}

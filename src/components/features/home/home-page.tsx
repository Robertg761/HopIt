'use client'

import Link from 'next/link'
import { FolderGit2 } from 'lucide-react'

import { PageScaffold } from '@/components/shell/page-scaffold'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusDot, type StatusDotTone } from '@/components/ui/status-dot'
import { useWorkspace } from '@/components/workspace/workspace-provider'
import type { AgentStatusSnapshot } from '@/lib/client/agent-status'
import { formatRelativeTime } from '@/lib/client/format'
import { repoPath } from '@/components/shell/repo-nav'
import { AttentionCard } from './attention-card'
import { CodebasesPreviewCard } from './codebases-preview-card'
import { QuickActions } from './quick-actions'
import { RecentActivityCard } from './recent-activity-card'
import { StatTiles } from './stat-tiles'

const STATE_TONE: Record<AgentStatusSnapshot['state'], StatusDotTone> = {
  online: 'hop',
  syncing: 'info',
  blocked: 'danger',
  offline: 'neutral',
}

export function HomePage() {
  const { status, loading, hasWorkspace, codebases, codebasesLoading } = useWorkspace()

  return (
    <PageScaffold
      title="Dashboard"
      description={
        hasWorkspace
          ? `${status.codebaseName} · workspace overview`
          : 'Your repositories and workspace status.'
      }
      actions={!loading && hasWorkspace ? <QuickActions /> : undefined}
    >
      {loading ? (
        <HomeSkeleton />
      ) : !hasWorkspace ? (
        <EmptyState
          icon={FolderGit2}
          title="No repository selected"
          description="Create or attach a repository to start working. HopIt keeps a synced workspace on each device."
          action={
            <Button asChild>
              <Link href="/codebases">View repositories</Link>
            </Button>
          }
        />
      ) : (
        <>
          <WorkspaceSummary status={status} />
          <StatTiles status={status} />
          <AttentionCard />
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <RecentActivityCard events={status.events} />
            <CodebasesPreviewCard codebases={codebases} loading={codebasesLoading} />
          </div>
        </>
      )}
    </PageScaffold>
  )
}

function WorkspaceSummary({ status }: { status: AgentStatusSnapshot }) {
  const repoHref = status.codebaseId ? repoPath(status.codebaseId) : '/codebases'

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusDot tone={STATE_TONE[status.state]} pulse={status.state === 'online'} />
            <Link href={repoHref} className="text-sm font-medium text-iris hover:underline">
              {status.codebaseName || 'Repository'}
            </Link>
            <span className="text-sm text-muted-foreground">{status.healthLabel}</span>
            <Badge tone="outline">{status.backend === 'd1' ? 'Cloud' : 'Local'}</Badge>
          </div>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <SummaryItem label="Change set" value={status.activeChangeSetId} />
          <SummaryItem label="Main" value={status.mainRevision} />
          <SummaryItem label="Synced" value={formatRelativeTime(status.lastSync)} />
          <SummaryItem
            label="Review"
            value={status.reviewState}
          />
        </div>
      </CardContent>
    </Card>
  )
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="truncate font-medium" title={value}>{value || '—'}</p>
    </div>
  )
}

function HomeSkeleton() {
  return (
    <>
      <Skeleton className="h-20 w-full" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-24" />
        ))}
      </div>
    </>
  )
}

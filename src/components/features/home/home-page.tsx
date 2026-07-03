'use client'

import Link from 'next/link'
import { FolderGit2 } from 'lucide-react'

import { PageScaffold } from '@/components/shell/page-scaffold'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useWorkspace } from '@/components/workspace/workspace-provider'
import { AttentionCard } from './attention-card'
import { CodebasesPreviewCard } from './codebases-preview-card'
import { HealthStrip } from './health-strip'
import { QuickActions } from './quick-actions'
import { RecentActivityCard } from './recent-activity-card'
import { StatTiles } from './stat-tiles'

export function HomePage() {
  const { status, loading, hasWorkspace, codebases, codebasesLoading } = useWorkspace()

  return (
    <PageScaffold title="Home" description="What's happening across your workspace.">
      {loading ? (
        <HomeSkeleton />
      ) : !hasWorkspace ? (
        <EmptyState
          icon={FolderGit2}
          title="Nothing attached yet"
          description="HopIt keeps your code in the cloud and syncs a thin local view to every device. Attach or create a codebase to get started."
          action={
            <Button asChild>
              <Link href="/codebases">Set up a codebase</Link>
            </Button>
          }
        />
      ) : (
        <>
          <HealthStrip status={status} />
          <StatTiles status={status} />
          <QuickActions />
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

function HomeSkeleton() {
  return (
    <>
      <Skeleton className="h-16 rounded-xl" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </>
  )
}

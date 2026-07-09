'use client'

import Link from 'next/link'
import { ArrowRight, Cloud, FolderGit2, GitBranch, Laptop, Sparkles } from 'lucide-react'

import { PageScaffold } from '@/components/shell/page-scaffold'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusDot, type StatusDotTone } from '@/components/ui/status-dot'
import { useWorkspace } from '@/components/workspace/workspace-provider'
import type { AgentStatusSnapshot } from '@/lib/client/agent-status'
import { formatRelativeTime } from '@/lib/client/format'
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

  const title = status.state === 'blocked'
    ? 'The relay needs you.'
    : status.state === 'syncing'
      ? 'Your work is moving.'
      : 'Everything is in motion.'

  return (
    <PageScaffold
      title={loading ? 'Opening your workspace…' : title}
      description="One living codebase, ready wherever you pick up next."
      actions={!loading && hasWorkspace ? <QuickActions /> : undefined}
    >
      {loading ? (
        <HomeSkeleton />
      ) : !hasWorkspace ? (
        <EmptyState
          icon={FolderGit2}
          title="Your first relay starts here"
          description="Attach a codebase once. HopIt will keep a lightweight, current workspace ready across every device."
          action={
            <Button asChild size="lg">
              <Link href="/codebases">Set up a codebase <ArrowRight /></Link>
            </Button>
          }
        />
      ) : (
        <>
          <WorkspaceRelay status={status} />
          <StatTiles status={status} />
          <AttentionCard />
          <div className="grid items-start gap-5 xl:grid-cols-[1.15fr_0.85fr]">
            <RecentActivityCard events={status.events} />
            <CodebasesPreviewCard codebases={codebases} loading={codebasesLoading} />
          </div>
        </>
      )}
    </PageScaffold>
  )
}

function WorkspaceRelay({ status }: { status: AgentStatusSnapshot }) {
  const lastSync = formatRelativeTime(status.lastSync)

  return (
    <section className="signal-sheen relative overflow-hidden rounded-[1.75rem] bg-[var(--sidebar)] px-5 py-6 text-[var(--sidebar-foreground)] shadow-[0_24px_70px_rgba(23,53,46,0.16)] sm:px-8 sm:py-8 lg:px-10 lg:py-9">
      <div className="absolute -right-12 -top-16 size-56 rounded-full border border-white/10" />
      <div className="absolute -right-2 -top-8 size-32 rounded-full border border-white/10" />

      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-3 flex items-center gap-2 font-mono text-[0.62rem] font-bold uppercase tracking-[0.16em] text-[var(--sidebar-muted)]">
            <StatusDot tone={STATE_TONE[status.state]} pulse={status.state === 'online'} />
            {status.healthLabel} / {status.backend === 'd1' ? 'Cloud relay' : 'Local relay'}
          </div>
          <h2 className="font-display text-[2.6rem] leading-[0.9] tracking-[-0.05em] text-white sm:text-[3.7rem] lg:text-[4.5rem]">
            {status.codebaseName}
          </h2>
          <p className="mt-4 max-w-2xl truncate font-mono text-[0.68rem] text-[var(--sidebar-muted)]" title={status.managedWorkspacePath}>
            {status.managedWorkspacePath}
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3 py-2 font-mono text-[0.62rem] font-semibold uppercase tracking-[0.12em] text-white">
          <Sparkles className="size-3.5 text-[var(--signal)]" />
          Synced {lastSync}
        </div>
      </div>

      <div className="relative mt-10 grid gap-2 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-center">
        <RelayNode
          icon={Laptop}
          index="01"
          label="This device"
          value={status.workspaceHydrationState}
          detail={status.cacheState}
          active
        />
        <RelayArrow />
        <RelayNode
          icon={GitBranch}
          index="02"
          label="Active change set"
          value={status.activeChangeSetId}
          detail={status.reviewState}
        />
        <RelayArrow />
        <RelayNode
          icon={Cloud}
          index="03"
          label="Cloud main"
          value={status.mainRevision}
          detail={status.remoteBehindByRevisions ? `${status.remoteBehindByRevisions} rev behind` : 'Current'}
        />
      </div>
    </section>
  )
}

function RelayNode({
  icon: Icon,
  index,
  label,
  value,
  detail,
  active = false,
}: {
  icon: typeof Laptop
  index: string
  label: string
  value: string
  detail: string
  active?: boolean
}) {
  return (
    <div className="group rounded-2xl border border-white/10 bg-black/10 p-4 transition-colors hover:bg-white/[0.06]">
      <div className="mb-5 flex items-center justify-between">
        <span className={active ? 'grid size-8 place-items-center rounded-full bg-[var(--signal)] text-[#17352e]' : 'grid size-8 place-items-center rounded-full bg-white/10 text-white'}>
          <Icon className="size-4" strokeWidth={1.8} />
        </span>
        <span className="font-mono text-[0.58rem] tracking-[0.16em] text-[var(--sidebar-muted)]">{index}</span>
      </div>
      <p className="font-mono text-[0.58rem] font-semibold uppercase tracking-[0.14em] text-[var(--sidebar-muted)]">{label}</p>
      <p className="mt-1 truncate text-sm font-bold text-white" title={value}>{value}</p>
      <p className="mt-1 truncate text-[0.68rem] text-[var(--sidebar-muted)]">{detail}</p>
    </div>
  )
}

function RelayArrow() {
  return (
    <div className="hidden items-center gap-1 px-1 text-[var(--signal)] md:flex" aria-hidden>
      <span className="relay-dash h-px w-5 opacity-60" />
      <ArrowRight className="size-3.5" />
    </div>
  )
}

function HomeSkeleton() {
  return (
    <>
      <Skeleton className="h-[25rem] rounded-[1.75rem]" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-32 rounded-[1.25rem]" />
        ))}
      </div>
    </>
  )
}

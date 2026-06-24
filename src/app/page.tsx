'use client'

import * as React from 'react'
import { Sidebar } from '@/components/hopit/sidebar'
import { Header } from '@/components/hopit/header'
import { StatsBar } from '@/components/hopit/stats-bar'
import { ReposSection } from '@/components/hopit/repos-section'
import { DriveSection } from '@/components/hopit/drive-section'
import { CodeReviewSection } from '@/components/hopit/code-review-section'
import { MembersInvitationsPanel } from '@/components/hopit/members-invitations-panel'
import { CollaborationSection } from '@/components/hopit/collaboration-section'
import { ActivityFeed } from '@/components/hopit/activity-feed'
import { RightRail } from '@/components/hopit/right-rail'
import { HopItLogo } from '@/components/hopit/logo'
import {
  Activity,
  Cloud,
  FolderOpen,
  GitPullRequest,
  HardDrive,
  KeyRound,
  ShieldCheck,
  Users,
} from 'lucide-react'
import { useAgentStatus } from '@/hooks/use-agent-status'
import type { AgentStatusSnapshot } from '@/lib/agent-status'

export default function Home() {
  const [sidebarOpen, setSidebarOpen] = React.useState(false)
  const agentStatus = useAgentStatus()

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <a
        href="#overview"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[80] focus:rounded-lg focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:shadow-lg focus:ring-2 focus:ring-hop/40"
      >
        Skip to dashboard
      </a>
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <Header onOpenSidebar={() => setSidebarOpen(true)} />

        <main className="workspace-canvas flex-1">
          <div className="mx-auto max-w-[1600px] px-4 py-6 md:px-6 md:py-8">
            <div className="space-y-6">
              <div id="overview" className="scroll-mt-24 space-y-4">
                <CommandCenter status={agentStatus.status} loading={agentStatus.loading} />
                <StatsBar status={agentStatus.status} loading={agentStatus.loading} />
              </div>

              {/* Main split: codebases + files */}
              <div className="grid gap-6 xl:grid-cols-2">
                <div id="codebases" className="scroll-mt-24">
                  <ReposSection status={agentStatus.status} />
                </div>
                <div id="files" className="scroll-mt-24">
                  <DriveSection status={agentStatus.status} />
                </div>
              </div>

              <div id="review" className="scroll-mt-24">
                <CodeReviewSection status={agentStatus.status} />
              </div>
              <div id="team" className="scroll-mt-24">
                <MembersInvitationsPanel
                  status={agentStatus.status}
                  loading={agentStatus.loading}
                  onRefreshStatus={agentStatus.refresh}
                />
              </div>
              <div id="work-items" className="scroll-mt-24">
                <CollaborationSection status={agentStatus.status} />
              </div>

              {/* Activity + right rail */}
              <div className="grid gap-6 lg:grid-cols-3">
                <div id="activity" className="scroll-mt-24 lg:col-span-2">
                  <ActivityFeed status={agentStatus.status} />
                </div>
                <div id="status" className="scroll-mt-24">
                  <RightRail
                    status={agentStatus.status}
                    loading={agentStatus.loading}
                    runCommand={agentStatus.runCommand}
                    runningCommand={agentStatus.runningCommand}
                    commandResult={agentStatus.commandResult}
                  />
                </div>
              </div>
            </div>
          </div>
        </main>

        <Footer />
      </div>
    </div>
  )
}

function CommandCenter({
  status,
  loading,
}: {
  status: AgentStatusSnapshot
  loading: boolean
}) {
  const online = status.state === 'online' || status.state === 'syncing'
  const blocked = status.state === 'blocked'
  const healthLabel = loading ? 'connecting' : status.healthLabel
  const storageLabel = status.backend === 'convex'
    ? 'Convex graph'
    : status.backend
  const summaryItems = [
    {
      label: 'Agent sync',
      value: healthLabel,
      icon: Activity,
      active: online,
      danger: blocked,
    },
    {
      label: 'Privacy',
      value: status.privateScope === 'scoped' ? 'Shield active' : 'Unscoped',
      icon: ShieldCheck,
      active: status.privateScope === 'scoped',
    },
    {
      label: 'Graph',
      value: storageLabel,
      icon: Cloud,
      active: status.backend !== 'unknown',
    },
    {
      label: 'Remote pull',
      value: status.remotePullEnabled ? status.remotePullState : 'disabled',
      icon: HardDrive,
      active: status.remotePullEnabled,
    },
  ]
  const quickLinks = [
    { id: 'files', label: 'Files', icon: FolderOpen },
    { id: 'review', label: 'Review', icon: GitPullRequest },
    { id: 'team', label: 'Members', icon: Users },
    { id: 'status', label: 'Agent', icon: HardDrive },
  ]

  return (
    <section
      aria-label="HopIt command center"
      className="overflow-hidden rounded-lg border border-border/70 bg-card shadow-sm"
    >
      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.55fr)]">
        <div className="workspace-grid bg-ink px-4 py-4 text-ink-foreground md:px-5 md:py-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="mono-label rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-ink-foreground/60">
                  Workspace command
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-md bg-hop/15 px-2 py-1 text-[10px] font-medium text-hop ring-1 ring-hop/25">
                  <span className="size-1.5 rounded-full bg-hop live-pulse" />
                  {healthLabel}
                </span>
              </div>
              <h1 className="mt-3 text-2xl font-semibold leading-tight md:text-3xl">
                HopIt Private Cloud OS
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-ink-foreground/70">
                {status.codebaseName === 'No codebase'
                  ? 'No managed workspace is connected on this device yet.'
                  : `${status.codebaseName} is mounted as a live cloud workspace with local agent state.`}
              </p>
            </div>
            <div className="shrink-0 rounded-md border border-white/10 bg-white/[0.04] px-3 py-2 text-left sm:min-w-48">
              <p className="mono-label text-[10px] text-ink-foreground/50">Active change set</p>
              <p className="mt-1 truncate font-mono text-sm font-semibold text-ink-foreground">
                {status.activeChangeSetId}
              </p>
              <p className="mt-1 truncate text-[11px] text-ink-foreground/60">
                head {status.cloudRevision}
              </p>
            </div>
          </div>
        </div>

        <div className="border-t border-border/70 bg-card lg:border-l lg:border-t-0">
          <div className="grid grid-cols-2">
            {summaryItems.map((item) => {
              const Icon = item.icon
              return (
                <div
                  key={item.label}
                  className="min-w-0 border-b border-r border-border/60 p-3 even:border-r-0 [&:nth-child(n+3)]:border-b-0 md:p-4"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Icon
                      className={[
                        'size-4 shrink-0',
                        item.danger
                          ? 'text-destructive'
                          : item.active
                            ? 'text-hop'
                            : 'text-muted-foreground',
                      ].join(' ')}
                    />
                    <p className="mono-label truncate text-[10px] text-muted-foreground">
                      {item.label}
                    </p>
                  </div>
                  <p className="mt-1 truncate text-sm font-semibold capitalize">
                    {item.value}
                  </p>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t border-border/70 px-4 py-3 md:flex-row md:items-center md:justify-between md:px-5">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <KeyRound className="size-3.5 shrink-0 text-hop-amber" />
          <span className="truncate">
            {status.privateScope === 'scoped'
              ? `${status.visibility} workspace with owner-private scope`
              : `${status.visibility} workspace`}
          </span>
        </div>
        <div className="grid grid-cols-4 gap-1.5 sm:flex sm:items-center">
          {quickLinks.map((item) => {
            const Icon = item.icon
            return (
              <a
                key={item.id}
                href={`#${item.id}`}
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border/70 bg-background px-2 text-xs font-medium text-foreground transition hover:border-hop/40 hover:bg-hop/5 hover:text-hop"
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="hidden sm:inline">{item.label}</span>
              </a>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer className="mt-auto border-t border-border/60 bg-card/90">
      <div className="mx-auto max-w-[1600px] px-4 py-6 md:px-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <HopItLogo size={26} />
            <span className="text-xs text-muted-foreground">
              © {new Date().getFullYear()} HopIt Labs · Code &amp; files. Together.
            </span>
          </div>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Cloud className="size-3.5 text-hop" />
              Always synced
            </span>
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="size-3.5 text-hop" />
              Prototype workspace
            </span>
          </div>
        </div>
      </div>
    </footer>
  )
}

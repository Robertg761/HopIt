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
import { Cloud, ShieldCheck } from 'lucide-react'
import { useAgentStatus } from '@/hooks/use-agent-status'

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

        <main className="flex-1">
          <div className="mx-auto max-w-[1600px] px-4 py-6 md:px-6 md:py-8">
            <div className="space-y-6">
              <div id="overview" className="scroll-mt-24">
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

function Footer() {
  return (
    <footer className="mt-auto border-t border-border/60 bg-card">
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

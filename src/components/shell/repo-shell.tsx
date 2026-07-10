'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { BookMarked, ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useWorkspace } from '@/components/workspace/workspace-provider'
import { activeRepoTabId, repoPath, repoTabs } from '@/components/shell/repo-nav'
import { Badge } from '@/components/ui/badge'
import { StatusDot } from '@/components/ui/status-dot'
import type { AgentStatusSnapshot } from '@/lib/client/agent-status'

function repositoryStatus(status: AgentStatusSnapshot) {
  if (status.state === 'offline') return { label: 'Offline', tone: 'neutral' as const, pulse: false }
  const conflictState = status.conflictState.toLowerCase()
  if (status.state === 'blocked' || !['none', 'clean', 'unavailable'].includes(conflictState)) {
    return { label: 'Needs attention', tone: 'danger' as const, pulse: false }
  }
  if (status.state === 'syncing' || status.pendingWrites > 0) {
    return { label: 'Syncing', tone: 'info' as const, pulse: true }
  }
  if (status.remoteBehindByRevisions !== null && status.remoteBehindByRevisions > 0) {
    return { label: 'Behind', tone: 'amber' as const, pulse: false }
  }
  return { label: 'Synced', tone: 'hop' as const, pulse: false }
}

export function RepoShell({
  codebaseId,
  children,
}: {
  codebaseId: string
  children: React.ReactNode
}) {
  const pathname = usePathname() ?? ''
  const { selectCodebase, codebases, status } = useWorkspace()
  const activeTab = activeRepoTabId(pathname)

  React.useEffect(() => {
    selectCodebase(codebaseId)
  }, [codebaseId, selectCodebase])

  const codebase = codebases.find((entry) => entry.id === codebaseId)
  const name = codebase?.name ?? (status.codebaseId === codebaseId ? status.codebaseName : codebaseId)
  const visibility = codebase?.visibility ?? 'private'
  const repoStatus = repositoryStatus(status)

  return (
    <div>
      <div className="border-b border-border bg-background">
        <div className="mx-auto w-full max-w-[1280px] px-4 pt-4 sm:px-6 lg:px-8">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <Link
              href="/codebases"
              className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-iris hover:underline"
            >
              <BookMarked className="size-4" />
              Repositories
            </Link>
            <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />
            <span className="inline-flex items-center gap-2 font-semibold">
              <BookMarked className="size-4 text-muted-foreground" />
              {name}
            </span>
            <Badge tone="outline" className="capitalize">
              {visibility}
            </Badge>
            {status.codebaseId === codebaseId ? (
              <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <StatusDot tone={repoStatus.tone} pulse={repoStatus.pulse} />
                {repoStatus.label}
              </span>
            ) : null}
          </div>

          <nav aria-label="Repository" className="-mb-px flex gap-0 overflow-x-auto">
            {repoTabs.map((tab) => {
              const href = repoPath(codebaseId, tab.segment)
              const isActive = tab.id === activeTab
              return (
                <Link
                  key={tab.id}
                  href={href}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
                    isActive
                      ? 'border-[var(--signal-orange)] text-foreground'
                      : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground',
                  )}
                >
                  <tab.icon className="size-4" strokeWidth={1.75} />
                  {tab.label}
                </Link>
              )
            })}
          </nav>
        </div>
      </div>
      {children}
    </div>
  )
}

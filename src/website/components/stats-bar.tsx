'use client'

import { motion } from 'framer-motion'
import {
  Activity,
  Code2,
  Folder,
  GitPullRequest,
  History,
} from 'lucide-react'
import type { AgentStatusSnapshot } from '@/website/lib/agent-status'

type Stat = {
  label: string
  value: string
  icon: React.ComponentType<{ className?: string }>
  accent: string
  bg: string
}

type StatsBarProps = {
  status: AgentStatusSnapshot
  loading: boolean
}

export function StatsBar({ status, loading }: StatsBarProps) {
  const stats: Stat[] = [
    {
      label: 'Codebase',
      value: loading ? '...' : status.codebaseName,
      icon: Code2,
      accent: 'text-hop',
      bg: 'bg-hop/10',
    },
    {
      label: 'Visible files',
      value: loading ? '...' : status.fileCount.toLocaleString(),
      icon: Folder,
      accent: 'text-grape',
      bg: 'bg-grape/10',
    },
    {
      label: 'Pending writes',
      value: loading ? '...' : status.pendingWrites.toString(),
      icon: History,
      accent: status.pendingWrites > 0 ? 'text-hop-amber' : 'text-hop',
      bg: status.pendingWrites > 0 ? 'bg-hop-amber/10' : 'bg-hop/10',
    },
    {
      label: 'Review state',
      value: loading ? '...' : status.reviewState,
      icon: GitPullRequest,
      accent: status.conflictState === 'conflicted' ? 'text-destructive' : 'text-sky-500',
      bg: status.conflictState === 'conflicted' ? 'bg-destructive/10' : 'bg-sky-500/10',
    },
  ]

  return (
    <motion.section
      aria-label="Workspace summary"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      className="overflow-hidden rounded-lg border border-border/70 bg-card shadow-sm"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Activity className="size-4 shrink-0 text-hop" />
          <p className="mono-label truncate text-[10px] text-muted-foreground">
            Workspace telemetry
          </p>
        </div>
        <span className="rounded-md bg-hop/10 px-2 py-1 text-[10px] font-medium text-hop ring-1 ring-hop/20">
          Live
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4">
        {stats.map((s) => {
          const Icon = s.icon
          return (
            <div
              key={s.label}
              className="group relative min-w-0 border-border/60 p-3 transition hover:bg-muted/35 sm:border-l sm:first:border-l-0 md:p-4 [&:nth-child(odd)]:border-r sm:[&:nth-child(odd)]:border-r-0 [&:nth-child(n+3)]:border-t sm:[&:nth-child(n+3)]:border-t-0"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className={`flex size-8 shrink-0 items-center justify-center rounded-md ${s.bg}`}>
                  <Icon className={`size-4 ${s.accent}`} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-semibold leading-tight [overflow-wrap:anywhere] md:text-lg">
                    {s.value}
                  </p>
                  <p className="mono-label truncate text-[10px] text-muted-foreground">{s.label}</p>
                </div>
              </div>
              <div className="absolute inset-x-0 bottom-0 h-0.5 origin-left scale-x-0 bg-hop transition-transform duration-300 group-hover:scale-x-100" />
            </div>
          )
        })}
      </div>
    </motion.section>
  )
}

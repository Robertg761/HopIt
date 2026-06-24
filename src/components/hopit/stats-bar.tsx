'use client'

import { motion } from 'framer-motion'
import {
  Code2,
  Folder,
  GitPullRequest,
  History,
} from 'lucide-react'
import type { AgentStatusSnapshot } from '@/lib/agent-status'

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
      className="grid grid-cols-2 overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm sm:grid-cols-4"
    >
      {stats.map((s) => {
        const Icon = s.icon
        return (
          <div
            key={s.label}
            className="group relative min-w-0 border-border/60 p-3 transition hover:bg-muted/35 sm:border-l sm:first:border-l-0 md:p-4 [&:nth-child(odd)]:border-r sm:[&:nth-child(odd)]:border-r-0 [&:nth-child(n+3)]:border-t sm:[&:nth-child(n+3)]:border-t-0"
          >
            <div className="flex min-w-0 items-center gap-3">
              <div className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${s.bg}`}>
                <Icon className={`size-4.5 ${s.accent}`} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="break-words text-lg font-semibold leading-tight sm:text-xl md:text-2xl [overflow-wrap:anywhere]">
                  {s.value}
                </p>
                <p className="truncate text-xs text-muted-foreground">{s.label}</p>
              </div>
            </div>
            {/* hover ribbon */}
            <div className="absolute inset-x-0 bottom-0 h-0.5 origin-left scale-x-0 bg-hop-gradient transition-transform duration-300 group-hover:scale-x-100" />
          </div>
        )
      })}
    </motion.section>
  )
}

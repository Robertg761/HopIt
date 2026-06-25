'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  Clock,
  FileStack,
  History,
  Lock,
  MoreHorizontal,
  Plus,
  RotateCcw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { codebases, type Codebase } from './data'
import { cn } from '@/lib/utils'
import type { AgentStatusSnapshot } from '@/website/lib/agent-status'

type ReposSectionProps = {
  status: AgentStatusSnapshot
}

export function ReposSection({ status }: ReposSectionProps) {
  const [filter, setFilter] = React.useState<'all' | 'public' | 'private'>('all')
  const codebaseItems = codebasesWithLiveStatus(status)
  const filtered = codebaseItems.filter((codebase) => {
    if (filter === 'public') return codebase.visibility === 'public'
    if (filter === 'private') return codebase.visibility === 'private'
    return true
  })

  return (
    <section
      aria-label="Codebases"
      className="panel-surface flex flex-col rounded-xl border border-border shadow-sm"
    >
      <SectionHeader
        title="Codebases"
        subtitle="Your team's code, organized."
        count={codebaseItems.length}
        filter={filter}
        setFilter={setFilter}
      />

      <div className="grid gap-3 p-4 md:grid-cols-2">
        {filtered.length > 0 ? (
          filtered.map((codebase, i) => (
            <CodebaseCard key={codebase.id} codebase={codebase} index={i} />
          ))
        ) : (
          <EmptyCodebases />
        )}
      </div>

    </section>
  )
}

function SectionHeader({
  title,
  subtitle,
  count,
  filter,
  setFilter,
}: {
  title: string
  subtitle: string
  count: number
  filter: 'all' | 'public' | 'private'
  setFilter: (f: 'all' | 'public' | 'private') => void
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-border/60 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">{title}</h2>
          <Badge variant="secondary" className="rounded-full bg-hop/10 text-hop">
            {count}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex items-center rounded-md border border-border/60 bg-muted/50 p-0.5">
          {(['all', 'public', 'private'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'rounded px-2.5 py-1 text-xs font-medium capitalize transition',
                filter === f
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {f}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled
          title="Codebase creation will land after account-wide discovery."
          className="gap-1.5 rounded-md border-dashed"
        >
          <Plus className="size-3.5 text-hop" />
          New codebase
        </Button>
      </div>
    </div>
  )
}

function codebasesWithLiveStatus(status: AgentStatusSnapshot): Codebase[] {
  if (status.state === 'offline' || status.codebaseName === 'No codebase') return codebases

  const liveCodebase: Codebase = {
    id: 'live-agent-codebase',
    name: status.codebaseName,
    owner: 'local',
    description: `Active change set ${status.activeChangeSetId} backed by the local managed workspace.`,
    language: 'Local',
    languageColor: '#10b981',
    snapshots: revisionNumber(status.cloudRevision),
    syncedFiles: status.fileCount,
    pendingSyncs: status.pendingWrites,
    latestSnapshot: {
      id: status.cloudRevision,
      message: status.events[0]?.detail ?? 'Local agent status is live',
      author: 'HopIt Agent',
      when: status.events[0]?.when ?? 'now',
    },
    tags: Array.from(new Set([status.visibility, status.reviewState, status.mergeState].filter(Boolean))),
    visibility: status.visibility === 'private' ? 'private' : 'public',
  }

  return [liveCodebase, ...codebases.filter((codebase) => codebase.name !== status.codebaseName)]
}

function EmptyCodebases() {
  return (
    <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 p-6 text-center md:col-span-2">
      <p className="text-sm font-medium">No real codebase connected</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Import a local folder with the HopIt agent, then start the status server to populate this view.
      </p>
    </div>
  )
}

function revisionNumber(revision: string) {
  const match = revision.match(/\d+/)
  return match ? Number(match[0]) : 0
}

function CodebaseCard({ codebase, index }: { codebase: Codebase; index: number }) {
  return (
    <motion.article
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05, duration: 0.35, ease: 'easeOut' }}
      className="group relative flex flex-col justify-between gap-4.5 rounded-xl border border-border bg-card p-5 transition duration-250 hover:border-primary/40 hover:shadow-md"
    >
      <div className="flex flex-col gap-3">
        {/* header row */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <div
              className="flex size-9 shrink-0 items-center justify-center rounded-xl text-xs font-bold text-white shadow-sm"
              style={{
                background: `linear-gradient(135deg, ${codebase.languageColor}, ${codebase.languageColor}dd)`,
              }}
            >
              {codebase.name.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-semibold text-muted-foreground">{codebase.owner}/</span>
                <h3 className="truncate text-sm font-bold text-foreground group-hover:text-primary transition duration-150">
                  {codebase.name}
                </h3>
                {codebase.visibility === 'private' && (
                  <Lock className="size-3 text-muted-foreground" />
                )}
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground leading-relaxed">
                {codebase.description}
              </p>
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="rounded-lg p-1.5 text-muted-foreground opacity-0 transition hover:bg-muted group-hover:opacity-100 cursor-pointer"
                aria-label="Codebase actions"
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem disabled>Sync now</DropdownMenuItem>
              <DropdownMenuItem disabled>Open snapshot</DropdownMenuItem>
              <DropdownMenuItem disabled>Share</DropdownMenuItem>
              <DropdownMenuItem disabled>Settings</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* tags */}
        <div className="flex flex-wrap gap-1.5 mt-0.5">
          {codebase.tags.map((t) => (
            <span
              key={t}
              className="rounded-md bg-secondary/80 px-2 py-0.5 text-[9px] font-bold text-muted-foreground uppercase tracking-wide border border-border/40"
            >
              #{t}
            </span>
          ))}
        </div>

        {/* metrics row */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-1 text-[11px] text-muted-foreground font-medium">
          <span className="flex items-center gap-1.5">
            <History className="size-3 text-primary" />
            {formatNum(codebase.snapshots)} snapshots
          </span>
          <span className="flex items-center gap-1.5">
            <FileStack className="size-3 text-primary" />
            {codebase.syncedFiles} files
          </span>
          <span className="flex items-center gap-1.5">
            <RotateCcw className="size-3 text-primary" />
            {codebase.pendingSyncs} syncs
          </span>
        </div>
      </div>

      {/* latest snapshot */}
      <div className="flex items-center gap-3 rounded-lg bg-secondary/35 border border-border/40 p-2.5">
        <div className="flex size-6.5 shrink-0 items-center justify-center rounded-full bg-hop-gradient text-[9px] font-black text-white shadow-sm shadow-primary/10">
          {codebase.latestSnapshot.author
              .split(' ')
              .map((n) => n[0])
              .join('')}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-bold text-foreground">
            {codebase.latestSnapshot.message}
          </p>
          <p className="truncate text-[10px] text-muted-foreground mt-0.5">
            <span className="font-mono font-semibold text-primary">{codebase.latestSnapshot.id}</span> ·{' '}
            {codebase.latestSnapshot.author}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-muted-foreground">
          <Clock className="size-2.5" />
          {codebase.latestSnapshot.when}
        </span>
      </div>
    </motion.article>
  )
}

function formatNum(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

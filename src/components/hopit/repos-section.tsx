'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  Clock,
  GitPullRequest,
  Lock,
  MoreHorizontal,
  Plus,
  CircleDot,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { repos, type Repo } from './data'
import { cn } from '@/lib/utils'

export function ReposSection() {
  const [filter, setFilter] = React.useState<'all' | 'public' | 'private'>('all')
  const filtered = repos.filter((r) => {
    if (filter === 'public') return r.visibility === 'public'
    if (filter === 'private') return r.visibility === 'private'
    return true
  })

  return (
    <section
      aria-label="Repositories"
      className="flex flex-col rounded-2xl border border-border/60 bg-card shadow-sm"
    >
      <SectionHeader
        title="Repositories"
        subtitle="Your team's code, organized."
        filter={filter}
        setFilter={setFilter}
      />

      <div className="grid gap-3 p-4 md:grid-cols-2">
        {filtered.map((r, i) => (
          <RepoCard key={r.id} repo={r} index={i} />
        ))}
      </div>

    </section>
  )
}

function SectionHeader({
  title,
  subtitle,
  filter,
  setFilter,
}: {
  title: string
  subtitle: string
  filter: 'all' | 'public' | 'private'
  setFilter: (f: 'all' | 'public' | 'private') => void
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-border/60 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          <Badge variant="secondary" className="rounded-full bg-hop/10 text-hop">
            {repos.length}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex items-center rounded-lg border border-border/60 bg-muted/50 p-0.5">
          {(['all', 'public', 'private'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium capitalize transition',
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
          className="gap-1.5 rounded-lg border-dashed"
        >
          <Plus className="size-3.5 text-hop" />
          New repo
        </Button>
      </div>
    </div>
  )
}

function RepoCard({ repo, index }: { repo: Repo; index: number }) {
  return (
    <motion.article
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04, duration: 0.35 }}
      className="group relative flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-4 transition hover:border-hop/30 hover:shadow-md"
    >
      {/* header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white"
            style={{
              background: `linear-gradient(135deg, ${repo.languageColor}, ${repo.languageColor}aa)`,
            }}
          >
            {repo.name.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">{repo.owner}/</span>
              <h3 className="truncate text-sm font-semibold text-foreground group-hover:text-hop">
                {repo.name}
              </h3>
              {repo.visibility === 'private' && (
                <Lock className="size-3 text-muted-foreground/70" />
              )}
            </div>
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {repo.description}
            </p>
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="rounded-md p-1 text-muted-foreground opacity-0 transition hover:bg-muted group-hover:opacity-100"
              aria-label="Repo actions"
            >
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem>Clone</DropdownMenuItem>
            <DropdownMenuItem>Open in CLI</DropdownMenuItem>
            <DropdownMenuItem>Share</DropdownMenuItem>
            <DropdownMenuItem>Settings</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* tags */}
      <div className="flex flex-wrap gap-1.5">
        {repo.tags.map((t) => (
          <span
            key={t}
            className="rounded-md bg-muted/70 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
          >
            #{t}
          </span>
        ))}
      </div>

      {/* metrics row */}
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <TopHatIcon
            className={cn('size-3', repo.starred ? 'text-amber-star' : '')}
          />
          {formatNum(repo.stars)}
        </span>
        <span className="flex items-center gap-1">
          <CircleDot className="size-3" />
          {repo.openIssues}
        </span>
        <span className="flex items-center gap-1">
          <GitPullRequest className="size-3" />
          {repo.openPRs}
        </span>
      </div>

      {/* last commit */}
      <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-2.5 py-2">
        <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-hop-gradient text-[10px] font-bold text-white">
          {repo.lastCommit.author
            .split(' ')
            .map((n) => n[0])
            .join('')}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11.5px] font-medium text-foreground">
            {repo.lastCommit.message}
          </p>
          <p className="truncate text-[10.5px] text-muted-foreground">
            <span className="font-mono">{repo.lastCommit.sha}</span> ·{' '}
            {repo.lastCommit.author}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-muted-foreground">
          <Clock className="size-2.5" />
          {repo.lastCommit.when}
        </span>
      </div>
    </motion.article>
  )
}

function TopHatIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={className}
      fill="none"
    >
      <path
        d="M5.25 3.25h5.5l.45 6.1h-6.4l.45-6.1Z"
        fill="currentColor"
        opacity="0.9"
      />
      <path
        d="M4.55 8.55h6.9c1.25 0 2.3.84 2.3 1.88 0 .67-.54 1.22-1.2 1.22h-9.1c-.66 0-1.2-.55-1.2-1.22 0-1.04 1.05-1.88 2.3-1.88Z"
        fill="currentColor"
      />
      <path
        d="M5 6.4h6"
        stroke="hsl(var(--background))"
        strokeLinecap="round"
        strokeWidth="1.2"
      />
    </svg>
  )
}

function formatNum(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

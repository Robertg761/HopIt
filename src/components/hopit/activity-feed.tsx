'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  GitCommitHorizontal,
  GitPullRequest,
  CircleDot,
  Upload,
  MessageSquare,
} from 'lucide-react'
import { activityFeed, activityIconMap, type ActivityItem } from './data'
import { cn } from '@/lib/utils'

type PrototypeActivityType = Extract<
  ActivityItem['what'],
  'commit' | 'pr' | 'issue' | 'upload' | 'comment'
>

type PrototypeActivityItem = ActivityItem & { what: PrototypeActivityType }

const prototypeActivityTypes = new Set<ActivityItem['what']>([
  'commit',
  'pr',
  'issue',
  'upload',
  'comment',
])

const prototypeActivityFeed = activityFeed.filter(
  (item): item is PrototypeActivityItem => prototypeActivityTypes.has(item.what),
)

const iconMap = {
  ...activityIconMap,
  commit: GitCommitHorizontal,
  pr: GitPullRequest,
  issue: CircleDot,
  upload: Upload,
  comment: MessageSquare,
} as const

const accentMap: Record<PrototypeActivityType, string> = {
  commit: 'text-hop bg-hop/10',
  pr: 'text-grape bg-grape/10',
  issue: 'text-destructive bg-destructive/10',
  upload: 'text-sky-500 bg-sky-500/10',
  comment: 'text-amber-star bg-amber-star/10',
}

const verbMap: Record<PrototypeActivityType, string> = {
  commit: 'pushed a commit to',
  pr: 'opened a pull request in',
  issue: 'opened an issue in',
  upload: 'uploaded',
  comment: 'commented on',
}

const filterTabs = [
  { id: 'all', label: 'All' },
  { id: 'commit', label: 'Commits' },
  { id: 'pr', label: 'PRs' },
  { id: 'upload', label: 'Uploads' },
  { id: 'comment', label: 'Comments' },
] as const

type Filter = (typeof filterTabs)[number]['id']

export function ActivityFeed() {
  const [filter, setFilter] = React.useState<Filter>('all')
  const items = prototypeActivityFeed.filter((a) => filter === 'all' || a.what === filter)

  return (
    <section className="flex flex-col rounded-2xl border border-border/60 bg-card shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border/60 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold tracking-tight">Activity</h2>
            <span className="flex items-center gap-1 rounded-full bg-hop/10 px-1.5 py-0.5 text-[10px] font-medium text-hop">
              <span className="size-1.5 rounded-full bg-hop live-pulse" />
              Live
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Unified timeline across repos, files, and discussions
          </p>
        </div>
        <div className="flex items-center gap-1 overflow-x-auto scroll-thin">
          {filterTabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setFilter(t.id)}
              className={cn(
                'whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition',
                filter === t.id
                  ? 'bg-hop/10 text-hop ring-1 ring-inset ring-hop/30'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <ol className="relative p-4">
        {/* vertical rail */}
        <span
          aria-hidden="true"
          className="absolute left-[28px] top-6 bottom-6 w-px bg-gradient-to-b from-border via-border/60 to-transparent"
        />
        {items.map((item, i) => {
          const Icon = iconMap[item.what]
          return (
            <motion.li
              key={item.id}
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.04, duration: 0.35 }}
              className="relative flex gap-3 pb-4 last:pb-0"
            >
              {/* avatar + icon badge */}
              <div className="relative shrink-0">
                <div
                  className="flex size-9 items-center justify-center rounded-full text-[11px] font-semibold text-white ring-2 ring-card"
                  style={{ backgroundColor: item.who.color }}
                >
                  {item.who.name
                    .split(' ')
                    .map((n) => n[0])
                    .join('')}
                </div>
                <div
                  className={cn(
                    'absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full ring-2 ring-card',
                    accentMap[item.what],
                  )}
                >
                  <Icon className="size-2.5" />
                </div>
              </div>

              <div className="min-w-0 flex-1 pt-0.5">
                <p className="text-sm leading-snug">
                  <span className="font-semibold text-foreground">{item.who.name}</span>{' '}
                  <span className="text-muted-foreground">{verbMap[item.what]}</span>{' '}
                  <span className="font-medium text-foreground">{item.target}</span>
                </p>
                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                  {item.detail}
                </p>
                <p className="mt-1 text-[10.5px] text-muted-foreground/70">
                  <span className="font-mono">@{item.who.handle}</span> · {item.when}
                </p>
              </div>
            </motion.li>
          )
        })}
      </ol>

      <div className="border-t border-border/60 p-3 text-center">
        <button className="text-xs text-muted-foreground hover:text-foreground">
          Load older activity →
        </button>
      </div>
    </section>
  )
}

'use client'

import * as React from 'react'
import { motion } from 'framer-motion'
import {
  History,
  RotateCcw,
  Upload,
  MessageSquare,
} from 'lucide-react'
import { type ActivityItem } from './data'
import { cn } from '@/lib/utils'
import type { AgentStatusSnapshot } from '@/website/lib/agent-status'

type PrototypeActivityType = Extract<
  ActivityItem['what'],
  'snapshot' | 'sync' | 'upload' | 'comment'
>

type PrototypeActivityItem = ActivityItem & { what: PrototypeActivityType }

const prototypeActivityTypes = new Set<ActivityItem['what']>([
  'snapshot',
  'sync',
  'upload',
  'comment',
])

const iconMap = {
  snapshot: History,
  sync: RotateCcw,
  upload: Upload,
  comment: MessageSquare,
} as const

const accentMap: Record<PrototypeActivityType, string> = {
  snapshot: 'text-primary bg-primary/10 border border-primary/20 shadow-sm',
  sync: 'text-grape bg-grape/10 border border-grape/20 shadow-sm',
  upload: 'text-sky-500 bg-sky-500/10 border border-sky-500/20 shadow-sm',
  comment: 'text-hop-amber bg-hop-amber/10 border border-hop-amber/20 shadow-sm',
}

const verbMap: Record<PrototypeActivityType, string> = {
  snapshot: 'saved a snapshot in',
  sync: 'synced',
  upload: 'uploaded',
  comment: 'commented on',
}

const filterTabs = [
  { id: 'all', label: 'All' },
  { id: 'snapshot', label: 'Snapshots' },
  { id: 'sync', label: 'Syncs' },
  { id: 'upload', label: 'Uploads' },
  { id: 'comment', label: 'Comments' },
] as const

type Filter = (typeof filterTabs)[number]['id']

type ActivityFeedProps = {
  status: AgentStatusSnapshot
}

export function ActivityFeed({ status }: ActivityFeedProps) {
  const [filter, setFilter] = React.useState<Filter>('all')
  const liveItems = status.events.some((event) => event.label !== 'agent:offline')
    ? status.events.map(agentEventToActivity)
    : []
  const items = liveItems.filter((a) => filter === 'all' || a.what === filter)

  return (
    <section className="panel-surface flex flex-col rounded-xl border border-border shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border/60 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-foreground">Activity</h2>
            <span className="flex items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-[9.5px] font-bold text-primary">
              <span className="size-1.5 rounded-full bg-primary live-pulse" />
              Live
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Live agent events and workspace activity
          </p>
        </div>
        <div className="flex items-center gap-1.5 overflow-x-auto scroll-thin pb-1 sm:pb-0">
          {filterTabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setFilter(t.id)}
              className={cn(
                'whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold border transition cursor-pointer',
                filter === t.id
                  ? 'bg-primary/10 text-primary border-primary/25 shadow-sm shadow-primary/5'
                  : 'text-muted-foreground border-transparent hover:bg-muted hover:text-foreground',
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
        {items.length > 0 ? items.map((item, i) => {
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
        }) : (
          <li className="rounded-lg border border-dashed border-border/70 bg-muted/20 p-6 text-center">
            <p className="text-sm font-medium">No real agent activity yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Import a local project or start the agent status server to populate this feed.
            </p>
          </li>
        )}
      </ol>

      <div className="border-t border-border/60 p-3 text-center">
        <button
          disabled
          className="text-xs text-muted-foreground/70 disabled:cursor-not-allowed"
        >
          No older activity loaded
        </button>
      </div>
    </section>
  )
}

function agentEventToActivity(event: AgentStatusSnapshot['events'][number], index: number): PrototypeActivityItem {
  const what = activityTypeForEvent(event.label)
  return {
    id: event.id,
    who: { name: 'HopIt Agent', handle: 'agent', color: '#10b981' },
    what,
    target: event.label,
    detail: event.detail,
    when: event.when,
  }
}

function activityTypeForEvent(label: string): PrototypeActivityType {
  if (label.includes('sync') || label.includes('acknowledged') || label.includes('journal')) return 'sync'
  if (label.includes('merge') || label.includes('review')) return 'snapshot'
  if (label.includes('hydrated') || label.includes('refresh')) return 'upload'
  return 'snapshot'
}

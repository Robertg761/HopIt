'use client'

import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusDot, type StatusDotTone } from '@/components/ui/status-dot'
import type { AgentEvent, AgentEventTone } from '@/lib/client/agent-status'

const EVENT_TONE: Record<AgentEventTone, StatusDotTone> = {
  ready: 'hop',
  syncing: 'info',
  queued: 'amber',
  blocked: 'danger',
  observed: 'neutral',
}

export function RecentActivityCard({ events }: { events: AgentEvent[] }) {
  const recent = events.slice(0, 7)

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-row items-center justify-between border-b border-border/80 pb-5">
        <div>
          <p className="mono-label mb-2 text-muted-foreground">Live feed / newest first</p>
          <CardTitle className="font-display text-2xl font-normal tracking-[-0.03em]">What just moved</CardTitle>
        </div>
        <Link href="/activity" className="grid size-9 place-items-center rounded-full border border-foreground/15 transition-colors hover:bg-foreground hover:text-background" aria-label="View all activity">
          <ArrowUpRight className="size-4" />
        </Link>
      </CardHeader>
      <CardContent className="p-0 sm:p-0">
        {recent.length === 0 ? (
          <p className="px-6 py-10 text-sm text-muted-foreground">No movement yet.</p>
        ) : (
          <ol>
            {recent.map((event, index) => (
              <li key={event.id} className="group grid grid-cols-[2rem_1fr_auto] items-center gap-3 border-b border-border/70 px-5 py-3.5 last:border-0 hover:bg-muted/45 sm:px-6">
                <span className="font-mono text-[0.58rem] text-muted-foreground">{String(index + 1).padStart(2, '0')}</span>
                <div className="min-w-0">
                  <p className="flex items-center gap-2 truncate text-[0.82rem] font-bold">
                    <StatusDot tone={EVENT_TONE[event.tone]} />
                    {event.label}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{event.detail}</p>
                </div>
                <time className="shrink-0 font-mono text-[0.62rem] text-muted-foreground">{event.when}</time>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}

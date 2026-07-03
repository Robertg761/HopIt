'use client'

import Link from 'next/link'

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

/** Compact list of the most recent agent events with a link to the full ledger. */
export function RecentActivityCard({ events }: { events: AgentEvent[] }) {
  const recent = events.slice(0, 8)

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Recent activity</CardTitle>
        <Link
          href="/activity"
          className="rounded text-xs font-medium text-iris outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          View all
        </Link>
      </CardHeader>
      <CardContent className="pt-3">
        {recent.length === 0 ? (
          <p className="text-xs text-muted-foreground">No activity yet.</p>
        ) : (
          <ul className="space-y-1">
            {recent.map((event) => (
              <li
                key={event.id}
                className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted/50"
              >
                <StatusDot tone={EVENT_TONE[event.tone]} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{event.label}</p>
                  <p className="truncate text-xs text-muted-foreground">{event.detail}</p>
                </div>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {event.when}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

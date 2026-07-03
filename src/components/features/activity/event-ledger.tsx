'use client'

import * as React from 'react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Segmented, type SegmentedOption } from '@/components/ui/segmented'
import { StatusDot, type StatusDotTone } from '@/components/ui/status-dot'
import type { AgentEvent, AgentEventTone } from '@/lib/client/agent-status'

type LedgerFilter = 'all' | 'sync' | 'review' | 'devices' | 'privacy'

const FILTER_OPTIONS: ReadonlyArray<SegmentedOption<LedgerFilter>> = [
  { value: 'all', label: 'All' },
  { value: 'sync', label: 'Sync' },
  { value: 'review', label: 'Review' },
  { value: 'devices', label: 'Devices' },
  { value: 'privacy', label: 'Privacy' },
]

const FILTER_PATTERNS: Record<Exclude<LedgerFilter, 'all'>, RegExp> = {
  sync: /sync|write|ack/i,
  review: /review|merge|conflict/i,
  devices: /device|session|handoff/i,
  privacy: /privacy|private|key/i,
}

const EVENT_TONE: Record<AgentEventTone, StatusDotTone> = {
  ready: 'hop',
  syncing: 'info',
  queued: 'amber',
  blocked: 'danger',
  observed: 'neutral',
}

/** Full agent event feed with a keyword-based segmented filter. */
export function EventLedger({ events }: { events: AgentEvent[] }) {
  const [filter, setFilter] = React.useState<LedgerFilter>('all')

  const visible =
    filter === 'all'
      ? events
      : events.filter((event) => FILTER_PATTERNS[filter].test(`${event.label} ${event.detail}`))

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>Event ledger</CardTitle>
        <Segmented
          aria-label="Filter events"
          value={filter}
          onChange={setFilter}
          options={FILTER_OPTIONS}
        />
      </CardHeader>
      <CardContent className="pt-3">
        {visible.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
            {filter === 'all'
              ? 'No events yet.'
              : `No ${filter === 'devices' ? 'device' : filter} events yet.`}
          </p>
        ) : (
          <ul className="space-y-1">
            {visible.map((event) => (
              <li
                key={event.id}
                className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted/50"
              >
                <StatusDot tone={EVENT_TONE[event.tone]} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{event.label}</p>
                  <p className="truncate text-xs text-muted-foreground">{event.detail}</p>
                </div>
                <span className="shrink-0 text-right font-mono text-xs text-muted-foreground">
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

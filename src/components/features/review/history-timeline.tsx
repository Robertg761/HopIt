'use client'

import * as React from 'react'
import { History } from 'lucide-react'

import type { AgentEvent, AgentEventTone } from '@/lib/client/agent-status'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { StatusDot, type StatusDotTone } from '@/components/ui/status-dot'

const EVENT_TONE_DOTS: Record<AgentEventTone, StatusDotTone> = {
  ready: 'hop',
  syncing: 'iris',
  queued: 'amber',
  observed: 'neutral',
  blocked: 'danger',
}

const REVIEW_HISTORY_PATTERN = /review|merge|merged|conflict|remote|sync/i

/** Events relevant to the review lifecycle, newest first. */
export function filterReviewHistory(events: AgentEvent[]): AgentEvent[] {
  return events.filter((event) => REVIEW_HISTORY_PATTERN.test(event.label))
}

export function HistoryTimelineCard({ events }: { events: AgentEvent[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Review history</CardTitle>
        <CardDescription>
          Review, merge, conflict, and sync signals from the agent, newest first.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-4">
        {events.length === 0 ? (
          <EmptyState
            icon={History}
            title="No review history yet"
            description="Open a review or sync a change set and the timeline will fill in here."
          />
        ) : (
          <ol className="relative space-y-6 border-l border-border pl-5">
            {events.map((event) => (
              <li key={event.id} className="relative">
                <StatusDot
                  tone={EVENT_TONE_DOTS[event.tone]}
                  className="absolute -left-[25px] top-1.5"
                />
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono text-xs font-medium">{event.label}</span>
                  <span className="text-xs text-muted-foreground">{event.when}</span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{event.detail}</p>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}

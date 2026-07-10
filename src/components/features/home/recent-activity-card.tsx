'use client'

import Link from 'next/link'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusDot, type StatusDotTone } from '@/components/ui/status-dot'
import type { AgentEvent, AgentEventTone } from '@/lib/client/agent-status'
import { repoPath } from '@/components/shell/repo-nav'
import { useWorkspace } from '@/components/workspace/workspace-provider'

const EVENT_TONE: Record<AgentEventTone, StatusDotTone> = {
  ready: 'hop',
  syncing: 'info',
  queued: 'amber',
  blocked: 'danger',
  observed: 'neutral',
}

export function RecentActivityCard({ events }: { events: AgentEvent[] }) {
  const { selectedCodebaseId, status } = useWorkspace()
  const codebaseId = selectedCodebaseId ?? status.codebaseId
  const recent = events.slice(0, 7)
  const activityHref = codebaseId ? repoPath(codebaseId, 'activity') : '/activity'

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between border-b border-border pb-3">
        <CardTitle>Recent activity</CardTitle>
        <Link href={activityHref} className="text-xs font-medium text-iris hover:underline">
          View all
        </Link>
      </CardHeader>
      <CardContent className="p-0 sm:p-0">
        {recent.length === 0 ? (
          <p className="px-4 py-8 text-sm text-muted-foreground sm:px-5">No recent activity.</p>
        ) : (
          <ol>
            {recent.map((event) => (
              <li
                key={event.id}
                className="grid grid-cols-[1fr_auto] items-start gap-3 border-b border-border px-4 py-3 last:border-0 sm:px-5"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 truncate text-sm font-medium">
                    <StatusDot tone={EVENT_TONE[event.tone]} />
                    {event.label}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{event.detail}</p>
                </div>
                <time className="shrink-0 text-xs text-muted-foreground">{event.when}</time>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}

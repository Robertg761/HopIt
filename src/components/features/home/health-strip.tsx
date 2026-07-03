'use client'

import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { StatusDot, type StatusDotTone } from '@/components/ui/status-dot'
import type { AgentStatusSnapshot } from '@/lib/client/agent-status'
import { formatAbsoluteTime, formatRelativeTime } from '@/lib/client/format'

const STATE_TONE: Record<AgentStatusSnapshot['state'], StatusDotTone> = {
  online: 'hop',
  syncing: 'info',
  blocked: 'danger',
  offline: 'neutral',
}

function backendLabel(backend: AgentStatusSnapshot['backend']): string {
  switch (backend) {
    case 'local-agent':
      return 'Local agent'
    case 'd1':
      return 'Hosted D1'
    default:
      return 'Unknown backend'
  }
}

/** One-line workspace health summary: state, codebase, backend, last sync. */
export function HealthStrip({ status }: { status: AgentStatusSnapshot }) {
  // lastSync may already be a humanized string ("3 min ago"); formatRelativeTime
  // falls back to returning the raw string when it does not parse as a date.
  const lastSyncLabel = formatRelativeTime(status.lastSync)
  const lastSyncTitle = formatAbsoluteTime(status.lastSync)

  return (
    <Card className="flex flex-wrap items-center gap-x-4 gap-y-2 p-5">
      <div className="flex items-center gap-2">
        <StatusDot tone={STATE_TONE[status.state]} pulse={status.state === 'online'} />
        <span className="text-sm font-medium">{status.healthLabel}</span>
      </div>
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-sm">{status.codebaseName}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {status.managedWorkspacePath}
        </span>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <Badge tone="outline">{backendLabel(status.backend)}</Badge>
        <span
          className="text-xs text-muted-foreground"
          title={lastSyncTitle.length > 0 ? lastSyncTitle : undefined}
        >
          Last sync {lastSyncLabel}
        </span>
      </div>
    </Card>
  )
}

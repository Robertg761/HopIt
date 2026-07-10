'use client'

import { PageScaffold } from '@/components/shell/page-scaffold'
import { StatusDot } from '@/components/ui/status-dot'
import { useWorkspace } from '@/components/workspace/workspace-provider'
import { EventLedger } from './event-ledger'
import { NotificationsCard } from './notifications-card'

export function ActivityPage() {
  const { status, selectedCodebaseId } = useWorkspace()

  return (
    <PageScaffold
      title="Activity"
      description="Notifications and recent workspace events."
      actions={<CadenceNote backend={status.backend} />}
    >
      {selectedCodebaseId ? <NotificationsCard codebaseId={selectedCodebaseId} /> : null}
      <EventLedger events={status.events} />
    </PageScaffold>
  )
}

function CadenceNote({
  backend,
}: {
  backend: 'local-agent' | 'd1' | 'unknown'
}) {
  if (backend === 'local-agent') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <StatusDot tone="hop" pulse />
        Live — updates every few seconds
      </span>
    )
  }
  if (backend === 'd1') {
    return <span className="text-xs text-muted-foreground">Updates every 30s</span>
  }
  return null
}

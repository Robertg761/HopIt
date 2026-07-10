'use client'

import * as React from 'react'
import { RotateCw } from 'lucide-react'

import { PageScaffold } from '@/components/shell/page-scaffold'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useWorkspace } from '@/components/workspace/workspace-provider'

import { ActionJobsCard } from './action-jobs-card'
import { CommandsCard, ImportGitCard } from './agent-commands-card'
import { HealthCard, SessionCard, SyncCard } from './agent-overview-cards'

export function AgentPage() {
  const { status, loading, refresh, runCommand, runningCommand, commandResult, selectedCodebaseId } =
    useWorkspace()
  const codebaseId = selectedCodebaseId ?? status.codebaseId
  const [refreshing, setRefreshing] = React.useState(false)

  async function refreshStatus() {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <PageScaffold
      title="Agent"
      description="Local agent health, sync, and workspace commands."
      actions={
        <Button variant="outline" size="sm" onClick={() => void refreshStatus()} disabled={refreshing}>
          <RotateCw className={refreshing ? 'size-4 animate-spin' : 'size-4'} />
          Refresh
        </Button>
      }
    >
      {loading ? (
        <div className="space-y-8">
          <Skeleton className="h-44 w-full" />
          <Skeleton className="h-44 w-full" />
        </div>
      ) : (
        <>
          <HealthCard status={status} />
          <SyncCard
            status={status}
            runningCommand={runningCommand}
            onCommand={async (command) => {
              await runCommand(command)
            }}
          />
          <CommandsCard
            commandsAvailable={status.commandsAvailable}
            runningCommand={runningCommand}
            commandResult={commandResult}
            runCommand={runCommand}
          />
          <ImportGitCard
            commandsAvailable={status.commandsAvailable}
            runningCommand={runningCommand}
            runCommand={runCommand}
          />
          <ActionJobsCard codebaseId={codebaseId} />
          <SessionCard status={status} />
        </>
      )}
    </PageScaffold>
  )
}

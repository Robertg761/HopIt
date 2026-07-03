'use client'

import { FolderSync, HardDriveDownload, RotateCw, type LucideIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import type { AgentCommand } from '@/components/workspace/workspace-provider'
import { useAgentCommandRunner } from './use-agent-command'

const ACTIONS: ReadonlyArray<{ command: AgentCommand; label: string; icon: LucideIcon }> = [
  { command: 'sync', label: 'Sync now', icon: FolderSync },
  { command: 'refresh', label: 'Refresh', icon: RotateCw },
  { command: 'hydrateWorkspace', label: 'Hydrate workspace', icon: HardDriveDownload },
]

/** Row of agent quick actions; hidden entirely when commands are unavailable. */
export function QuickActions() {
  const { run, runningCommand, commandsAvailable } = useAgentCommandRunner()

  if (!commandsAvailable) return null

  return (
    <div className="flex flex-wrap items-center gap-2">
      {ACTIONS.map(({ command, label, icon: Icon }) => {
        const busy = runningCommand === command
        return (
          <Button
            key={command}
            variant="outline"
            disabled={runningCommand !== null}
            onClick={() => void run(command, label)}
          >
            {busy ? <Spinner className="size-3.5" /> : <Icon className="size-4" />}
            {label}
          </Button>
        )
      })}
    </div>
  )
}

'use client'

import * as React from 'react'

import {
  useWorkspace,
  type AgentCommand,
  type AgentCommandPayload,
  type AgentCommandResult,
} from '@/components/workspace/workspace-provider'
import { useToast } from '@/hooks/use-toast'

/**
 * Wraps `runCommand` from the workspace provider with toast feedback so the
 * home page's quick actions and attention rows share one code path.
 */
export function useAgentCommandRunner() {
  const { status, runCommand, runningCommand } = useWorkspace()
  const { toast } = useToast()

  const run = React.useCallback(
    async (
      command: AgentCommand,
      label: string,
      payload?: AgentCommandPayload,
    ): Promise<AgentCommandResult> => {
      const result = await runCommand(command, payload)
      if (result.ok) {
        toast({
          title: result.label ?? label,
          description: result.summary ?? 'Command completed.',
        })
      } else {
        toast({
          title: `${label} failed`,
          description:
            result.error?.message ??
            result.stderr ??
            result.summary ??
            'The agent could not run this command.',
          variant: 'destructive',
        })
      }
      return result
    },
    [runCommand, toast],
  )

  return { run, runningCommand, commandsAvailable: status.commandsAvailable }
}

'use client'

import * as React from 'react'
import {
  type AgentStatusSnapshot,
  mapAgentStatusResponse,
  offlineAgentStatus,
} from '@/website/lib/agent-status'

type AgentStatusState = {
  status: AgentStatusSnapshot
  loading: boolean
  selectedCodebaseId: string | null
  selectCodebase: (codebaseId: string) => void
  refresh: () => Promise<void>
  runCommand: (command: AgentCommand, payload?: AgentCommandPayload) => Promise<AgentCommandResult>
  runningCommand: AgentCommand | null
  commandResult: AgentCommandResult | null
}

const localPollMs = 2500
const hostedPollMs = 30_000

export type AgentCommand =
  | 'sync'
  | 'refresh'
  | 'recover'
  | 'review'
  | 'merge'
  | 'setupWorkspace'
  | 'attachWorkspace'
  | 'hydrateWorkspace'
  | 'hydratePath'
  | 'pruneWorkspace'
  | 'pinPath'
  | 'unpinPath'
  | 'dehydrateWorkspace'
  | 'importGitUrl'

export type AgentCommandPayload = {
  codebaseId?: string | null
  url?: string
  branch?: string
  path?: string
  recursive?: boolean
  execute?: boolean
  inactiveMs?: number
}

export type AgentCommandResult = {
  ok: boolean
  command: AgentCommand
  label?: string
  summary?: string
  stdout?: string
  stderr?: string
  error?: {
    message?: string
  }
}

export function useAgentStatus(initialCodebaseId: string | null = null): AgentStatusState {
  const [status, setStatus] = React.useState<AgentStatusSnapshot>(() =>
    offlineAgentStatus('Connecting to the local HopIt agent.'),
  )
  const [loading, setLoading] = React.useState(true)
  const [selectedCodebaseId, setSelectedCodebaseId] = React.useState<string | null>(initialCodebaseId)
  const [runningCommand, setRunningCommand] = React.useState<AgentCommand | null>(null)
  const [commandResult, setCommandResult] = React.useState<AgentCommandResult | null>(null)

  const refresh = React.useCallback(async () => {
    try {
      const statusUrl = selectedCodebaseId
        ? `/api/agent/status?codebaseId=${encodeURIComponent(selectedCodebaseId)}`
        : '/api/agent/status'
      const response = await fetch(statusUrl, {
        cache: 'no-store',
      })
      const body = await response.json()
      const nextStatus = mapAgentStatusResponse(body)

      setStatus(nextStatus)
      if (!selectedCodebaseId && nextStatus.codebaseId) setSelectedCodebaseId(nextStatus.codebaseId)
      setLoading(false)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Agent status request failed.'

      setStatus(offlineAgentStatus(message))
      setLoading(false)
    }
  }, [selectedCodebaseId])

  const runCommand = React.useCallback(
    async (command: AgentCommand, payload: AgentCommandPayload = {}) => {
      if (!status.commandsAvailable) {
        const result: AgentCommandResult = {
          ok: false,
          command,
          stderr: 'Workspace commands are only available from the local HopIt agent.',
        }
        setCommandResult(result)
        return result
      }

      setRunningCommand(command)
      try {
        const response = await fetch('/api/agent/command', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ command, codebaseId: selectedCodebaseId ?? status.codebaseId, ...payload }),
        })
        const result = (await response.json()) as AgentCommandResult
        const nextResult = {
          ...result,
          command,
        }
        setCommandResult(nextResult)
        return nextResult
      } catch (error) {
        const result: AgentCommandResult = {
          ok: false,
          command,
          stderr: error instanceof Error ? error.message : 'Agent command failed.',
        }
        setCommandResult(result)
        return result
      } finally {
        setRunningCommand(null)
        await refresh()
      }
    },
    [refresh, selectedCodebaseId, status.codebaseId, status.commandsAvailable],
  )

  React.useEffect(() => {
    let cancelled = false

    async function loadStatus() {
      if (cancelled) return
      await refresh()
    }

    void loadStatus()
    const interval = window.setInterval(() => {
      void loadStatus()
    }, status.backend === 'd1' || status.backend === 'convex' ? hostedPollMs : localPollMs)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [refresh, status.backend])

  return {
    status,
    loading,
    selectedCodebaseId,
    selectCodebase: setSelectedCodebaseId,
    refresh,
    runCommand,
    runningCommand,
    commandResult,
  }
}

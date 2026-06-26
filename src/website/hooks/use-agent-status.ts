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
  runCommand: (command: AgentCommand, payload?: AgentCommandPayload) => Promise<void>
  runningCommand: AgentCommand | null
  commandResult: AgentCommandResult | null
}

const pollMs = 2500

export type AgentCommand = 'sync' | 'refresh' | 'recover' | 'review' | 'merge' | 'importGitUrl'

export type AgentCommandPayload = {
  url?: string
  branch?: string
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

export function useAgentStatus(): AgentStatusState {
  const [status, setStatus] = React.useState<AgentStatusSnapshot>(() =>
    offlineAgentStatus('Connecting to the local HopIt agent.'),
  )
  const [loading, setLoading] = React.useState(true)
  const [selectedCodebaseId, setSelectedCodebaseId] = React.useState<string | null>(null)
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
        setCommandResult({
          ok: false,
          command,
          stderr: 'Workspace commands are only available from the local HopIt agent.',
        })
        return
      }

      setRunningCommand(command)
      try {
        const response = await fetch('/api/agent/command', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ command, ...payload }),
        })
        const result = (await response.json()) as AgentCommandResult
        setCommandResult({
          ...result,
          command,
        })
      } catch (error) {
        setCommandResult({
          ok: false,
          command,
          stderr: error instanceof Error ? error.message : 'Agent command failed.',
        })
      } finally {
        setRunningCommand(null)
        await refresh()
      }
    },
    [refresh, status.commandsAvailable],
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
    }, pollMs)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [refresh])

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

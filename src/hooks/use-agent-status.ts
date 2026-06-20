'use client'

import * as React from 'react'
import {
  type AgentStatusSnapshot,
  mapAgentStatusResponse,
  offlineAgentStatus,
} from '@/lib/agent-status'

type AgentStatusState = {
  status: AgentStatusSnapshot
  loading: boolean
  refresh: () => Promise<void>
  runCommand: (command: AgentCommand) => Promise<void>
  runningCommand: AgentCommand | null
  commandResult: AgentCommandResult | null
}

const pollMs = 2500

export type AgentCommand = 'sync' | 'refresh' | 'recover' | 'review' | 'merge'

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
  const [runningCommand, setRunningCommand] = React.useState<AgentCommand | null>(null)
  const [commandResult, setCommandResult] = React.useState<AgentCommandResult | null>(null)

  const refresh = React.useCallback(async () => {
      try {
        const response = await fetch('/api/agent/status', {
          cache: 'no-store',
        })
        const body = await response.json()

        setStatus(mapAgentStatusResponse(body))
        setLoading(false)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Agent status request failed.'

        setStatus(offlineAgentStatus(message))
        setLoading(false)
      }
  }, [])

  const runCommand = React.useCallback(
    async (command: AgentCommand) => {
      setRunningCommand(command)
      try {
        const response = await fetch('/api/agent/command', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ command }),
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
    [refresh],
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

  return { status, loading, refresh, runCommand, runningCommand, commandResult }
}

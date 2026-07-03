'use client'

import * as React from 'react'
import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { StatusDot, type StatusDotTone } from '@/components/ui/status-dot'
import { useWorkspace, type AgentCommand } from '@/components/workspace/workspace-provider'
import { useAgentCommandRunner } from './use-agent-command'

const RESOLVED_CONFLICT_STATES = new Set(['none', 'clean', '', 'unavailable'])

type AttentionRow = {
  id: string
  tone: StatusDotTone
  message: string
  action: React.ReactNode
}

/** Lists workspace problems that need action. Renders nothing when healthy. */
export function AttentionCard() {
  const { status } = useWorkspace()
  const { run, runningCommand, commandsAvailable } = useAgentCommandRunner()

  const commandAction = (command: AgentCommand, label: string) => (
    <Button
      variant="outline"
      size="sm"
      disabled={runningCommand !== null}
      onClick={() => void run(command, label)}
    >
      {runningCommand === command ? <Spinner className="size-3.5" /> : null}
      {label}
    </Button>
  )

  const linkAction = (href: string, label: string) => (
    <Button variant="outline" size="sm" asChild>
      <Link href={href}>{label}</Link>
    </Button>
  )

  const behind = status.remoteBehindByRevisions ?? 0
  const conflictActive = !RESOLVED_CONFLICT_STATES.has(status.conflictState.toLowerCase())
  const rows: AttentionRow[] = []

  if (status.failedWrites > 0) {
    rows.push({
      id: 'failed-writes',
      tone: 'danger',
      message: `${status.failedWrites} write${status.failedWrites === 1 ? '' : 's'} failed to reach the cloud.`,
      action: commandsAvailable
        ? commandAction('sync', 'Retry sync')
        : linkAction('/activity', 'View activity'),
    })
  }

  if (conflictActive) {
    rows.push({
      id: 'conflict',
      tone: 'danger',
      message: `The active change set has conflicts (${status.conflictState}).`,
      action: linkAction('/review', 'Open review'),
    })
  }

  if (behind > 0) {
    rows.push({
      id: 'behind-remote',
      tone: 'amber',
      message: `Workspace is behind the remote by ${behind} revision${behind === 1 ? '' : 's'}.`,
      action: commandsAvailable
        ? commandAction('hydrateWorkspace', 'Hydrate workspace')
        : linkAction('/codebases', 'View codebases'),
    })
  }

  if (status.state === 'blocked') {
    rows.push({
      id: 'blocked',
      tone: 'danger',
      message: 'The agent is blocked — check recent activity for details.',
      action: linkAction('/activity', 'View activity'),
    })
  }

  if (rows.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-amber" />
          Needs attention
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-3">
        <ul className="space-y-1">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/50"
            >
              <StatusDot tone={row.tone} />
              <p className="min-w-0 flex-1 text-sm">{row.message}</p>
              {row.action}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

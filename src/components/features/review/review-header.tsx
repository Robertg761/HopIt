'use client'

import * as React from 'react'
import { ArrowRight, GitMerge, GitPullRequest, LifeBuoy, RefreshCw, TriangleAlert } from 'lucide-react'

import type { AgentStatusSnapshot } from '@/lib/client/agent-status'
import type { AgentCommand } from '@/components/workspace/workspace-provider'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { StateBadge } from './review-shared'

const COMMANDS_HINT = 'Available from the local agent'

export function ReviewMetaRow({ status }: { status: AgentStatusSnapshot }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <span className="font-mono text-xs font-medium">{status.activeChangeSetId}</span>
      <StateBadge label="review" value={status.reviewState} />
      <StateBadge label="merge" value={status.mergeState} />
      <StateBadge label="conflict" value={status.conflictState} />
      <span className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
        {status.mainRevision}
        <ArrowRight aria-hidden className="size-3.5" />
        {status.cloudRevision}
      </span>
    </div>
  )
}

export function ReviewActions({
  status,
  runningCommand,
  onCommand,
}: {
  status: AgentStatusSnapshot
  runningCommand: AgentCommand | null
  onCommand: (command: AgentCommand) => Promise<void>
}) {
  const [confirmMerge, setConfirmMerge] = React.useState(false)
  const disabled = !status.commandsAvailable
  const busy = runningCommand !== null
  const hint = disabled ? COMMANDS_HINT : undefined

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled || busy}
        title={hint}
        onClick={() => void onCommand('refresh')}
      >
        {runningCommand === 'refresh' ? <Spinner className="size-3.5" /> : <RefreshCw />}
        Refresh
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || busy}
        title={hint}
        onClick={() => void onCommand('review')}
      >
        {runningCommand === 'review' ? <Spinner className="size-3.5" /> : <GitPullRequest />}
        Open review
      </Button>
      <Button
        size="sm"
        disabled={disabled || busy}
        title={hint}
        onClick={() => setConfirmMerge(true)}
      >
        {runningCommand === 'merge' ? <Spinner className="size-3.5" /> : <GitMerge />}
        Merge to main
      </Button>
      <Dialog
        open={confirmMerge}
        onOpenChange={setConfirmMerge}
        title="Merge to Main?"
        description="This promotes the active change set into Main for everyone on this codebase."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmMerge(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setConfirmMerge(false)
                void onCommand('merge')
              }}
            >
              <GitMerge />
              Merge {status.activeChangeSetId}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          <span className="font-mono text-xs">{status.mainRevision}</span> will advance to{' '}
          <span className="font-mono text-xs">{status.cloudRevision}</span>. Merges cannot be
          undone from here.
        </p>
      </Dialog>
    </>
  )
}

const CLEAN_CONFLICT_STATES = new Set(['none', 'clean', ''])

export function ConflictPanel({
  status,
  runningCommand,
  onCommand,
}: {
  status: AgentStatusSnapshot
  runningCommand: AgentCommand | null
  onCommand: (command: AgentCommand) => Promise<void>
}) {
  if (CLEAN_CONFLICT_STATES.has(status.conflictState.trim().toLowerCase())) return null

  const disabled = !status.commandsAvailable
  const busy = runningCommand !== null

  return (
    <Card className="border-amber/40 bg-amber-soft/60">
      <CardContent className="flex flex-wrap items-start gap-3">
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-amber" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            Conflict state: <span className="font-mono text-xs">{status.conflictState}</span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            The change set diverged from Main. Refresh to pull the latest Main state, or run
            recover to rebuild the local workspace from the cloud.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || busy}
            title={disabled ? COMMANDS_HINT : undefined}
            onClick={() => void onCommand('refresh')}
          >
            {runningCommand === 'refresh' ? <Spinner className="size-3.5" /> : <RefreshCw />}
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || busy}
            title={disabled ? COMMANDS_HINT : undefined}
            onClick={() => void onCommand('recover')}
          >
            {runningCommand === 'recover' ? <Spinner className="size-3.5" /> : <LifeBuoy />}
            Recover
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

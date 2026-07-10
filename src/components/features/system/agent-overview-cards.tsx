'use client'

import * as React from 'react'
import { LifeBuoy, RefreshCw, TriangleAlert } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { StatusDot, type StatusDotTone } from '@/components/ui/status-dot'
import type { AgentCommand } from '@/components/workspace/workspace-provider'
import type { AgentStatusSnapshot } from '@/lib/client/agent-status'
import { handoffGuidance } from '@/lib/client/agent-status/guidance'

import { InfoRow, MonoId, QuietNote, Stat } from './shared'

const STATE_TONE: Record<AgentStatusSnapshot['state'], StatusDotTone> = {
  online: 'hop',
  syncing: 'amber',
  offline: 'neutral',
  blocked: 'danger',
}

export function HealthCard({ status }: { status: AgentStatusSnapshot }) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <CardTitle className="flex items-center gap-2">
            <StatusDot tone={STATE_TONE[status.state]} pulse={status.state === 'online' || status.state === 'syncing'} />
            {status.healthLabel}
          </CardTitle>
          <CardDescription>Agent health for {status.codebaseName}.</CardDescription>
        </div>
        <Badge tone="outline">{status.backend}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {!status.commandsAvailable ? (
          <QuietNote>Hosted dashboard — commands run from your local agent.</QuietNote>
        ) : null}
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <InfoRow label="Workspace path" mono>
            <MonoId value={status.managedWorkspacePath} />
          </InfoRow>
          <InfoRow label="Index path" mono>
            <MonoId value={status.workspaceIndexPath} />
          </InfoRow>
          <InfoRow label="Hydration">
            {status.workspaceHydrationState}
            {status.workspaceMaterializedRevision !== null ? (
              <span className="text-muted-foreground"> · rev {status.workspaceMaterializedRevision}</span>
            ) : null}
          </InfoRow>
          <InfoRow label="Cache">{status.cacheState}</InfoRow>
          <InfoRow label="Last sync">{status.lastSync}</InfoRow>
          <InfoRow label="Last acknowledgement">{status.lastAck}</InfoRow>
        </dl>
      </CardContent>
    </Card>
  )
}

export function SyncCard({
  status,
  runningCommand,
  onCommand,
}: {
  status: AgentStatusSnapshot
  runningCommand: AgentCommand | null
  onCommand: (command: AgentCommand) => Promise<void>
}) {
  const behind = status.remoteBehindByRevisions
  const push = status.remotePush
  const guidance = handoffGuidance(status)
  const connectionTone =
    push.connectionState === 'connected'
      ? 'hop'
      : push.connectionState === 'disconnected'
        ? 'amber'
        : 'outline'
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cross-device handoff</CardTitle>
        <CardDescription>Write journal, push delivery, and periodic safety checks.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Pending" value={status.pendingWrites} tone="amber" />
          <Stat label="Failed" value={status.failedWrites} tone="danger" />
          <Stat label="Acknowledged" value={status.acknowledgedWrites} />
        </div>
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <InfoRow label="Push connection">
            <span className="flex flex-wrap items-center gap-2">
              <Badge tone={connectionTone}>{push.connectionState}</Badge>
              <span className="text-muted-foreground">{push.state}</span>
            </span>
          </InfoRow>
          <InfoRow label="Safety fallback">
            <span className="flex flex-wrap items-center gap-2">
              <Badge tone={push.fallbackState === 'checking' ? 'amber' : push.enabled ? 'info' : 'outline'}>
                {push.fallbackState}
              </Badge>
              <span className="text-muted-foreground">{push.reconciliationCadence}</span>
            </span>
          </InfoRow>
          <InfoRow label="Last applied revision">
            {push.lastAppliedRevision === null ? (
              <span className="text-muted-foreground">None yet</span>
            ) : (
              <span>
                rev {push.lastAppliedRevision}
                <span className="text-muted-foreground"> · {push.lastApplied}</span>
              </span>
            )}
          </InfoRow>
          <InfoRow label="Last pushed revision">
            {push.lastPushedRevision === null ? (
              <span className="text-muted-foreground">None observed</span>
            ) : (
              <>rev {push.lastPushedRevision}</>
            )}
          </InfoRow>
          <InfoRow label="Remote pull">
            <span className="flex items-center gap-2">
              <Badge tone={status.remotePullEnabled ? 'hop' : 'outline'}>
                {status.remotePullEnabled ? 'enabled' : 'disabled'}
              </Badge>
              <span className="text-muted-foreground">{status.remotePullMode}</span>
            </span>
          </InfoRow>
          <InfoRow label="Cadence">{status.remotePullCadence}</InfoRow>
          <InfoRow label="Behind remote">
            {behind !== null && behind > 0 ? (
              <Badge tone="amber">
                {behind} revision{behind === 1 ? '' : 's'} behind
              </Badge>
            ) : (
              <span className="text-muted-foreground">{behind === null ? 'Unknown' : 'Up to date'}</span>
            )}
          </InfoRow>
          <InfoRow label="States">
            <span className="text-muted-foreground">
              update: {status.remoteUpdateState} · pull: {status.remotePullState}
            </span>
          </InfoRow>
        </dl>
        {guidance ? (
          <div className="flex flex-wrap items-start gap-3 rounded-lg border border-amber/40 bg-amber-soft/60 p-3">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-amber" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{guidance.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{guidance.detail}</p>
              {guidance.reason ? (
                <p className="mt-1 font-mono text-[11px] text-muted-foreground">{guidance.reason}</p>
              ) : null}
            </div>
            {guidance.command ? (
              <Button
                variant="outline"
                size="sm"
                disabled={!status.commandsAvailable || runningCommand !== null}
                title={!status.commandsAvailable ? 'Run this command from the local HopIt dashboard.' : undefined}
                onClick={() => void onCommand(guidance.command!)}
              >
                {runningCommand === guidance.command ? (
                  <Spinner className="size-3.5" />
                ) : guidance.command === 'recover' ? (
                  <LifeBuoy className="size-4" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                {guidance.commandLabel}
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

export function SessionCard({ status }: { status: AgentStatusSnapshot }) {
  const { requester } = status
  return (
    <Card>
      <CardHeader>
        <CardTitle>This session</CardTitle>
        <CardDescription>How this dashboard is connecting.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-3">
          <InfoRow label="Session" mono>
            <MonoId value={requester.sessionId} />
          </InfoRow>
          <InfoRow label="Role">
            <Badge tone={requester.role === 'owner' ? 'hop' : requester.role === 'maintainer' ? 'iris' : 'outline'}>
              {requester.role}
            </Badge>
          </InfoRow>
          <InfoRow label="Membership source">{requester.membershipSource}</InfoRow>
        </dl>
      </CardContent>
    </Card>
  )
}

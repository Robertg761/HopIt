'use client'

import * as React from 'react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusDot, type StatusDotTone } from '@/components/ui/status-dot'
import type { AgentStatusSnapshot } from '@/lib/client/agent-status'

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

export function SyncCard({ status }: { status: AgentStatusSnapshot }) {
  const behind = status.remoteBehindByRevisions
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sync</CardTitle>
        <CardDescription>Write journal and remote pull state.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Pending" value={status.pendingWrites} tone="amber" />
          <Stat label="Failed" value={status.failedWrites} tone="danger" />
          <Stat label="Acknowledged" value={status.acknowledgedWrites} />
        </div>
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
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

'use client'

import * as React from 'react'
import Link from 'next/link'
import { TerminalSquare } from 'lucide-react'

import { PageScaffold } from '@/components/shell/page-scaffold'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { useWorkspace } from '@/components/workspace/workspace-provider'
import { formatCount } from '@/lib/client/format'

import { InfoRow, ManagedCaption, MonoId } from './shared'

export function SettingsPage() {
  const { status, selectedCodebaseId } = useWorkspace()
  const hostedBackend = status.backend === 'd1'
  const codebaseId = selectedCodebaseId ?? status.codebaseId
  const agentHref = codebaseId
    ? `/codebases/${encodeURIComponent(codebaseId)}/agent`
    : '/status'

  return (
    <PageScaffold
      title="Settings"
      description="Sync, storage, review, and privacy policy for this repository."
      actions={
        <Button asChild variant="outline" size="sm">
          <Link href={agentHref}>
            <TerminalSquare className="size-4" />
            Agent commands
          </Link>
        </Button>
      }
    >
      <Card>
        <CardHeader>
          <CardTitle>Sync policy</CardTitle>
          <CardDescription>When the agent pulls remote changes into your workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
            <InfoRow label="Remote pull">
              <Badge tone={status.remotePullEnabled ? 'hop' : 'outline'}>
                {status.remotePullEnabled ? 'enabled' : 'disabled'}
              </Badge>
            </InfoRow>
            <InfoRow label="Mode">{status.remotePullMode}</InfoRow>
            <InfoRow label="Cadence">{status.remotePullCadence}</InfoRow>
            <InfoRow label="Dashboard polling">
              {hostedBackend ? 'Every 30 seconds (hosted backend)' : 'Every 2.5 seconds (local agent)'}
            </InfoRow>
          </dl>
        </CardContent>
        <CardFooter>
          <ManagedCaption />
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Storage &amp; hydration</CardTitle>
          <CardDescription>What lives on this device versus in the cloud.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
            <InfoRow label="Hydration state">{status.workspaceHydrationState}</InfoRow>
            <InfoRow label="Materialized revision">
              {status.workspaceMaterializedRevision === null ? '—' : status.workspaceMaterializedRevision}
            </InfoRow>
            <InfoRow label="Cache state">{status.cacheState}</InfoRow>
            <InfoRow label="Index path" mono>
              <MonoId value={status.workspaceIndexPath} />
            </InfoRow>
          </dl>
        </CardContent>
        <CardFooter>
          <ManagedCaption>
            Hydration and cache policy are managed automatically by the local agent.
          </ManagedCaption>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Review gates</CardTitle>
          <CardDescription>Where the active change set sits on its way to Main.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-3">
            <InfoRow label="Review">
              <span className="flex flex-col items-start gap-1">
                <Badge tone={reviewTone(status.reviewState)}>{status.reviewState}</Badge>
                <span className="text-xs text-muted-foreground">
                  A review opens when a change set is ready for teammates.
                </span>
              </span>
            </InfoRow>
            <InfoRow label="Merge">
              <span className="flex flex-col items-start gap-1">
                <Badge tone={mergeTone(status.mergeState)}>{status.mergeState}</Badge>
                <span className="text-xs text-muted-foreground">
                  Merging lands the change set into the Main state.
                </span>
              </span>
            </InfoRow>
            <InfoRow label="Conflicts">
              <span className="flex flex-col items-start gap-1">
                <Badge tone={conflictTone(status.conflictState)}>{status.conflictState}</Badge>
                <span className="text-xs text-muted-foreground">
                  Conflicts block merging until they are resolved.
                </span>
              </span>
            </InfoRow>
          </dl>
        </CardContent>
        <CardFooter>
          <ManagedCaption>Review and merge run from the agent or the Review page — read-only here.</ManagedCaption>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Privacy</CardTitle>
          <CardDescription>What other people can and cannot see in this codebase.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
            <InfoRow label="Visibility">{status.visibility}</InfoRow>
            <InfoRow label="Hidden files">{formatCount(status.hiddenFileCount)}</InfoRow>
            <InfoRow label="Private scope">{status.privateScope}</InfoRow>
            <InfoRow label="Private scope path" mono>
              <MonoId value={status.privateScopePath} />
            </InfoRow>
          </dl>
          <p className="mt-4 text-xs text-muted-foreground">
            Files under <span className="font-mono">.private/</span> are only ever visible to the codebase owner —
            collaborators and reviewers never see them.
          </p>
        </CardContent>
        <CardFooter>
          <ManagedCaption>Visibility changes are made from the codebase settings on the backend.</ManagedCaption>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>Where this dashboard is pointed right now.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
            <InfoRow label="Codebase">{status.codebaseName}</InfoRow>
            <InfoRow label="Backend">
              <Badge tone="outline">{status.backend}</Badge>
            </InfoRow>
          </dl>
          <p className="mt-4 text-xs text-muted-foreground">
            The light / dark theme toggle lives in the top bar and follows your system preference by default.
          </p>
        </CardContent>
      </Card>
    </PageScaffold>
  )
}

function reviewTone(state: string): BadgeTone {
  if (state === 'open' || state === 'in-review') return 'iris'
  if (state === 'approved') return 'hop'
  if (state === 'changes-requested') return 'amber'
  return 'neutral'
}

function mergeTone(state: string): BadgeTone {
  if (state === 'merged') return 'hop'
  if (state === 'merging') return 'amber'
  return 'neutral'
}

function conflictTone(state: string): BadgeTone {
  if (state === 'conflicted') return 'danger'
  if (state === 'none') return 'neutral'
  return 'amber'
}

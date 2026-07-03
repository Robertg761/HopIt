'use client'

import * as React from 'react'
import { FolderOpen } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useToast } from '@/hooks/use-toast'
import { useWorkspace } from '@/components/workspace/workspace-provider'
import { humanizeMessage } from './codebases-api'

/** Shows the discovered workspace root on this device and offers first-run setup. */
export function WorkspaceRootCard() {
  const { workspaceDiscovery, status, hasWorkspace, runCommand, runningCommand, codebasesLoading } = useWorkspace()
  const { toast } = useToast()

  const rootPath = workspaceDiscovery?.rootPath ?? null
  const rootExists = workspaceDiscovery?.rootExists ?? false
  const needsSetup = !(rootPath && rootExists) && !hasWorkspace
  const settingUp = runningCommand === 'setupWorkspace'

  const setUpRoot = async () => {
    const result = await runCommand('setupWorkspace')
    if (result.ok) {
      toast({ title: 'Workspace root ready', description: result.summary ?? 'Workspace root created on this device.' })
    } else {
      toast({
        title: 'Workspace setup failed',
        description: result.error?.message ?? result.stderr ?? 'Command failed.',
        variant: 'destructive',
      })
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <div className="flex items-center gap-2">
            <FolderOpen className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold tracking-tight">Workspace root</h2>
            {workspaceDiscovery === null && codebasesLoading ? null : rootPath ? (
              <Badge tone={rootExists ? 'hop' : 'amber'}>{rootExists ? 'Exists' : 'Missing'}</Badge>
            ) : (
              <Badge tone="outline">Not configured</Badge>
            )}
          </div>
          {workspaceDiscovery === null && codebasesLoading ? (
            <Skeleton className="h-4 w-72" />
          ) : (
            <p className="truncate font-mono text-xs text-muted-foreground" title={rootPath ?? undefined}>
              {rootPath ?? 'No workspace root discovered on this device.'}
            </p>
          )}
          {hasWorkspace ? (
            <p className="truncate text-xs text-muted-foreground">
              Managed workspace <span className="font-mono">{status.managedWorkspacePath}</span>
            </p>
          ) : null}
          {workspaceDiscovery?.error ? (
            <p className="inline-flex rounded-md bg-amber-soft px-2 py-1 text-xs text-amber-soft-foreground">
              {humanizeMessage(workspaceDiscovery.error)}
            </p>
          ) : null}
        </div>
        {needsSetup ? (
          status.commandsAvailable ? (
            <Button onClick={() => void setUpRoot()} disabled={settingUp}>
              {settingUp ? <Spinner className="size-3.5 text-primary-foreground" /> : null}
              {settingUp ? 'Setting up…' : 'Set up workspace root'}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">Setup is available from the local agent.</p>
          )
        ) : null}
      </CardContent>
    </Card>
  )
}

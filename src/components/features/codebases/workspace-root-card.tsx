'use client'

import * as React from 'react'
import { Check, Circle, FolderOpen, Laptop, Play, Plus } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useToast } from '@/hooks/use-toast'
import { useWorkspace } from '@/components/workspace/workspace-provider'
import { humanizeMessage } from './codebases-api'

/** Joins cloud setup, local device setup, attachment, and first hydration into one flow. */
export function WorkspaceRootCard({ onCreateCodebase }: { onCreateCodebase?: () => void }) {
  const {
    workspaceDiscovery,
    status,
    hasWorkspace,
    runCommand,
    runningCommand,
    codebases,
    selectedCodebaseId,
    selectCodebase,
    codebasesLoading,
  } = useWorkspace()
  const { toast } = useToast()

  const codebase = codebases.find((entry) => entry.id === selectedCodebaseId) ?? codebases[0] ?? null
  const rootPath = workspaceDiscovery?.rootPath ?? null
  const rootExists = workspaceDiscovery?.rootExists ?? false
  const localAgentReady = status.commandsAvailable
  const attached = Boolean(codebase?.attached || (hasWorkspace && codebase?.id === status.codebaseId && status.backend === 'local-agent'))
  const hydrationState = codebase?.hydrationState ?? status.workspaceHydrationState
  const workingSetReady = attached && !['cloud-only', 'not_attached', 'metadata-only', 'unknown'].includes(hydrationState)
  const settingUp = runningCommand === 'setupWorkspace' || runningCommand === 'attachWorkspace'
  const opening = runningCommand === 'openWorkspace'

  const runWorkspaceCommand = async (command: 'setupWorkspace' | 'attachWorkspace' | 'openWorkspace') => {
    if (!codebase) return
    selectCodebase(codebase.id)
    const result = await runCommand(command, { codebaseId: codebase.id })
    if (result.ok) {
      toast({
        title: command === 'openWorkspace' ? 'Working set ready' : 'Workspace attached',
        description: result.summary ?? 'The managed workspace is ready on this device.',
      })
    } else {
      toast({
        title: command === 'openWorkspace' ? 'Workspace open failed' : 'Workspace setup failed',
        description: result.error?.message ?? result.stderr ?? 'Command failed.',
        variant: 'destructive',
      })
    }
  }

  return (
    <Card>
      <CardContent className="space-y-5 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <FolderOpen className="size-4 text-iris" />
              <h2 className="text-sm font-semibold tracking-tight">Workspace setup</h2>
              {workingSetReady ? <Badge tone="hop">Ready</Badge> : <Badge tone="outline">In progress</Badge>}
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              Connect one cloud project to a normal local folder, then prepare its first working set.
            </p>
          </div>
          {rootPath ? (
            <p className="max-w-full truncate rounded-md bg-muted px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground" title={rootPath}>
              {rootPath}
            </p>
          ) : null}
        </div>

        {workspaceDiscovery === null && codebasesLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : (
          <ol className="grid gap-2 lg:grid-cols-2">
            <SetupStep
              complete={Boolean(codebase)}
              title="Choose a cloud project"
              detail={codebase ? codebase.name : 'Create the project this device should open.'}
              action={!codebase && onCreateCodebase ? (
                <Button size="sm" variant="outline" onClick={onCreateCodebase}><Plus /> Create project</Button>
              ) : undefined}
            />
            <SetupStep
              complete={localAgentReady}
              title="Connect the local agent"
              detail={localAgentReady ? 'This browser can reach workspace commands.' : 'Install HopIt, then run hop setup on this device.'}
              icon={<Laptop className="size-3.5" />}
            />
            <SetupStep
              complete={Boolean(rootPath && rootExists && attached)}
              title="Attach the Workspace Root"
              detail={attached ? codebase?.workspacePath ?? status.managedWorkspacePath : 'Create a managed folder under your chosen root.'}
              action={codebase && localAgentReady && !attached ? (
                <Button size="sm" onClick={() => void runWorkspaceCommand(rootPath && rootExists ? 'attachWorkspace' : 'setupWorkspace')} disabled={settingUp}>
                  {settingUp ? <Spinner className="size-3.5 text-primary-foreground" /> : <FolderOpen />}
                  {settingUp ? 'Attaching…' : 'Attach folder'}
                </Button>
              ) : undefined}
            />
            <SetupStep
              complete={workingSetReady}
              title="Prepare the first working set"
              detail={workingSetReady ? `Hydration: ${hydrationState}` : 'Hydrate the files editors and tools need first.'}
              action={codebase && localAgentReady && attached && !workingSetReady ? (
                <Button size="sm" onClick={() => void runWorkspaceCommand('openWorkspace')} disabled={opening}>
                  {opening ? <Spinner className="size-3.5 text-primary-foreground" /> : <Play />}
                  {opening ? 'Preparing…' : 'Prepare files'}
                </Button>
              ) : undefined}
            />
          </ol>
        )}

        {!localAgentReady ? (
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
            <p className="text-xs text-muted-foreground">On the device you want to connect:</p>
            <code className="mt-1 block overflow-x-auto text-[11px] text-foreground">curl -fsSL https://hopit.dev/install | sh &amp;&amp; hop setup</code>
          </div>
        ) : null}

        {workspaceDiscovery?.error ? (
          <p className="inline-flex rounded-md bg-amber-soft px-2 py-1 text-xs text-amber-soft-foreground">
            {humanizeMessage(workspaceDiscovery.error)}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

function SetupStep({
  complete,
  title,
  detail,
  icon,
  action,
}: {
  complete: boolean
  title: string
  detail: string
  icon?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <li className="flex min-h-16 flex-wrap items-start gap-3 rounded-lg border border-border bg-background/60 p-3 sm:flex-nowrap">
      <span className={complete ? 'mt-0.5 flex size-5 items-center justify-center rounded-full bg-hop-soft text-hop-soft-foreground' : 'mt-0.5 flex size-5 items-center justify-center rounded-full bg-muted text-muted-foreground'}>
        {complete ? <Check className="size-3.5" aria-hidden /> : icon ?? <Circle className="size-3" aria-hidden />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-foreground">{title}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground" title={detail}>{detail}</p>
      </div>
      {action ? <div className="w-full pl-8 sm:w-auto sm:shrink-0 sm:pl-0">{action}</div> : null}
    </li>
  )
}

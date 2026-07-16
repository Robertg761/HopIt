'use client'

import * as React from 'react'
import { Copy, DownloadCloud, Eraser, Pin, PinOff } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { useToast } from '@/hooks/use-toast'
import { useWorkspace, type AgentCommand, type AgentCommandPayload } from '@/components/workspace/workspace-provider'
import type { AgentFile } from '@/lib/client/agent-status'
import { formatAbsoluteTime, formatBytes, formatRelativeTime } from '@/lib/client/format'
import { FileEditor } from './file-editor'
import { LOCAL_STATE_TONES, localStateLabel } from './local-state'

type FileAction = 'hydrate' | 'pin' | 'prune'

export function FileDetail({ file, codebaseId }: { file: AgentFile; codebaseId: string | null }) {
  const { status, runCommand, runningCommand } = useWorkspace()
  const { toast } = useToast()
  const [pendingAction, setPendingAction] = React.useState<FileAction | null>(null)

  const commandsAvailable = status.commandsAvailable
  const actionsDisabled = !commandsAvailable || pendingAction !== null || runningCommand !== null

  const runFileCommand = async (
    action: FileAction,
    command: AgentCommand,
    payload: AgentCommandPayload,
    label: string,
  ) => {
    setPendingAction(action)
    const result = await runCommand(command, payload)
    setPendingAction(null)
    if (result.ok) {
      toast({ title: label, description: result.summary ?? `${label} completed for ${file.path}.` })
    } else {
      toast({
        title: `${label} failed`,
        description: result.error?.message ?? result.stderr ?? 'Command failed.',
        variant: 'destructive',
      })
    }
  }

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(file.path)
      toast({ title: 'Path copied', description: file.path })
    } catch {
      toast({ title: 'Copy failed', description: 'Clipboard is not available.', variant: 'destructive' })
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{file.name}</CardTitle>
        <div className="flex min-w-0 items-center gap-1">
          <span className="truncate font-mono text-xs text-muted-foreground" title={file.path}>
            {file.path}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Copy path"
            className="shrink-0 text-muted-foreground"
            onClick={() => void copyPath()}
          >
            <Copy className="size-3.5" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
          <Meta label="Local state">
            <Badge tone={LOCAL_STATE_TONES[file.local.state]}>{localStateLabel(file.local.state)}</Badge>
          </Meta>
          <Meta label="Scope">{file.scope === 'owner-private' ? 'Private to you' : 'Shared'}</Meta>
          <Meta label="Revision">
            {file.revision !== null ? <span className="font-mono">{file.revision}</span> : 'Not available'}
          </Meta>
          <Meta label="Size">{formatBytes(file.size)}</Meta>
          <Meta label="Hash">
            {file.hash ? (
              <span className="font-mono" title={file.hash}>
                {file.hash.slice(0, 12)}…
              </span>
            ) : (
              'Not available'
            )}
          </Meta>
          <Meta label="Pinned">{file.local.pinned ? 'Yes' : 'No'}</Meta>
          <Meta label="Edited">
            <Timestamp value={file.local.lastEditedAt} />
          </Meta>
          <Meta label="Hydrated">
            <Timestamp value={file.local.lastHydratedAt} />
          </Meta>
          <Meta label="Synced">
            <Timestamp value={file.local.lastSyncedAt} />
          </Meta>
        </dl>

        <div className="space-y-1.5 border-t border-border pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={actionsDisabled}
              onClick={() => void runFileCommand('hydrate', 'hydratePath', { path: file.path }, 'Hydrate')}
            >
              {pendingAction === 'hydrate' ? <Spinner className="size-3.5" /> : <DownloadCloud />}
              Hydrate
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={actionsDisabled}
              onClick={() =>
                void runFileCommand(
                  'pin',
                  file.local.pinned ? 'unpinPath' : 'pinPath',
                  { path: file.path },
                  file.local.pinned ? 'Unpin' : 'Pin',
                )
              }
            >
              {pendingAction === 'pin' ? <Spinner className="size-3.5" /> : file.local.pinned ? <PinOff /> : <Pin />}
              {file.local.pinned ? 'Unpin' : 'Pin'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={actionsDisabled}
              onClick={() =>
                void runFileCommand('prune', 'pruneWorkspace', { path: file.path, execute: true }, 'Free space')
              }
            >
              {pendingAction === 'prune' ? <Spinner className="size-3.5" /> : <Eraser />}
              Free space
            </Button>
          </div>
          {!commandsAvailable ? (
            <p className="text-xs text-muted-foreground">Available from the local agent</p>
          ) : null}
        </div>

        <div className="border-t border-border pt-4">
          <FileEditor key={file.path} file={file} codebaseId={codebaseId} />
        </div>
      </CardContent>
    </Card>
  )
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-xs text-foreground">{children}</dd>
    </div>
  )
}

function Timestamp({ value }: { value: string | null }) {
  if (!value) return <>Not available</>
  return <span title={formatAbsoluteTime(value)}>{formatRelativeTime(value)}</span>
}

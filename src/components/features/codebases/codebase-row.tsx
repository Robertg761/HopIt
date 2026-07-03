'use client'

import * as React from 'react'
import { CloudOff, DownloadCloud, HardDrive, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { StatusDot } from '@/components/ui/status-dot'
import { useToast } from '@/hooks/use-toast'
import {
  useWorkspace,
  type AgentCommand,
  type CodebaseSummary,
} from '@/components/workspace/workspace-provider'
import { formatAbsoluteTime, formatCount, formatRelativeTime } from '@/lib/client/format'
import { cn } from '@/lib/utils'

export function CodebaseRow({
  codebase,
  onRename,
  onDelete,
}: {
  codebase: CodebaseSummary
  onRename: () => void
  onDelete: () => void
}) {
  const { selectedCodebaseId, selectCodebase, runCommand, runningCommand, status } = useWorkspace()
  const { toast } = useToast()

  const selected = selectedCodebaseId === codebase.id
  const commandsAvailable = status.commandsAvailable
  const commandBusy = runningCommand !== null

  const runRowCommand = async (command: AgentCommand, label: string) => {
    const result = await runCommand(command, { codebaseId: codebase.id })
    if (result.ok) {
      toast({ title: label, description: result.summary ?? `${label} completed for ${codebase.name}.` })
    } else {
      toast({
        title: `${label} failed`,
        description: result.error?.message ?? result.stderr ?? 'Command failed.',
        variant: 'destructive',
      })
    }
  }

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={() => selectCodebase(codebase.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            selectCodebase(codebase.id)
          }
        }}
        className={cn(
          'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 outline-none transition-colors',
          'hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/40',
          selected && 'bg-muted/50',
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {selected ? <StatusDot tone="hop" /> : null}
            <span className="text-sm font-medium">{codebase.name}</span>
            <Badge tone={codebase.attached ? 'hop' : 'outline'}>
              {codebase.attached ? 'Attached' : 'Cloud only'}
            </Badge>
            {codebase.behindByRevisions > 0 ? (
              <Badge tone="amber">
                Behind {formatCount(codebase.behindByRevisions)} rev
                {codebase.behindByRevisions === 1 ? '' : 's'}
              </Badge>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span className="font-mono">{codebase.id}</span>
            <span aria-hidden>·</span>
            <span>{codebase.hydrationState}</span>
            <span aria-hidden>·</span>
            <span>{codebase.visibility}</span>
            {codebase.updatedAt ? (
              <>
                <span aria-hidden>·</span>
                <span title={formatAbsoluteTime(codebase.updatedAt)}>
                  {formatRelativeTime(codebase.updatedAt)}
                </span>
              </>
            ) : null}
          </div>
        </div>
        <div className="hidden shrink-0 items-center gap-4 text-xs text-muted-foreground sm:flex">
          <span>
            {formatCount(codebase.fileCount)} files
            {codebase.privateFileCount > 0 ? ` (+${formatCount(codebase.privateFileCount)} private)` : ''}
          </span>
          <span>
            {formatCount(codebase.memberCount)} member{codebase.memberCount === 1 ? '' : 's'}
          </span>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${codebase.name}`}
              className="shrink-0 text-muted-foreground"
              onClick={(event) => event.stopPropagation()}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
            <DropdownMenuItem
              disabled={!commandsAvailable || commandBusy}
              onSelect={() => void runRowCommand('attachWorkspace', 'Attach')}
            >
              <HardDrive /> Attach
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!commandsAvailable || commandBusy}
              onSelect={() => void runRowCommand('hydrateWorkspace', 'Hydrate')}
            >
              <DownloadCloud /> Hydrate
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!commandsAvailable || commandBusy}
              onSelect={() => void runRowCommand('dehydrateWorkspace', 'Dehydrate')}
            >
              <CloudOff /> Dehydrate
            </DropdownMenuItem>
            {!commandsAvailable ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">Available from the local agent</p>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onRename}>
              <Pencil /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  )
}

'use client'

import * as React from 'react'
import { Folder, Lock, Pin } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import type { AgentFile } from '@/lib/client/agent-status'
import { formatBytes } from '@/lib/client/format'
import { cn } from '@/lib/utils'
import { LOCAL_STATE_TONES, localStateLabel } from './local-state'

function groupByTopLevel(files: AgentFile[]): Array<[string, AgentFile[]]> {
  const groups = new Map<string, AgentFile[]>()
  for (const file of files) {
    const slash = file.path.indexOf('/')
    const group = slash === -1 ? '/' : file.path.slice(0, slash)
    const bucket = groups.get(group)
    if (bucket) bucket.push(file)
    else groups.set(group, [file])
  }
  return Array.from(groups.entries()).sort(([a], [b]) => {
    if (a === '/') return -1
    if (b === '/') return 1
    return a.localeCompare(b)
  })
}

export function FileList({
  files,
  selectedPath,
  onSelect,
}: {
  files: AgentFile[]
  selectedPath: string | null
  onSelect: (path: string) => void
}) {
  const groups = React.useMemo(() => groupByTopLevel(files), [files])

  if (files.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
        No files match the current filters.
      </p>
    )
  }

  return (
    <div className="scroll-thin max-h-[70vh] space-y-3 overflow-y-auto rounded-xl border border-border bg-card p-2">
      {groups.map(([group, groupFiles]) => (
        <div key={group}>
          <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground">
            <Folder className="size-3.5" aria-hidden />
            <span className="font-mono">{group}</span>
          </div>
          <ul className="space-y-0.5">
            {groupFiles.map((file) => (
              <FileRow
                key={file.path}
                file={file}
                selected={file.path === selectedPath}
                onSelect={() => onSelect(file.path)}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function FileRow({
  file,
  selected,
  onSelect,
}: {
  file: AgentFile
  selected: boolean
  onSelect: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none transition-colors',
          'hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/40',
          selected && 'bg-muted/60',
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{file.name}</span>
            {file.scope === 'owner-private' ? (
              <span title="Private to you" className="shrink-0 text-muted-foreground">
                <Lock className="size-3" aria-hidden />
                <span className="sr-only">Private</span>
              </span>
            ) : null}
            {file.local.pinned ? (
              <span title="Pinned locally" className="shrink-0 text-iris">
                <Pin className="size-3" aria-hidden />
                <span className="sr-only">Pinned</span>
              </span>
            ) : null}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">{file.directory}</p>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(file.size)}</span>
        <Badge tone={LOCAL_STATE_TONES[file.local.state]} className="shrink-0">
          {localStateLabel(file.local.state)}
        </Badge>
      </button>
    </li>
  )
}

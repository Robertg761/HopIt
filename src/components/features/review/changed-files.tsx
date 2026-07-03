'use client'

import * as React from 'react'
import { FileDiff, MessageSquare } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { fileStateTone, type ChangedFile } from './review-shared'

export function ChangedFilesCard({
  changedFiles,
  loading,
  selectedPath,
  onSelect,
  threadCounts,
}: {
  changedFiles: ChangedFile[]
  loading: boolean
  selectedPath?: string | null
  onSelect?: (path: string) => void
  threadCounts?: Map<string, number>
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Changed files</CardTitle>
        <CardDescription>
          Files that diverged from Main in this change set.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-4">
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-3/4" />
          </div>
        ) : changedFiles.length === 0 ? (
          <EmptyState
            icon={FileDiff}
            title="No changed files"
            description="Everything in this change set matches Main. Edits from your workspace will show up here."
          />
        ) : (
          <ul className="space-y-0.5">
            {changedFiles.map(({ file }) => {
              const threadCount = threadCounts?.get(file.path) ?? 0
              const selected = selectedPath === file.path
              const row = (
                <>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={file.path}>
                    {file.path}
                  </span>
                  {threadCount > 0 ? (
                    <Badge tone="iris">
                      <MessageSquare />
                      {threadCount}
                    </Badge>
                  ) : null}
                  <Badge tone={fileStateTone(file.local.state)}>{file.local.state}</Badge>
                </>
              )

              return (
                <li key={file.path}>
                  {onSelect ? (
                    <button
                      type="button"
                      onClick={() => onSelect(file.path)}
                      aria-pressed={selected}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left outline-none transition-colors',
                        'hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/40',
                        selected && 'bg-muted/60',
                      )}
                    >
                      {row}
                    </button>
                  ) : (
                    <div className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 hover:bg-muted/50">
                      {row}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

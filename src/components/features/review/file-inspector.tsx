'use client'

import * as React from 'react'
import { FileSearch, ListPlus } from 'lucide-react'

import type { AgentFile } from '@/lib/client/agent-status'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Spinner } from '@/components/ui/spinner'
import { fileStateTone } from './review-shared'

export function FileInspector({
  file,
  selectedLine,
  onSelectLine,
  onFileFollowUp,
  followUpBusy,
  followUpDisabledReason,
}: {
  file: AgentFile | null
  selectedLine: number | null
  onSelectLine: (line: number | null) => void
  onFileFollowUp: () => void
  followUpBusy: boolean
  followUpDisabledReason: string | null
}) {
  if (!file) {
    return (
      <Card>
        <CardContent>
          <EmptyState
            icon={FileSearch}
            title="Select a file"
            description="Pick a changed file to inspect its preview and start inline review threads."
          />
        </CardContent>
      </Card>
    )
  }

  const lines = file.contentPreview !== null ? file.contentPreview.split('\n') : null

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <CardTitle className="truncate font-mono text-xs font-medium leading-5" title={file.path}>
            {file.path}
          </CardTitle>
          <CardDescription className="mt-1 flex flex-wrap items-center gap-2">
            <Badge tone={fileStateTone(file.local.state)}>{file.local.state}</Badge>
            {typeof file.revision === 'number' ? (
              <span className="font-mono">rev {file.revision}</span>
            ) : null}
            {selectedLine !== null ? <span className="font-mono">line {selectedLine}</span> : null}
          </CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onFileFollowUp}
          disabled={followUpBusy || followUpDisabledReason !== null}
          title={followUpDisabledReason ?? undefined}
        >
          {followUpBusy ? <Spinner className="size-3.5" /> : <ListPlus />}
          File follow-up issue
        </Button>
      </CardHeader>
      <CardContent className="pt-4">
        {lines === null ? (
          <p className="text-xs text-muted-foreground">
            No inline preview is available for this file (binary, private, or blob-stored content).
          </p>
        ) : (
          <>
            <ol className="scroll-thin max-h-96 overflow-auto rounded-lg bg-muted/40 py-1.5 font-mono text-xs leading-5">
              {lines.map((text, index) => {
                const lineNumber = index + 1
                const selected = selectedLine === lineNumber
                return (
                  <li key={lineNumber}>
                    <button
                      type="button"
                      onClick={() => onSelectLine(selected ? null : lineNumber)}
                      aria-pressed={selected}
                      className={cn(
                        'flex w-full gap-3 px-2.5 text-left outline-none transition-colors',
                        'hover:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring/40',
                        selected && 'bg-iris-soft text-iris-soft-foreground hover:bg-iris-soft',
                      )}
                    >
                      <span className="w-8 shrink-0 select-none text-right text-muted-foreground/60">
                        {lineNumber}
                      </span>
                      <span className="whitespace-pre">{text.length > 0 ? text : ' '}</span>
                    </button>
                  </li>
                )
              })}
            </ol>
            <p className="mt-2 text-xs text-muted-foreground">
              {file.contentPreviewTruncated
                ? 'Preview truncated. Showing the first part of the file.'
                : 'Click a line to anchor an inline thread.'}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}

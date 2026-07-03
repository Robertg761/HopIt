'use client'

import * as React from 'react'
import { ArrowRight } from 'lucide-react'

import type { AgentStatusSnapshot } from '@/lib/client/agent-status'
import { formatCount } from '@/lib/client/format'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ChangedFilesCard } from './changed-files'
import { QuietNote, type ChangedFile } from './review-shared'

export function CompareView({
  status,
  changedFiles,
  loading,
}: {
  status: AgentStatusSnapshot
  changedFiles: ChangedFile[]
  loading: boolean
}) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Change set vs Main</CardTitle>
          <CardDescription>
            Where the active change set stands relative to the Main state.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <ComparePane
              label="Active change set"
              id={status.activeChangeSetId}
              revision={status.cloudRevision}
            />
            <ComparePane label="Main" id={status.mainId} revision={status.mainRevision} />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-4">
            <span className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
              {status.mainRevision}
              <ArrowRight aria-hidden className="size-3.5" />
              {status.cloudRevision}
            </span>
            <Badge tone={changedFiles.length > 0 ? 'iris' : 'neutral'}>
              {formatCount(changedFiles.length)} changed file{changedFiles.length === 1 ? '' : 's'}
            </Badge>
            {status.remoteBehindByRevisions !== null ? (
              <Badge tone={status.remoteBehindByRevisions > 0 ? 'amber' : 'neutral'}>
                behind by {formatCount(status.remoteBehindByRevisions)}
              </Badge>
            ) : null}
            <Badge tone="outline">visibility: {status.visibility}</Badge>
          </div>
          <div className="mt-3">
            <QuietNote>
              Full line-by-line diffing is on the roadmap. For now, compare revisions and the
              per-file change states below.
            </QuietNote>
          </div>
        </CardContent>
      </Card>
      <ChangedFilesCard changedFiles={changedFiles} loading={loading} />
    </>
  )
}

function ComparePane({ label, id, revision }: { label: string; id: string; revision: string }) {
  return (
    <div className="rounded-lg bg-muted/40 p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 truncate font-mono text-xs font-medium" title={id}>
        {id}
      </p>
      <p className="mt-2 font-mono text-xs text-muted-foreground">{revision}</p>
    </div>
  )
}

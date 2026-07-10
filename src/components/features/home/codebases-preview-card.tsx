'use client'

import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import type { CodebaseSummary } from '@/components/workspace/workspace-provider'
import { repoPath } from '@/components/shell/repo-nav'
import { formatCount } from '@/lib/client/format'

export function CodebasesPreviewCard({ codebases, loading }: { codebases: CodebaseSummary[]; loading: boolean }) {
  const preview = codebases.slice(0, 5)

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between border-b border-border pb-3">
        <CardTitle>Repositories</CardTitle>
        <Link href="/codebases" className="text-xs font-medium text-iris hover:underline">
          View all
        </Link>
      </CardHeader>
      <CardContent className="p-0 sm:p-0">
        {loading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : preview.length === 0 ? (
          <p className="px-4 py-8 text-sm text-muted-foreground sm:px-5">No repositories yet.</p>
        ) : (
          <ul>
            {preview.map((codebase) => (
              <li key={codebase.id} className="border-b border-border last:border-0">
                <Link
                  href={repoPath(codebase.id)}
                  className="flex items-center gap-3 px-4 py-3 outline-none hover:bg-muted/50 sm:px-5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-iris hover:underline">{codebase.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {formatCount(codebase.fileCount)} files ·{' '}
                      {codebase.behindByRevisions > 0
                        ? `${formatCount(codebase.behindByRevisions)} rev${codebase.behindByRevisions === 1 ? '' : 's'} behind`
                        : 'Up to date'}
                    </p>
                  </div>
                  <Badge tone="outline">{codebase.attached ? 'Attached' : 'Cloud'}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

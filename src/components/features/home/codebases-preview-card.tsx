'use client'

import Link from 'next/link'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import type { CodebaseSummary } from '@/components/workspace/workspace-provider'
import { formatCount } from '@/lib/client/format'

/** Up to four codebases with hydration and drift info, linking to /codebases. */
export function CodebasesPreviewCard({
  codebases,
  loading,
}: {
  codebases: CodebaseSummary[]
  loading: boolean
}) {
  const preview = codebases.slice(0, 4)

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Codebases</CardTitle>
        <Link
          href="/codebases"
          className="rounded text-xs font-medium text-iris outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          View all
        </Link>
      </CardHeader>
      <CardContent className="pt-3">
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
          </div>
        ) : preview.length === 0 ? (
          <p className="text-xs text-muted-foreground">No codebases in this account yet.</p>
        ) : (
          <ul className="space-y-1">
            {preview.map((codebase) => (
              <li key={codebase.id}>
                <Link
                  href="/codebases"
                  className="flex items-center gap-3 rounded-lg px-2 py-2 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {codebase.name}
                  </span>
                  <Badge tone={codebase.attached ? 'hop' : 'neutral'}>
                    {codebase.hydrationState}
                  </Badge>
                  {codebase.behindByRevisions > 0 ? (
                    <Badge tone="amber">behind {formatCount(codebase.behindByRevisions)}</Badge>
                  ) : null}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatCount(codebase.fileCount)} files
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

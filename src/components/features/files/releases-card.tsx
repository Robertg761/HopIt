'use client'

import * as React from 'react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { ManagedCaption } from '@/components/features/system/shared'

import { useReleases } from './use-releases'

/**
 * Releases dashboard list (GR-B4, decisions §9): "mark this Main state as a
 * release" -- name, optional notes, pinned Main revision, created_at. This
 * card is a plain, read-only list on the codebase page. Flag-gated behind
 * `NEXT_PUBLIC_RELEASES_LIST` while Track B's dashboard surfaces stay behind
 * the collaboration-surface freeze (see
 * docs/git-replacement-implementation-plan.md, Track B); creating a release
 * is CLI-only, like the other CLI-managed cards.
 */
export function ReleasesCard({ codebaseId }: { codebaseId: string | null }) {
  const state = useReleases(codebaseId)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Releases</CardTitle>
        <CardDescription>Named, permanent pins of a Main revision -- exactly what shipped.</CardDescription>
      </CardHeader>
      <CardContent>
        {!codebaseId || !state || state.status === 'loading' ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : state.status === 'error' ? (
          <p className="text-sm text-muted-foreground">{state.error.message}</p>
        ) : state.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No releases yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {state.data.map((release) => (
              <li key={release.releaseId} className="flex items-center justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <span className="font-medium">{release.name}</span>
                  {release.notes ? (
                    <span className="ml-2 truncate text-xs text-muted-foreground">{release.notes}</span>
                  ) : null}
                </div>
                <Badge tone="outline">rev {release.pinnedRevision ?? '?'}</Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <CardFooter>
        <ManagedCaption>
          Create a release with <span className="font-mono">hop release &lt;name&gt; [--notes]</span>. Names are
          unique per codebase and pins never move once created.
        </ManagedCaption>
      </CardFooter>
    </Card>
  )
}

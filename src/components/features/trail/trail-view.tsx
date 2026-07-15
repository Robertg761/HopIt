'use client'

import * as React from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  ChevronRight,
  Footprints,
  GitCompareArrows,
  Laptop,
  Sparkles,
  Terminal,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { humanizeApiError } from '@/lib/client/errors'
import { formatRelativeTime } from '@/lib/client/format'
import {
  episodeCompareHref,
  episodeDurationLabel,
  episodeLabelView,
  episodeModelBadge,
  episodeStepSummary,
  sortEpisodesNewestFirst,
} from '@/lib/client/trail/mappers'
import type { TrailEpisode, TrailError } from '@/lib/client/trail/types'
import { useTrailData } from './use-trail-data'

const BACKEND_UNAVAILABLE_CODES = new Set(['d1_required', 'cloud_backend_unavailable', 'http_503'])

/**
 * The Trail view: stored trail episodes rendered as labeled cards, newest first.
 * Each card links into the existing compare page preloaded with the episode's
 * revision pair. When summaries are switched off for the codebase, the honest
 * state is shown with the CLI hint that turns them on.
 */
export function TrailView({ codebaseId }: { codebaseId: string | null }) {
  const trail = useTrailData(codebaseId)

  if (!codebaseId) {
    return (
      <EmptyState
        icon={Footprints}
        title="No repository selected"
        description="Open a repository to browse the episodes on its trail."
      />
    )
  }

  if (!trail || trail.status === 'loading') {
    return <TrailSkeleton />
  }

  if (trail.status === 'error') {
    return <StateNote error={trail.error} title="Trail episodes unavailable" />
  }

  const { episodes, summaries } = trail.data
  const ordered = sortEpisodesNewestFirst(episodes)

  return (
    <div className="space-y-4">
      {!summaries.enabled ? <SummariesOffNote /> : null}

      <Card>
        <CardHeader>
          <CardTitle>Trail episodes</CardTitle>
          <CardDescription>
            Runs of trail steps grouped into episodes, newest first. Open one to compare what changed
            across it.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          {ordered.length === 0 ? (
            <EmptyState
              icon={Footprints}
              title="No trail episodes yet"
              description="Once this repository records trail steps, its episodes appear here."
            />
          ) : (
            <ul className="space-y-3">
              {ordered.map((episode) => (
                <EpisodeCard key={episode.episodeId} codebaseId={codebaseId} episode={episode} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function EpisodeCard({ codebaseId, episode }: { codebaseId: string; episode: TrailEpisode }) {
  const [open, setOpen] = React.useState(false)
  const label = episodeLabelView(episode)
  const modelBadge = episodeModelBadge(episode)
  const compareHref = episodeCompareHref(codebaseId, episode)

  return (
    <li className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className={cn(
          'flex w-full items-start gap-2 rounded-xl px-3 py-3 text-left outline-none transition-colors',
          'hover:bg-muted/40 focus-visible:bg-muted/40',
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn('mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
        />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            {label.labeled ? (
              <span className="text-sm font-medium">{label.text}</span>
            ) : (
              <span className="text-sm italic text-muted-foreground">{label.text}</span>
            )}
            {modelBadge ? (
              <Badge tone="iris">
                <Sparkles aria-hidden className="mr-1 size-3" />
                {modelBadge}
              </Badge>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {episode.deviceName ? (
              <span className="inline-flex items-center gap-1">
                <Laptop aria-hidden className="size-3.5" />
                {episode.deviceName}
              </span>
            ) : null}
            <span title={rangeTitle(episode)}>{formatRelativeTime(episode.endedAt ?? episode.startedAt)}</span>
            <span>{episodeDurationLabel(episode)}</span>
            <span className="tabular-nums">{episodeStepSummary(episode)}</span>
          </div>
        </div>
      </button>

      {open ? (
        <div className="border-t border-border px-3 py-3 pl-9">
          <SamplePaths episode={episode} />
          <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
            <span className="font-mono">
              step {episode.fromRevision ?? 'Not available'} → step {episode.toRevision ?? 'Not available'}
            </span>
            {compareHref ? (
              <Link
                href={compareHref}
                className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
              >
                <GitCompareArrows aria-hidden className="size-3.5" />
                Compare these steps
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  )
}

function SamplePaths({ episode }: { episode: TrailEpisode }) {
  if (episode.samplePaths.length === 0) {
    return <p className="text-xs text-muted-foreground">No sample paths were recorded for this episode.</p>
  }
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">Sample paths</p>
      <ul className="space-y-1">
        {episode.samplePaths.map((path) => (
          <li key={path} className="truncate font-mono text-xs" title={path}>
            {path}
          </li>
        ))}
      </ul>
    </div>
  )
}

function SummariesOffNote() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-info-soft bg-info-soft/20 px-3 py-2.5 text-xs text-info-soft-foreground">
      <Terminal aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>
        Trail summaries are off for this repository, so episodes stay unlabeled. Turn AI labels on from
        the agent CLI with{' '}
        <code className="rounded bg-background/60 px-1 py-0.5 font-mono">hop trail summaries on</code>.
      </span>
    </div>
  )
}

function StateNote({ error, title }: { error: TrailError; title: string }) {
  const message = BACKEND_UNAVAILABLE_CODES.has(error.code)
    ? 'The hosted trail backend is not available in this environment.'
    : humanizeApiError(error.message)
  return <EmptyState icon={AlertTriangle} title={title} description={message} />
}

function rangeTitle(episode: TrailEpisode): string {
  const parts = [episode.startedAt, episode.endedAt].filter(Boolean)
  return parts.length > 0 ? parts.join(' → ') : ''
}

function TrailSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  )
}

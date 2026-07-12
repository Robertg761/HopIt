import { repoPath } from '@/components/shell/repo-nav'
import { formatCount } from '@/lib/client/format'

import type { TrailEpisode } from './types'

/**
 * Pure view-model mappers for the trail-episode surface. Everything user-facing
 * about an episode — its label (or the honest "not yet labeled" state), its
 * duration, its step/file counts, and the deep-link into the existing compare
 * page — is derived here so it can be unit-tested without React and stays in the
 * roadmap's trail vocabulary (episodes and steps on a trail, never commits).
 */

export const UNLABELED_TEXT = '(not yet labeled)'

export type EpisodeLabelView = {
  /** True when a cheap model has already written a label for this episode. */
  labeled: boolean
  /** The label text, or the honest placeholder when none has been written. */
  text: string
}

export function episodeLabelView(episode: TrailEpisode): EpisodeLabelView {
  const label = typeof episode.label === 'string' ? episode.label.trim() : ''
  return label ? { labeled: true, text: label } : { labeled: false, text: UNLABELED_TEXT }
}

/**
 * The model/mode provenance shown as a small badge on a labeled episode, e.g.
 * "haiku · metadata". Returns null when neither is known, so an unlabeled or
 * provenance-less episode never advertises a source it does not have.
 */
export function episodeModelBadge(episode: TrailEpisode): string | null {
  const model = cleanText(episode.labelModel)
  const mode = cleanText(episode.labelMode)
  if (!model && !mode) return null
  return [model, mode].filter(Boolean).join(' · ')
}

/**
 * Human duration between an episode's first and last step. Deterministic and
 * timezone-independent (a millisecond delta, not a wall-clock render), so it is
 * safe to unit-test. Honest "—" when either bound is missing or unparseable.
 */
export function episodeDurationLabel(episode: TrailEpisode): string {
  const start = timestampMs(episode.startedAt)
  const end = timestampMs(episode.endedAt)
  if (start === null || end === null) return '—'
  const delta = Math.max(0, end - start)
  if (delta < 60_000) return 'under a minute'
  const totalMinutes = Math.round(delta / 60_000)
  if (totalMinutes < 60) return `${totalMinutes} min`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes === 0 ? `${hours} hr` : `${hours} hr ${minutes} min`
}

/** "12 steps · 5 files" — the compact activity summary shown on a card. */
export function episodeStepSummary(episode: TrailEpisode): string {
  const steps = plural(episode.stepCount, 'step')
  const files = plural(episode.changedPathCount, 'file')
  return `${steps} · ${files}`
}

/**
 * Deep-link into the EXISTING compare page, preloaded with this episode's
 * revision pair (`?from=&to=`). Returns null when the codebase or either
 * revision is unknown, so a card never renders a link that cannot resolve.
 */
export function episodeCompareHref(
  codebaseId: string | null | undefined,
  episode: TrailEpisode,
): string | null {
  if (!codebaseId) return null
  if (!Number.isInteger(episode.fromRevision) || !Number.isInteger(episode.toRevision)) return null
  const search = new URLSearchParams({
    from: String(episode.fromRevision),
    to: String(episode.toRevision),
  })
  return `${repoPath(codebaseId, 'compare')}?${search.toString()}`
}

/**
 * Newest episode first. Episodes never overlap, so ordering by the ending
 * revision (then the starting revision) is a total order that matches wall-clock
 * recency without depending on possibly-null timestamps.
 */
export function sortEpisodesNewestFirst(episodes: TrailEpisode[]): TrailEpisode[] {
  return [...episodes].sort((a, b) => {
    const byTo = revisionRank(b.toRevision) - revisionRank(a.toRevision)
    if (byTo !== 0) return byTo
    return revisionRank(b.fromRevision) - revisionRank(a.fromRevision)
  })
}

function plural(count: number, noun: string): string {
  const value = Number.isFinite(count) ? count : 0
  return `${formatCount(value)} ${noun}${value === 1 ? '' : 's'}`
}

function revisionRank(value: number | null): number {
  return Number.isInteger(value) ? (value as number) : Number.NEGATIVE_INFINITY
}

function cleanText(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function timestampMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

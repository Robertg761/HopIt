// @ts-check
import { DEFAULT_EPISODE_GAP_MS, DEFAULT_SAMPLE_PATH_LIMIT } from '@hopit/backend-d1'
import { buildEpisodePayload } from './payload.js'

// The engine core. Provider-injectable and I/O-injectable (the `service`), so
// it is unit-testable without network. The opt-in gate is enforced HERE, before
// the provider is ever touched: when summarization is off the function returns
// immediately and `provider.label` is unreachable.

/**
 * @param {{
 *   service: any,
 *   codebaseId: string,
 *   settings: { trailSummariesEnabled: boolean, trailSummariesMode: string },
 *   provider?: { label: Function, provider?: string, model?: string },
 *   mode?: string,
 *   limit?: number|null,
 *   maxEpisodes?: number,
 *   gapMs?: number,
 *   sampleLimit?: number,
 *   diffMaxChars?: number,
 *   dryRun?: boolean,
 *   visibility?: object,
 * }} params
 */
export async function summarizeEpisodes(params) {
  const {
    service,
    codebaseId,
    settings,
    provider,
    limit = null,
    maxEpisodes = 50,
    gapMs = DEFAULT_EPISODE_GAP_MS,
    sampleLimit = DEFAULT_SAMPLE_PATH_LIMIT,
    diffMaxChars = 8000,
    dryRun = false,
    visibility = {},
  } = params

  // Hard opt-in gate. No episodes are read, no payload is built, and the
  // provider is never called when summarization is off for this codebase.
  if (!settings?.trailSummariesEnabled) {
    return {
      ok: false,
      state: 'disabled',
      codebaseId,
      reason: 'Trail summaries are off for this codebase. Enable with: hop trail summaries on',
      mode: null,
      episodeCount: 0,
      labeled: 0,
      payloads: [],
    }
  }

  const mode = settings.trailSummariesMode === 'diff' ? 'diff' : 'metadata'
  // Diff mode must be an explicit, persisted opt-in (a separate switch).
  if (params.mode === 'diff' && mode !== 'diff') {
    throw new Error('Diff-mode summaries are a separate opt-in. Enable with: hop trail summaries on --mode diff')
  }

  const episodes = await service.computeTrailEpisodes(codebaseId, { gapMs, sampleLimit })
  const stored = await service.listTrailEpisodes(codebaseId)
  const labeledIds = new Set(stored.filter((row) => row.label != null && row.label !== '').map((row) => row.episodeId))
  const unlabeled = episodes.filter((ep) => !labeledIds.has(ep.episodeId))

  const cap = Math.min(
    Number.isInteger(limit) && limit > 0 ? limit : Number.POSITIVE_INFINITY,
    Number.isInteger(maxEpisodes) && maxEpisodes > 0 ? maxEpisodes : Number.POSITIVE_INFINITY,
  )
  const targets = Number.isFinite(cap) ? unlabeled.slice(0, cap) : unlabeled

  const payloads = []
  let labeled = 0

  for (const episode of targets) {
    let diffText = null
    if (mode === 'diff') {
      diffText = await buildEpisodeDiffText(service, episode, { diffMaxChars, visibility })
    }
    const payload = buildEpisodePayload(episode, { mode, diffText, diffMaxChars })
    payloads.push({ episodeId: episode.episodeId, mode, payload })

    if (dryRun) continue

    const { label, model } = await provider.label(episode, { mode, diffText })
    await service.upsertTrailEpisode(codebaseId, {
      ...episode,
      label,
      labelModel: model,
      labelMode: mode,
    })
    labeled += 1
  }

  return {
    ok: true,
    state: dryRun ? 'dry-run' : 'summarized',
    codebaseId,
    mode,
    provider: provider?.provider ?? null,
    model: provider?.model ?? null,
    episodeCount: episodes.length,
    unlabeledCount: unlabeled.length,
    labeled,
    skippedByCap: Math.max(0, unlabeled.length - targets.length),
    payloads,
  }
}

// Best-effort bounded unified-diff text for one episode, assembled from the
// WS7c compare engine over the episode's sample paths. Never includes more than
// `diffMaxChars` characters; the payload layer bounds it a second time.
export async function buildEpisodeDiffText(service, episode, { diffMaxChars = 8000, visibility = {}, maxPaths = 5 } = {}) {
  if (typeof service.compareRevisions !== 'function') return ''
  const toRevision = episode.toRevision
  const paths = (episode.samplePaths ?? []).slice(0, maxPaths)
  const blocks = []
  let total = 0

  for (const filePath of paths) {
    const result = await compareForPath(service, episode.fromRevision, toRevision, filePath, visibility)
    const entry = result?.ok ? result.entries?.find((candidate) => candidate.path === filePath) : null
    const diff = entry?.body?.state === 'text_diff' ? entry.body.diff : null
    if (!diff) continue
    const block = formatDiffBlock(filePath, diff)
    if (total + block.length > diffMaxChars) {
      blocks.push(`--- ${filePath}\n… [remaining diffs omitted for length]`)
      break
    }
    blocks.push(block)
    total += block.length
  }

  return blocks.join('\n')
}

async function compareForPath(service, fromRevision, toRevision, filePath, visibility) {
  const base = Number.isInteger(fromRevision) && fromRevision > 0 ? fromRevision - 1 : fromRevision
  try {
    const primary = await service.compareRevisions(base, toRevision, { ...visibility, path: filePath })
    if (primary?.ok) return primary
  } catch {
    // fall through to a same-revision base attempt
  }
  try {
    return await service.compareRevisions(fromRevision, toRevision, { ...visibility, path: filePath })
  } catch {
    return null
  }
}

function formatDiffBlock(filePath, diff) {
  const removed = (diff.removedLines ?? []).map((line) => `-${line}`)
  const added = (diff.addedLines ?? []).map((line) => `+${line}`)
  return [`--- ${filePath}`, ...removed, ...added].join('\n')
}

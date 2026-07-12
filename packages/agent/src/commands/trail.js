// @ts-check
import { DEFAULT_EPISODE_GAP_MS } from '@hopit/backend-d1'
import { createCloudGraphService, visibilityRequestFromOptions } from '../cloud/d1-graph-service.js'
import { resolveSummaryConfig } from '../summaries/config.js'
import { createSummarizerProvider, MissingSummaryKeyError } from '../summaries/provider.js'
import { summarizeEpisodes } from '../summaries/summarize.js'
import { reportResult, writeLine } from '../output.js'

const VALID_MODES = new Set(['metadata', 'diff'])

export async function runTrailCommand(action = 'episodes', state = null, options = {}) {
  switch (action) {
    case 'episodes':
      return runTrailEpisodes(options)
    case 'summarize':
      return runTrailSummarize(options)
    case 'summaries':
      return runTrailSummaries(state, options)
    default:
      throw new Error(`Unknown trail command: ${action}. Try: hop trail episodes | hop trail summarize | hop trail summaries on|off`)
  }
}

async function runTrailEpisodes(options) {
  const service = createCloudGraphService(options)
  const codebaseId = resolveCodebaseId(service, options)
  const gapMs = gapMsFromOptions(options)
  const limit = intOrNull(options.limit)

  const clustered = await service.computeTrailEpisodes(codebaseId, { gapMs })
  const stored = await service.listTrailEpisodes(codebaseId)
  const labelsById = new Map(stored.map((row) => [row.episodeId, row]))
  const merged = clustered.map((episode) => {
    const record = labelsById.get(episode.episodeId)
    return {
      ...episode,
      label: record?.label ?? null,
      labelModel: record?.labelModel ?? null,
      labelMode: record?.labelMode ?? null,
    }
  })
  const episodes = limit ? merged.slice(-limit) : merged

  const result = {
    ok: true,
    codebaseId,
    gapMs,
    episodeCount: merged.length,
    episodes,
  }

  reportResult(options, result, ({ line, accent, muted, success }) => {
    if (episodes.length === 0) {
      line(`  ${muted('No trail episodes yet.')}`)
      return
    }
    line(`  ${accent('•')} ${episodes.length} episode${episodes.length === 1 ? '' : 's'} ${muted(`(gap ${Math.round(gapMs / 60000)}m, codebase ${codebaseId})`)}`)
    for (const episode of episodes) {
      const range = `rev ${episode.fromRevision}→${episode.toRevision}`
      const meta = muted(`${range} · ${episode.stepCount} step${episode.stepCount === 1 ? '' : 's'} · ${episode.changedPathCount} file${episode.changedPathCount === 1 ? '' : 's'}${episode.deviceName ? ` · ${episode.deviceName}` : ''}`)
      const label = episode.label ? success(episode.label) : muted('(unlabeled)')
      line(`    ${label} ${meta}`)
    }
  })
  return result
}

async function runTrailSummarize(options) {
  const service = createCloudGraphService(options)
  const codebaseId = resolveCodebaseId(service, options)
  const settings = await service.readCodebaseSettings(codebaseId)
  const dryRun = Boolean(options['dry-run'])

  if (!settings.trailSummariesEnabled) {
    const result = {
      ok: false,
      state: 'disabled',
      codebaseId,
      reason: 'Trail summaries are off for this codebase. Enable with: hop trail summaries on',
    }
    reportResult(options, result, ({ line, caution }) => {
      line(`  ${caution('○')} Trail summaries are off for ${codebaseId}. Enable with: hop trail summaries on`)
    })
    return result
  }

  const summaryConfig = resolveSummaryConfig(options)
  const provider = createSummarizerProvider(summaryConfig)

  // Honest, early failure when a real provider has no key and this is not a
  // privacy-inspection dry run.
  if (!dryRun && provider.requiresKey && !summaryConfig.apiKey) {
    throw new MissingSummaryKeyError(summaryConfig.provider, summaryConfig.apiKeyEnv)
  }

  const result = await summarizeEpisodes({
    service,
    codebaseId,
    settings,
    provider,
    limit: intOrNull(options.limit),
    maxEpisodes: summaryConfig.maxEpisodes,
    gapMs: gapMsFromOptions(options),
    diffMaxChars: summaryConfig.diffMaxChars,
    dryRun,
    visibility: visibilityRequestFromOptions(options),
  })

  reportResult(options, result, ({ line, accent, muted, success }) => {
    if (dryRun) {
      line(`  ${accent('•')} Dry run — payloads that WOULD be sent (${result.payloads.length}, mode ${result.mode}):`)
      for (const item of result.payloads) {
        line(`    ${muted(item.episodeId)}`)
        writeLine(JSON.stringify(item.payload, null, 2))
      }
      return
    }
    line(`  ${success('✓')} Labeled ${result.labeled} episode${result.labeled === 1 ? '' : 's'} ${muted(`(${result.provider}/${result.model}, mode ${result.mode})`)}`)
    if (result.skippedByCap > 0) {
      line(`    ${muted(`${result.skippedByCap} more unlabeled — raise --limit or HOPIT_SUMMARY_MAX_EPISODES to continue`)}`)
    }
  })
  return result
}

async function runTrailSummaries(state, options) {
  if (state !== 'on' && state !== 'off') {
    throw new Error('Usage: hop trail summaries on|off [--mode metadata|diff]')
  }
  const service = createCloudGraphService(options)
  const codebaseId = resolveCodebaseId(service, options)

  let mode
  if (options.mode !== undefined) {
    if (!VALID_MODES.has(options.mode)) {
      throw new Error(`Invalid --mode ${options.mode}. Use metadata or diff.`)
    }
    mode = options.mode
  }

  const updated = await service.setTrailSummaries(codebaseId, {
    enabled: state === 'on',
    mode,
  })

  const result = { ok: true, ...updated }
  reportResult(options, result, ({ line, success, caution, muted }) => {
    if (updated.trailSummariesEnabled) {
      line(`  ${success('✓')} Trail summaries on for ${codebaseId} ${muted(`(mode ${updated.trailSummariesMode})`)}`)
      if (updated.trailSummariesMode === 'diff') {
        line(`    ${caution('!')} Diff mode sends bounded file-diff text to the model, not just metadata.`)
      }
    } else {
      line(`  ${caution('○')} Trail summaries off for ${codebaseId}`)
    }
  })
  return result
}

function resolveCodebaseId(service, options) {
  return (
    options['codebase-id'] ||
    service.codebaseId ||
    process.env.HOPIT_CODEBASE_ID ||
    'hopit'
  )
}

function gapMsFromOptions(options) {
  const gapMs = Number(options['gap-ms'])
  if (Number.isFinite(gapMs) && gapMs >= 0) return gapMs
  const gapMinutes = Number(options['gap-minutes'])
  if (Number.isFinite(gapMinutes) && gapMinutes >= 0) return Math.round(gapMinutes * 60000)
  return DEFAULT_EPISODE_GAP_MS
}

function intOrNull(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

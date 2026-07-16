import { describe, expect, it } from 'vitest'

import {
  UNLABELED_TEXT,
  episodeCompareHref,
  episodeDurationLabel,
  episodeLabelView,
  episodeModelBadge,
  episodeStepSummary,
  sortEpisodesNewestFirst,
} from './mappers'
import type { TrailEpisode } from './types'

function episode(overrides: Partial<TrailEpisode> = {}): TrailEpisode {
  return {
    episodeId: 'ep_1_3',
    fromRevision: 1,
    toRevision: 3,
    deviceName: 'studio',
    startedAt: '2026-07-11T10:00:00.000Z',
    endedAt: '2026-07-11T10:45:00.000Z',
    stepCount: 3,
    changedPathCount: 5,
    samplePaths: ['src/a.ts', 'src/b.ts'],
    label: 'Refined the trail view',
    labelModel: 'haiku',
    labelMode: 'metadata',
    createdAt: null,
    updatedAt: null,
    ...overrides,
  }
}

describe('episodeLabelView', () => {
  it('surfaces a written label as the labeled state', () => {
    const view = episodeLabelView(episode({ label: 'Fixed the sync deadlock' }))
    expect(view).toEqual({ labeled: true, text: 'Fixed the sync deadlock' })
  })

  it('falls back to an honest placeholder when there is no label', () => {
    expect(episodeLabelView(episode({ label: null }))).toEqual({ labeled: false, text: UNLABELED_TEXT })
  })

  it('treats a blank label as unlabeled', () => {
    expect(episodeLabelView(episode({ label: '   ' })).labeled).toBe(false)
  })

  it('never uses commit vocabulary in the placeholder', () => {
    expect(UNLABELED_TEXT).not.toMatch(/commit/i)
  })
})

describe('episodeModelBadge', () => {
  it('joins model and mode for provenance', () => {
    expect(episodeModelBadge(episode({ labelModel: 'haiku', labelMode: 'diff' }))).toBe('haiku · diff')
  })

  it('returns just the known part when one side is missing', () => {
    expect(episodeModelBadge(episode({ labelModel: 'haiku', labelMode: null }))).toBe('haiku')
    expect(episodeModelBadge(episode({ labelModel: null, labelMode: 'metadata' }))).toBe('metadata')
  })

  it('returns null when neither model nor mode is known', () => {
    expect(episodeModelBadge(episode({ labelModel: null, labelMode: null }))).toBeNull()
  })
})

describe('episodeDurationLabel', () => {
  it('reports whole-minute durations', () => {
    expect(
      episodeDurationLabel(
        episode({ startedAt: '2026-07-11T10:00:00.000Z', endedAt: '2026-07-11T10:45:00.000Z' }),
      ),
    ).toBe('45 min')
  })

  it('rolls minutes into hours', () => {
    expect(
      episodeDurationLabel(
        episode({ startedAt: '2026-07-11T10:00:00.000Z', endedAt: '2026-07-11T12:10:00.000Z' }),
      ),
    ).toBe('2 hr 10 min')
  })

  it('drops a trailing zero-minute remainder', () => {
    expect(
      episodeDurationLabel(
        episode({ startedAt: '2026-07-11T10:00:00.000Z', endedAt: '2026-07-11T13:00:00.000Z' }),
      ),
    ).toBe('3 hr')
  })

  it('reports a sub-minute episode honestly', () => {
    expect(
      episodeDurationLabel(
        episode({ startedAt: '2026-07-11T10:00:00.000Z', endedAt: '2026-07-11T10:00:30.000Z' }),
      ),
    ).toBe('under a minute')
  })

  it('returns a dash when a timestamp is missing or unparseable', () => {
    expect(episodeDurationLabel(episode({ endedAt: null }))).toBe('Not available')
    expect(episodeDurationLabel(episode({ startedAt: 'not-a-date' }))).toBe('Not available')
  })
})

describe('episodeStepSummary', () => {
  it('pluralizes steps and files', () => {
    expect(episodeStepSummary(episode({ stepCount: 3, changedPathCount: 5 }))).toBe('3 steps · 5 files')
  })

  it('singularizes a lone step and file', () => {
    expect(episodeStepSummary(episode({ stepCount: 1, changedPathCount: 1 }))).toBe('1 step · 1 file')
  })
})

describe('episodeCompareHref', () => {
  it('builds a compare deep-link with the episode revision pair', () => {
    expect(episodeCompareHref('repo-a', episode({ fromRevision: 2, toRevision: 7 }))).toBe(
      '/codebases/repo-a/compare?from=2&to=7',
    )
  })

  it('encodes the codebase id', () => {
    expect(episodeCompareHref('a/b', episode({ fromRevision: 1, toRevision: 2 }))).toBe(
      '/codebases/a%2Fb/compare?from=1&to=2',
    )
  })

  it('returns null when a revision is missing', () => {
    expect(episodeCompareHref('repo-a', episode({ fromRevision: null }))).toBeNull()
  })

  it('returns null when the codebase id is absent', () => {
    expect(episodeCompareHref(null, episode())).toBeNull()
  })
})

describe('sortEpisodesNewestFirst', () => {
  it('orders by ending revision descending', () => {
    const ordered = sortEpisodesNewestFirst([
      episode({ episodeId: 'a', fromRevision: 1, toRevision: 2 }),
      episode({ episodeId: 'b', fromRevision: 5, toRevision: 9 }),
      episode({ episodeId: 'c', fromRevision: 3, toRevision: 4 }),
    ])
    expect(ordered.map((item) => item.episodeId)).toEqual(['b', 'c', 'a'])
  })

  it('does not mutate the input array', () => {
    const input = [
      episode({ episodeId: 'a', toRevision: 1 }),
      episode({ episodeId: 'b', toRevision: 2 }),
    ]
    sortEpisodesNewestFirst(input)
    expect(input.map((item) => item.episodeId)).toEqual(['a', 'b'])
  })
})

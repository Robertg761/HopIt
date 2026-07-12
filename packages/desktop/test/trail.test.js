import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FILE_STATE_META,
  fileStateMeta,
  buildStepCompareRange,
  enrichStepFromCompare,
  buildFileDiffView,
  unifiedDiffRows,
  createTrailCache,
  buildEpisodeCompareRange,
  mapEpisode,
  mapEpisodesResult,
  mapSummariesState,
  mapSummarizeResult,
  recentStepsBeyondEpisodes,
  EPISODE_UNLABELED_TEXT,
} from '../src/lib/trail.js'

// A directory-compare result shaped exactly like `hop compare --from --to --json`.
function dirCompare(entries, overrides = {}) {
  return {
    ok: true,
    leftRevision: 1,
    rightRevision: 3,
    retention: { min: 1, max: 3, retainedVersions: 7 },
    summary: {
      added: 1, modified: 1, deleted: 0, unchanged: 2,
      missingBlob: 0, integrityFailures: 0, requiresLocalKey: 0, binaryChanged: 0,
    },
    entries,
    ...overrides,
  }
}

function fileEntry(path, state, extra = {}) {
  return { path, state, kind: 'file', scope: 'shared', privacyZone: 'repo-content', left: null, right: null, ...extra }
}

// ---------------------------------------------------------------------------
// buildStepCompareRange
// ---------------------------------------------------------------------------

test('buildStepCompareRange uses the event span when present', () => {
  assert.deepEqual(buildStepCompareRange({ revision: 4437, fromRevision: 4436 }), { fromRevision: 4436, toRevision: 4437 })
  // A bulk commit spanning several revisions compares its true span.
  assert.deepEqual(buildStepCompareRange({ revision: 4436, fromRevision: 4412 }), { fromRevision: 4412, toRevision: 4436 })
})

test('buildStepCompareRange falls back to revision-1 for single-revision steps', () => {
  assert.deepEqual(buildStepCompareRange({ revision: 4437 }), { fromRevision: 4436, toRevision: 4437 })
  assert.deepEqual(buildStepCompareRange({ revision: 4437, fromRevision: null }), { fromRevision: 4436, toRevision: 4437 })
  // A nonsensical fromRevision (>= to) is ignored in favor of revision-1.
  assert.deepEqual(buildStepCompareRange({ revision: 10, fromRevision: 99 }), { fromRevision: 9, toRevision: 10 })
})

test('buildStepCompareRange clamps and rejects unusable rows', () => {
  assert.deepEqual(buildStepCompareRange({ revision: 1 }), { fromRevision: 0, toRevision: 1 })
  assert.equal(buildStepCompareRange({}), null)
  assert.equal(buildStepCompareRange({ revision: 'nope' }), null)
})

// ---------------------------------------------------------------------------
// enrichStepFromCompare
// ---------------------------------------------------------------------------

test('enrichStepFromCompare lists changed files, omits unchanged, and orders them', () => {
  const enriched = enrichStepFromCompare(dirCompare([
    fileEntry('z.ts', 'unchanged'),
    fileEntry('gone.ts', 'deleted'),
    fileEntry('b.ts', 'modified'),
    fileEntry('a.ts', 'added'),
    fileEntry('new.ts', 'added'),
  ]), { fromRevision: 1, toRevision: 3 })
  assert.equal(enriched.ok, true)
  assert.equal(enriched.status, 'ready')
  // unchanged is dropped; added group first (A→Z), then modified, then deleted.
  assert.deepEqual(enriched.files.map((f) => f.path), ['a.ts', 'new.ts', 'b.ts', 'gone.ts'])
  assert.deepEqual(enriched.files.map((f) => f.state), ['added', 'added', 'modified', 'deleted'])
  assert.equal(enriched.summary.unchanged, 2)
})

test('enrichStepFromCompare maps every per-file state to language and diffability', () => {
  const enriched = enrichStepFromCompare(dirCompare([
    fileEntry('add.ts', 'added'),
    fileEntry('mod.ts', 'modified'),
    fileEntry('del.ts', 'deleted'),
    fileEntry('logo.png', 'binary_changed', { kind: 'file' }),
    fileEntry('secret.md', 'requiresLocalKey'),
    fileEntry('gc.ts', 'missing_blob'),
    fileEntry('bad.ts', 'integrity_failure'),
  ]))
  const byPath = Object.fromEntries(enriched.files.map((f) => [f.path, f]))
  assert.equal(byPath['add.ts'].label, 'Added')
  assert.equal(byPath['add.ts'].diffable, true)
  assert.equal(byPath['del.ts'].label, 'Removed')
  assert.equal(byPath['logo.png'].label, 'Binary changed')
  assert.equal(byPath['logo.png'].tone, 'binary')
  // Honest states carry the required plain-language and are not offered as line diffs.
  assert.match(byPath['secret.md'].plainLanguage, /[Ee]ncrypted/)
  assert.equal(byPath['secret.md'].diffable, false)
  assert.match(byPath['gc.ts'].plainLanguage, /cleaned up/)
  assert.equal(byPath['gc.ts'].diffable, false)
  assert.match(byPath['bad.ts'].plainLanguage, /checksum/)
  assert.equal(byPath['bad.ts'].diffable, false)
})

test('enrichStepFromCompare marks a directory entry non-diffable even when modified', () => {
  const enriched = enrichStepFromCompare(dirCompare([fileEntry('src', 'modified', { kind: 'directory' })]))
  assert.equal(enriched.files[0].diffable, false)
})

test('enrichStepFromCompare reports empty when nothing changed', () => {
  const enriched = enrichStepFromCompare(dirCompare([fileEntry('a.ts', 'unchanged')]))
  assert.equal(enriched.ok, true)
  assert.equal(enriched.status, 'empty')
  assert.equal(enriched.files.length, 0)
})

test('enrichStepFromCompare surfaces revision_expired honestly', () => {
  const enriched = enrichStepFromCompare({
    ok: false,
    error: { code: 'revision_expired', message: 'Revision 0 or 99 is outside retained file-version history.' },
    retention: { min: 1, max: 3, retainedVersions: 7 },
    entries: [],
  })
  assert.equal(enriched.ok, false)
  assert.equal(enriched.status, 'expired')
  assert.match(enriched.message, /retained history/)
  assert.deepEqual(enriched.retention, { min: 1, max: 3, retainedVersions: 7 })
})

test('enrichStepFromCompare handles other errors and missing data', () => {
  const err = enrichStepFromCompare({ ok: false, error: { code: 'boom', message: 'kaboom' } })
  assert.equal(err.status, 'error')
  assert.equal(err.message, 'kaboom')
  const gone = enrichStepFromCompare(null)
  assert.equal(gone.status, 'unavailable')
  assert.equal(gone.files.length, 0)
})

// ---------------------------------------------------------------------------
// buildFileDiffView
// ---------------------------------------------------------------------------

function pathCompare(path, body, state = 'modified') {
  return dirCompare([{ ...fileEntry(path, state), body }])
}

test('buildFileDiffView renders a text diff into unified rows', () => {
  const view = buildFileDiffView(pathCompare('README.md', {
    state: 'text_diff',
    diff: {
      changed: true, leftLineCount: 3, rightLineCount: 5,
      commonPrefixLines: 3, commonSuffixLines: 0,
      addedLines: ['', 'Edited through the HopIt managed workspace folder.'],
      removedLines: [], addedLineCount: 2, removedLineCount: 0,
    },
  }), 'README.md')
  assert.equal(view.status, 'text')
  assert.deepEqual(view.stats, { added: 2, removed: 0 })
  // A prefix-context marker then the two added lines.
  assert.equal(view.lines[0].type, 'context')
  assert.match(view.lines[0].text, /3 unchanged lines above/)
  assert.equal(view.lines.at(-1).type, 'added')
})

test('buildFileDiffView maps binary, encrypted, missing, and integrity bodies', () => {
  const binary = buildFileDiffView(pathCompare('logo.png', { state: 'binary_changed', left: { size: 10 }, right: { size: 20 } }, 'binary_changed'), 'logo.png')
  assert.equal(binary.status, 'binary')
  assert.match(binary.message, /non-text file/)

  const locked = buildFileDiffView(pathCompare('secret.md', { state: 'requiresLocalKey' }, 'requiresLocalKey'), 'secret.md')
  assert.equal(locked.status, 'locked')
  assert.match(locked.message, /[Ee]ncrypted/)

  const missing = buildFileDiffView(pathCompare('gc.ts', { state: 'missing_blob' }), 'gc.ts')
  assert.equal(missing.status, 'missing_blob')
  assert.match(missing.message, /cleaned up/)

  const integrity = buildFileDiffView(pathCompare('bad.ts', { state: 'integrity_failure' }), 'bad.ts')
  assert.equal(integrity.status, 'integrity')
  assert.match(integrity.message, /checksum/)
})

test('buildFileDiffView handles metadata-only, missing entry, and expired', () => {
  const meta = buildFileDiffView(pathCompare('src', { state: 'metadata_only', reason: 'directory' }, 'modified'), 'src')
  assert.equal(meta.status, 'metadata')
  assert.match(meta.message, /directory/)

  const noBody = buildFileDiffView(pathCompare('a.ts', undefined), 'a.ts')
  assert.equal(noBody.status, 'metadata')

  const notThere = buildFileDiffView(dirCompare([]), 'ghost.ts')
  assert.equal(notThere.status, 'missing')

  const expired = buildFileDiffView({ ok: false, error: { code: 'revision_expired', message: 'x' } }, 'a.ts')
  assert.equal(expired.status, 'expired')

  const broken = buildFileDiffView(null, 'a.ts')
  assert.equal(broken.status, 'error')
})

test('unifiedDiffRows brackets changes with context markers and handles no-change', () => {
  const rows = unifiedDiffRows({
    changed: true, commonPrefixLines: 2, commonSuffixLines: 1,
    removedLines: ['old'], addedLines: ['new'],
  })
  assert.deepEqual(rows.map((r) => r.type), ['context', 'removed', 'added', 'context'])
  assert.match(rows[3].text, /1 unchanged line below/)

  const none = unifiedDiffRows({ changed: false, commonPrefixLines: 0, commonSuffixLines: 0, removedLines: [], addedLines: [] })
  assert.deepEqual(none, [{ type: 'context', text: 'No line changes.' }])
  assert.deepEqual(unifiedDiffRows(null), [])
})

test('fileStateMeta falls back safely for unknown states', () => {
  assert.equal(fileStateMeta('added'), FILE_STATE_META.added)
  const unknown = fileStateMeta('who_knows')
  assert.equal(unknown.label, 'Changed')
  assert.equal(unknown.diffable, true)
})

// ---------------------------------------------------------------------------
// Episode view model (hop trail episodes --json)
// ---------------------------------------------------------------------------

function rawEpisode(overrides = {}) {
  return {
    episodeId: 'ep_10_14',
    fromRevision: 10,
    toRevision: 14,
    deviceName: 'Robert’s MacBook',
    startedAt: '2026-07-11T10:00:00.000Z',
    endedAt: '2026-07-11T10:20:00.000Z',
    stepCount: 3,
    changedPathCount: 5,
    samplePaths: ['src/a.ts', 'src/b.ts'],
    label: null,
    labelModel: null,
    labelMode: null,
    ...overrides,
  }
}

test('buildEpisodeCompareRange compares the state just before the episode through its last revision', () => {
  // fromRevision is the FIRST revision inside the cluster, so the net diff starts at from-1.
  assert.deepEqual(buildEpisodeCompareRange({ fromRevision: 10, toRevision: 14 }), { fromRevision: 9, toRevision: 14 })
  // A single-revision episode still yields a usable pair (rev-1 -> rev).
  assert.deepEqual(buildEpisodeCompareRange({ fromRevision: 1, toRevision: 1 }), { fromRevision: 0, toRevision: 1 })
  // Never goes negative.
  assert.deepEqual(buildEpisodeCompareRange({ fromRevision: 0, toRevision: 0 }), { fromRevision: 0, toRevision: 0 })
  assert.equal(buildEpisodeCompareRange({ fromRevision: null, toRevision: 5 }), null)
  assert.equal(buildEpisodeCompareRange({}), null)
})

test('mapEpisode surfaces an honest placeholder for an unlabeled episode', () => {
  const ep = mapEpisode(rawEpisode())
  assert.equal(ep.labeled, false)
  assert.equal(ep.label, null)
  assert.equal(ep.labelText, EPISODE_UNLABELED_TEXT)
  assert.deepEqual(ep.range, { fromRevision: 9, toRevision: 14 })
  assert.equal(ep.deviceName, 'Robert’s MacBook')
  assert.equal(ep.stepCount, 3)
  assert.equal(ep.changedPathCount, 5)
})

test('mapEpisode keeps a real label and its model/mode when present', () => {
  const ep = mapEpisode(rawEpisode({ label: '  Refine the trail view  ', labelModel: 'claude-x', labelMode: 'metadata' }))
  assert.equal(ep.labeled, true)
  assert.equal(ep.label, 'Refine the trail view')
  assert.equal(ep.labelText, 'Refine the trail view')
  assert.equal(ep.labelModel, 'claude-x')
  assert.equal(ep.labelMode, 'metadata')
})

test('mapEpisodesResult orders newest-first and reports the max episodized revision', () => {
  const view = mapEpisodesResult({
    ok: true,
    codebaseId: 'hopit',
    episodeCount: 2,
    episodes: [rawEpisode({ episodeId: 'ep_1_4', fromRevision: 1, toRevision: 4 }), rawEpisode({ episodeId: 'ep_10_14', fromRevision: 10, toRevision: 14, label: 'Ship it' })],
  })
  assert.equal(view.ok, true)
  assert.equal(view.status, 'ready')
  assert.equal(view.episodes.length, 2)
  assert.equal(view.episodes[0].toRevision, 14) // newest first
  assert.equal(view.episodes[1].toRevision, 4)
  assert.equal(view.maxToRevision, 14)
  assert.equal(view.codebaseId, 'hopit')
})

test('mapEpisodesResult reports an empty state distinctly from an error', () => {
  const empty = mapEpisodesResult({ ok: true, codebaseId: 'hopit', episodeCount: 0, episodes: [] })
  assert.equal(empty.ok, true)
  assert.equal(empty.status, 'empty')
  assert.equal(empty.episodes.length, 0)
  assert.equal(empty.maxToRevision, null)
})

test('mapEpisodesResult reports engine errors honestly (not-ok and no-data)', () => {
  const notOk = mapEpisodesResult({ ok: false, error: { message: 'engine offline' } })
  assert.equal(notOk.ok, false)
  assert.equal(notOk.status, 'error')
  assert.match(notOk.message, /engine offline/)

  const noData = mapEpisodesResult(null)
  assert.equal(noData.ok, false)
  assert.equal(noData.status, 'error')
  assert.equal(noData.episodes.length, 0)
})

// ---------------------------------------------------------------------------
// Summaries state + summarize result
// ---------------------------------------------------------------------------

test('mapSummariesState reads on/off + mode from a dry-run probe', () => {
  assert.deepEqual(mapSummariesState({ ok: true, state: 'dry-run', mode: 'diff' }), { known: true, enabled: true, mode: 'diff', reason: null })
  assert.deepEqual(mapSummariesState({ ok: true, state: 'dry-run', mode: 'metadata' }), { known: true, enabled: true, mode: 'metadata', reason: null })
  // Unknown mode is coerced to metadata (the safe default).
  assert.equal(mapSummariesState({ ok: true, mode: 'weird' }).mode, 'metadata')

  const off = mapSummariesState({ ok: false, state: 'disabled', reason: 'Trail summaries are off for this codebase. Enable with: hop trail summaries on' })
  assert.equal(off.known, true)
  assert.equal(off.enabled, false)
  assert.match(off.reason, /off/)

  const unknown = mapSummariesState(null)
  assert.equal(unknown.known, false)
  assert.equal(unknown.enabled, false)
})

test('mapSummarizeResult is honest about labeled counts, the off state, and errors', () => {
  const ok = mapSummarizeResult({ ok: true, labeled: 2, mode: 'metadata', skippedByCap: 0 })
  assert.equal(ok.ok, true)
  assert.equal(ok.labeled, 2)
  assert.match(ok.message, /Labeled 2 episodes/)

  const capped = mapSummarizeResult({ ok: true, labeled: 1, mode: 'metadata', skippedByCap: 3 })
  assert.match(capped.message, /3 more remain/)

  const none = mapSummarizeResult({ ok: true, labeled: 0 })
  assert.match(none.message, /already labeled/)

  const disabled = mapSummarizeResult({ ok: false, state: 'disabled', reason: 'Trail summaries are off for this codebase.' })
  assert.equal(disabled.ok, false)
  assert.equal(disabled.disabled, true)

  // A thrown CLI error (e.g. missing key) arrives as stderr text with no JSON.
  const keyErr = mapSummarizeResult(null, 'MissingSummaryKeyError: set HOPIT_SUMMARY_API_KEY')
  assert.equal(keyErr.ok, false)
  assert.match(keyErr.message, /MissingSummaryKeyError/)
})

test('recentStepsBeyondEpisodes keeps only steps newer than the last episodized revision', () => {
  const rows = [{ revision: 16 }, { revision: 15 }, { revision: 14 }, { revision: 9 }]
  assert.deepEqual(recentStepsBeyondEpisodes(rows, 14), [{ revision: 16 }, { revision: 15 }])
  // With no episodes, every recent step qualifies.
  assert.deepEqual(recentStepsBeyondEpisodes(rows, null), rows)
  assert.deepEqual(recentStepsBeyondEpisodes([], 14), [])
})

// ---------------------------------------------------------------------------
// createTrailCache (fetch-once per revision pair per session)
// ---------------------------------------------------------------------------

test('createTrailCache fetches once for a key, concurrently and thereafter', async () => {
  const cache = createTrailCache()
  let calls = 0
  const fetcher = () => { calls += 1; return Promise.resolve({ value: calls }) }
  const key = cache.key('hopit', 1, 3)

  // Two concurrent requests share one in-flight fetch.
  const [a, b] = await Promise.all([cache.getOrFetch(key, fetcher), cache.getOrFetch(key, fetcher)])
  assert.equal(calls, 1)
  assert.deepEqual(a, b)

  // A later request returns the cached value without re-fetching.
  const c = await cache.getOrFetch(key, fetcher)
  assert.equal(calls, 1)
  assert.deepEqual(c, a)

  // A different revision pair (and a --path key) are cached independently.
  await cache.getOrFetch(cache.key('hopit', 1, 3, 'a.ts'), fetcher)
  await cache.getOrFetch(cache.key('hopit', 2, 4), fetcher)
  assert.equal(calls, 3)
})

test('createTrailCache evicts a rejected fetch so the user can retry', async () => {
  const cache = createTrailCache()
  let calls = 0
  const key = cache.key('hopit', 5, 6)
  await assert.rejects(() => cache.getOrFetch(key, () => { calls += 1; return Promise.reject(new Error('spawn failed')) }))
  assert.equal(cache.has(key), false)
  const value = await cache.getOrFetch(key, () => { calls += 1; return Promise.resolve('ok') })
  assert.equal(value, 'ok')
  assert.equal(calls, 2)
})

test('createTrailCache peek returns resolved values but not in-flight promises', async () => {
  const cache = createTrailCache()
  const key = cache.key('hopit', 1, 3)
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const inFlight = cache.getOrFetch(key, () => pending)
  // While the fetch is pending, peek must not hand back the raw promise.
  assert.equal(cache.peek(key), undefined)
  release({ done: true })
  await inFlight
  assert.deepEqual(cache.peek(key), { done: true })
})

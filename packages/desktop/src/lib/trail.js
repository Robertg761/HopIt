// @ts-check
// User-facing name for this view is "Trail". This module turns the WS7c compare
// engine's JSON (from `hop compare ... --json`) into the view model the Trail tab
// renders, and provides the fetch-once cache the renderer uses so opening a step
// never hammers the engine.
//
// Nothing here re-implements diffing: it only reshapes what `hop compare` already
// returns. The event journal (history.js) supplies the step list: real revision
// numbers, timestamps, and triggers: and this module enriches a step on demand
// with the real per-file change set, and a single file with its real line diff.
//
// The compare contract this maps (see docs/ws7c-object-backed-diff-history-design.md):
//   directory compare ->
//     { ok, leftRevision, rightRevision, retention:{min,max,retainedVersions},
//       summary:{added,modified,deleted,unchanged,missingBlob,integrityFailures,
//                requiresLocalKey,binaryChanged},
//       entries:[{ path, state, kind, scope, privacyZone, left, right }] }
//   --path compare -> the matching entry additionally carries `body`:
//     { state: 'text_diff', diff:{changed,commonPrefixLines,commonSuffixLines,
//                                 addedLines[],removedLines[],...} }
//     | { state:'binary_changed'|'binary_unchanged', left, right }
//     | { state:'requiresLocalKey' } | { state:'missing_blob' }
//     | { state:'integrity_failure' } | { state:'metadata_only', reason }
//   not-ok -> { ok:false, error:{code,message}, retention }
// The honest failure states (missing_blob, requiresLocalKey, integrity_failure,
// binary_changed, revision_expired) each get plain-language copy; we never invent
// content the engine could not produce.

/**
 * Per-file change states and how the Trail speaks about them. Language is
 * step/episode-flavored: no commit metaphors.
 * @type {Record<string, { label: string, tone: string, plain: string, diffable: boolean }>}
 */
export const FILE_STATE_META = {
  added: { label: 'Added', tone: 'added', plain: 'Added in this step.', diffable: true },
  modified: { label: 'Changed', tone: 'modified', plain: 'Edited in this step.', diffable: true },
  deleted: { label: 'Removed', tone: 'deleted', plain: 'Removed in this step.', diffable: true },
  unchanged: { label: 'Unchanged', tone: 'unchanged', plain: 'No change in this step.', diffable: false },
  binary_changed: {
    label: 'Binary changed',
    tone: 'binary',
    plain: 'A non-text file changed: HopIt shows its size, not a line diff.',
    diffable: true,
  },
  requiresLocalKey: {
    label: 'Encrypted',
    tone: 'locked',
    plain: 'Encrypted on this Mac only: its contents can’t be shown here.',
    diffable: false,
  },
  missing_blob: {
    label: 'Cleaned up',
    tone: 'missing',
    plain: 'This version’s content has been cleaned up and can no longer be shown.',
    diffable: false,
  },
  integrity_failure: {
    label: 'Integrity failed',
    tone: 'error',
    plain: 'This version’s stored content didn’t match its checksum, so it can’t be shown.',
    diffable: false,
  },
}

const DEFAULT_STATE_META = { label: 'Changed', tone: 'modified', plain: 'Edited in this step.', diffable: true }

/** Look up the language/tone for a compare state, with a safe fallback. */
export function fileStateMeta(state) {
  return FILE_STATE_META[state] ?? DEFAULT_STATE_META
}

/**
 * Choose the {from,to} revision pair to compare for a Trail step derived from the
 * event journal. Events that carry their own span (bulk commit, remote push) use
 * it exactly; single-revision events (a watch save, a refresh) compare the one
 * revision against the one before it. Returns null when the row has no usable
 * revision.
 * @param {{ revision?: unknown, fromRevision?: unknown }} row
 */
export function buildStepCompareRange(row) {
  const to = toSafeInt(row?.revision)
  if (to == null) return null
  const explicitFrom = toSafeInt(row?.fromRevision)
  const from = explicitFrom != null && explicitFrom < to ? explicitFrom : to - 1
  return { fromRevision: Math.max(0, from), toRevision: to }
}

/**
 * Choose the {from,to} revision pair for an episode's net directory compare.
 * An episode's `fromRevision` is the FIRST revision *inside* the cluster (see
 * clusterEpisodes/finalizeEpisode in @hopit/backend-d1), so to show everything
 * the episode changed we compare the state just BEFORE it (fromRevision-1) against
 * its last revision. This mirrors buildStepCompareRange's exclusive-left-edge
 * convention and lets an episode reuse the exact directory-compare machinery a
 * single step uses. Returns null when the episode carries no usable revisions.
 * @param {{ fromRevision?: unknown, toRevision?: unknown }} episode
 */
export function buildEpisodeCompareRange(episode) {
  const to = toSafeInt(episode?.toRevision)
  const first = toSafeInt(episode?.fromRevision)
  if (to == null || first == null) return null
  const base = Math.min(first - 1, to)
  return { fromRevision: Math.max(0, base), toRevision: to }
}

/** Copy used for an episode the summarizer has not labeled yet. */
export const EPISODE_UNLABELED_TEXT = '(not yet labeled)'

/**
 * Normalize one raw episode object (from `hop trail episodes --json`) into the
 * Trail card view model. `label` is null until the summarizer runs; we surface an
 * honest placeholder rather than inventing text.
 * @param {any} raw
 */
export function mapEpisode(raw) {
  const fromRevision = toSafeInt(raw?.fromRevision)
  const toRevision = toSafeInt(raw?.toRevision)
  const label = typeof raw?.label === 'string' && raw.label.trim() !== '' ? raw.label.trim() : null
  const samplePaths = Array.isArray(raw?.samplePaths) ? raw.samplePaths.filter((p) => typeof p === 'string') : []
  return {
    episodeId: typeof raw?.episodeId === 'string' && raw.episodeId ? raw.episodeId : `ep_${fromRevision}_${toRevision}`,
    fromRevision,
    toRevision,
    labeled: label != null,
    label,
    labelText: label ?? EPISODE_UNLABELED_TEXT,
    labelModel: typeof raw?.labelModel === 'string' ? raw.labelModel : null,
    labelMode: typeof raw?.labelMode === 'string' ? raw.labelMode : null,
    deviceName: typeof raw?.deviceName === 'string' && raw.deviceName ? raw.deviceName : null,
    startedAt: raw?.startedAt ?? null,
    endedAt: raw?.endedAt ?? null,
    stepCount: toSafeInt(raw?.stepCount) ?? 0,
    changedPathCount: toSafeInt(raw?.changedPathCount) ?? 0,
    samplePaths,
    range: buildEpisodeCompareRange(raw),
  }
}

/**
 * Turn `hop trail episodes --json` output into the Trail episode view model:
 * episodes newest-first, an honest empty/error status, and the highest episodized
 * revision so the renderer can show newer, not-yet-clustered steps separately.
 * @param {any} json
 */
export function mapEpisodesResult(json) {
  if (!json || typeof json !== 'object') {
    return { ok: false, status: 'error', message: 'The trail engine returned no episode data.', episodes: [], episodeCount: 0, maxToRevision: null }
  }
  if (json.ok === false) {
    return {
      ok: false,
      status: 'error',
      message: json.error?.message ?? json.reason ?? 'Trail episodes could not be loaded.',
      episodes: [],
      episodeCount: 0,
      maxToRevision: null,
    }
  }
  const rawList = Array.isArray(json.episodes) ? json.episodes : []
  const episodes = rawList.map(mapEpisode).sort((a, b) => (b.toRevision ?? -1) - (a.toRevision ?? -1))
  let maxToRevision = null
  for (const episode of episodes) {
    if (episode.toRevision != null && (maxToRevision == null || episode.toRevision > maxToRevision)) {
      maxToRevision = episode.toRevision
    }
  }
  return {
    ok: true,
    status: episodes.length ? 'ready' : 'empty',
    codebaseId: typeof json.codebaseId === 'string' ? json.codebaseId : null,
    episodes,
    episodeCount: toSafeInt(json.episodeCount) ?? episodes.length,
    maxToRevision,
  }
}

/**
 * Interpret a `hop trail summarize --dry-run --json` probe as the per-codebase
 * summaries setting. A dry run never touches the provider (no API key needed and
 * nothing is sent), so it is a safe read of on/off + mode:
 *   off  -> { ok:false, state:'disabled', reason }
 *   on   -> { ok:true, mode:'metadata'|'diff', ... }
 * A missing/garbled result is reported as unknown so the UI stays honest.
 * @param {any} json
 */
export function mapSummariesState(json) {
  if (!json || typeof json !== 'object') {
    return { known: false, enabled: false, mode: null, reason: 'Summaries state is unavailable right now.' }
  }
  if (json.ok === false && json.state === 'disabled') {
    return { known: true, enabled: false, mode: null, reason: json.reason ?? 'Trail summaries are off for this project.' }
  }
  if (json.ok === false) {
    return { known: false, enabled: false, mode: null, reason: json.error?.message ?? json.reason ?? 'Summaries state is unavailable right now.' }
  }
  return { known: true, enabled: true, mode: json.mode === 'diff' ? 'diff' : 'metadata', reason: null }
}

/**
 * Interpret the result of a real `hop trail summarize --json` run (the "Summarize
 * now" action) for the UI. Honest about the off state and any provider error.
 * @param {any} json
 * @param {string|null} [errorText] stderr surfaced when the CLI threw (e.g. missing key)
 */
export function mapSummarizeResult(json, errorText = null) {
  if (!json || typeof json !== 'object') {
    return { ok: false, message: errorText?.trim() || 'The summarizer returned no result.' }
  }
  if (json.ok === false) {
    if (json.state === 'disabled') {
      return { ok: false, disabled: true, message: json.reason ?? 'Trail summaries are off for this project.' }
    }
    return { ok: false, message: json.error?.message ?? json.reason ?? (errorText?.trim() || 'Summarizing failed.') }
  }
  const labeled = toSafeInt(json.labeled) ?? 0
  const skippedByCap = toSafeInt(json.skippedByCap) ?? 0
  return {
    ok: true,
    labeled,
    mode: typeof json.mode === 'string' ? json.mode : null,
    skippedByCap,
    message: labeled > 0
      ? `Labeled ${labeled} episode${labeled === 1 ? '' : 's'}${skippedByCap > 0 ? ` (${skippedByCap} more remain: run again)` : ''}.`
      : 'Every episode is already labeled.',
  }
}

/**
 * Split event-derived recent steps (history.js rows) into those newer than the
 * newest episodized revision: episodes are clustered from cloud history and can
 * lag the local event window: so they can be shown in a "recent, not yet
 * episodized" section. With no episodes (or no max), every recent step qualifies.
 * @param {Array<{ revision?: unknown }>} rows
 * @param {number|null} maxEpisodizedRevision
 */
export function recentStepsBeyondEpisodes(rows, maxEpisodizedRevision) {
  const list = Array.isArray(rows) ? rows : []
  if (maxEpisodizedRevision == null) return [...list]
  return list.filter((row) => {
    const rev = toSafeInt(row?.revision)
    return rev != null && rev > maxEpisodizedRevision
  })
}

const EMPTY_SUMMARY = Object.freeze({
  added: 0,
  modified: 0,
  deleted: 0,
  unchanged: 0,
  missingBlob: 0,
  integrityFailures: 0,
  requiresLocalKey: 0,
  binaryChanged: 0,
})

/**
 * Turn a directory-compare JSON result into the expansion view model for one
 * Trail step: a list of changed files (unchanged omitted: a directory compare
 * lists every visible path, and the Trail only shows what moved) plus honest
 * loading/expired/error status.
 * @param {any} compareJson
 * @param {{ fromRevision?: number, toRevision?: number }} [range]
 */
export function enrichStepFromCompare(compareJson, range = {}) {
  if (!compareJson || typeof compareJson !== 'object') {
    return {
      ok: false,
      status: 'unavailable',
      message: 'The compare engine returned no data for this step.',
      files: [],
      summary: { ...EMPTY_SUMMARY },
      range,
      retention: null,
    }
  }
  if (compareJson.ok === false) {
    const code = compareJson.error?.code ?? 'error'
    if (code === 'revision_expired') {
      return {
        ok: false,
        status: 'expired',
        message:
          'The versions before this step are outside the retained history, so its file changes can’t be reconstructed.',
        files: [],
        summary: { ...EMPTY_SUMMARY },
        range,
        retention: compareJson.retention ?? null,
      }
    }
    return {
      ok: false,
      status: 'error',
      message: compareJson.error?.message ?? 'This step could not be compared.',
      files: [],
      summary: { ...EMPTY_SUMMARY },
      range,
      retention: compareJson.retention ?? null,
    }
  }

  const entries = Array.isArray(compareJson.entries) ? compareJson.entries : []
  const files = entries
    .filter((entry) => entry && typeof entry.path === 'string' && entry.state !== 'unchanged')
    .map(fileRowFromEntry)
    .sort(byStateThenPath)
  return {
    ok: true,
    status: files.length ? 'ready' : 'empty',
    files,
    summary: normalizeSummary(compareJson.summary),
    range,
    retention: compareJson.retention ?? null,
  }
}

/** Order in the file list: added, then changed/binary/encrypted/etc, then removed; path A→Z within a group. */
const STATE_ORDER = { added: 0, modified: 1, binary_changed: 1, requiresLocalKey: 1, missing_blob: 1, integrity_failure: 1, deleted: 2 }
function byStateThenPath(a, b) {
  const oa = STATE_ORDER[a.state] ?? 1
  const ob = STATE_ORDER[b.state] ?? 1
  if (oa !== ob) return oa - ob
  return a.path.localeCompare(b.path)
}

function fileRowFromEntry(entry) {
  const meta = fileStateMeta(entry.state)
  const kind = entry.kind ?? 'file'
  return {
    path: entry.path,
    state: entry.state,
    label: meta.label,
    tone: meta.tone,
    plainLanguage: meta.plain,
    // Only real files with a resolvable body are worth opening a line diff for.
    diffable: meta.diffable && kind === 'file',
    kind,
    scope: entry.scope ?? null,
    privacyZone: entry.privacyZone ?? null,
    sizeBefore: toSafeInt(entry.left?.size),
    sizeAfter: toSafeInt(entry.right?.size),
  }
}

/**
 * Turn a `--path` compare result into the inline-diff view model for one file.
 * Every engine body state maps to an honest, renderable shape.
 * @param {any} compareJson
 * @param {string} path
 */
export function buildFileDiffView(compareJson, path) {
  if (!compareJson || typeof compareJson !== 'object') {
    return { status: 'error', state: null, message: 'The compare engine returned no data for this file.' }
  }
  if (compareJson.ok === false) {
    const code = compareJson.error?.code
    if (code === 'revision_expired') {
      return {
        status: 'expired',
        state: 'revision_expired',
        message: 'The version before this step is no longer retained, so this file can’t be shown.',
      }
    }
    return { status: 'error', state: null, message: compareJson.error?.message ?? 'This file could not be compared.' }
  }

  const entry = (Array.isArray(compareJson.entries) ? compareJson.entries : []).find((candidate) => candidate?.path === path)
  if (!entry) return { status: 'missing', state: null, message: 'That file is not part of this step.' }

  const body = entry.body
  if (!body || typeof body !== 'object') {
    // A directory compare (no --path) has no body; treat as metadata-only.
    return { status: 'metadata', state: entry.state, message: fileStateMeta(entry.state).plain }
  }

  switch (body.state) {
    case 'text_diff':
      return {
        status: 'text',
        state: entry.state,
        lines: unifiedDiffRows(body.diff),
        stats: {
          added: toSafeInt(body.diff?.addedLineCount) ?? 0,
          removed: toSafeInt(body.diff?.removedLineCount) ?? 0,
        },
      }
    case 'binary_changed':
    case 'binary_unchanged':
      return {
        status: 'binary',
        state: 'binary_changed',
        message: fileStateMeta('binary_changed').plain,
        left: body.left ?? null,
        right: body.right ?? null,
      }
    case 'requiresLocalKey':
      return { status: 'locked', state: 'requiresLocalKey', message: fileStateMeta('requiresLocalKey').plain }
    case 'missing_blob':
      return { status: 'missing_blob', state: 'missing_blob', message: fileStateMeta('missing_blob').plain }
    case 'integrity_failure':
      return { status: 'integrity', state: 'integrity_failure', message: fileStateMeta('integrity_failure').plain }
    case 'metadata_only':
      return {
        status: 'metadata',
        state: entry.state,
        message: `This is a ${body.reason ?? entry.kind ?? 'non-file'}: there’s no line diff to show.`,
      }
    default:
      return { status: 'unknown', state: entry.state, message: 'This file’s change can’t be displayed as a line diff.' }
  }
}

/**
 * Build renderable unified-diff rows from the compare engine's line-diff summary.
 * The engine reports common prefix/suffix line *counts* (not the surrounding text)
 * plus the exact removed/added line slices, so we render the changed region and
 * mark how many unchanged lines sit above/below: honest about what we do and
 * don't have.
 * @param {any} diff
 */
export function unifiedDiffRows(diff) {
  if (!diff || typeof diff !== 'object') return []
  const rows = []
  const prefix = toSafeInt(diff.commonPrefixLines) ?? 0
  const suffix = toSafeInt(diff.commonSuffixLines) ?? 0
  const removed = Array.isArray(diff.removedLines) ? diff.removedLines : []
  const added = Array.isArray(diff.addedLines) ? diff.addedLines : []
  if (prefix > 0) rows.push({ type: 'context', text: unchangedLabel(prefix, 'above') })
  for (const line of removed) rows.push({ type: 'removed', text: String(line) })
  for (const line of added) rows.push({ type: 'added', text: String(line) })
  if (suffix > 0) rows.push({ type: 'context', text: unchangedLabel(suffix, 'below') })
  if (removed.length === 0 && added.length === 0 && !diff.changed) {
    rows.push({ type: 'context', text: 'No line changes.' })
  }
  return rows
}

function unchangedLabel(count, where) {
  return `… ${count} unchanged line${count === 1 ? '' : 's'} ${where}`
}

function normalizeSummary(summary) {
  if (!summary || typeof summary !== 'object') return { ...EMPTY_SUMMARY }
  return {
    added: toSafeInt(summary.added) ?? 0,
    modified: toSafeInt(summary.modified) ?? 0,
    deleted: toSafeInt(summary.deleted) ?? 0,
    unchanged: toSafeInt(summary.unchanged) ?? 0,
    missingBlob: toSafeInt(summary.missingBlob) ?? 0,
    integrityFailures: toSafeInt(summary.integrityFailures) ?? 0,
    requiresLocalKey: toSafeInt(summary.requiresLocalKey) ?? 0,
    binaryChanged: toSafeInt(summary.binaryChanged) ?? 0,
  }
}

/**
 * A fetch-once cache keyed by (codebaseId, from, to, path?). The Trail fetches a
 * step's compare on expand and a file's diff on click, once per session: the 5s
 * status poll never touches it. In-flight promises are memoized so a double-click
 * cannot spawn two `hop compare` processes; a rejected fetch is evicted so the
 * user can retry.
 */
export function createTrailCache() {
  /** @type {Map<string, any>} */
  const store = new Map()
  return {
    key(codebaseId, fromRevision, toRevision, path) {
      return [codebaseId, fromRevision, toRevision, path ?? ''].join(' ')
    },
    has(key) {
      return store.has(key)
    },
    peek(key) {
      const value = store.get(key)
      // A memoized in-flight promise is not a resolved value.
      return value && typeof value.then === 'function' ? undefined : value
    },
    set(key, value) {
      store.set(key, value)
      return value
    },
    async getOrFetch(key, fetcher) {
      if (store.has(key)) return store.get(key)
      const promise = Promise.resolve().then(() => fetcher())
      store.set(key, promise)
      try {
        const value = await promise
        store.set(key, value)
        return value
      } catch (error) {
        store.delete(key)
        throw error
      }
    },
    clear() {
      store.clear()
    },
    get size() {
      return store.size
    },
  }
}

function toSafeInt(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

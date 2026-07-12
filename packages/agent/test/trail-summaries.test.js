import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildEpisodePayload, sanitizeLabel, MAX_LABEL_TOKENS } from '../src/summaries/payload.js'
import { resolveSummaryConfig } from '../src/summaries/config.js'
import {
  createSummarizerProvider,
  createStubProvider,
  createOpenAiProvider,
  createGeminiProvider,
  MissingSummaryKeyError,
} from '../src/summaries/provider.js'
import { summarizeEpisodes } from '../src/summaries/summarize.js'

const EPISODE = {
  episodeId: 'ep_1_3',
  fromRevision: 1,
  toRevision: 3,
  deviceName: 'Laptop',
  startedAt: '2026-07-12T09:00:00.000Z',
  endedAt: '2026-07-12T09:20:00.000Z',
  stepCount: 3,
  changedPathCount: 4,
  samplePaths: ['src/auth/login.js', 'src/auth/session.js'],
}

const METADATA_KEYS = new Set([
  'mode',
  'device',
  'fromRevision',
  'toRevision',
  'startedAt',
  'endedAt',
  'stepCount',
  'changedPathCount',
  'samplePaths',
])

function fakeService({ enabled, mode = 'metadata', episodes = [], stored = [], compareRevisions } = {}) {
  const upserts = []
  const service = {
    upserts,
    async computeTrailEpisodes() {
      return episodes
    },
    async listTrailEpisodes() {
      return stored
    },
    async upsertTrailEpisode(_codebaseId, episode) {
      upserts.push(episode)
      return { ok: true }
    },
    async readCodebaseSettings() {
      return { codebaseId: 'demo', trailSummariesEnabled: enabled, trailSummariesMode: mode }
    },
  }
  if (compareRevisions) service.compareRevisions = compareRevisions
  return service
}

const throwingProvider = {
  provider: 'openai',
  model: 'gpt-5.4-mini',
  requiresKey: true,
  label() {
    throw new Error('provider.label must not be called')
  },
}

// -------------------------------------------------------------------------
// Payload contract
// -------------------------------------------------------------------------

test('metadata payload contains only paths/counts/timestamps/device — never file contents', () => {
  const payload = buildEpisodePayload(EPISODE, { mode: 'metadata', diffText: 'SECRET FILE BODY' })
  for (const key of Object.keys(payload)) assert.ok(METADATA_KEYS.has(key), `unexpected key ${key}`)
  assert.equal(payload.mode, 'metadata')
  assert.equal('diff' in payload, false)
  assert.equal(JSON.stringify(payload).includes('SECRET FILE BODY'), false)
})

test('diff-mode payload is bounded to diffMaxChars', () => {
  const longDiff = '+'.repeat(50000)
  const payload = buildEpisodePayload(EPISODE, { mode: 'diff', diffText: longDiff, diffMaxChars: 1000 })
  assert.equal(payload.mode, 'diff')
  assert.ok(typeof payload.diff === 'string')
  assert.ok(payload.diff.length <= 1000 + 64, `diff length ${payload.diff.length} exceeds bound`)
  assert.ok(payload.diff.includes('truncated'))
})

test('sanitizeLabel clamps model output to one terse line within the token budget', () => {
  const noisy = `"${'word '.repeat(40)}"\n\nsecond line`
  const label = sanitizeLabel(noisy)
  assert.ok(!label.includes('\n'))
  assert.ok(label.split(/\s+/).length <= MAX_LABEL_TOKENS)
})

// -------------------------------------------------------------------------
// Provider selection / swap
// -------------------------------------------------------------------------

test('resolveSummaryConfig defaults to OpenAI gpt-5.4-mini', () => {
  const config = resolveSummaryConfig({}, {})
  assert.equal(config.provider, 'openai')
  assert.equal(config.model, 'gpt-5.4-mini')
})

test('provider swap via env selects Gemini flash-lite with the right endpoint default', () => {
  const config = resolveSummaryConfig({}, { HOPIT_SUMMARY_PROVIDER: 'gemini' })
  assert.equal(config.provider, 'gemini')
  assert.equal(config.model, 'gemini-2.5-flash-lite')
  const provider = createSummarizerProvider(config)
  assert.equal(provider.provider, 'gemini')
  assert.equal(provider.model, 'gemini-2.5-flash-lite')
})

test('CLI flags override env for provider and model', () => {
  const config = resolveSummaryConfig(
    { 'summary-provider': 'gemini', 'summary-model': 'gemini-custom' },
    { HOPIT_SUMMARY_PROVIDER: 'openai' },
  )
  assert.equal(config.provider, 'gemini')
  assert.equal(config.model, 'gemini-custom')
})

test('createSummarizerProvider rejects an unknown provider', () => {
  assert.throws(() => createSummarizerProvider({ provider: 'nope' }), /Unknown summary provider/)
})

test('stub provider needs no key; real providers require one', () => {
  assert.equal(createStubProvider({}).requiresKey, false)
  assert.equal(createOpenAiProvider({}).requiresKey, true)
  assert.equal(createGeminiProvider({}).requiresKey, true)
})

// -------------------------------------------------------------------------
// Missing key
// -------------------------------------------------------------------------

test('openai provider throws an honest missing-key error naming the env var', async () => {
  const provider = createOpenAiProvider({ apiKey: null, apiKeyEnv: 'HOPIT_SUMMARY_API_KEY (or OPENAI_API_KEY)' })
  await assert.rejects(
    () => provider.label(EPISODE, { mode: 'metadata' }),
    (error) => {
      assert.ok(error instanceof MissingSummaryKeyError)
      assert.match(error.message, /HOPIT_SUMMARY_API_KEY/)
      return true
    },
  )
})

// -------------------------------------------------------------------------
// Stub provider labels
// -------------------------------------------------------------------------

test('stub provider produces a deterministic terse label from metadata only', async () => {
  const provider = createStubProvider({})
  const first = await provider.label(EPISODE, { mode: 'metadata' })
  const second = await provider.label(EPISODE, { mode: 'metadata' })
  assert.deepEqual(first, second)
  assert.equal(first.model, 'stub')
  assert.ok(first.label.split(/\s+/).length <= MAX_LABEL_TOKENS)
  assert.equal(/commit|branch|pull request/i.test(first.label), false)
  assert.match(first.label, /src\/auth/)
})

// -------------------------------------------------------------------------
// Opt-in enforcement (the load-bearing privacy rule)
// -------------------------------------------------------------------------

test('summarize is impossible when opt-in is OFF: the provider is never called', async () => {
  const service = fakeService({ enabled: false, episodes: [EPISODE] })
  const result = await summarizeEpisodes({
    service,
    codebaseId: 'demo',
    settings: { trailSummariesEnabled: false, trailSummariesMode: 'metadata' },
    provider: throwingProvider, // would throw if reached
  })
  assert.equal(result.ok, false)
  assert.equal(result.state, 'disabled')
  assert.equal(result.labeled, 0)
  assert.equal(service.upserts.length, 0)
})

test('summarize labels unlabeled episodes and persists labels when opt-in is ON', async () => {
  const service = fakeService({ enabled: true, episodes: [EPISODE], stored: [] })
  const result = await summarizeEpisodes({
    service,
    codebaseId: 'demo',
    settings: { trailSummariesEnabled: true, trailSummariesMode: 'metadata' },
    provider: createStubProvider({}),
  })
  assert.equal(result.ok, true)
  assert.equal(result.state, 'summarized')
  assert.equal(result.labeled, 1)
  assert.equal(service.upserts.length, 1)
  assert.equal(service.upserts[0].labelModel, 'stub')
  assert.equal(service.upserts[0].labelMode, 'metadata')
  assert.ok(service.upserts[0].label.length > 0)
})

test('summarize skips already-labeled episodes', async () => {
  const service = fakeService({
    enabled: true,
    episodes: [EPISODE],
    stored: [{ episodeId: 'ep_1_3', label: 'already labeled' }],
  })
  const result = await summarizeEpisodes({
    service,
    codebaseId: 'demo',
    settings: { trailSummariesEnabled: true, trailSummariesMode: 'metadata' },
    provider: throwingProvider,
  })
  assert.equal(result.labeled, 0)
  assert.equal(service.upserts.length, 0)
})

test('dry-run builds payloads but sends nothing and persists nothing', async () => {
  const service = fakeService({ enabled: true, episodes: [EPISODE], stored: [] })
  const result = await summarizeEpisodes({
    service,
    codebaseId: 'demo',
    settings: { trailSummariesEnabled: true, trailSummariesMode: 'metadata' },
    provider: throwingProvider, // must not be called during a dry run
    dryRun: true,
  })
  assert.equal(result.state, 'dry-run')
  assert.equal(result.labeled, 0)
  assert.equal(result.payloads.length, 1)
  assert.equal(result.payloads[0].payload.mode, 'metadata')
  assert.equal('diff' in result.payloads[0].payload, false)
  assert.equal(service.upserts.length, 0)
})

test('diff mode must be an explicit opt-in beyond turning summaries on', async () => {
  await assert.rejects(
    () =>
      summarizeEpisodes({
        service: fakeService({ enabled: true, episodes: [EPISODE] }),
        codebaseId: 'demo',
        settings: { trailSummariesEnabled: true, trailSummariesMode: 'metadata' },
        provider: createStubProvider({}),
        mode: 'diff',
      }),
    /separate opt-in/,
  )
})

test('diff mode assembles a bounded diff payload via the compare engine', async () => {
  const compareRevisions = async (_from, _to, request) => ({
    ok: true,
    entries: [
      {
        path: request.path,
        body: { state: 'text_diff', diff: { addedLines: ['new line'], removedLines: ['old line'] } },
      },
    ],
  })
  const service = fakeService({
    enabled: true,
    mode: 'diff',
    episodes: [EPISODE],
    stored: [],
    compareRevisions,
  })
  const result = await summarizeEpisodes({
    service,
    codebaseId: 'demo',
    settings: { trailSummariesEnabled: true, trailSummariesMode: 'diff' },
    provider: createStubProvider({}),
    diffMaxChars: 500,
    dryRun: true,
  })
  assert.equal(result.mode, 'diff')
  const payload = result.payloads[0].payload
  assert.equal(payload.mode, 'diff')
  assert.ok(payload.diff.includes('+new line'))
  assert.ok(payload.diff.includes('-old line'))
  assert.ok(payload.diff.length <= 500 + 64)
})

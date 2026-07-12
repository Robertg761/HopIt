// @ts-check
import { withCloudFetchRetry } from '../cloud-retry.js'
import { buildEpisodePayload, buildPrompt, sanitizeLabel } from './payload.js'

// A thin, provider-agnostic summarizer interface. Each adapter exposes the same
// shape: `{ provider, model, requiresKey, label(episode, { mode, diffText }) }`.
// The payload/prompt contract and the metadata/diff privacy boundary live in
// payload.js, shared by every adapter, so a model swap is a config change.

export class MissingSummaryKeyError extends Error {
  constructor(provider, apiKeyEnv) {
    super(`No API key for the ${provider} summary provider. Set ${apiKeyEnv} to summarize, or run with --dry-run to inspect the payload without sending it.`)
    this.name = 'MissingSummaryKeyError'
    this.code = 'summary_api_key_missing'
    this.provider = provider
    this.apiKeyEnv = apiKeyEnv
  }
}

export function createSummarizerProvider(config = {}) {
  switch (config.provider) {
    case 'stub':
      return createStubProvider(config)
    case 'openai':
      return createOpenAiProvider(config)
    case 'gemini':
      return createGeminiProvider(config)
    default:
      throw new Error(`Unknown summary provider: ${config.provider}. Set HOPIT_SUMMARY_PROVIDER to openai, gemini, or stub.`)
  }
}

// -------------------------------------------------------------------------
// Deterministic stub — no network, used in every test. Produces a readable
// label purely from episode metadata.
// -------------------------------------------------------------------------

export function createStubProvider(config = {}) {
  const model = config.model || 'stub'
  return {
    provider: 'stub',
    model,
    requiresKey: false,
    async label(episode, { mode = 'metadata' } = {}) {
      const payload = buildEpisodePayload(episode, { mode, diffText: null })
      return { label: sanitizeLabel(stubLabel(payload)), model }
    },
  }
}

function stubLabel(payload) {
  const area = commonArea(payload.samplePaths)
  const files = `${payload.changedPathCount} file${payload.changedPathCount === 1 ? '' : 's'}`
  const steps = `${payload.stepCount} step${payload.stepCount === 1 ? '' : 's'}`
  const scope = area ? `under ${area}` : 'across the workspace'
  return `Worked ${scope} — ${files}, ${steps}`
}

function commonArea(samplePaths) {
  if (!Array.isArray(samplePaths) || samplePaths.length === 0) return null
  const segments = samplePaths.map((p) => String(p).split('/'))
  if (segments.length === 1) {
    return segments[0].length > 1 ? segments[0].slice(0, -1).join('/') : segments[0][0]
  }
  const prefix = []
  for (let i = 0; ; i += 1) {
    const seg = segments[0][i]
    if (seg === undefined) break
    if (segments.every((parts) => parts[i] === seg) && i < segments[0].length - 1) prefix.push(seg)
    else break
  }
  return prefix.length > 0 ? prefix.join('/') : null
}

// -------------------------------------------------------------------------
// OpenAI adapter (default: gpt-5.4-mini, chat/completions shape).
// -------------------------------------------------------------------------

export function createOpenAiProvider(config = {}) {
  const model = config.model || 'gpt-5.4-mini'
  return {
    provider: 'openai',
    model,
    requiresKey: true,
    async label(episode, { mode = 'metadata', diffText = null } = {}) {
      if (!config.apiKey) throw new MissingSummaryKeyError('openai', config.apiKeyEnv ?? 'HOPIT_SUMMARY_API_KEY')
      const payload = buildEpisodePayload(episode, { mode, diffText, diffMaxChars: config.diffMaxChars })
      const { system, user } = buildPrompt(payload)
      const url = `${(config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')}/chat/completions`
      const body = {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_completion_tokens: 48,
        temperature: 0,
      }
      const text = await withCloudFetchRetry(
        () => postJson(url, body, { Authorization: `Bearer ${config.apiKey}` }, config.timeoutMs),
        { attempts: config.retries ?? 3 },
      )
      return { label: sanitizeLabel(extractOpenAiText(text)), model }
    },
  }
}

function extractOpenAiText(body) {
  return body?.choices?.[0]?.message?.content ?? ''
}

// -------------------------------------------------------------------------
// Gemini adapter (fallback: gemini-2.5-flash-lite, generateContent shape).
// -------------------------------------------------------------------------

export function createGeminiProvider(config = {}) {
  const model = config.model || 'gemini-2.5-flash-lite'
  return {
    provider: 'gemini',
    model,
    requiresKey: true,
    async label(episode, { mode = 'metadata', diffText = null } = {}) {
      if (!config.apiKey) throw new MissingSummaryKeyError('gemini', config.apiKeyEnv ?? 'HOPIT_SUMMARY_API_KEY')
      const payload = buildEpisodePayload(episode, { mode, diffText, diffMaxChars: config.diffMaxChars })
      const { system, user } = buildPrompt(payload)
      const base = (config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '')
      const url = `${base}/models/${encodeURIComponent(model)}:generateContent`
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 48 },
      }
      const text = await withCloudFetchRetry(
        () => postJson(url, body, { 'x-goog-api-key': config.apiKey }, config.timeoutMs),
        { attempts: config.retries ?? 3 },
      )
      return { label: sanitizeLabel(extractGeminiText(text)), model }
    },
  }
}

function extractGeminiText(body) {
  const parts = body?.candidates?.[0]?.content?.parts ?? []
  return parts.map((part) => part?.text ?? '').join('')
}

// -------------------------------------------------------------------------
// Shared HTTP with a hard timeout. Errors carry `status` so cloud-retry.js
// classifies 4xx (auth/validation) as non-transient and 429/5xx as retryable.
// -------------------------------------------------------------------------

async function postJson(url, body, headers, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000)
  timer.unref?.()
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      const error = new Error(`Summary provider request failed (${response.status}): ${text.slice(0, 400)}`)
      // @ts-ignore - attach status for cloud-retry classification
      error.status = response.status
      throw error
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('Summary provider returned a non-JSON response.')
    }
  } finally {
    clearTimeout(timer)
  }
}

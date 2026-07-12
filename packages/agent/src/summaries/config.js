// @ts-check
import { DEFAULT_DIFF_MAX_CHARS } from './payload.js'

// Model ids and endpoints are CONFIG, not constants: the pricing/availability
// landscape moves weekly, and the roadmap's "local model later" is just another
// adapter. Defaults below reflect the owner's 2026-07-12 decision — OpenAI
// gpt-5.4-mini default, Gemini 2.5 flash-lite pre-wired fallback — but every one
// is overridable by env or CLI flag.

export const DEFAULT_PROVIDER = 'openai'

export const PROVIDER_DEFAULTS = {
  openai: {
    model: 'gpt-5.4-mini',
    baseUrl: 'https://api.openai.com/v1',
  },
  gemini: {
    model: 'gemini-2.5-flash-lite',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },
  stub: {
    model: 'stub',
    baseUrl: null,
  },
}

export const DEFAULT_TIMEOUT_MS = 15000
export const DEFAULT_MAX_EPISODES = 50
export const DEFAULT_RETRIES = 3

/**
 * Resolve the summarizer configuration from CLI options then environment.
 * @param {Record<string, any>} [options]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveSummaryConfig(options = {}, env = process.env) {
  const provider = String(
    options['summary-provider'] ?? env.HOPIT_SUMMARY_PROVIDER ?? DEFAULT_PROVIDER,
  ).toLowerCase()
  const defaults = PROVIDER_DEFAULTS[provider] ?? {}
  const model = firstString(options['summary-model'], env.HOPIT_SUMMARY_MODEL) ?? defaults.model ?? null
  const baseUrl = firstString(options['summary-base-url'], env.HOPIT_SUMMARY_BASE_URL) ?? defaults.baseUrl ?? null
  const apiKey = firstString(
    options['summary-api-key'],
    env.HOPIT_SUMMARY_API_KEY,
    provider === 'openai' ? env.OPENAI_API_KEY : null,
    provider === 'gemini' ? env.GEMINI_API_KEY : null,
  )

  return {
    provider,
    model,
    baseUrl,
    apiKey: apiKey ?? null,
    apiKeyEnv: apiKeyEnvName(provider),
    timeoutMs: intOr(options['summary-timeout-ms'] ?? env.HOPIT_SUMMARY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxEpisodes: intOr(options['summary-max-episodes'] ?? env.HOPIT_SUMMARY_MAX_EPISODES, DEFAULT_MAX_EPISODES),
    diffMaxChars: intOr(options['summary-diff-max-chars'] ?? env.HOPIT_SUMMARY_DIFF_MAX_CHARS, DEFAULT_DIFF_MAX_CHARS),
    retries: intOr(options['summary-retries'] ?? env.HOPIT_SUMMARY_RETRIES, DEFAULT_RETRIES),
  }
}

export function apiKeyEnvName(provider) {
  if (provider === 'openai') return 'HOPIT_SUMMARY_API_KEY (or OPENAI_API_KEY)'
  if (provider === 'gemini') return 'HOPIT_SUMMARY_API_KEY (or GEMINI_API_KEY)'
  return 'HOPIT_SUMMARY_API_KEY'
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

function intOr(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

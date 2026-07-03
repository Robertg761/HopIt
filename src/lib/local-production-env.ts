import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const productionEnvPath = path.join(os.homedir(), '.config/hopit/production.env')

const productionBackendKeys = new Set([
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'HOPIT_AGENT_SESSION_CAPABILITIES',
  'HOPIT_AGENT_SESSION_TOKEN',
  'HOPIT_CLOUD_BACKEND',
  'HOPIT_CODEBASE_ID',
  'HOPIT_D1_ASSUME_SCHEMA',
  'HOPIT_D1_ACCOUNT_ID',
  'HOPIT_D1_API_BASE_URL',
  'HOPIT_D1_API_TOKEN',
  'HOPIT_D1_DATABASE_ID',
  'HOPIT_DEVICE_NAME',
  'HOPIT_SESSION_ID',
])

let cachedProductionEnv: Record<string, string> | null | undefined

export function applyLocalProductionEnvFallback(targetEnv: NodeJS.ProcessEnv = process.env) {
  const merged = mergeLocalProductionEnv(targetEnv)
  for (const [key, value] of Object.entries(merged)) {
    if (targetEnv[key] !== value) targetEnv[key] = value
  }
}

export function mergeLocalProductionEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...baseEnv }
  if (env.VERCEL) return env

  const productionEnv = productionCommandEnv() ?? {}
  const processBackend = normalizeCloudBackend(baseEnv.HOPIT_CLOUD_BACKEND)
  const productionBackend = normalizeCloudBackend(productionEnv.HOPIT_CLOUD_BACKEND)
  const useProductionBackend = !processBackend && Boolean(productionBackend)

  for (const [key, value] of Object.entries(productionEnv)) {
    if (env[key] === undefined || env[key] === '') env[key] = value
    if (useProductionBackend && productionBackendKeys.has(key)) env[key] = value
  }

  return env
}

export function normalizeCloudBackend(value: string | undefined) {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'd1' || normalized === 'cloudflare-d1') return 'd1'
  return normalized ?? null
}

export function localCommandProfile(env: NodeJS.ProcessEnv = process.env) {
  const requested = env.HOPIT_COMMAND_PROFILE?.trim()
  if (requested === 'production') return 'production'
  if (requested === 'development') return 'development'
  if (env.HOPIT_WORKSPACE_ROOT || env.HOPIT_AGENT_STATE_ROOT || env.HOPIT_WORKSPACE_INDEX) return 'production'
  return 'development'
}

function productionCommandEnv() {
  if (cachedProductionEnv !== undefined) return cachedProductionEnv
  if (!existsSync(productionEnvPath)) {
    cachedProductionEnv = null
    return cachedProductionEnv
  }

  try {
    cachedProductionEnv = parseEnvFile(readFileSync(productionEnvPath, 'utf8'))
  } catch {
    cachedProductionEnv = null
  }
  return cachedProductionEnv
}

function parseEnvFile(contents: string) {
  const env: Record<string, string> = {}
  for (const rawLine of contents.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const line = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trimStart() : trimmed
    const separator = line.indexOf('=')
    if (separator <= 0) continue

    const key = line.slice(0, separator).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue

    env[key] = parseEnvValue(line.slice(separator + 1))
  }
  return env
}

function parseEnvValue(rawValue: string) {
  const value = rawValue.trim()
  const quote = value[0]
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    const unquoted = value.slice(1, -1)
    if (quote === '"') {
      return unquoted.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    }
    return unquoted
  }
  return value.replace(/\s+#.*$/, '')
}

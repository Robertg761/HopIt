#!/usr/bin/env node

import { existsSync } from 'node:fs'
import path from 'node:path'

const env = process.env

const authProvider = env.HOPIT_AUTH_PROVIDER || 'clerk'
const cloudBackend = normalizeCloudBackend(env.HOPIT_CLOUD_BACKEND)
const checks = [
  required('HOPIT_CODEBASE_ID'),
]

const warnings = []
if (!env.HOPIT_AUTH_PROVIDER) {
  warnings.push('HOPIT_AUTH_PROVIDER is unset; the checker assumes "clerk". Set it explicitly for production.')
}
if (!env.HOPIT_CLOUD_BACKEND) {
  warnings.push(`HOPIT_CLOUD_BACKEND is unset; the checker inferred "${cloudBackend}". Set it explicitly for production.`)
}
if (cloudBackend === 'd1') {
  checks.push(exactNormalized('HOPIT_CLOUD_BACKEND', ['d1', 'cloudflare-d1'], { allowUnset: true }))
  checks.push(requiredOneOf(['HOPIT_D1_ACCOUNT_ID', 'CLOUDFLARE_ACCOUNT_ID']))
  checks.push(required('HOPIT_D1_DATABASE_ID'))
  checks.push(secretOneOf(['HOPIT_D1_API_TOKEN', 'CLOUDFLARE_API_TOKEN', 'HOPIT_AGENT_SESSION_TOKEN'], { minLength: 32 }))
  if (env.HOPIT_D1_API_BASE_URL) checks.push(urlCheck('HOPIT_D1_API_BASE_URL'))
  if (env.HOPIT_CONVEX_URL || env.CONVEX_URL || env.NEXT_PUBLIC_CONVEX_URL) {
    warnings.push('Convex URL variables are still set, but HOPIT_CLOUD_BACKEND=d1 will use Cloudflare D1 for graph/status/actions.')
  }
} else if (cloudBackend === 'convex') {
  checks.push(exactNormalized('HOPIT_CLOUD_BACKEND', ['convex'], { allowUnset: true }))
  checks.push(requiredOneOf(['HOPIT_CONVEX_URL', 'CONVEX_URL']))
  checks.push(required('NEXT_PUBLIC_CONVEX_URL'))
  checks.push(secret('HOPIT_AGENT_TOKEN', { minLength: 32 }))
  warnings.push('Convex is a legacy production backend for this repo. Prefer HOPIT_CLOUD_BACKEND=d1 for the free-first path.')
} else {
  checks.push({
    name: 'HOPIT_CLOUD_BACKEND',
    failures: ['Configure HOPIT_CLOUD_BACKEND=d1 with HOPIT_D1_* values, or set Convex URL/token variables for the legacy backend.'],
  })
}

if (authProvider === 'clerk') {
  checks.push(required('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'))
  checks.push(secret('CLERK_SECRET_KEY', { minLength: 32 }))
  checks.push(required('CLERK_JWT_ISSUER_DOMAIN'))
  checks.push(required('HOPIT_OWNER_EMAIL'))

  if (env.HOPIT_ALLOW_BASIC_AUTH_FALLBACK === '1') {
    checks.push(secret('HOPIT_DASHBOARD_PASSWORD', { minLength: 16 }))
    if (!env.HOPIT_DASHBOARD_USERNAME) {
      warnings.push('HOPIT_DASHBOARD_USERNAME is unset; Basic Auth fallback will use "hopit".')
    }
  }
} else if (authProvider === 'basic') {
  checks.push(exact('HOPIT_ALLOW_BASIC_AUTH_FALLBACK', '1'))
  checks.push(secret('HOPIT_DASHBOARD_PASSWORD', { minLength: 16 }))
  warnings.push('HOPIT_AUTH_PROVIDER=basic is a rollback/recovery mode. Normal production should use Clerk with only HOPIT_ALLOW_BASIC_AUTH_FALLBACK=1 kept temporarily until owner sign-in/OAuth and owner mapping are verified.')
  if (!env.HOPIT_DASHBOARD_USERNAME) {
    warnings.push('HOPIT_DASHBOARD_USERNAME is unset; hosted dashboard auth will use "hopit".')
  }
} else {
  checks.push({
    name: 'HOPIT_AUTH_PROVIDER',
    failures: [`HOPIT_AUTH_PROVIDER must be "clerk" or "basic", got "${authProvider}".`],
  })
}

if (!env.HOPIT_AGENT_STATE_ROOT) {
  warnings.push('HOPIT_AGENT_STATE_ROOT is unset; production-profile hop commands will use the platform default.')
} else {
  checks.push(absolutePath('HOPIT_AGENT_STATE_ROOT'))
}
if (!env.HOPIT_WORKSPACE_ROOT) {
  warnings.push('HOPIT_WORKSPACE_ROOT is unset; production-profile hop commands will use ~/HopIt Workspaces.')
} else {
  checks.push(absolutePath('HOPIT_WORKSPACE_ROOT'))
}
if (!env.HOPIT_WORKSPACE_INDEX) {
  warnings.push('HOPIT_WORKSPACE_INDEX is unset; production-profile hop commands will store the workspace index under the agent state root.')
} else {
  checks.push(absolutePath('HOPIT_WORKSPACE_INDEX'))
}
if (!env.HOPIT_AGENT_SESSION_TOKEN) {
  warnings.push(cloudBackend === 'd1'
    ? 'HOPIT_AGENT_SESSION_TOKEN is unset; installed devices should use a scoped D1 proxy session token after registration. Server/bootstrap tasks can use HOPIT_D1_API_TOKEN.'
    : 'HOPIT_AGENT_SESSION_TOKEN is unset; bootstrap can use HOPIT_AGENT_TOKEN, but installed devices should use scoped session tokens.')
} else {
  checks.push(secret('HOPIT_AGENT_SESSION_TOKEN', { minLength: 32 }))
  if (env.HOPIT_AGENT_TOKEN) checks.push(notEqual('HOPIT_AGENT_SESSION_TOKEN', 'HOPIT_AGENT_TOKEN'))
}
if (!env.HOPIT_SESSION_ID) {
  warnings.push('HOPIT_SESSION_ID is unset; hop device register can allocate one for this device.')
} else {
  checks.push(nonPlaceholder('HOPIT_SESSION_ID'))
}
if (!env.HOPIT_DEVICE_NAME) {
  warnings.push('HOPIT_DEVICE_NAME is unset; session registration will use the local hostname.')
} else {
  checks.push(nonPlaceholder('HOPIT_DEVICE_NAME'))
}
if (!env.HOPIT_REMOTE_PULL) {
  warnings.push('HOPIT_REMOTE_PULL is unset; start-on-login can run, but activity-gated safe refresh is disabled by default.')
} else if (/^(1|true|yes|on)$/i.test(env.HOPIT_REMOTE_PULL)) {
  checks.push(truthy('HOPIT_REMOTE_PULL'))
} else if (/^(0|false|no|off)$/i.test(env.HOPIT_REMOTE_PULL)) {
  warnings.push('HOPIT_REMOTE_PULL is disabled; this avoids background remote checks until you opt into activity-gated safe refresh.')
} else {
  checks.push(truthy('HOPIT_REMOTE_PULL'))
}
if (env.HOPIT_REMOTE_PULL_COOLDOWN_MS) {
  checks.push(integerRange('HOPIT_REMOTE_PULL_COOLDOWN_MS', { min: 1000, max: 86400000 }))
}
if (env.HOPIT_REMOTE_REFRESH_INTERVAL_MS) {
  checks.push(integerRange('HOPIT_REMOTE_REFRESH_INTERVAL_MS', { min: 1000, max: 86400000 }))
  warnings.push('HOPIT_REMOTE_REFRESH_INTERVAL_MS is a legacy alias; prefer HOPIT_REMOTE_PULL_COOLDOWN_MS.')
}
if (env.HOPIT_AGENT_SESSION_CAPABILITIES) {
  checks.push(csvSubset('HOPIT_AGENT_SESSION_CAPABILITIES', ['read', 'write', 'sync', 'watch', 'admin']))
}
if (env.HOPIT_AGENT_BASE_URL) {
  checks.push(loopbackUrl('HOPIT_AGENT_BASE_URL'))
}
if (!env.HOPIT_BLOB_PROVIDER) {
  warnings.push('HOPIT_BLOB_PROVIDER is unset; this avoids R2 object-storage charges, but synced file bodies will stay inline in the graph backend if the agent is started. Keep large repo sync paused or configure R2 free-only first.')
} else {
  const blobProvider = normalizeBlobProvider(env.HOPIT_BLOB_PROVIDER)
  checks.push(nonPlaceholder('HOPIT_BLOB_PROVIDER'))
  if (blobProvider === 'r2') {
    checks.push(required('HOPIT_R2_ACCOUNT_ID'))
    checks.push(required('HOPIT_R2_BUCKET'))
    checks.push(secret('HOPIT_R2_ACCESS_KEY_ID', { minLength: 16 }))
    checks.push(secret('HOPIT_R2_SECRET_ACCESS_KEY', { minLength: 32 }))
    checks.push(truthyDefault('HOPIT_BLOB_FREE_ONLY', '1'))
    checks.push(integerRangeDefault('HOPIT_BLOB_STORAGE_BUDGET_BYTES', { defaultValue: 8000000000, min: 1, max: 8000000000 }))
    if (env.HOPIT_R2_ENDPOINT) checks.push(urlCheck('HOPIT_R2_ENDPOINT'))
  } else if (blobProvider === 'b2') {
    checks.push(required('HOPIT_B2_BUCKET'))
    checks.push(required('HOPIT_B2_ENDPOINT'))
    checks.push(secret('HOPIT_B2_KEY_ID', { minLength: 16 }))
    checks.push(secret('HOPIT_B2_APPLICATION_KEY', { minLength: 32 }))
  } else if (blobProvider === 's3') {
    checks.push(required('HOPIT_S3_ENDPOINT'))
    checks.push(required('HOPIT_S3_BUCKET'))
    checks.push(secret('HOPIT_S3_ACCESS_KEY_ID', { minLength: 16 }))
    checks.push(secret('HOPIT_S3_SECRET_ACCESS_KEY', { minLength: 32 }))
  } else if (blobProvider === 'filesystem') {
    checks.push(required('HOPIT_BLOB_ROOT'))
    checks.push(absolutePath('HOPIT_BLOB_ROOT'))
    warnings.push('HOPIT_BLOB_PROVIDER=filesystem is for local tests only; use r2, b2, or s3 for real production.')
  } else {
    checks.push({
      name: 'HOPIT_BLOB_PROVIDER',
      failures: [`HOPIT_BLOB_PROVIDER must be r2, b2, s3, filesystem, or unset; got "${env.HOPIT_BLOB_PROVIDER}".`],
    })
  }
}
if (env.HOPIT_DEVICE_KEYS_PATH) {
  checks.push(absolutePath('HOPIT_DEVICE_KEYS_PATH'))
}
const configuredDeviceKeyringPath = productionDeviceKeyringPath()
if (!env.HOPIT_CLIENT_ENCRYPTION_KEY && !configuredDeviceKeyringPath) {
  warnings.push('No local secret encryption key source is configured; .private/env remains local-only and routed secrets will not cloud-sync.')
} else if (!env.HOPIT_CLIENT_ENCRYPTION_KEY && configuredDeviceKeyringPath && !existsSync(configuredDeviceKeyringPath)) {
  warnings.push(`HOPIT_CLIENT_ENCRYPTION_KEY is unset and the local device keyring was not found at ${configuredDeviceKeyringPath}; .private/env remains local-only until hop keys init-device is run.`)
} else {
  if (env.HOPIT_CLIENT_ENCRYPTION_KEY) {
    checks.push(secret('HOPIT_CLIENT_ENCRYPTION_KEY', { minLength: 32 }))
  }
  if (configuredDeviceKeyringPath && (!env.HOPIT_CLIENT_ENCRYPTION_KEY || env.HOPIT_DEVICE_KEYS_PATH)) {
    checks.push({
      name: 'HOPIT_DEVICE_KEYS_PATH or default device keyring',
      failures: existsSync(configuredDeviceKeyringPath) ? [] : [`Local device keyring was not found at ${configuredDeviceKeyringPath}.`],
    })
  }
}
if (env.HOPIT_CLIENT_ENCRYPTION_SCOPE) {
  checks.push(oneOf('HOPIT_CLIENT_ENCRYPTION_SCOPE', ['secrets', 'owner-private', 'private', 'all', 'off']))
}
if (!env.HOPIT_BACKUP_ROOT) {
  warnings.push('HOPIT_BACKUP_ROOT is unset; restorable agent-state backups should use an explicit output path.')
} else {
  checks.push(absolutePath('HOPIT_BACKUP_ROOT'))
}
if (!env.HOPIT_EXPORT_ROOT) {
  warnings.push('HOPIT_EXPORT_ROOT is unset; publishable exports should use an explicit output path.')
} else {
  checks.push(absolutePath('HOPIT_EXPORT_ROOT'))
}

if (env.HOPIT_AGENT_STATE_ROOT && env.HOPIT_WORKSPACE_ROOT && bothAbsolute('HOPIT_AGENT_STATE_ROOT', 'HOPIT_WORKSPACE_ROOT')) {
  checks.push(disjointPaths('HOPIT_AGENT_STATE_ROOT', 'HOPIT_WORKSPACE_ROOT'))
}
if (env.HOPIT_WORKSPACE_INDEX && env.HOPIT_WORKSPACE_ROOT && bothAbsolute('HOPIT_WORKSPACE_INDEX', 'HOPIT_WORKSPACE_ROOT')) {
  checks.push(pathOutside('HOPIT_WORKSPACE_INDEX', 'HOPIT_WORKSPACE_ROOT'))
}

const failures = checks.flatMap((check) => check.failures)
const result = {
  ok: failures.length === 0,
  checkedAt: new Date().toISOString(),
  failures,
  warnings,
  authProvider,
  cloudBackend,
  required: checks.map((check) => check.name),
}

console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1

function required(name) {
  const value = env[name]
  const failures = []
  if (!value) failures.push(`${name} is required.`)
  if (value && isPlaceholder(value)) failures.push(`${name} still has a placeholder value.`)
  return { name, failures }
}

function productionDeviceKeyringPath() {
  if (env.HOPIT_DEVICE_KEYS_PATH) return env.HOPIT_DEVICE_KEYS_PATH
  if (!env.HOPIT_AGENT_STATE_ROOT || !env.HOPIT_CODEBASE_ID) return null
  return path.join(env.HOPIT_AGENT_STATE_ROOT, 'keys', `${env.HOPIT_CODEBASE_ID}.device.json`)
}

function requiredOneOf(names) {
  const hasValue = names.some((name) => Boolean(env[name]))
  return {
    name: names.join(' or '),
    failures: hasValue ? [] : [`One of ${names.join(', ')} is required.`],
  }
}

function secret(name, options = {}) {
  const value = env[name]
  const failures = []
  if (!value) failures.push(`${name} is required.`)
  if (value && isPlaceholder(value)) failures.push(`${name} still has a placeholder value.`)
  if (value && options.minLength && value.length < options.minLength) {
    failures.push(`${name} must be at least ${options.minLength} characters.`)
  }
  return { name, failures }
}

function secretOneOf(names, options = {}) {
  const present = names.filter((name) => Boolean(env[name]))
  const failures = []
  if (present.length === 0) {
    failures.push(`One of ${names.join(', ')} is required.`)
  }
  for (const name of present) {
    const value = env[name]
    if (value && isPlaceholder(value)) failures.push(`${name} still has a placeholder value.`)
    if (value && options.minLength && value.length < options.minLength) {
      failures.push(`${name} must be at least ${options.minLength} characters.`)
    }
  }
  return { name: names.join(' or '), failures }
}

function exact(name, expected) {
  const value = env[name]
  const failures = []
  if (value !== expected) failures.push(`${name} must be "${expected}".`)
  return { name, failures }
}

function exactNormalized(name, expectedValues, options = {}) {
  const value = env[name]
  const failures = []
  if (!value && options.allowUnset) return { name, failures }
  if (!expectedValues.includes(value)) failures.push(`${name} must be one of ${expectedValues.join(', ')}.`)
  return { name, failures }
}

function oneOf(name, allowedValues) {
  const value = env[name]
  const failures = []
  if (value && !allowedValues.includes(value)) {
    failures.push(`${name} must be one of ${allowedValues.join(', ')}.`)
  }
  return { name, failures }
}

function truthy(name) {
  const value = env[name]
  const failures = []
  if (!/^(1|true|yes|on)$/i.test(value ?? '')) {
    failures.push(`${name} must be one of 1, true, yes, or on when set.`)
  }
  return { name, failures }
}

function nonPlaceholder(name) {
  const value = env[name]
  const failures = []
  if (value && isPlaceholder(value)) failures.push(`${name} still has a placeholder value.`)
  return { name, failures }
}

function notEqual(name, otherName) {
  const value = env[name]
  const otherValue = env[otherName]
  const failures = []
  if (value && otherValue && value === otherValue) {
    failures.push(`${name} must not match ${otherName}; installed devices should use scoped session tokens.`)
  }
  return { name: `${name} != ${otherName}`, failures }
}

function absolutePath(name) {
  const value = env[name]
  const failures = []
  if (value && !path.isAbsolute(value)) failures.push(`${name} must be an absolute path.`)
  if (value && isPlaceholder(value)) failures.push(`${name} still has a placeholder value.`)
  return { name, failures }
}

function integerRange(name, options) {
  const value = Number(env[name])
  const failures = []
  if (!Number.isInteger(value)) {
    failures.push(`${name} must be an integer.`)
  } else {
    if (options.min && value < options.min) failures.push(`${name} must be at least ${options.min}.`)
    if (options.max && value > options.max) failures.push(`${name} must be at most ${options.max}.`)
  }
  return { name, failures }
}

function integerRangeDefault(name, options) {
  const rawValue = env[name] ?? String(options.defaultValue)
  const value = Number(rawValue)
  const failures = []
  if (!Number.isInteger(value)) {
    failures.push(`${name} must be an integer.`)
  } else {
    if (options.min && value < options.min) failures.push(`${name} must be at least ${options.min}.`)
    if (options.max && value > options.max) failures.push(`${name} must be at most ${options.max}.`)
  }
  return { name, failures }
}

function csvSubset(name, allowedValues) {
  const allowed = new Set(allowedValues)
  const values = String(env[name] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const failures = []
  const invalid = values.filter((value) => !allowed.has(value))
  if (invalid.length > 0) {
    failures.push(`${name} contains unsupported capabilities: ${invalid.join(', ')}.`)
  }
  return { name, failures }
}

function loopbackUrl(name) {
  const failures = []
  try {
    const url = new URL(env[name])
    const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
    if (!['http:', 'https:'].includes(url.protocol)) {
      failures.push(`${name} must use http or https.`)
    }
    if (!loopbackHosts.has(url.hostname)) {
      failures.push(`${name} must point at a loopback host, not ${url.hostname}.`)
    }
  } catch {
    failures.push(`${name} must be a valid URL.`)
  }
  return { name, failures }
}

function truthyDefault(name, defaultValue) {
  const value = env[name] ?? defaultValue
  const failures = []
  if (!/^(1|true|yes|on)$/i.test(value ?? '')) {
    failures.push(`${name} must stay enabled for the current free-only R2 setup.`)
  }
  return { name, failures }
}

function urlCheck(name) {
  const failures = []
  try {
    const url = new URL(env[name])
    if (!['http:', 'https:'].includes(url.protocol)) {
      failures.push(`${name} must use http or https.`)
    }
  } catch {
    failures.push(`${name} must be a valid URL.`)
  }
  return { name, failures }
}

function normalizeBlobProvider(value) {
  if (value === 'local' || value === 'fs') return 'filesystem'
  if (value === 'backblaze') return 'b2'
  return value
}

function normalizeCloudBackend(value) {
  if (value === 'd1' || value === 'cloudflare-d1') return 'd1'
  if (value === 'convex') return 'convex'
  if (env.HOPIT_D1_DATABASE_ID || env.HOPIT_D1_ACCOUNT_ID || env.HOPIT_D1_API_TOKEN) return 'd1'
  if (env.HOPIT_CONVEX_URL || env.CONVEX_URL || env.NEXT_PUBLIC_CONVEX_URL) return 'convex'
  return 'unavailable'
}

function bothAbsolute(name, otherName) {
  return path.isAbsolute(env[name]) && path.isAbsolute(env[otherName])
}

function disjointPaths(name, otherName) {
  const first = path.resolve(env[name])
  const second = path.resolve(env[otherName])
  const failures = []
  if (pathsOverlap(first, second)) {
    failures.push(`${name} and ${otherName} must be separate directories.`)
  }
  return { name: `${name} separate from ${otherName}`, failures }
}

function pathOutside(name, parentName) {
  const child = path.resolve(env[name])
  const parent = path.resolve(env[parentName])
  const failures = []
  if (child === parent || isPathInside(child, parent)) {
    failures.push(`${name} should live outside ${parentName} so workspace exports do not include agent metadata.`)
  }
  return { name: `${name} outside ${parentName}`, failures }
}

function pathsOverlap(first, second) {
  return first === second || isPathInside(first, second) || isPathInside(second, first)
}

function isPathInside(child, parent) {
  const relative = path.relative(parent, child)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function isPlaceholder(value) {
  return /replace|example|changeme|your-|placeholder/i.test(value)
}

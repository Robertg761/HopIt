#!/usr/bin/env node

import path from 'node:path'

const env = process.env

const authProvider = env.HOPIT_AUTH_PROVIDER || 'clerk'
const checks = [
  required('HOPIT_CODEBASE_ID'),
  requiredOneOf(['HOPIT_CONVEX_URL', 'CONVEX_URL']),
  required('NEXT_PUBLIC_CONVEX_URL'),
  secret('HOPIT_AGENT_TOKEN', { minLength: 32 }),
]

const warnings = []
if (!env.HOPIT_AUTH_PROVIDER) {
  warnings.push('HOPIT_AUTH_PROVIDER is unset; the checker assumes "clerk". Set it explicitly for production.')
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
  warnings.push('HOPIT_AUTH_PROVIDER=basic is the domain-deferred personal production guard, not final product auth.')
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
  warnings.push('HOPIT_AGENT_SESSION_TOKEN is unset; bootstrap can use HOPIT_AGENT_TOKEN, but installed devices should use scoped session tokens.')
} else {
  checks.push(secret('HOPIT_AGENT_SESSION_TOKEN', { minLength: 32 }))
  checks.push(notEqual('HOPIT_AGENT_SESSION_TOKEN', 'HOPIT_AGENT_TOKEN'))
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
  warnings.push('HOPIT_REMOTE_PULL is unset; start-on-login can run, but automatic safe refresh is disabled by default.')
} else {
  checks.push(truthy('HOPIT_REMOTE_PULL'))
}
if (env.HOPIT_REMOTE_REFRESH_INTERVAL_MS) {
  checks.push(integerRange('HOPIT_REMOTE_REFRESH_INTERVAL_MS', { min: 1000, max: 60000 }))
}
if (env.HOPIT_AGENT_SESSION_CAPABILITIES) {
  checks.push(csvSubset('HOPIT_AGENT_SESSION_CAPABILITIES', ['read', 'write', 'sync', 'watch']))
}
if (env.HOPIT_AGENT_BASE_URL) {
  checks.push(loopbackUrl('HOPIT_AGENT_BASE_URL'))
}
if (!env.HOPIT_BACKUP_ROOT) {
  warnings.push('HOPIT_BACKUP_ROOT is unset; private backup exports should use an explicit output path.')
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

function exact(name, expected) {
  const value = env[name]
  const failures = []
  if (value !== expected) failures.push(`${name} must be "${expected}".`)
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

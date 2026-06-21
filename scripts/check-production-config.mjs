#!/usr/bin/env node

const env = process.env

const checks = [
  required('HOPIT_CODEBASE_ID'),
  requiredOneOf(['HOPIT_CONVEX_URL', 'CONVEX_URL']),
  required('NEXT_PUBLIC_CONVEX_URL'),
  secret('HOPIT_AGENT_TOKEN', { minLength: 32 }),
  secret('HOPIT_DASHBOARD_PASSWORD', { minLength: 16 }),
]

const warnings = []
if (!env.HOPIT_DASHBOARD_USERNAME) {
  warnings.push('HOPIT_DASHBOARD_USERNAME is unset; hosted dashboard auth will use "hopit".')
}
if (!env.HOPIT_AGENT_STATE_ROOT) {
  warnings.push('HOPIT_AGENT_STATE_ROOT is unset; production-profile hop commands will use the platform default.')
}
if (!env.HOPIT_WORKSPACE_ROOT) {
  warnings.push('HOPIT_WORKSPACE_ROOT is unset; production-profile hop commands will use ~/HopIt Workspaces.')
}

const failures = checks.flatMap((check) => check.failures)
const result = {
  ok: failures.length === 0,
  checkedAt: new Date().toISOString(),
  failures,
  warnings,
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

function isPlaceholder(value) {
  return /replace|example|changeme|your-|placeholder/i.test(value)
}

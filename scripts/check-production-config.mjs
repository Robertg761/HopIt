#!/usr/bin/env node

const env = process.env

const authProvider = env.HOPIT_AUTH_PROVIDER || 'clerk'
const checks = [
  required('HOPIT_CODEBASE_ID'),
  requiredOneOf(['HOPIT_CONVEX_URL', 'CONVEX_URL']),
  required('NEXT_PUBLIC_CONVEX_URL'),
  secret('HOPIT_AGENT_TOKEN', { minLength: 32 }),
]

const warnings = []

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
  checks.push(secret('HOPIT_DASHBOARD_PASSWORD', { minLength: 16 }))
  warnings.push('HOPIT_AUTH_PROVIDER=basic is an emergency fallback, not production product auth.')
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

function isPlaceholder(value) {
  return /replace|example|changeme|your-|placeholder/i.test(value)
}

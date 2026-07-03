import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('production config check fails when basic auth fallback lacks explicit risk acknowledgement', () => {
  const result = runCheck({
    HOPIT_ALLOW_BASIC_AUTH_FALLBACK: '1',
  })

  assert.notEqual(result.status, 0)
  const body = JSON.parse(result.stdout)
  assert.equal(body.ok, false)
  assert.ok(body.failures.some((failure) => failure.includes('HOPIT_ACKNOWLEDGE_BASIC_AUTH_RISK=1')))
  assert.ok(body.warnings.some((warning) => warning.includes('HOPIT_ALLOW_BASIC_AUTH_FALLBACK=1 is enabled')))
})

test('production config check accepts acknowledged temporary basic auth fallback', () => {
  const result = runCheck({
    HOPIT_ALLOW_BASIC_AUTH_FALLBACK: '1',
    HOPIT_ACKNOWLEDGE_BASIC_AUTH_RISK: '1',
  })

  assert.equal(result.status, 0)
  const body = JSON.parse(result.stdout)
  assert.equal(body.ok, true)
  assert.ok(body.warnings.some((warning) => warning.includes('HOPIT_ALLOW_BASIC_AUTH_FALLBACK=1 is enabled')))
})

function runCheck(overrides) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    VERCEL_ENV: 'production',
    HOPIT_CODEBASE_ID: 'hopit',
    HOPIT_AUTH_PROVIDER: 'clerk',
    HOPIT_CLOUD_BACKEND: 'd1',
    HOPIT_D1_ACCOUNT_ID: 'account-id',
    HOPIT_D1_DATABASE_ID: 'database-id',
    HOPIT_D1_API_TOKEN: 'd1_token_12345678901234567890123456789012',
    HOPIT_D1_ASSUME_SCHEMA: '1',
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_live_12345678901234567890123456789012',
    CLERK_SECRET_KEY: 'sk_live_12345678901234567890123456789012',
    CLERK_JWT_ISSUER_DOMAIN: 'https://clerk.hopit.dev',
    HOPIT_OWNER_EMAIL: 'person@hopit.dev',
    HOPIT_DASHBOARD_PASSWORD: 'dashboard-password-1234567890',
    ...overrides,
  }
  return spawnSync(process.execPath, ['scripts/check-production-config.mjs'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  })
}

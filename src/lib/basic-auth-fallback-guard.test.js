import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resetBasicAuthFallbackWarningForTests,
  warnBasicAuthFallbackEnabledOnce,
} from './basic-auth-fallback-guard.js'

test('basic auth fallback guard emits one warning per process', () => {
  resetBasicAuthFallbackWarningForTests()
  const warnings = []
  const logger = { warn: (message) => warnings.push(message) }

  assert.equal(warnBasicAuthFallbackEnabledOnce(logger), true)
  assert.equal(warnBasicAuthFallbackEnabledOnce(logger), false)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /HOPIT_ALLOW_BASIC_AUTH_FALLBACK=1/)
  assert.match(warnings[0], /bypasses Clerk/)
})

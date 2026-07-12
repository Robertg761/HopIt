import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isMultiTenant, shouldAllowBasicAuthFallback } from './auth-config'

// Phase 3 §2e / decision 10: with multi-tenancy on, the basic-auth fallback (the
// source of the empty wildcard actor) must be forced off regardless of the
// HOPIT_ALLOW_BASIC_AUTH_FALLBACK knob. With the flag off, behavior is exactly
// the legacy env-driven toggle (byte-for-byte).

const FLAG = 'HOPIT_MULTITENANT'
const FALLBACK = 'HOPIT_ALLOW_BASIC_AUTH_FALLBACK'

describe('auth-config multi-tenant flag', () => {
  const original: Record<string, string | undefined> = {}

  beforeEach(() => {
    original[FLAG] = process.env[FLAG]
    original[FALLBACK] = process.env[FALLBACK]
    delete process.env[FLAG]
    delete process.env[FALLBACK]
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('parses HOPIT_MULTITENANT with the same truthy values the backend uses', () => {
    for (const on of ['1', 'true', 'yes', 'on', 'TRUE', 'On']) {
      process.env[FLAG] = on
      expect(isMultiTenant()).toBe(true)
    }
    for (const off of ['0', 'false', 'no', 'off', '', 'nonsense']) {
      process.env[FLAG] = off
      expect(isMultiTenant()).toBe(false)
    }
    delete process.env[FLAG]
    expect(isMultiTenant()).toBe(false)
  })

  it('honors HOPIT_ALLOW_BASIC_AUTH_FALLBACK when the flag is OFF (legacy behavior)', () => {
    process.env[FALLBACK] = '1'
    expect(shouldAllowBasicAuthFallback()).toBe(true)

    delete process.env[FALLBACK]
    expect(shouldAllowBasicAuthFallback()).toBe(false)
  })

  it('forces the basic-auth fallback OFF when the flag is ON, even if the knob is set', () => {
    process.env[FLAG] = '1'
    process.env[FALLBACK] = '1'
    expect(shouldAllowBasicAuthFallback()).toBe(false)
  })
})

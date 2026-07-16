// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

import { confirmsCodebaseDeletion } from './codebase-dialogs'

describe('codebase deletion confirmation', () => {
  it('requires the exact codebase name', () => {
    expect(confirmsCodebaseDeletion('HopIt', 'HopIt')).toBe(true)
    expect(confirmsCodebaseDeletion('HopIt', 'hopit')).toBe(false)
    expect(confirmsCodebaseDeletion('HopIt', ' HopIt ')).toBe(false)
    expect(confirmsCodebaseDeletion(undefined, '')).toBe(false)
  })
})

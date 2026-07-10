import { describe, expect, it } from 'vitest'

import { normalizeDeviceCodebaseOptions } from './codebase-options'

describe('normalizeDeviceCodebaseOptions', () => {
  it('accepts codebase-head and flat API rows', () => {
    expect(normalizeDeviceCodebaseOptions([
      { codebase: { id: 'alpha', name: 'Alpha' } },
      { id: 'beta', name: 'Beta' },
    ])).toEqual([
      { id: 'alpha', name: 'Alpha' },
      { id: 'beta', name: 'Beta' },
    ])
  })

  it('drops invalid and duplicate rows', () => {
    expect(normalizeDeviceCodebaseOptions([
      null,
      { codebase: { id: 'alpha', name: 'Alpha' } },
      { id: 'alpha', name: 'Duplicate' },
      { name: 'Missing id' },
    ])).toEqual([{ id: 'alpha', name: 'Alpha' }])
  })
})

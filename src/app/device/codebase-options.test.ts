import { describe, expect, it } from 'vitest'

import { deviceApprovalGate, normalizeDeviceCodebaseOptions } from './codebase-options'

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

describe('deviceApprovalGate', () => {
  it('requires a selection when no specific project was requested', () => {
    expect(deviceApprovalGate({
      requestedId: null,
      requestedExists: false,
      selectedCodebaseId: '',
      overrideAcknowledged: false,
    })).toEqual({ requestedNeedsCreate: false, canApprove: false })

    expect(deviceApprovalGate({
      requestedId: null,
      requestedExists: false,
      selectedCodebaseId: 'alpha',
      overrideAcknowledged: false,
    })).toEqual({ requestedNeedsCreate: false, canApprove: true })
  })

  it('never allows one-click approval of a different existing project when a new one was requested', () => {
    // A different project is selected but the requested one still needs creating:
    // approval is blocked until the override is explicitly acknowledged.
    expect(deviceApprovalGate({
      requestedId: 'lunarlog',
      requestedExists: false,
      selectedCodebaseId: 'hopit',
      overrideAcknowledged: false,
    })).toEqual({ requestedNeedsCreate: true, canApprove: false })

    expect(deviceApprovalGate({
      requestedId: 'lunarlog',
      requestedExists: false,
      selectedCodebaseId: 'hopit',
      overrideAcknowledged: true,
    })).toEqual({ requestedNeedsCreate: true, canApprove: true })
  })

  it('allows approval once the requested project exists (created)', () => {
    expect(deviceApprovalGate({
      requestedId: 'lunarlog',
      requestedExists: true,
      selectedCodebaseId: 'lunarlog',
      overrideAcknowledged: false,
    })).toEqual({ requestedNeedsCreate: false, canApprove: true })
  })

  it('stays disabled while busy', () => {
    expect(deviceApprovalGate({
      requestedId: null,
      requestedExists: false,
      selectedCodebaseId: 'alpha',
      overrideAcknowledged: false,
      busy: true,
    }).canApprove).toBe(false)
  })
})

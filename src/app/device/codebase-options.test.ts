import { describe, expect, it } from 'vitest'

import {
  deviceBatchApprovalGate,
  normalizeDeviceCodebaseOptions,
  normalizeDeviceRequestedProjects,
  type DeviceProjectSelection,
} from './codebase-options'

function row(
  requestedId: string,
  overrides: Partial<DeviceProjectSelection> = {},
): DeviceProjectSelection {
  return {
    requested: { id: requestedId, name: requestedId },
    selected: true,
    resolvedCodebaseId: requestedId,
    acknowledgedExisting: false,
    ...overrides,
  }
}

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

describe('normalizeDeviceRequestedProjects', () => {
  it('keeps order, fills a missing name from the id, and drops duplicates', () => {
    expect(normalizeDeviceRequestedProjects([
      { id: 'alpha', name: 'Alpha' },
      { id: 'beta' },
      { id: 'alpha', name: 'Duplicate' },
      { name: 'no id' },
      null,
    ])).toEqual([
      { id: 'alpha', name: 'Alpha' },
      { id: 'beta', name: 'beta' },
    ])
  })

  it('returns nothing when the authorization requested no specific project', () => {
    expect(normalizeDeviceRequestedProjects(undefined)).toEqual([])
  })
})

describe('deviceBatchApprovalGate', () => {
  it('requires at least one selected row', () => {
    expect(deviceBatchApprovalGate({
      selections: [row('alpha', { selected: false })],
      existingCodebaseIds: ['alpha'],
    }).canApprove).toBe(false)

    expect(deviceBatchApprovalGate({
      selections: [row('alpha')],
      existingCodebaseIds: ['alpha'],
    }).canApprove).toBe(true)
  })

  it('blocks a row whose requested project has not been created yet', () => {
    // Nothing to connect to: the row must be created (or deliberately pointed
    // elsewhere) before it can be approved.
    const gate = deviceBatchApprovalGate({
      selections: [row('lunarlog', { resolvedCodebaseId: '' })],
      existingCodebaseIds: [],
    })
    expect(gate.incompleteCount).toBe(1)
    expect(gate.canApprove).toBe(false)
  })

  it('never lets a bulk approval sweep in an unacknowledged adopt of an existing project', () => {
    // Two safe creates plus one row quietly pointed at an existing project. The
    // whole batch stays blocked until THAT row is acknowledged on its own.
    const selections = [
      row('alpha'),
      row('beta'),
      row('lunarlog', { resolvedCodebaseId: 'hopit' }),
    ]
    const blocked = deviceBatchApprovalGate({
      selections,
      existingCodebaseIds: ['alpha', 'beta', 'hopit'],
    })
    expect(blocked.createCount).toBe(2)
    expect(blocked.adoptCount).toBe(1)
    expect(blocked.unacknowledgedAdoptCount).toBe(1)
    expect(blocked.canApprove).toBe(false)

    const acknowledged = deviceBatchApprovalGate({
      selections: [
        row('alpha'),
        row('beta'),
        row('lunarlog', { resolvedCodebaseId: 'hopit', acknowledgedExisting: true }),
      ],
      existingCodebaseIds: ['alpha', 'beta', 'hopit'],
    })
    expect(acknowledged.unacknowledgedAdoptCount).toBe(0)
    expect(acknowledged.canApprove).toBe(true)
  })

  it('ignores unselected rows entirely, including an unacknowledged adopt', () => {
    const gate = deviceBatchApprovalGate({
      selections: [
        row('alpha'),
        row('lunarlog', { selected: false, resolvedCodebaseId: 'hopit' }),
      ],
      existingCodebaseIds: ['alpha', 'hopit'],
    })
    expect(gate.selectedCount).toBe(1)
    expect(gate.adoptCount).toBe(0)
    expect(gate.canApprove).toBe(true)
  })

  it('stays disabled while busy', () => {
    expect(deviceBatchApprovalGate({
      selections: [row('alpha')],
      existingCodebaseIds: ['alpha'],
      busy: true,
    }).canApprove).toBe(false)
  })
})

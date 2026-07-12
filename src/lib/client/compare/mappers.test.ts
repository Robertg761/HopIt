import { describe, expect, it } from 'vitest'

import {
  changedEntryCount,
  defaultRevisionPair,
  fileStateView,
  initialRevisionPair,
  parseComparePairFromSearch,
  revisionOptions,
  sortCompareEntries,
  summaryChips,
  unifiedDiffLines,
} from './mappers'
import type { CompareEntry, CompareSummary, TextDiffSummary } from './types'

function entry(path: string, state: string): CompareEntry {
  return { path, state, kind: 'file', scope: 'shared', privacyZone: 'shared', left: null, right: null }
}

const emptySummary: CompareSummary = {
  added: 0,
  modified: 0,
  deleted: 0,
  unchanged: 0,
  missingBlob: 0,
  integrityFailures: 0,
  requiresLocalKey: 0,
  binaryChanged: 0,
}

describe('fileStateView', () => {
  it('maps each state to trail-vocabulary copy and a tone', () => {
    expect(fileStateView('added').label).toBe('Added')
    expect(fileStateView('added').description).toMatch(/trail/i)
    expect(fileStateView('modified').tone).toBe('iris')
    expect(fileStateView('deleted').label).toBe('Removed')
    expect(fileStateView('requiresLocalKey').metadataOnly).toBe(true)
    expect(fileStateView('missing_blob').tone).toBe('danger')
    expect(fileStateView('integrity_failure').tone).toBe('danger')
  })

  it('never uses commit vocabulary', () => {
    const combined = ['added', 'modified', 'deleted', 'unchanged', 'binary_changed']
      .map((state) => `${fileStateView(state).label} ${fileStateView(state).description}`)
      .join(' ')
    expect(combined).not.toMatch(/commit/i)
  })

  it('falls back to a neutral unknown view', () => {
    expect(fileStateView('nonsense').label).toBe('Unknown')
    expect(fileStateView('nonsense').tone).toBe('neutral')
  })
})

describe('summaryChips', () => {
  it('drops zero counts and only surfaces failures that occurred', () => {
    const chips = summaryChips({ ...emptySummary, added: 2, modified: 1 })
    expect(chips.map((chip) => chip.key)).toEqual(['added', 'modified'])
    expect(chips.find((chip) => chip.key === 'added')?.value).toBe(2)
  })

  it('surfaces failure states when non-zero', () => {
    const chips = summaryChips({ ...emptySummary, missingBlob: 1, requiresLocalKey: 3 })
    const keys = chips.map((chip) => chip.key)
    expect(keys).toContain('missingBlob')
    expect(keys).toContain('requiresLocalKey')
    expect(chips.find((chip) => chip.key === 'missingBlob')?.tone).toBe('danger')
  })

  it('returns nothing for a null summary', () => {
    expect(summaryChips(null)).toEqual([])
  })
})

describe('sortCompareEntries / changedEntryCount', () => {
  it('lists changed files before unchanged, then alphabetically', () => {
    const sorted = sortCompareEntries([
      entry('z.txt', 'unchanged'),
      entry('b.txt', 'modified'),
      entry('a.txt', 'unchanged'),
      entry('c.txt', 'added'),
    ])
    expect(sorted.map((item) => item.path)).toEqual(['b.txt', 'c.txt', 'a.txt', 'z.txt'])
  })

  it('counts only changed entries', () => {
    expect(
      changedEntryCount([entry('a', 'unchanged'), entry('b', 'modified'), entry('c', 'added')]),
    ).toBe(2)
  })
})

describe('unifiedDiffLines', () => {
  const diff: TextDiffSummary = {
    changed: true,
    leftLineCount: 4,
    rightLineCount: 4,
    commonPrefixLines: 1,
    commonSuffixLines: 1,
    removedLines: ['old-a', 'old-b'],
    addedLines: ['new-a', 'new-b'],
    addedLineCount: 2,
    removedLineCount: 2,
  }

  it('frames removed then added lines with context markers and line numbers', () => {
    const lines = unifiedDiffLines(diff)
    expect(lines.map((line) => line.type)).toEqual([
      'context',
      'remove',
      'remove',
      'add',
      'add',
      'context',
    ])
    // Removed lines number on the left starting after the common prefix.
    const removed = lines.filter((line) => line.type === 'remove')
    expect(removed.map((line) => line.oldLineNumber)).toEqual([2, 3])
    expect(removed.every((line) => line.newLineNumber === null)).toBe(true)
    // Added lines number on the right starting after the common prefix.
    const added = lines.filter((line) => line.type === 'add')
    expect(added.map((line) => line.newLineNumber)).toEqual([2, 3])
    expect(added.every((line) => line.oldLineNumber === null)).toBe(true)
  })

  it('omits context markers when there is no common prefix or suffix', () => {
    const lines = unifiedDiffLines({
      ...diff,
      commonPrefixLines: 0,
      commonSuffixLines: 0,
      removedLines: ['x'],
      addedLines: ['y'],
    })
    expect(lines.some((line) => line.type === 'context')).toBe(false)
    expect(lines).toHaveLength(2)
  })

  it('singularizes the context label for a single unchanged line', () => {
    const [contextLine] = unifiedDiffLines({ ...diff, commonSuffixLines: 0 })
    expect(contextLine.text).toContain('1 unchanged line above')
  })
})

describe('revisionOptions / defaultRevisionPair', () => {
  it('prefers distinct enumerated revisions, sorted and de-duplicated', () => {
    expect(revisionOptions([3, 1, 2, 3], null)).toEqual([1, 2, 3])
  })

  it('falls back to the retained integer range when no revisions are enumerated', () => {
    expect(revisionOptions([], { min: 4, max: 7, retainedVersions: 9 })).toEqual([4, 5, 6, 7])
  })

  it('returns nothing when neither revisions nor retention are known', () => {
    expect(revisionOptions(null, null)).toEqual([])
  })

  it('defaults to comparing the previous retained step against the latest', () => {
    expect(defaultRevisionPair([1, 2, 3, 5])).toEqual({ from: 3, to: 5 })
  })

  it('compares a lone revision against itself', () => {
    expect(defaultRevisionPair([7])).toEqual({ from: 7, to: 7 })
  })

  it('returns null for an empty option list', () => {
    expect(defaultRevisionPair([])).toBeNull()
  })
})

describe('parseComparePairFromSearch / initialRevisionPair', () => {
  it('parses integer from/to out of a query string', () => {
    expect(parseComparePairFromSearch('?from=2&to=7')).toEqual({ from: 2, to: 7 })
  })

  it('drops non-integer and absent params', () => {
    expect(parseComparePairFromSearch('?from=abc')).toEqual({ from: null, to: null })
    expect(parseComparePairFromSearch('')).toEqual({ from: null, to: null })
    expect(parseComparePairFromSearch(null)).toEqual({ from: null, to: null })
  })

  it('honors a requested pair when both are valid options', () => {
    expect(initialRevisionPair([1, 2, 3, 5], { from: 2, to: 5 })).toEqual({ from: 2, to: 5 })
  })

  it('falls back to the default pair when a requested revision is not an option', () => {
    expect(initialRevisionPair([1, 2, 3, 5], { from: 2, to: 99 })).toEqual({ from: 3, to: 5 })
  })

  it('falls back to the default pair when nothing is requested', () => {
    expect(initialRevisionPair([1, 2, 3, 5], { from: null, to: null })).toEqual({ from: 3, to: 5 })
  })

  it('returns null when there are no options at all', () => {
    expect(initialRevisionPair([], { from: 1, to: 2 })).toBeNull()
  })
})

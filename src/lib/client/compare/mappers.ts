import type { BadgeTone } from '@/components/ui/badge'

import type {
  CompareEntry,
  CompareRetention,
  CompareSummary,
  TextDiffSummary,
} from './types'

/**
 * Pure view-model mappers for the compare surface. Everything user-facing about
 * a compare — the plain-language state copy, the summary chips, the unified diff
 * lines — is derived here so it can be unit-tested without React and stays in the
 * roadmap's trail vocabulary (steps on a trail, never commits).
 */

export type FileStateView = {
  label: string
  description: string
  tone: BadgeTone
  /** True when there is no meaningful diff body to expand for this state. */
  metadataOnly: boolean
}

const FILE_STATE_VIEWS: Record<string, FileStateView> = {
  added: {
    label: 'Added',
    description: 'New on the trail by this step.',
    tone: 'hop',
    metadataOnly: false,
  },
  modified: {
    label: 'Changed',
    description: 'Edited between these steps.',
    tone: 'iris',
    metadataOnly: false,
  },
  deleted: {
    label: 'Removed',
    description: 'Taken off the trail by this step.',
    tone: 'amber',
    metadataOnly: false,
  },
  unchanged: {
    label: 'Unchanged',
    description: 'Identical at both steps.',
    tone: 'neutral',
    metadataOnly: true,
  },
  binary_changed: {
    label: 'Binary changed',
    description: 'Binary file changed. No line-by-line diff is shown.',
    tone: 'iris',
    metadataOnly: true,
  },
  requiresLocalKey: {
    label: 'Encrypted locally',
    description: 'Encrypted on your device. Open this trail locally to diff it.',
    tone: 'info',
    metadataOnly: true,
  },
  missing_blob: {
    label: 'Content unavailable',
    description: 'The stored content for this step is missing and cannot be shown.',
    tone: 'danger',
    metadataOnly: true,
  },
  integrity_failure: {
    label: 'Integrity check failed',
    description: 'Stored content did not match its recorded hash, so it is withheld.',
    tone: 'danger',
    metadataOnly: true,
  },
}

const UNKNOWN_STATE_VIEW: FileStateView = {
  label: 'Unknown',
  description: 'This step is in a state the trail does not recognize.',
  tone: 'neutral',
  metadataOnly: true,
}

export function fileStateView(state: string): FileStateView {
  return FILE_STATE_VIEWS[state] ?? UNKNOWN_STATE_VIEW
}

export type SummaryChip = {
  key: string
  label: string
  value: number
  tone: BadgeTone
}

/**
 * Turns the raw compare summary into chips, dropping any zero counts. Failure
 * states (missing / integrity / encrypted) are only shown when they occur, so a
 * clean compare never advertises problems it does not have.
 */
export function summaryChips(summary: CompareSummary | null | undefined): SummaryChip[] {
  if (!summary) return []
  const chips: Array<Omit<SummaryChip, 'value'> & { value: number | undefined }> = [
    { key: 'added', label: 'added', value: summary.added, tone: 'hop' },
    { key: 'modified', label: 'changed', value: summary.modified, tone: 'iris' },
    { key: 'deleted', label: 'removed', value: summary.deleted, tone: 'amber' },
    { key: 'unchanged', label: 'unchanged', value: summary.unchanged, tone: 'neutral' },
    { key: 'binaryChanged', label: 'binary', value: summary.binaryChanged, tone: 'iris' },
    { key: 'requiresLocalKey', label: 'encrypted', value: summary.requiresLocalKey, tone: 'info' },
    { key: 'missingBlob', label: 'missing content', value: summary.missingBlob, tone: 'danger' },
    {
      key: 'integrityFailures',
      label: 'integrity failures',
      value: summary.integrityFailures,
      tone: 'danger',
    },
  ]
  return chips
    .filter((chip): chip is SummaryChip => typeof chip.value === 'number' && chip.value > 0)
}

/** Files worth listing first: everything that actually changed, then the rest. */
export function sortCompareEntries(entries: CompareEntry[]): CompareEntry[] {
  return [...entries].sort((a, b) => {
    const aChanged = a.state === 'unchanged' ? 1 : 0
    const bChanged = b.state === 'unchanged' ? 1 : 0
    if (aChanged !== bChanged) return aChanged - bChanged
    return a.path.localeCompare(b.path)
  })
}

export function changedEntryCount(entries: CompareEntry[]): number {
  return entries.filter((entry) => entry.state !== 'unchanged').length
}

export type DiffLineType = 'context' | 'add' | 'remove'

export type DiffLine = {
  type: DiffLineType
  text: string
  /** 1-based line number on the left (from) side, or null for added lines. */
  oldLineNumber: number | null
  /** 1-based line number on the right (to) side, or null for removed lines. */
  newLineNumber: number | null
}

/**
 * Builds a unified-diff line list from the backend's `textDiffSummary`. The
 * engine reports common-prefix / common-suffix counts plus the changed removed
 * and added lines (a deterministic prefix/suffix trim, not a full Myers diff),
 * so we render the changed hunk framed by context markers for the unchanged
 * regions. We never fabricate the unchanged line contents the engine omits.
 */
export function unifiedDiffLines(diff: TextDiffSummary): DiffLine[] {
  const lines: DiffLine[] = []
  const prefix = Math.max(0, diff.commonPrefixLines)
  const suffix = Math.max(0, diff.commonSuffixLines)

  if (prefix > 0) {
    lines.push({
      type: 'context',
      text: contextLabel(prefix, 'unchanged line', 'above'),
      oldLineNumber: null,
      newLineNumber: null,
    })
  }

  let oldLine = prefix + 1
  for (const text of diff.removedLines) {
    lines.push({ type: 'remove', text, oldLineNumber: oldLine, newLineNumber: null })
    oldLine += 1
  }

  let newLine = prefix + 1
  for (const text of diff.addedLines) {
    lines.push({ type: 'add', text, oldLineNumber: null, newLineNumber: newLine })
    newLine += 1
  }

  if (suffix > 0) {
    lines.push({
      type: 'context',
      text: contextLabel(suffix, 'unchanged line', 'below'),
      oldLineNumber: null,
      newLineNumber: null,
    })
  }

  return lines
}

function contextLabel(count: number, noun: string, where: string): string {
  return `@@ ${count} ${noun}${count === 1 ? '' : 's'} ${where} @@`
}

/**
 * Which revisions the pickers may offer. Prefers the exact distinct revisions
 * enumerated from file-version rows; falls back to the retained integer range
 * when only bounds are known. Honest either way — it never invents revisions
 * outside the retention window.
 */
export function revisionOptions(
  revisions: number[] | null | undefined,
  retention: CompareRetention | null | undefined,
): number[] {
  if (revisions && revisions.length > 0) {
    return [...new Set(revisions)].sort((a, b) => a - b)
  }
  if (retention && Number.isInteger(retention.min) && Number.isInteger(retention.max)) {
    const out: number[] = []
    for (let value = retention.min; value <= retention.max; value += 1) out.push(value)
    return out
  }
  return []
}

/**
 * Sensible default pair: compare the previous retained step against the latest.
 * With a single revision, compares it against itself (an honest empty diff).
 */
export function defaultRevisionPair(options: number[]): { from: number; to: number } | null {
  if (options.length === 0) return null
  const to = options[options.length - 1]
  const from = options.length > 1 ? options[options.length - 2] : options[0]
  return { from, to }
}

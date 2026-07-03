'use client'

import * as React from 'react'

import type { AgentFile, AgentFileLocalState } from '@/lib/client/agent-status'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import type { CollaborationError } from '@/lib/collaboration'

/**
 * Maps review / merge / conflict state strings to badge tones.
 * open/ready -> hop, in-review -> iris, conflict/blocked -> danger,
 * pending -> amber, unmerged/not-open -> neutral.
 */
export function reviewStateTone(value: string): BadgeTone {
  const state = value.trim().toLowerCase()
  if (state.includes('conflict') || state === 'blocked' || state === 'failed') return 'danger'
  if (state.includes('pending')) return 'amber'
  if (state === 'in-review') return 'iris'
  if (state === 'open' || state === 'ready' || state === 'merged' || state === 'clean') return 'hop'
  return 'neutral'
}

export function StateBadge({ label, value }: { label: string; value: string }) {
  return (
    <Badge tone={reviewStateTone(value)}>
      <span className="text-muted-foreground/80">{label}</span>
      {value}
    </Badge>
  )
}

/**
 * Same fingerprint scheme as the previous review UI so existing threads
 * keep anchoring: `${hash}:${revision}:${line}`.
 */
export function reviewLineFingerprint(file: AgentFile, line: number | null): string {
  return [
    file.hash ?? 'hash-unavailable',
    file.revision?.toString() ?? 'rev-unavailable',
    line?.toString() ?? 'file',
  ].join(':')
}

/** Pulls the numeric part out of a formatted revision label like "main-rev 12". */
export function revisionNumber(revision: string): number | null {
  const match = revision.match(/\d+/)
  return match ? Number(match[0]) : null
}

const LOCALLY_CHANGED_STATES: ReadonlySet<AgentFileLocalState> = new Set([
  'dirty',
  'pending-upload',
  'uploaded',
])

export type ChangedFileReason = 'local' | 'revision'

export type ChangedFile = {
  file: AgentFile
  reason: ChangedFileReason
}

/**
 * A file counts as changed when its local cache state says it diverged
 * (dirty / pending-upload / uploaded) or its cloud revision is ahead of Main —
 * the same derivation the previous review surface used.
 */
export function deriveChangedFiles(files: AgentFile[], mainRevision: string): ChangedFile[] {
  const mainRev = revisionNumber(mainRevision)
  const changed: ChangedFile[] = []
  for (const file of files) {
    if (file.scope !== 'shared' || file.kind !== 'file') continue
    const locallyChanged = LOCALLY_CHANGED_STATES.has(file.local.state)
    const revisionChanged =
      mainRev !== null && typeof file.revision === 'number' && file.revision > mainRev
    if (locallyChanged || revisionChanged) {
      changed.push({ file, reason: locallyChanged ? 'local' : 'revision' })
    }
  }
  return changed.sort((a, b) => a.file.path.localeCompare(b.file.path))
}

export function fileStateTone(state: AgentFileLocalState): BadgeTone {
  if (state === 'dirty' || state === 'pending-upload') return 'amber'
  if (state === 'uploaded') return 'hop'
  if (state === 'blocked') return 'danger'
  return 'neutral'
}

/**
 * Review threads / decisions are hosted-D1-only. These error codes mean the
 * backend simply is not there — render a quiet note, not an error blowup.
 */
export function isBackendUnavailable(error: CollaborationError | null | undefined): boolean {
  if (!error) return false
  return (
    error.code === 'd1_required' ||
    error.code === 'cloud_backend_unavailable' ||
    error.code === 'http_503'
  )
}

export const BACKEND_UNAVAILABLE_NOTE = 'Review threads need the hosted D1 backend.'

export function QuietNote({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>
}

import type { AgentStatusSnapshot } from '@hopit/core'

export type HandoffAction = 'sync' | 'refresh' | 'recover' | 'hydrateWorkspace'

export type HandoffGuidance = {
  title: string
  detail: string
  reason: string | null
  command: HandoffAction | null
  commandLabel: string | null
}

export function handoffGuidance(status: AgentStatusSnapshot): HandoffGuidance | null {
  const conflictState = status.conflictState.trim().toLowerCase()
  if (!['none', 'clean', 'resolved', 'unavailable'].includes(conflictState)) {
    return {
      title: 'Conflicting edits are protected',
      detail: 'HopIt stopped the handoff before replacing local work. Refresh the change set, then review the conflict before continuing.',
      reason: `conflict:${status.conflictState}`,
      command: 'refresh',
      commandLabel: 'Refresh safely',
    }
  }

  const reason = status.remotePush.state === 'push-skipped'
    ? status.remotePush.lastSkippedReason ?? status.remotePush.lastError
    : status.remotePush.lastError
  if (reason === 'journal_has_unresolved_entries') {
    return {
      title: 'Handoff paused for journal recovery',
      detail: 'Pending or failed journal entries must be recovered before remote changes can be applied.',
      reason,
      command: 'recover',
      commandLabel: 'Recover journal',
    }
  }
  if (reason === 'local_sync_pending' || reason === 'workspace_has_unjournaled_changes') {
    return {
      title: 'Handoff paused for local work',
      detail: 'Sync the local changes first. The next safety check can then apply the remote revision without overwriting them.',
      reason,
      command: 'sync',
      commandLabel: 'Sync local work',
    }
  }
  if (reason === 'workspace_not_fully_materialized' || reason === 'workspace_missing') {
    return {
      title: 'This workspace is not ready for automatic handoff',
      detail: 'Hydrate the managed workspace before expecting pushed revisions to appear on this device.',
      reason,
      command: 'hydrateWorkspace',
      commandLabel: 'Hydrate workspace',
    }
  }
  if (status.remotePush.lastError) {
    return {
      title: 'Push delivery needs attention',
      detail: 'The periodic safety check remains read-only until it finds a newer clean revision. You can also run a safe refresh now.',
      reason: status.remotePush.lastError,
      command: 'refresh',
      commandLabel: 'Check remote now',
    }
  }
  if (status.state === 'blocked') {
    return {
      title: 'Handoff is blocked',
      detail: 'Recover the local journal, then refresh once the workspace is clean.',
      reason: null,
      command: 'recover',
      commandLabel: 'Recover journal',
    }
  }
  return null
}

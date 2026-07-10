import { describe, expect, it } from 'vitest'

import { offlineAgentStatus } from './defaults'
import { handoffGuidance } from './guidance'

describe('handoffGuidance', () => {
  it('offers journal recovery when a safe push refresh was skipped', () => {
    const status = offlineAgentStatus()
    status.state = 'blocked'
    status.conflictState = 'none'
    status.remotePush.enabled = true
    status.remotePush.state = 'push-skipped'
    status.remotePush.lastSkippedReason = 'journal_has_unresolved_entries'

    expect(handoffGuidance(status)).toMatchObject({
      reason: 'journal_has_unresolved_entries',
      command: 'recover',
      commandLabel: 'Recover journal',
    })
  })

  it('prioritizes conflict-safe refresh guidance over transport errors', () => {
    const status = offlineAgentStatus()
    status.state = 'blocked'
    status.conflictState = 'detected'
    status.remotePush.lastError = 'remote_push_stream_closed'

    expect(handoffGuidance(status)).toMatchObject({
      reason: 'conflict:detected',
      command: 'refresh',
      commandLabel: 'Refresh safely',
    })
  })

  it('does not keep showing a resolved historical push skip', () => {
    const status = offlineAgentStatus()
    status.state = 'online'
    status.conflictState = 'none'
    status.remotePush.enabled = true
    status.remotePush.state = 'push-connected'
    status.remotePush.lastSkippedReason = 'workspace_has_unjournaled_changes'

    expect(handoffGuidance(status)).toBeNull()
  })
})

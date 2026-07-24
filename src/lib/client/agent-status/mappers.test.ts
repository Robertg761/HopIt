// GR-D2 (decisions §7: "rotate, don't redact"). `mapRecentEvents` is what
// feeds the event ledger; it must describe `secret.suspected` as "possible
// secret in <path>" with rotation guidance and an escalated ("blocked") tone
// so it reads as a flag rather than routine activity.
import { describe, expect, it } from 'vitest'

import { mapRecentEvents } from './mappers'
import type { RawAgentEvent } from './normalize'

describe('mapRecentEvents', () => {
  it('describes a secret.suspected event with path, finding count, and rotation guidance', () => {
    const events: RawAgentEvent[] = [
      {
        event: 'secret.suspected',
        at: '2026-07-24T10:00:00.000Z',
        detail: { path: 'src/config/keys.js', findingCount: 2 },
      },
    ]

    const [mapped] = mapRecentEvents(events)
    expect(mapped.label).toBe('secret.suspected')
    expect(mapped.detail).toContain('Possible secret in src/config/keys.js')
    expect(mapped.detail).toContain('2 findings')
    expect(mapped.detail.toLowerCase()).toContain("rotate it, don't redact it")
    expect(mapped.tone).toBe('blocked')
  })

  it('falls back to a generic message when the path is missing', () => {
    const events: RawAgentEvent[] = [{ event: 'secret.suspected', at: '2026-07-24T10:00:00.000Z', detail: {} }]

    const [mapped] = mapRecentEvents(events)
    expect(mapped.detail).toBe("Possible secret found -- rotate it, don't redact it")
  })

  it('singularizes the finding count for exactly one finding', () => {
    const events: RawAgentEvent[] = [
      { event: 'secret.suspected', at: '2026-07-24T10:00:00.000Z', detail: { path: '.env', findingCount: 1 } },
    ]

    const [mapped] = mapRecentEvents(events)
    expect(mapped.detail).toContain('1 finding)')
    expect(mapped.detail).not.toContain('1 findings')
  })
})

// @vitest-environment jsdom

// GR-D2 (decisions §7: "rotate, don't redact"). The event ledger is a generic
// agent-event feed; `secret.suspected` must read as "possible secret in
// <path>" with rotation guidance (never "redact") and show up under the
// Privacy filter alongside other privacy-zone events.
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { AgentEvent } from '@/lib/client/agent-status'
import { EventLedger } from './event-ledger'

function makeEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id: 'evt-1',
    label: 'sync.complete',
    detail: 'Sync complete',
    when: '2m ago',
    tone: 'ready',
    ...overrides,
  }
}

describe('EventLedger', () => {
  it('renders a secret.suspected event as a rotation-guidance line', () => {
    render(
      <EventLedger
        events={[
          makeEvent({
            id: 'evt-secret',
            label: 'secret.suspected',
            detail: "Possible secret in src/config/keys.js (2 findings) -- rotate it, don't redact it",
          }),
        ]}
      />,
    )

    expect(screen.getByText(/Possible secret in src\/config\/keys\.js/)).toBeInTheDocument()
    expect(screen.getByText(/rotate it, don't redact it/i)).toBeInTheDocument()
  })

  it('surfaces secret.suspected events under the Privacy filter', () => {
    render(
      <EventLedger
        events={[
          makeEvent({ id: 'evt-sync', label: 'sync.complete', detail: 'Sync complete' }),
          makeEvent({ id: 'evt-secret', label: 'secret.suspected', detail: 'Possible secret in .env' }),
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Privacy' }))

    expect(screen.getByText('Possible secret in .env')).toBeInTheDocument()
    expect(screen.queryByText('Sync complete')).not.toBeInTheDocument()
  })
})

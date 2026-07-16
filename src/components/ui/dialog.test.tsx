// @vitest-environment jsdom

import * as React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { Dialog } from './dialog'

function DialogHarness() {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Confirm change"
        description="Review this action before continuing."
        footer={<button type="button">Continue</button>}
      >
        <input aria-label="Name" />
      </Dialog>
    </>
  )
}

describe('Dialog', () => {
  it('associates its title and description and restores focus on close', async () => {
    const user = userEvent.setup()
    render(<DialogHarness />)
    const trigger = screen.getByRole('button', { name: 'Open dialog' })
    await user.click(trigger)

    const dialog = screen.getByRole('dialog', { name: 'Confirm change' })
    expect(dialog).toHaveAccessibleDescription('Review this action before continuing.')
    expect(dialog).toContainElement(document.activeElement as HTMLElement)

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('keeps tab focus inside the modal', async () => {
    const user = userEvent.setup()
    render(<DialogHarness />)
    await user.click(screen.getByRole('button', { name: 'Open dialog' }))
    const dialog = screen.getByRole('dialog')

    for (let index = 0; index < 5; index += 1) {
      await user.tab()
      expect(dialog).toContainElement(document.activeElement as HTMLElement)
    }
  })
})

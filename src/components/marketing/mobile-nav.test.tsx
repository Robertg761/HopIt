// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { MobileNav } from './mobile-nav'

describe('MobileNav', () => {
  it('exposes every public destination and closes on Escape', async () => {
    const user = userEvent.setup()
    render(<MobileNav />)
    const trigger = screen.getByRole('button', { name: 'Open navigation' })
    await user.click(trigger)

    expect(screen.getByRole('navigation', { name: 'Public mobile' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'How it works' })).toHaveAttribute('href', '/#how-it-works')
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms')

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('navigation', { name: 'Public mobile' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})

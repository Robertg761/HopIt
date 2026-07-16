// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { PublicAuthActions } from './public-auth-actions'

describe('PublicAuthActions', () => {
  it('renders lightweight signed-out links without Clerk context', () => {
    render(<PublicAuthActions />)
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in')
    expect(screen.getByRole('link', { name: 'Start free' })).toHaveAttribute('href', '/sign-up')
  })

  it('renders the dashboard link for a signed-in session', () => {
    render(<PublicAuthActions signedIn />)
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute('href', '/overview')
    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument()
  })
})

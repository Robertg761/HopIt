// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ReleasesLoadState } from './use-releases'

const useReleases = vi.fn<[string | null], ReleasesLoadState | null>()

vi.mock('./use-releases', () => ({
  useReleases: (codebaseId: string | null) => useReleases(codebaseId),
}))

import { ReleasesCard } from './releases-card'

// GR-B4 (decisions §9): "release visible in dashboard test render" -- this is
// that render test. The card is flag-gated on the files page
// (NEXT_PUBLIC_RELEASES_LIST); this test exercises the card component
// directly, mirroring the derived-paths-card convention.

describe('ReleasesCard', () => {
  it('shows a loading state before the codebase is known', () => {
    useReleases.mockReturnValue({ status: 'loading' })
    render(<ReleasesCard codebaseId="repo" />)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('shows an empty state when there are no releases', () => {
    useReleases.mockReturnValue({ status: 'ready', data: [] })
    render(<ReleasesCard codebaseId="repo" />)
    expect(screen.getByText('No releases yet.')).toBeInTheDocument()
  })

  it('renders a release row with its name, notes, and pinned revision', () => {
    useReleases.mockReturnValue({
      status: 'ready',
      data: [
        {
          releaseId: 'rel_1',
          name: 'v1.0',
          notes: 'First cut',
          pinnedRevision: 2,
          createdByUserId: 'user_1',
          createdAt: '2026-07-24T00:00:00.000Z',
        },
      ],
    })
    render(<ReleasesCard codebaseId="repo" />)

    expect(screen.getByText('v1.0')).toBeInTheDocument()
    expect(screen.getByText('First cut')).toBeInTheDocument()
    expect(screen.getByText('rev 2')).toBeInTheDocument()
  })

  it('renders multiple releases', () => {
    useReleases.mockReturnValue({
      status: 'ready',
      data: [
        { releaseId: 'rel_2', name: 'v2.0', notes: null, pinnedRevision: 5, createdByUserId: 'user_1', createdAt: '2026-07-25T00:00:00.000Z' },
        { releaseId: 'rel_1', name: 'v1.0', notes: null, pinnedRevision: 2, createdByUserId: 'user_1', createdAt: '2026-07-24T00:00:00.000Z' },
      ],
    })
    render(<ReleasesCard codebaseId="repo" />)

    expect(screen.getByText('v2.0')).toBeInTheDocument()
    expect(screen.getByText('v1.0')).toBeInTheDocument()
  })

  it('surfaces an error message', () => {
    useReleases.mockReturnValue({ status: 'error', error: { code: 'releases_failed', message: 'The releases request failed.' } })
    render(<ReleasesCard codebaseId="repo" />)
    expect(screen.getByText('The releases request failed.')).toBeInTheDocument()
  })
})

// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ReviewDecision } from '@/lib/collaboration'
import type { DirectoryCompareResponse } from '@/lib/client/compare/types'
import { DecisionsCard } from './decisions-card'
import type { ReviewData } from './use-review-data'

// GR-B3 (decisions §4): a re-pinned proposal automatically stales existing
// review decisions -- the dashboard's "changed since your review" affordance
// (`stale`/`decisionRevision`/`currentPinnedRevision`, server-computed in
// packages/backend-d1/src/collaboration.js's `decorateReviewDecisionsWithStaleness`).

vi.mock('@/lib/client/compare/api', () => ({
  fetchDirectoryCompare: vi.fn(),
}))

import { fetchDirectoryCompare } from '@/lib/client/compare/api'

function makeDecision(overrides: Partial<ReviewDecision> = {}): ReviewDecision {
  return {
    id: 'rdec_1',
    codebaseId: 'codebase-1',
    changeSetId: 'cs_1',
    decision: 'approved',
    summary: 'Looks good',
    createdBy: 'reviewer_1',
    createdAt: '2026-07-24T10:00:00.000Z',
    proposalId: 'prop_1',
    decisionRevision: 2,
    currentPinnedRevision: 2,
    stale: false,
    ...overrides,
  }
}

function makeReview(decisions: ReviewDecision[]): ReviewData {
  return {
    codebaseId: 'codebase-1',
    threads: [],
    threadsLoading: false,
    threadsUnavailable: false,
    decisions,
    decisionsLoading: false,
    decisionsUnavailable: false,
    creatingThread: false,
    commentingThreadId: null,
    resolvingThreadId: null,
    submittingDecision: false,
    createThread: vi.fn(),
    addThreadComment: vi.fn(),
    resolveThread: vi.fn(),
    submitDecision: vi.fn(),
  }
}

describe('DecisionsCard', () => {
  it('does not show a stale badge for a non-stale decision', () => {
    render(<DecisionsCard review={makeReview([makeDecision()])} composerDisabledReason={null} />)
    expect(screen.queryByText(/changed since/i)).not.toBeInTheDocument()
  })

  it('shows a "changed since review" badge for a stale decision and fetches the diff summary', async () => {
    vi.mocked(fetchDirectoryCompare).mockResolvedValue({
      ok: true,
      codebaseId: 'codebase-1',
      mode: 'directory',
      leftRevision: 2,
      rightRevision: 4,
      summary: { added: 0, modified: 2, deleted: 0, unchanged: 3, missingBlob: 0, integrityFailures: 0, requiresLocalKey: 0, binaryChanged: 0 },
      entries: [],
    } satisfies DirectoryCompareResponse)

    render(
      <DecisionsCard
        review={makeReview([
          makeDecision({ decisionRevision: 2, currentPinnedRevision: 4, stale: true }),
        ])}
        composerDisabledReason={null}
      />,
    )

    expect(screen.getByText('Changed since review')).toBeInTheDocument()
    expect(fetchDirectoryCompare).toHaveBeenCalledWith('codebase-1', 2, 4)

    await waitFor(() => {
      expect(screen.getByText('2 files changed since this review')).toBeInTheDocument()
    })
  })

  it('renders a decision that predates proposals (no linked proposal) without a stale badge', () => {
    render(
      <DecisionsCard
        review={makeReview([
          makeDecision({ proposalId: null, decisionRevision: null, currentPinnedRevision: null, stale: false }),
        ])}
        composerDisabledReason={null}
      />,
    )
    expect(screen.queryByText(/changed since/i)).not.toBeInTheDocument()
  })
})

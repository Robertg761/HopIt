'use client'

import * as React from 'react'

import { apiErrorFromUnknown } from '@/lib/client/api'
import { fetchReleases } from '@/lib/client/releases/api'
import type { ReleasesError, ReleaseSummary } from '@/lib/client/releases/types'

/**
 * Owns the releases card's read: a single fetch of the codebase's releases,
 * reloaded whenever the codebase changes. Read-only: releases are created
 * from the agent CLI (`hop release <name> [--notes]`), so there is nothing
 * to mutate here.
 */

export type ReleasesLoadState =
  | { status: 'loading' }
  | { status: 'ready'; data: ReleaseSummary[] }
  | { status: 'error'; error: ReleasesError }

export function useReleases(codebaseId: string | null): ReleasesLoadState | null {
  const [state, setState] = React.useState<ReleasesLoadState | null>(null)

  React.useEffect(() => {
    if (!codebaseId) {
      setState(null)
      return
    }
    let cancelled = false
    setState({ status: 'loading' })
    void fetchReleases(codebaseId)
      .then((response) => {
        if (cancelled) return
        if (!response.ok) {
          setState({ status: 'error', error: response.error ?? unknownError() })
          return
        }
        setState({ status: 'ready', data: response.releases ?? [] })
      })
      .catch((error) => {
        if (cancelled) return
        setState({ status: 'error', error: apiErrorFromUnknown(error) as ReleasesError })
      })
    return () => {
      cancelled = true
    }
  }, [codebaseId])

  return state
}

function unknownError(): ReleasesError {
  return { code: 'releases_failed', message: 'The releases request failed.' }
}

'use client'

import * as React from 'react'

import { apiErrorFromUnknown } from '@/lib/client/api'
import { fetchDerivedPathSettings } from '@/lib/client/derived-paths/api'
import type { DerivedPathOverrides, DerivedPathsError } from '@/lib/client/derived-paths/types'

/**
 * Owns the derived-paths settings surface's read: a single fetch of the
 * curated built-in list plus the codebase's stored add/remove overrides,
 * reloaded whenever the codebase changes. Read-only: overrides are edited
 * from the agent CLI (`hop derived add|remove <path>`), so there is nothing
 * to mutate here.
 */

export type DerivedPathsLoadState =
  | { status: 'loading' }
  | { status: 'ready'; data: DerivedPathsReadyData }
  | { status: 'error'; error: DerivedPathsError }

export type DerivedPathsReadyData = {
  builtin: string[]
  overrides: DerivedPathOverrides
}

export function useDerivedPaths(codebaseId: string | null): DerivedPathsLoadState | null {
  const [state, setState] = React.useState<DerivedPathsLoadState | null>(null)

  React.useEffect(() => {
    if (!codebaseId) {
      setState(null)
      return
    }
    let cancelled = false
    setState({ status: 'loading' })
    void fetchDerivedPathSettings(codebaseId)
      .then((response) => {
        if (cancelled) return
        if (!response.ok) {
          setState({ status: 'error', error: response.error ?? unknownError() })
          return
        }
        setState({
          status: 'ready',
          data: {
            builtin: response.builtin ?? [],
            overrides: response.overrides ?? { add: [], remove: [] },
          },
        })
      })
      .catch((error) => {
        if (cancelled) return
        setState({ status: 'error', error: apiErrorFromUnknown(error) as DerivedPathsError })
      })
    return () => {
      cancelled = true
    }
  }, [codebaseId])

  return state
}

function unknownError(): DerivedPathsError {
  return { code: 'derived_paths_failed', message: 'The derived-path settings request failed.' }
}

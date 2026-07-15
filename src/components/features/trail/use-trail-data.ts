'use client'

import * as React from 'react'

import { apiErrorFromUnknown } from '@/lib/client/api'
import { fetchTrailEpisodes } from '@/lib/client/trail/api'
import type { TrailEpisode, TrailError, TrailSummariesSettings } from '@/lib/client/trail/types'

/**
 * Owns the trail-episode surface's read: a single fetch of the stored episodes
 * plus the codebase's trail-summaries setting, reloaded whenever the codebase
 * changes. Read-only. Labeling and toggling summaries happen from the agent CLI,
 * so there is nothing to mutate here.
 */

export type TrailLoadState =
  | { status: 'loading' }
  | { status: 'ready'; data: TrailReadyData }
  | { status: 'error'; error: TrailError }

export type TrailReadyData = {
  episodes: TrailEpisode[]
  summaries: TrailSummariesSettings
}

export function useTrailData(codebaseId: string | null): TrailLoadState | null {
  const [state, setState] = React.useState<TrailLoadState | null>(null)

  React.useEffect(() => {
    if (!codebaseId) {
      setState(null)
      return
    }
    let cancelled = false
    setState({ status: 'loading' })
    void fetchTrailEpisodes(codebaseId)
      .then((response) => {
        if (cancelled) return
        if (!response.ok) {
          setState({ status: 'error', error: response.error ?? unknownError() })
          return
        }
        setState({
          status: 'ready',
          data: {
            episodes: response.episodes ?? [],
            summaries: response.summaries ?? { enabled: false, mode: 'metadata' },
          },
        })
      })
      .catch((error) => {
        if (cancelled) return
        setState({ status: 'error', error: apiErrorFromUnknown(error) as TrailError })
      })
    return () => {
      cancelled = true
    }
  }, [codebaseId])

  return state
}

function unknownError(): TrailError {
  return { code: 'episodes_failed', message: 'The trail episodes request failed.' }
}

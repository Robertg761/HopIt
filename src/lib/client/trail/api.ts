import { apiFetch } from '@/lib/client/api'

import type { EpisodesResponse } from './types'

/**
 * Fetch wrapper over `/api/codebases/episodes`. Uses `allowErrorEnvelope` so
 * honest failure states (an unavailable backend, an authorization failure) come
 * back as data to render rather than thrown exceptions, matching the compare
 * surface's convention.
 */
export function fetchTrailEpisodes(codebaseId: string): Promise<EpisodesResponse> {
  const search = new URLSearchParams({ codebaseId })
  return apiFetch<EpisodesResponse>(`/api/codebases/episodes?${search.toString()}`, {
    allowErrorEnvelope: true,
  })
}

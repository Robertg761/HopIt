import { apiFetch } from '@/lib/client/api'

import type { ReleasesResponse } from './types'

/**
 * Fetch wrapper over `/api/codebases/releases`. Uses `allowErrorEnvelope` so
 * honest failure states (an unavailable backend, an authorization failure)
 * come back as data to render rather than thrown exceptions, matching the
 * derived-paths surface's convention.
 */
export function fetchReleases(codebaseId: string): Promise<ReleasesResponse> {
  const search = new URLSearchParams({ codebaseId })
  return apiFetch<ReleasesResponse>(`/api/codebases/releases?${search.toString()}`, {
    allowErrorEnvelope: true,
  })
}

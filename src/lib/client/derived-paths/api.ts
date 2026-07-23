import { apiFetch } from '@/lib/client/api'

import type { DerivedPathsResponse } from './types'

/**
 * Fetch wrapper over `/api/codebases/derived-paths`. Uses `allowErrorEnvelope`
 * so honest failure states (an unavailable backend, an authorization failure)
 * come back as data to render rather than thrown exceptions, matching the
 * trail-episodes surface's convention.
 */
export function fetchDerivedPathSettings(codebaseId: string): Promise<DerivedPathsResponse> {
  const search = new URLSearchParams({ codebaseId })
  return apiFetch<DerivedPathsResponse>(`/api/codebases/derived-paths?${search.toString()}`, {
    allowErrorEnvelope: true,
  })
}

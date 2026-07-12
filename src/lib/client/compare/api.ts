import { apiFetch } from '@/lib/client/api'

import type { DirectoryCompareResponse, FileDiffResponse, RevisionsResponse } from './types'

/**
 * Fetch wrappers over `/api/codebases/compare`. All three use the shared
 * `apiFetch` with `allowErrorEnvelope` so honest failure states (an expired
 * revision window, a missing blob, an unavailable backend) come back as data to
 * render, not thrown exceptions.
 */

function buildUrl(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  return `/api/codebases/compare?${search.toString()}`
}

export function fetchCompareRevisions(codebaseId: string): Promise<RevisionsResponse> {
  return apiFetch<RevisionsResponse>(buildUrl({ codebaseId }), { allowErrorEnvelope: true })
}

export function fetchDirectoryCompare(
  codebaseId: string,
  from: number,
  to: number,
): Promise<DirectoryCompareResponse> {
  return apiFetch<DirectoryCompareResponse>(buildUrl({ codebaseId, from, to }), {
    allowErrorEnvelope: true,
  })
}

export function fetchFileDiff(
  codebaseId: string,
  from: number,
  to: number,
  path: string,
): Promise<FileDiffResponse> {
  return apiFetch<FileDiffResponse>(buildUrl({ codebaseId, from, to, path }), {
    allowErrorEnvelope: true,
  })
}

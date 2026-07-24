/**
 * Client-facing shapes for the releases dashboard surface (GR-B4, decisions
 * §9). These mirror the `/api/codebases/releases` route envelope, a thin
 * read-only wrapper over the backend `listReleases` method. Mutation happens
 * from the agent CLI (`hop release <name> [--notes]`), never from the
 * dashboard.
 */

export type ReleaseSummary = {
  releaseId: string
  name: string
  notes: string | null
  pinnedRevision: number | null
  createdByUserId: string | null
  createdAt: string | null
}

export type ReleasesError = {
  code: string
  message: string
}

export type ReleasesResponse = {
  ok: boolean
  codebaseId: string | null
  releases?: ReleaseSummary[]
  error?: ReleasesError
}

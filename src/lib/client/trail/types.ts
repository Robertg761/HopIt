/**
 * Client-facing shapes for the trail-episode surface. These mirror the
 * `/api/codebases/episodes` route envelope, which is a thin read-only wrapper
 * over the backend `listTrailEpisodes` / `readCodebaseSettings` methods. We never
 * invent fields the engine does not persist — an episode's label may honestly be
 * null (not yet labeled), and summaries may be switched off entirely.
 */

export type TrailSummaryMode = 'metadata' | 'diff'

export type TrailEpisode = {
  episodeId: string
  fromRevision: number | null
  toRevision: number | null
  deviceName: string | null
  startedAt: string | null
  endedAt: string | null
  stepCount: number
  changedPathCount: number
  samplePaths: string[]
  label: string | null
  labelModel: string | null
  labelMode: string | null
  createdAt: string | null
  updatedAt: string | null
}

export type TrailSummariesSettings = {
  enabled: boolean
  mode: TrailSummaryMode
}

export type TrailError = {
  code: string
  message: string
}

export type EpisodesResponse = {
  ok: boolean
  codebaseId: string | null
  mode?: 'episodes'
  episodes?: TrailEpisode[]
  summaries?: TrailSummariesSettings
  error?: TrailError
}

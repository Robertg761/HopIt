import { defineBackendMethods } from './method-support.js'
import { clusterEpisodes } from './episodes.js'

export const SUMMARY_MODES = ['metadata', 'diff']

export function normalizeSummaryMode(value) {
  return value === 'diff' ? 'diff' : 'metadata'
}

export function normalizeCodebaseSettings(codebaseId, row) {
  return {
    codebaseId,
    trailSummariesEnabled: Boolean(row?.trail_summaries_enabled),
    trailSummariesMode: normalizeSummaryMode(row?.trail_summaries_mode),
    updatedAt: row?.updated_at ?? null,
  }
}

export function mapTrailEpisodeRow(row) {
  return {
    episodeId: row.episode_id,
    fromRevision: intOrNull(row.from_revision),
    toRevision: intOrNull(row.to_revision),
    deviceName: row.device ?? null,
    startedAt: row.started_at ?? null,
    endedAt: row.ended_at ?? null,
    stepCount: intOrNull(row.step_count) ?? 0,
    changedPathCount: intOrNull(row.changed_path_count) ?? 0,
    samplePaths: parseJsonArray(row.sample_paths_json),
    label: row.label ?? null,
    labelModel: row.label_model ?? null,
    labelMode: row.label_mode ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

export function attachEpisodeMethods(Backend) {
  defineBackendMethods(Backend, {
    async readCodebaseSettings(codebaseId = this.codebaseId) {
      await this.ensureSchema()
      const row = await this.first(
        `select * from codebase_settings where codebase_id = ? limit 1`,
        [codebaseId],
      )
      return normalizeCodebaseSettings(codebaseId, row)
    },

    async setTrailSummaries(codebaseId = this.codebaseId, { enabled, mode } = {}) {
      await this.ensureSchema()
      const now = new Date().toISOString()
      const current = await this.readCodebaseSettings(codebaseId)
      const nextEnabled = enabled === undefined ? current.trailSummariesEnabled : Boolean(enabled)
      const nextMode = mode === undefined ? current.trailSummariesMode : normalizeSummaryMode(mode)
      await this.query(
        `insert into codebase_settings (
          codebase_id, trail_summaries_enabled, trail_summaries_mode, created_at, updated_at
        ) values (?, ?, ?, ?, ?)
        on conflict(codebase_id) do update set
          trail_summaries_enabled = excluded.trail_summaries_enabled,
          trail_summaries_mode = excluded.trail_summaries_mode,
          updated_at = excluded.updated_at`,
        [codebaseId, nextEnabled ? 1 : 0, nextMode, now, now],
      )
      return {
        codebaseId,
        trailSummariesEnabled: nextEnabled,
        trailSummariesMode: nextMode,
        updatedAt: now,
      }
    },

    async listTrailEpisodes(codebaseId = this.codebaseId, { limit } = {}) {
      await this.ensureSchema()
      const rows = await this.query(
        `select * from trail_episodes where codebase_id = ? order by from_revision asc`,
        [codebaseId],
      )
      const mapped = rows.map(mapTrailEpisodeRow)
      const bounded = boundedLimit(limit)
      return bounded ? mapped.slice(-bounded) : mapped
    },

    async upsertTrailEpisode(codebaseId = this.codebaseId, episode = {}) {
      await this.ensureSchema()
      const now = new Date().toISOString()
      await this.query(
        `insert into trail_episodes (
          codebase_id, episode_id, from_revision, to_revision, device,
          started_at, ended_at, step_count, changed_path_count, sample_paths_json,
          label, label_model, label_mode, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(codebase_id, episode_id) do update set
          from_revision = excluded.from_revision,
          to_revision = excluded.to_revision,
          device = excluded.device,
          started_at = excluded.started_at,
          ended_at = excluded.ended_at,
          step_count = excluded.step_count,
          changed_path_count = excluded.changed_path_count,
          sample_paths_json = excluded.sample_paths_json,
          label = excluded.label,
          label_model = excluded.label_model,
          label_mode = excluded.label_mode,
          updated_at = excluded.updated_at`,
        [
          codebaseId,
          episode.episodeId,
          intOrNull(episode.fromRevision) ?? 0,
          intOrNull(episode.toRevision) ?? 0,
          episode.deviceName ?? null,
          episode.startedAt ?? null,
          episode.endedAt ?? null,
          intOrNull(episode.stepCount) ?? 0,
          intOrNull(episode.changedPathCount) ?? 0,
          JSON.stringify(Array.isArray(episode.samplePaths) ? episode.samplePaths : []),
          episode.label ?? null,
          episode.labelModel ?? null,
          episode.labelMode ?? null,
          now,
          now,
        ],
      )
      return { ok: true, codebaseId, episodeId: episode.episodeId }
    },

    async computeTrailEpisodes(codebaseId = this.codebaseId, options = {}) {
      const versions = await this.listFileVersions(codebaseId)
      return clusterEpisodes(versions, options)
    },
  })
}

function intOrNull(value) {
  return Number.isSafeInteger(value) ? value : null
}

function parseJsonArray(value) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function boundedLimit(value) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return null
  return Math.min(parsed, 1000)
}

import { randomUUID } from 'node:crypto'
import { defineBackendMethods } from './method-support.js'

// Same-owner multi-device divergence persistence (GR-A2, decisions §1). A
// divergence record is opened by the reconnect protocol (`packages/agent/src/
// reconnect.js` classification, applied in `packages/agent/src/commands/
// sync.js:recoverJournal`) the moment a path is classified as bucket 3 (both
// devices touched it, content differs) -- *before* any resolution happens.
// Nothing is ever silently dropped: `localEntry` on the record carries the
// offline device's full file payload, so it stays independently retrievable
// even though it is never written into `files` while the divergence is open.
// Resolution (GR-A3's `hop conflicts resolve`) writes a normal journaled
// step and then closes the record via `resolveDivergence` -- the record
// itself is never deleted, so both the local and cloud sides remain
// recoverable from the trail forever.

export const divergenceState = {
  open: 'open',
  resolved: 'resolved',
}

export function divergenceId() {
  return `dvg_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
}

export function normalizeDivergenceRow(row) {
  if (!row) return null
  return {
    divergenceId: row.divergence_id,
    codebaseId: row.codebase_id,
    path: row.path,
    scope: row.scope ?? null,
    state: row.state === divergenceState.resolved ? divergenceState.resolved : divergenceState.open,
    reason: row.reason ?? null,
    baseRevision: intOrNull(row.base_revision),
    cloudRevision: intOrNull(row.cloud_revision),
    localHash: row.local_hash ?? null,
    cloudHash: row.cloud_hash ?? null,
    localDevice: row.local_device ?? null,
    cloudDevice: row.cloud_device ?? null,
    localSide: row.local_side ?? null,
    cloudSide: row.cloud_side ?? null,
    localEntry: parseJsonOrNull(row.local_entry_json),
    openedAt: row.opened_at ?? null,
    resolvedAt: row.resolved_at ?? null,
    resolvedKeep: row.resolved_keep ?? null,
    resolvedRevision: intOrNull(row.resolved_revision),
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

function intOrNull(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : null
}

function parseJsonOrNull(value) {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export function attachDivergenceMethods(Backend) {
  defineBackendMethods(Backend, {
    async listDivergences(codebaseId = this.codebaseId, { state } = {}) {
      await this.ensureSchema()
      const rows = state
        ? await this.query(
          `select * from divergences where codebase_id = ? and state = ? order by opened_at asc, divergence_id asc`,
          [codebaseId, state],
        )
        : await this.query(
          `select * from divergences where codebase_id = ? order by opened_at asc, divergence_id asc`,
          [codebaseId],
        )
      return rows.map(normalizeDivergenceRow)
    },

    async getDivergence(codebaseId = this.codebaseId, id) {
      await this.ensureSchema()
      const row = await this.first(
        `select * from divergences where codebase_id = ? and divergence_id = ? limit 1`,
        [codebaseId, id],
      )
      return normalizeDivergenceRow(row)
    },

    async getOpenDivergence(codebaseId = this.codebaseId, path) {
      await this.ensureSchema()
      const row = await this.first(
        `select * from divergences where codebase_id = ? and path = ? and state = 'open'
          order by opened_at desc limit 1`,
        [codebaseId, path],
      )
      return normalizeDivergenceRow(row)
    },

    // Idempotent: reconnecting again against the same still-diverged path
    // (agent restart mid-divergence, a repeated `hop recover`) refreshes the
    // existing open record in place rather than opening a second one, so the
    // divergence is preserved -- never duplicated, never silently replaced.
    async openDivergence(codebaseId = this.codebaseId, divergence = {}) {
      await this.ensureSchema()
      if (!divergence.path) throw new Error('openDivergence requires a path')
      const existing = await this.getOpenDivergence(codebaseId, divergence.path)
      const now = new Date().toISOString()
      const id = existing?.divergenceId ?? divergenceId()
      const openedAt = existing?.openedAt ?? now
      const createdAt = existing?.createdAt ?? now
      await this.query(
        `insert into divergences (
          divergence_id, codebase_id, path, scope, state, reason,
          base_revision, cloud_revision, local_hash, cloud_hash,
          local_device, cloud_device, local_side, cloud_side, local_entry_json,
          opened_at, resolved_at, resolved_keep, resolved_revision,
          created_at, updated_at
        ) values (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, null, ?, ?)
        on conflict(divergence_id) do update set
          scope = excluded.scope,
          state = 'open',
          reason = excluded.reason,
          base_revision = excluded.base_revision,
          cloud_revision = excluded.cloud_revision,
          local_hash = excluded.local_hash,
          cloud_hash = excluded.cloud_hash,
          local_device = excluded.local_device,
          cloud_device = excluded.cloud_device,
          local_side = excluded.local_side,
          cloud_side = excluded.cloud_side,
          local_entry_json = excluded.local_entry_json,
          resolved_at = null,
          resolved_keep = null,
          resolved_revision = null,
          updated_at = excluded.updated_at`,
        [
          id,
          codebaseId,
          divergence.path,
          divergence.scope ?? null,
          divergence.reason ?? null,
          divergence.baseRevision ?? null,
          divergence.cloudRevision ?? null,
          divergence.localHash ?? null,
          divergence.cloudHash ?? null,
          divergence.localDevice ?? null,
          divergence.cloudDevice ?? null,
          divergence.localSide ?? null,
          divergence.cloudSide ?? null,
          divergence.localEntry ? JSON.stringify(divergence.localEntry) : null,
          openedAt,
          createdAt,
          now,
        ],
      )
      return this.getDivergence(codebaseId, id)
    },

    // Closes an open divergence. `keep` is 'local' | 'cloud' | 'combined'
    // (decisions §1: a user-edited resolution counts as combined).
    // `resolvedRevision` is the graph revision the resolution step landed on,
    // if any (an already-matching resolution -- e.g. keeping cloud with no
    // further edit -- may have no new revision). The record itself is never
    // deleted, so both sides stay in the trail forever.
    async resolveDivergence(codebaseId = this.codebaseId, id, { keep, resolvedRevision } = {}) {
      await this.ensureSchema()
      const now = new Date().toISOString()
      await this.query(
        `update divergences set
          state = 'resolved',
          resolved_at = ?,
          resolved_keep = ?,
          resolved_revision = ?,
          updated_at = ?
        where codebase_id = ? and divergence_id = ?`,
        [now, keep ?? null, resolvedRevision ?? null, now, codebaseId, id],
      )
      return this.getDivergence(codebaseId, id)
    },
  })
}

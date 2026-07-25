import { randomUUID } from 'node:crypto'
import { defineBackendMethods } from './method-support.js'

// Releases (GR-B4, decisions §9): "mark this Main state as a release" -- a
// named, permanently pinned pointer at a Main revision, with optional notes.
// Unlike proposals (one re-pinned-in-place row per change-set lifecycle),
// every `hop release <name>` call inserts a brand-new row: releases are
// historical facts ("this is what shipped as v1.2"), never mutated or
// re-pinned once created.
//
// Names are unique per codebase (decisions §9, "answers exactly what shipped
// as v1.2"), enforced in application code -- see the comment on the
// `releases` table in schema.js for why this isn't a SQL unique constraint.
// `createRelease` below is the only write path, and it always checks
// `getReleaseByName` first.
//
// GR-E3: `hop release` (packages/agent/src/commands/release.js) reads this
// row right after creating it to emit a git tag on the mirror when one is
// configured (packages/agent/src/commands/mirror.js `runMirrorTagRelease`):
// `name` is the tag name, `pinnedRevision` is the Main revision the mirror
// commit is looked up by.

export class DuplicateReleaseNameError extends Error {
  constructor(name, detail = {}) {
    super(`A release named "${name}" already exists for this codebase.`)
    this.name = 'DuplicateReleaseNameError'
    this.code = 'duplicate_release_name'
    this.detail = { reason: this.code, releaseName: name, ...detail }
  }
}

export function releaseId() {
  return `rel_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
}

export function normalizeReleaseRow(row) {
  if (!row) return null
  return {
    releaseId: row.release_id,
    codebaseId: row.codebase_id,
    name: row.name,
    notes: row.notes ?? null,
    pinnedRevision: intOrNull(row.pinned_revision),
    createdByUserId: row.created_by_user_id ?? null,
    createdAt: row.created_at ?? null,
  }
}

function intOrNull(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : null
}

export function attachReleaseMethods(Backend) {
  defineBackendMethods(Backend, {
    // Newest first -- the dashboard list and `hop release` both want "most
    // recent release" at the top.
    async listReleases(codebaseId = this.codebaseId) {
      await this.ensureSchema()
      const rows = await this.query(
        `select * from releases where codebase_id = ? order by created_at desc, release_id desc`,
        [codebaseId],
      )
      return rows.map(normalizeReleaseRow)
    },

    async getRelease(codebaseId = this.codebaseId, id) {
      await this.ensureSchema()
      const row = await this.first(
        `select * from releases where codebase_id = ? and release_id = ? limit 1`,
        [codebaseId, id],
      )
      return normalizeReleaseRow(row)
    },

    async getReleaseByName(codebaseId = this.codebaseId, name) {
      await this.ensureSchema()
      if (!name) return null
      const row = await this.first(
        `select * from releases where codebase_id = ? and name = ? limit 1`,
        [codebaseId, name],
      )
      return normalizeReleaseRow(row)
    },

    // `hop release <name> [--notes]`: pins the current Main revision under a
    // permanent, unique-per-codebase name. Throws `DuplicateReleaseNameError`
    // if the name is already taken (decisions §9: "duplicate names
    // rejected").
    async createRelease(codebaseId = this.codebaseId, {
      name,
      notes,
      pinnedRevision,
      actorId,
      now = new Date().toISOString(),
    } = {}) {
      await this.ensureSchema()
      if (!name) throw new Error('createRelease requires name')
      if (!Number.isInteger(pinnedRevision)) throw new Error('createRelease requires an integer pinnedRevision')

      const existing = await this.getReleaseByName(codebaseId, name)
      if (existing) throw new DuplicateReleaseNameError(name, { codebaseId })

      const id = releaseId()
      await this.query(
        `insert into releases (
          release_id, codebase_id, name, notes, pinned_revision,
          created_by_user_id, created_at
        ) values (?, ?, ?, ?, ?, ?, ?)`,
        [id, codebaseId, name, notes ?? null, pinnedRevision, actorId ?? null, now],
      )
      return this.getRelease(codebaseId, id)
    },
  })
}

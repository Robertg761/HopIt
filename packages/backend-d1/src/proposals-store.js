import { randomUUID } from 'node:crypto'
import { defineBackendMethods } from './method-support.js'

// First-class proposal persistence (GR-B2, decisions §2-4), against the
// `proposals` table GR-B1 already shipped (schema + migration only, no
// reads/writes). See docs/proposal-data-model-design.md for the full state
// machine, traceability table, and why this is a single re-pinned-in-place
// row per change-set lifecycle rather than a new row per propose/re-pin.
//
// OWNER CONSTRAINT (set at design approval, 2026-07-24): at most one *open*
// (non-merged) proposal may exist per (codebase_id, change_set_id) at a
// time. The design doc explains why this lives in application code, not a
// partial unique index (the GR-S1 drift-test parser only understands plain
// `create index` statements): `upsertProposal` below is the single write
// path that creates/re-pins a proposal, and it always looks up the existing
// open row for the change set first -- a second `hop propose` on the same
// change set can only ever update that row in place, never fork a second one.

export const proposalState = {
  draft: 'draft',
  proposed: 'proposed',
  approved: 'approved',
  stale: 'stale',
  merged: 'merged',
}

export const proposalStaleReason = {
  reviewStale: 'review_stale',
  mainConflict: 'main_conflict',
}

export function proposalId() {
  return `prop_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
}

export function normalizeProposalRow(row) {
  if (!row) return null
  return {
    proposalId: row.proposal_id,
    codebaseId: row.codebase_id,
    changeSetId: row.change_set_id,
    title: row.title ?? null,
    state: normalizeProposalState(row.state),
    pinnedRevision: intOrNull(row.pinned_revision),
    pinnedAt: row.pinned_at ?? null,
    baseRevision: intOrNull(row.base_revision),
    createdByUserId: row.created_by_user_id ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    queuedAt: row.queued_at ?? null,
    mergedAt: row.merged_at ?? null,
    mergedRevision: intOrNull(row.merged_revision),
    mergedByUserId: row.merged_by_user_id ?? null,
    staleAt: row.stale_at ?? null,
    staleReason: row.stale_reason ?? null,
  }
}

function normalizeProposalState(value) {
  return Object.values(proposalState).includes(value) ? value : proposalState.proposed
}

function intOrNull(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : null
}

export function attachProposalMethods(Backend) {
  defineBackendMethods(Backend, {
    async listProposals(codebaseId = this.codebaseId, { state, changeSetId } = {}) {
      await this.ensureSchema()
      const clauses = ['codebase_id = ?']
      const params = [codebaseId]
      if (state) {
        clauses.push('state = ?')
        params.push(state)
      }
      if (changeSetId) {
        clauses.push('change_set_id = ?')
        params.push(changeSetId)
      }
      const rows = await this.query(
        `select * from proposals where ${clauses.join(' and ')} order by updated_at asc, proposal_id asc`,
        params,
      )
      return rows.map(normalizeProposalRow)
    },

    async getProposal(codebaseId = this.codebaseId, id) {
      await this.ensureSchema()
      const row = await this.first(
        `select * from proposals where codebase_id = ? and proposal_id = ? limit 1`,
        [codebaseId, id],
      )
      return normalizeProposalRow(row)
    },

    // "At most one open proposal per change set" (owner constraint above):
    // the only non-merged row for a given change set, if any. `stale` still
    // counts as open -- it can be re-pinned back to `proposed` in place.
    async getOpenProposalForChangeSet(codebaseId = this.codebaseId, changeSetId) {
      await this.ensureSchema()
      if (!changeSetId) return null
      const row = await this.first(
        `select * from proposals where codebase_id = ? and change_set_id = ? and state != 'merged'
          order by updated_at desc limit 1`,
        [codebaseId, changeSetId],
      )
      return normalizeProposalRow(row)
    },

    async listReadyProposals(codebaseId = this.codebaseId) {
      await this.ensureSchema()
      const rows = await this.query(
        `select * from proposals where codebase_id = ? and state = 'approved'
          order by queued_at asc, proposal_id asc`,
        [codebaseId],
      )
      return rows.map(normalizeProposalRow)
    },

    // `hop propose [--title]`: pins the current change-set head as a
    // proposal, or -- per the owner constraint -- re-pins the existing open
    // proposal for this change set in place. Re-pinning resets `state` to
    // `proposed`, clears `queued_at`/stale markers (decisions §4: re-pinning
    // is what makes prior review decisions stale, GR-B3's write side), and
    // never touches `merged_at`/`merged_revision`/`merged_by_user_id` (those
    // only ever get set by `markProposalMerged` once, on the row's terminal
    // transition).
    async upsertProposal(codebaseId = this.codebaseId, {
      changeSetId,
      title,
      pinnedRevision,
      baseRevision,
      actorId,
      now = new Date().toISOString(),
    } = {}) {
      await this.ensureSchema()
      if (!changeSetId) throw new Error('upsertProposal requires changeSetId')
      const existing = await this.getOpenProposalForChangeSet(codebaseId, changeSetId)

      if (existing) {
        const nextTitle = title === undefined ? existing.title : title
        await this.query(
          `update proposals set
            title = ?,
            state = 'proposed',
            pinned_revision = ?,
            pinned_at = ?,
            base_revision = ?,
            updated_at = ?,
            queued_at = null,
            stale_at = null,
            stale_reason = null
          where codebase_id = ? and proposal_id = ?`,
          [nextTitle, pinnedRevision, now, baseRevision, now, codebaseId, existing.proposalId],
        )
        return this.getProposal(codebaseId, existing.proposalId)
      }

      const id = proposalId()
      await this.query(
        `insert into proposals (
          proposal_id, codebase_id, change_set_id, title, state,
          pinned_revision, pinned_at, base_revision, created_by_user_id,
          created_at, updated_at
        ) values (?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?)`,
        [id, codebaseId, changeSetId, title ?? null, pinnedRevision, now, baseRevision, actorId ?? null, now, now],
      )
      return this.getProposal(codebaseId, id)
    },

    // Solo path (`hop propose --merge`) and team review-approval both land
    // here: `state -> approved`, `queued_at` set to the instant it became
    // mergeable -- the merge queue's FIFO order key (design doc "Merge
    // queue serialization").
    async approveProposal(codebaseId = this.codebaseId, id, { now = new Date().toISOString() } = {}) {
      await this.ensureSchema()
      await this.query(
        `update proposals set state = 'approved', queued_at = ?, updated_at = ?
          where codebase_id = ? and proposal_id = ?`,
        [now, now, codebaseId, id],
      )
      return this.getProposal(codebaseId, id)
    },

    // `stale_reason` is one of `review_stale` (re-pinned after an approval
    // existed -- GR-B3's automation) or `main_conflict` (this task's merge
    // queue found the proposal's own changed paths overlap what changed on
    // Main since its base). Both block the queue; neither auto-resolves.
    async markProposalStale(codebaseId = this.codebaseId, id, { reason, now = new Date().toISOString() } = {}) {
      await this.ensureSchema()
      await this.query(
        `update proposals set state = 'stale', stale_at = ?, stale_reason = ?, queued_at = null, updated_at = ?
          where codebase_id = ? and proposal_id = ?`,
        [now, reason ?? null, now, codebaseId, id],
      )
      return this.getProposal(codebaseId, id)
    },

    // GR-B3 (decisions §4, design doc "how review staleness is derived" +
    // "queued_at is set the instant a proposal's most recent (non-stale)
    // review decision makes it mergeable"): the merge-queue guard. Team
    // review-approval (`createReviewDecision` in collaboration.js) is the
    // only path that ever creates a `review_decisions` row linked to a
    // proposal -- the solo self-approve path (`hop propose --merge`) calls
    // `approveProposal` directly and leaves no linked row. So "no linked
    // decision" unambiguously means solo self-approve, which this guard must
    // never block (GR-B2 stays intact); a linked decision exists only for
    // the team path, and the queue must refuse to land unless that most
    // recent decision is both `approved` and still pinned at the revision
    // the proposal currently sits at.
    async getLatestDecisionForProposal(codebaseId = this.codebaseId, proposalId) {
      await this.ensureSchema()
      if (!proposalId) return null
      const row = await this.first(
        `select decision, decision_revision from review_decisions
          where codebase_id = ? and proposal_id = ? order by created_at desc limit 1`,
        [codebaseId, proposalId],
      )
      if (!row) return null
      return { decision: row.decision, decisionRevision: intOrNull(row.decision_revision) }
    },

    async markProposalMerged(codebaseId = this.codebaseId, id, { mergedRevision, mergedByUserId, now = new Date().toISOString() } = {}) {
      await this.ensureSchema()
      await this.query(
        `update proposals set
          state = 'merged',
          merged_at = ?,
          merged_revision = ?,
          merged_by_user_id = ?,
          queued_at = null,
          updated_at = ?
        where codebase_id = ? and proposal_id = ?`,
        [now, mergedRevision ?? null, mergedByUserId ?? null, now, codebaseId, id],
      )
      return this.getProposal(codebaseId, id)
    },
  })
}

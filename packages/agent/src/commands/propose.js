// @ts-check
// GR-B2 (decisions §2-4, docs/proposal-data-model-design.md -- owner-approved
// 2026-07-24): `hop propose` and the merge queue that lands ready proposals.
// Main has exactly one door: propose -> review -> merge queue (decisions
// §2). This module is that door. `mergeChangeSet` in sync.js remains for
// the plain, proposal-less path and shares the same `advanceMainToRevision`
// Main-write primitive (see its comment there) so there is exactly one code
// path that ever mutates `cloud.main.revision`.
//
// OWNER CONSTRAINT (set at design approval): at most one *open*
// (non-merged) proposal exists per change set at a time -- `proposeChangeSet`
// below always re-pins the existing open proposal for the active change set
// in place instead of creating a second one (enforced by
// `upsertProposal`/`getOpenProposalForChangeSet` in the cloud service, see
// docs/proposal-data-model-design.md "One row per proposal lifecycle").
import { randomUUID } from 'node:crypto'
import { proposalStaleReason, proposalState } from '@hopit/backend-d1'
import { createCloudGraphService } from '../cloud/d1-graph-service.js'
import { emit } from '../io.js'
import { actorIdFromOptions, ensureActiveChangeSet } from '../journal.js'
import { advanceMainToRevision } from './sync.js'

// `hop propose [--title <text>]`: pins the active change set's current head
// as a proposal. A second `hop propose` on the same, still-unmerged change
// set re-pins the *same* row in place (the owner constraint above) --
// `pinned_revision` moves forward, `state` resets to `proposed`, and any
// prior `queued_at` is cleared, so post-propose saves never silently change
// what a pending merge would land (decisions §4).
export async function proposeChangeSet(options, { title } = {}) {
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()
  const now = new Date().toISOString()
  const actorId = actorIdFromOptions(options, cloud)

  ensureActiveChangeSet(cloud)
  if (cloud.selectedState.mergeState === 'merged') {
    throw new Error('Cannot propose because the selected change set is already merged.')
  }

  const proposal = await cloudService.upsertProposal(cloud.codebase.id, {
    changeSetId: cloud.selectedState.id,
    title,
    pinnedRevision: cloud.selectedState.revision,
    baseRevision: cloud.main.revision,
    actorId,
    now,
  })

  await emit(options, 'proposal.pinned', {
    proposalId: proposal.proposalId,
    codebaseId: cloud.codebase.id,
    changeSetId: proposal.changeSetId,
    title: proposal.title,
    state: proposal.state,
    pinnedRevision: proposal.pinnedRevision,
    baseRevision: proposal.baseRevision,
    createdByUserId: proposal.createdByUserId,
  })

  return proposal
}

// Solo self-approve and the (future, GR-B3-surfaced) team review-approval
// both land here: `state -> approved`, `queued_at` set to the instant it
// became mergeable -- the merge queue's FIFO order key.
export async function approveProposal(options, { proposalId: id } = {}) {
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()
  const now = new Date().toISOString()
  const actorId = actorIdFromOptions(options, cloud)
  const codebaseId = cloud.codebase.id

  const proposal = id
    ? await cloudService.getProposal(codebaseId, id)
    : await cloudService.getOpenProposalForChangeSet(codebaseId, cloud.selectedState?.id)

  if (!proposal) throw new Error('No proposal found to approve.')
  if (proposal.state === proposalState.merged) {
    throw new Error(`Proposal ${proposal.proposalId} is already merged.`)
  }

  const approved = await cloudService.approveProposal(codebaseId, proposal.proposalId, { now })
  await emit(options, 'proposal.approved', {
    proposalId: approved.proposalId,
    codebaseId,
    changeSetId: approved.changeSetId,
    approvedBy: actorId,
    queuedAt: approved.queuedAt,
  })
  return approved
}

// `hop propose --merge`: solo path (decisions §3 -- "owner self-approves in
// the same command... same door, zero extra ceremony"). Pins, self-approves,
// then drains the merge queue through the exact same path a team review
// approval would use.
export async function proposeAndMerge(options, { title } = {}) {
  const proposal = await proposeChangeSet(options, { title })
  await approveProposal(options, { proposalId: proposal.proposalId })
  const outcomes = await runMergeQueue(options)
  return { proposal, outcomes }
}

export async function runProposeCommand(options) {
  if (options.merge) return proposeAndMerge(options, { title: options.title })
  const proposal = await proposeChangeSet(options, { title: options.title })
  return { proposal, outcomes: [] }
}

// The merge queue: lands every currently-`approved` proposal for this
// codebase, oldest `queued_at` first, refreshing against latest Main before
// each land (design doc "Merge queue serialization"). Draining happens in
// one straight-line loop -- always re-listing "ready" proposals after each
// land -- so a proposal queued behind one that just landed is evaluated
// against the *just-landed* Main revision, never a stale snapshot: this is
// what gives "two ready proposals merge serially, the second refreshed
// against the first's result" with no explicit lock.
export async function runMergeQueue(options) {
  const cloudService = createCloudGraphService(options)
  const cloud = await cloudService.readGraph()
  const codebaseId = cloud.codebase.id
  const actorId = actorIdFromOptions(options, cloud)

  const outcomes = []
  for (;;) {
    const ready = await cloudService.listReadyProposals(codebaseId)
    if (ready.length === 0) break
    const outcome = await landOneProposal(options, cloudService, ready[0], actorId)
    outcomes.push(outcome)
    // Defensive only: every reachable outcome flips the proposal's state
    // away from 'approved' (merged or stale), so `ready` always shrinks.
    // A 'skipped' outcome means the row already moved (e.g. raced by
    // another caller) -- stop rather than spin.
    if (outcome.outcome === 'skipped') break
  }
  return outcomes
}

async function landOneProposal(options, cloudService, candidate, actorId) {
  const cloud = await cloudService.readGraph()
  const codebaseId = cloud.codebase.id
  const now = new Date().toISOString()

  // Re-read the proposal fresh -- `candidate` is a snapshot from the queue
  // listing a moment ago.
  const proposal = await cloudService.getProposal(codebaseId, candidate.proposalId)
  if (!proposal || proposal.state !== proposalState.approved) {
    return { proposalId: candidate.proposalId, outcome: 'skipped', reason: 'not-approved' }
  }

  const mainRevision = cloud.main.revision
  if (proposal.baseRevision !== mainRevision) {
    const requester = { requesterId: actorId }
    // Design doc: "compareRevisions(base_revision, cloud.main.revision) to
    // check whether the paths Main gained overlap the proposal's own
    // changed paths." This codebase has a single shared linear revision
    // timeline (one `selectedState`/`files` map per codebase, no true
    // branch storage), so a later proposal's own range always structurally
    // *contains* an earlier, already-landed proposal's changes as an
    // ancestor -- comparing from the original `base_revision` would flag
    // every serial (non-conflicting) merge as "overlap". Comparing the
    // proposal's own paths from the just-refreshed Main position instead
    // isolates genuinely-this-proposal's incremental edits, matching the
    // design's stated intent ("no overlap -> merge proceeds... content
    // unchanged, only the CAS baseline moves") while staying correct for
    // this storage model.
    const [mainGained, proposalOwn] = await Promise.all([
      cloudService.compareRevisions(proposal.baseRevision, mainRevision, requester),
      cloudService.compareRevisions(mainRevision, proposal.pinnedRevision, requester),
    ])
    const overlap = !mainGained.ok || !proposalOwn.ok
      // Can't verify safety (e.g. retention expired the comparison) --
      // "safe before clever": treat as a conflict rather than guess.
      ? true
      : intersectChangedPaths(mainGained, proposalOwn).length > 0

    if (overlap) {
      const stale = await cloudService.markProposalStale(codebaseId, proposal.proposalId, {
        reason: proposalStaleReason.mainConflict,
        now,
      })
      await emit(options, 'proposal.stale', {
        proposalId: stale.proposalId,
        codebaseId,
        changeSetId: stale.changeSetId,
        staleReason: stale.staleReason,
        mainRevision,
        proposalBaseRevision: proposal.baseRevision,
      })
      return { proposalId: stale.proposalId, outcome: 'stale', reason: proposalStaleReason.mainConflict }
    }
  }

  const previousMainRevision = cloud.main.revision
  const willRotate = cloud.selectedState?.id === proposal.changeSetId

  // GR-B2 (design doc "change-set rotation on merge"): once the change set
  // this proposal pinned actually lands, it can no longer accept saves
  // (`selected_state_already_merged`) -- rotate to a fresh active change
  // set, in the same write as the Main advance, so work can continue. The
  // rotated change set's base must be the *newly landed* Main revision, so
  // `rotateActiveChangeSet` runs inside `beforeWrite`, after
  // `advanceMainToRevision` has already mutated `cloud.main` but before the
  // graph is persisted.
  await advanceMainToRevision(options, cloudService, cloud, {
    revision: proposal.pinnedRevision,
    mergedChangeSetId: proposal.changeSetId,
    actorId,
    now,
    beforeWrite: willRotate ? (graph) => { graph.selectedState = rotateActiveChangeSet(graph, now) } : null,
  })

  const merged = await cloudService.markProposalMerged(codebaseId, proposal.proposalId, {
    mergedRevision: proposal.pinnedRevision,
    mergedByUserId: actorId,
    now,
  })

  await emit(options, 'proposal.merged', {
    proposalId: merged.proposalId,
    codebaseId,
    changeSetId: merged.changeSetId,
    mainRevision: cloud.main.revision,
    previousMainRevision,
    mergedRevision: merged.mergedRevision,
    mergedByUserId: merged.mergedByUserId,
    rotatedChangeSetId: cloud.selectedState?.id ?? null,
  })

  return { proposalId: merged.proposalId, outcome: 'merged', mergedRevision: merged.mergedRevision, previousMainRevision }
}

function intersectChangedPaths(left, right) {
  const leftPaths = new Set(changedPaths(left))
  return changedPaths(right).filter((path) => leftPaths.has(path))
}

function changedPaths(compareResult) {
  if (!compareResult?.ok) return []
  return compareResult.entries.filter((entry) => entry.state !== 'unchanged').map((entry) => entry.path)
}

// A freshly landed proposal's change set is done -- it can never accept
// another save (`selected_state_already_merged`). The next active change
// set's *base* is exactly where Main now sits (proposal.pinnedRevision), but
// its *head* must stay at the live `cloud.revision` -- saves made after
// proposing (decisions §4: "saves after proposing accumulate as 'since
// proposal'") are not part of what just landed and must not be discarded;
// they carry forward as the new change set's own unproposed work.
// `cloud.selectedState.revision` always tracks `cloud.revision` exactly
// (see `applyJournalEntryToCloud`), so either works as the head value.
function rotateActiveChangeSet(cloud, now) {
  const previous = cloud.selectedState
  const liveRevision = Number.isInteger(cloud.revision) ? cloud.revision : cloud.main.revision
  return {
    type: 'active-change-set',
    id: `cs_${cloud.codebase.id}_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`,
    ownerId: previous?.ownerId ?? cloud.owner?.id ?? cloud.codebase?.ownerId ?? null,
    baseMainId: cloud.main.id,
    baseRevision: cloud.main.revision,
    revision: liveRevision,
    visibility: previous?.visibility ?? 'private',
    effectiveVisibility: previous?.effectiveVisibility ?? previous?.visibility ?? 'private',
    reviewState: 'not-open',
    mergeState: 'unmerged',
    conflictState: 'none',
    conflict: null,
    review: null,
    merge: null,
    createdAt: now,
  }
}

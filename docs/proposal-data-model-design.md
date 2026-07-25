# Proposal data model design (GR-B1)

Approved by the owner (Robert) on 2026-07-24, as-is. Additional constraint set at approval time: at most one open proposal per change set -- GR-B2 must enforce this at propose time.

Status: **design-gated**, awaiting owner sign-off before GR-B2 writes any
propose/merge-queue code against this schema. Created 2026-07-24 for
[GR-B1](git-replacement-implementation-plan.md#gr-b1-proposal-data-model-design--migration-design-gated).
Implements the schema half of
[docs/git-replacement-decisions-2026-07.md](git-replacement-decisions-2026-07.md)
§2 (authority), §3 (propose is the same for solo and team), and §4 (a
proposal pins a trail step). No command code (`hop propose`, merge-queue
runner) ships in this task -- see [Deferred to GR-B2/B3/B4/B5](#deferred-to-gr-b2b3b4b5)
below for exactly what is and isn't built here.

## What already exists (do not duplicate)

- **`review_threads`** (`packages/backend-d1/src/schema.js`) already carries
  `change_set_id`, `base_revision`, `head_revision` for inline file/line
  comments on a change set.
- **`review_decisions`** already carries `codebase_id`, `change_set_id`,
  `decision` (`approved` / `changes-requested` / `commented`), an append-only
  event log (one row per decision, no update-in-place).
- **`action_jobs`** is a generic CI-style work queue: `status`
  (`queued`/`running`/`succeeded`/`failed`), `runner_id`, claim/complete
  methods in `packages/backend-d1/src/actions.js`. It has no concept of a
  change set or proposal today.
- **`cloud.selectedState`** (`packages/agent/src/cloud/d1-graph-service.js`,
  `packages/agent/src/journal.js`) is the *ephemeral* active-change-set head:
  `type`, `id`, `baseRevision`, `revision`, `reviewState`
  (`not-open`/`open`/`merged`), `mergeState` (`unmerged`/`merged`). It lives
  inside the single JSON blob (`codebases.selected_state_json`) that backs
  the whole graph, guarded by `codebases.revision` as a compare-and-swap
  (CAS) key on every write (`packages/backend-d1/src/graph.js`,
  `where codebase_id = ? and revision = ?`).
- **`openChangeSetReview` / `mergeChangeSet`**
  (`packages/agent/src/commands/sync.js`) already implement "open the active
  change set for review" and "merge it into Main," but there is no
  first-class, persisted **proposal** object: a proposal today is just
  `selectedState` with `reviewState = 'open'`, which cannot record a pinned
  historical revision distinct from the live head, cannot exist alongside a
  second in-flight proposal, and disappears (is overwritten) the moment the
  owner keeps saving.
- **`compareRevisions(left, right, requester)`**
  (`packages/backend-d1/src/graph.js`, exposed through
  `packages/agent/src/cloud/d1-graph-service.js`) is the WS7c revision-diff
  engine used by `hop compare`, trail summaries, and the dashboard compare
  view. It is the *only* diff machinery in the codebase and this design reuses
  it for both "saves since proposal" and refresh-conflict detection -- no new
  diff/merge algorithm is introduced.

## Proposal row shape

New table `proposals` (full DDL in
[`cloudflare/d1/migrations/2026-07-24-proposals.sql`](../cloudflare/d1/migrations/2026-07-24-proposals.sql),
mirrored in `packages/backend-d1/src/schema.js` and `cloudflare/d1/schema.sql`
so the GR-S1 drift guard passes today):

| Column | Type | Meaning |
| --- | --- | --- |
| `proposal_id` | text, PK | Opaque id, e.g. `prop_<base36 time>_<uuid8>` (matches `action_jobs.job_id` convention). |
| `codebase_id` | text | FK to `codebases`, `on delete cascade`. |
| `change_set_id` | text | The active change set this proposal pins (`cloud.selectedState.id`). |
| `title` | text, nullable | Optional human title (`hop propose --title`). |
| `state` | text | `draft` \| `proposed` \| `approved` \| `stale` \| `merged`. Default `proposed`. |
| `pinned_revision` | integer | The change-set revision (`cloud.selectedState.revision`) pinned at propose/re-pin time. **This is the trail step.** |
| `pinned_at` | text (ISO) | When `pinned_revision` was last set (propose or re-pin). |
| `base_revision` | integer | Main's revision (`cloud.main.revision`) as of the pin -- the CAS baseline the queue refreshes against before merging. |
| `created_by_user_id` | text | The proposer. |
| `created_at` / `updated_at` | text (ISO) | Row lifecycle timestamps. |
| `queued_at` | text, nullable | Set the instant `state` becomes `approved`; the merge queue's FIFO order key. Cleared on re-pin or merge. |
| `merged_at` | text, nullable | Set on landing. |
| `merged_revision` | integer, nullable | The Main revision the proposal produced (== `pinned_revision` when the refresh needed no adjustment). |
| `merged_by_user_id` | text, nullable | Who ran the merge (solo: same actor as `created_by_user_id`, via `hop propose --merge`). |
| `stale_at` / `stale_reason` | text, nullable | When/why `state` became `stale` -- one of `review_stale` (re-pinned after approval) or `main_conflict` (refresh could not land cleanly). See [Staleness has two distinct causes](#staleness-has-two-distinct-causes). |

Indexes: `(codebase_id, change_set_id, updated_at)` for "the proposal history
of this change set," `(codebase_id, state, queued_at)` for the merge queue
scan.

**One row per proposal lifecycle, re-pinned in place.** Decisions §4 says
"the proposer explicitly updates the proposal" -- this is the same
`proposal_id` row, not a new one: `pinned_revision`/`pinned_at` are
overwritten, `state` resets to `proposed`, `queued_at` is cleared. A **new**
row only appears when a *new* change set is proposed -- i.e., after the prior
proposal for that `change_set_id` reaches `merged` and a fresh
`change_set_id` begins for subsequent work (change-set rotation on merge is
GR-B2 scope; this design only requires that `change_set_id` be stable across
re-pins and distinct across merge cycles, which the existing
`cloud.selectedState.id` / `cloud.main.mergedChangeSetId` fields already
provide).

At most one **non-merged** proposal should exist per `(codebase_id,
change_set_id)` at a time (re-pin, don't fork). SQLite/D1 partial unique
indexes exist, but the GR-S1 drift-test parser only recognizes plain
`create index if not exists ... on table(...)` statements (see
[Migration and drift-test compatibility](#migration-and-drift-test-compatibility)),
so this invariant is enforced in GR-B2's application code (look up the
existing non-merged row for `change_set_id` before deciding insert vs.
update), not in schema. Documented here as a deliberate app-level constraint,
not an oversight.

## How "saves since proposal" is computed

No new diff machinery. `compareRevisions(proposal.pinned_revision,
cloud.selectedState.revision, requester)` (the same WS7c engine `hop
compare` and trail summaries already call) answers "what changed between the
pinned step and the live head of this change set." The dashboard proposal
page renders that result under a "N saves since you proposed" affordance;
`hop propose` (no `--title` re-pin) can show the same diff as a
confirmation before re-pinning.

## How review staleness is derived

Every `review_decisions` row now carries `decision_revision` (the
`proposals.pinned_revision` the reviewer was looking at) and `proposal_id`
(added as additive columns -- existing rows get `NULL`, meaning "predates
proposals"). A decision is **stale** exactly when:

```
decision.proposal_id IS NOT NULL
  AND decision.decision_revision != (select pinned_revision from proposals where proposal_id = decision.proposal_id)
```

This is a plain integer comparison, not a `compareRevisions` diff -- decisions
§4 only requires detecting *that* the pin moved, not *what* changed (that's
the "saves since proposal" question above, answered separately).
`decision_revision`/`proposal_id` are schema-only in this task; the
write-side automation that marks decisions stale on re-pin, and the merge
guard that refuses to land an unreviewed pin, are GR-B3's scope (it depends
on GR-B2, which depends on this task).

## Staleness has two distinct causes

`proposals.state = 'stale'` covers two different situations,
disambiguated by `stale_reason`:

1. **`review_stale`** -- the proposer re-pinned to a newer step after an
   approval existed. The content is fine, it just needs re-review. Decisions
   §4: "automatically marks existing reviews as stale... the merge queue only
   lands a reviewed, pinned step."
2. **`main_conflict`** -- Main advanced (another proposal landed, or a direct
   owner action) since `base_revision`, and the queue's refresh attempt
   (below) found the proposal's changed paths overlap what changed on Main.
   This reuses the same "Main changed under you" detection as decisions §10
   (Track F, refresh under a live editor) and §2 ("resolving a conflict...
   only ever edits the resolver's own change set") -- the proposer resolves it
   in their own change set and re-pins, which is again just a re-pin
   (`review_stale`-shaped state reset), not a special code path.

Both reasons block the merge queue; neither auto-resolves. This is schema
only -- computing and writing `stale_reason` is GR-B2/B3 application logic.

## Merge queue serialization

**Decision: no new queue table.** `action_jobs` was considered and rejected
for this purpose: it is a claim/run/complete work queue for *executing CI
commands* (`runner_id`, `stdout`/`stderr`, `exit_code`) with no notion of a
change set, and reusing it would conflate "a shell command ran" with "a
change set landed on Main" -- two different objects with different failure
modes (a CI job can be retried without touching Main; a merge cannot be
retried once it has partially applied).

Instead, the merge queue is:

- **Order**: `select * from proposals where codebase_id = ? and state =
  'approved' order by queued_at asc`. `queued_at` is set the instant a
  proposal's most recent (non-stale) review decision makes it mergeable --
  solo path via `hop propose --merge` sets `state = 'approved'` and
  `queued_at` in the same request (decisions §3: "owner self-approves in the
  same command... same door, zero extra ceremony").
- **Mutual exclusion**: for free, from the CAS pattern every codebase write
  already uses (`update codebases set ... where codebase_id = ? and revision
  = ?`, see `packages/backend-d1/src/graph.js`). Landing a proposal is a
  `mergeChangeSet`-shaped write: it only succeeds if `cloud.main.revision`
  still equals what the queue runner read when it started processing that
  proposal. Two concurrent merge attempts for the same codebase can never
  both succeed -- the loser's CAS affects zero rows and it re-reads Main and
  either retries (if its own `base_revision` still cleanly refreshes) or
  marks itself `stale`/`main_conflict`.
- **Refresh, then merge**: before applying proposal N+1 (the second of two
  ready proposals), the queue re-reads `cloud.main.revision`. If it still
  equals `base_revision`, merge is a direct `mergeChangeSet` (no refresh
  needed -- nothing changed underneath it). If Main advanced (because
  proposal N just landed), the queue calls `compareRevisions(base_revision,
  cloud.main.revision)` to check whether the paths Main gained overlap the
  proposal's own changed paths (from `compareRevisions(base_revision,
  pinned_revision)`); no overlap ⇒ merge proceeds and `base_revision` is
  advanced to the new Main revision as part of the same write (content is
  unchanged -- only the CAS baseline moves); overlap ⇒ `state = 'stale'`,
  `stale_reason = 'main_conflict'`, queue moves to the next proposal.
- **Cross-codebase**: no shared lock needed -- `codebase_id` scopes every
  read/write, so unrelated codebases' queues drain independently and
  concurrently.

This gives GR-B2 exactly the acceptance shape the plan asks for: "two ready
proposals merge serially with the second refreshed against the first's
result... a proposal whose pinned revision no longer matches its reviewed
revision is not merged."

## Migration and drift-test compatibility

[`cloudflare/d1/migrations/2026-07-24-proposals.sql`](../cloudflare/d1/migrations/2026-07-24-proposals.sql)
is a **draft** migration: committed, documented, never applied by an agent --
the owner applies it by hand against production D1, per the repo's hard
guardrails. It:

1. Adds `review_decisions.decision_revision` / `review_decisions.proposal_id`
   via `alter table ... add column` (additive, matches the existing
   `device_authorizations` / `codebase_settings` migration precedent in this
   repo -- not idempotent by design, single-apply).
2. Creates the `proposals` table and its two indexes.

`packages/backend-d1/src/schema.js` (canonical runtime source) and
`cloudflare/d1/schema.sql` (fresh-database reference) both already declare
the identical table/columns/indexes, so `npm run agent:test -- --test-name-pattern
"schema drift"` (the GR-S1 guard, `packages/agent/test/schema-drift.test.js`)
passes unchanged. `packages/agent/test/proposal-schema-design.test.js` (new,
this task) additionally proves the migration file itself is *sufficient*: it
parses the migration's statements, unions them onto a copy of the runtime
schema with every proposal-related addition stripped back out, and asserts
the result is byte-for-byte structurally identical (same tables, columns,
indexes) to the real `schema.js` -- i.e., "applying this migration to a
pre-GR-B1 database reproduces exactly what ships in this PR," not just "the
migration file exists."

## Deferred to GR-B2/B3/B4/B5

Explicitly **not** built in this task (schema only, no reads/writes):

- `hop propose` / `hop propose --merge` commands, the merge-queue runner,
  `proposals` row creation/update -- **GR-B2**.
- Change-set rotation after merge (starting a fresh `change_set_id`) --
  **GR-B2**.
- Writing `review_decisions.decision_revision` / `.proposal_id` on decision
  creation, and the automation that marks decisions stale on re-pin
  (decisions §4, "automatically marks existing reviews as stale") --
  **GR-B3**.
- The dashboard "changed since your review" affordance
  (`compareRevisions(reviewedRev, pinnedRev)`) -- **GR-B3**.
- `releases` table, `hop release`, git-tag emission on the mirror (decisions
  §9) -- **GR-B4**. Releases pin a Main revision, not a proposal, so they have
  no FK into `proposals`; noted for completeness since GR-B4 depends on "the
  proposal/Main model settled" (this design), not on new proposal columns.
- Linking `action_jobs` to a specific proposal so CI can gate the merge
  queue (decisions §3, "CI's default trigger is on propose and in the merge
  queue") -- **GR-B5**. `action_jobs` gets its own additive `proposal_id` (or
  equivalent) column when GR-B5 lands; not added speculatively here to avoid
  shipping an unused FK ahead of the code that would populate it.
- Maintainer comment-only edits / one-click suggestions (decisions §5) -- no
  schema impact identified; `review_thread_comments` already supports
  attaching a comment to a thread, which is where a future "suggested patch"
  attachment would live. No action taken in this task.

## Traceability table

Every sentence-level commitment in decisions §2–§4 (plus the adjacent §3/§9
cross-references the plan calls out), mapped to either a design element in
this document or an explicit deferred line.

| # | Decisions doc statement (§2–§4, verbatim or close paraphrase) | Design element / Deferred |
| --- | --- | --- |
| 1 | §2 "Resolving a conflict... only ever edits the resolver's own change set. Main has exactly one door: propose → review → merge queue." | `proposals` is the only table that writes `cloud.main.revision` (via the reused CAS `mergeChangeSet` write path); no other write path advances Main. See [Merge queue serialization](#merge-queue-serialization). |
| 2 | §2 "The proposer owns the content of their change set..." | `proposals.created_by_user_id`; a proposal is always keyed to one `change_set_id`, which one actor's device(s) write to (existing `cloud.selectedState.ownerId`). No schema change needed beyond the existing ownership model. |
| 3 | §2 "The reviewer owns acceptance..." | `review_decisions` (existing) + new `decision_revision`/`proposal_id` linkage; `proposals.state` only reaches `approved` via a review decision (or the solo self-approve path), never by proposer action alone. |
| 4 | §2 "The merge queue owns ordering. Ready proposals land serially, refreshed against latest Main and CI-checked." | `proposals.queued_at` FIFO order + CAS mutual exclusion (see [Merge queue serialization](#merge-queue-serialization)). "CI-checked" -- **deferred to GR-B5** (no `action_jobs` linkage added yet, see above). |
| 5 | §2 "Outside contributors work in a remix... they never have any write path to upstream Main." | No schema change: proposals are always scoped to one `codebase_id`; a remix is a separate `codebase_id` (existing model) whose proposals can only ever target its own Main. Cross-codebase proposing is out of scope / not representable by this schema, which is the desired invariant. |
| 6 | §3 "Solo codebases use the same 'Propose Changes' button as teams -- no auto-flow mode." | Single `proposals` table/state-machine for both; solo path is `state: proposed → approved` in one command (`hop propose --merge`, **GR-B2**) rather than a schema variant. |
| 7 | §3 "Proposals are the known-good markers." / "Rollback UI leads with merged proposals, then episodes, then raw steps." | `proposals.merged_at`/`merged_revision` give the dashboard a queryable "known-good" list ordered by `merged_at`, distinct from `trail_episodes` (episodes) and `file_versions` (raw steps) -- the three-tier rollback UI is **deferred to a dashboard task**, no new table needed beyond what exists. |
| 8 | §3 "Bisect-style debugging anchors on proposals." | Same as above -- `proposals.merged_revision` is a stable, named anchor point; bisect UI itself is **deferred** (not GR-B1/B2 scope; noted for later dashboard work). |
| 9 | §3 "CI's default trigger is on propose and in the merge queue, not on every save." | **Deferred to GR-B5** -- requires the `action_jobs` ↔ `proposals` linkage called out above. |
| 10 | §3 "Propose is all-or-nothing per change set... there is no way to split a change set afterward." | One `proposal_id` ↔ one `change_set_id` ↔ one `pinned_revision` -- the schema has no concept of partial/selective proposing (no per-file proposal rows), which is the invariant, not an omission. |
| 11 | §3 "the propose screen suggests [a sandbox] when a change set has grown large or old" | UI nudge, no schema dependency -- **deferred**, out of scope for this data-model task. |
| 12 | §4 "A proposal is the change set as of a specific trail step, pinned at propose time." | `proposals.pinned_revision` + `pinned_at`. See [Proposal row shape](#proposal-row-shape). |
| 13 | §4 "Saves after proposing accumulate as 'since proposal'..." | `compareRevisions(pinned_revision, selectedState.revision)`. See [How "saves since proposal" is computed](#how-saves-since-proposal-is-computed). |
| 14 | §4 "the proposer explicitly updates the proposal, which automatically marks existing reviews as stale." | Re-pin resets `proposals.state`/`pinned_revision` in place (schema supports it); the automatic marking of `review_decisions` as stale is **deferred to GR-B3** (write-side automation), the columns it needs (`decision_revision`, `proposal_id`) ship in this task. |
| 15 | §4 "The merge queue only lands a reviewed, pinned step." | Merge queue scan is `state = 'approved'` only, and `state` can only become `approved` via a non-stale review decision (or solo self-approve) -- see rows 3–4. |
| 16 | §4 "This gives review a stable artifact and prevents landing states nobody reviewed." | Same as row 15 -- the CAS-guarded merge only ever applies `proposals.pinned_revision`, never the live (possibly-since-changed) `selectedState.revision`, so what was reviewed is exactly what lands (modulo the `main_conflict` refresh case, which blocks rather than silently substitutes content). |
| 17 | §9 (cross-reference, GR-B4 depends on "the proposal/Main model settled") "mark this as a release on any Main state." | No FK from `releases` into `proposals` -- releases pin a Main *revision*, which every merged proposal already produces via `merged_revision`. **Deferred to GR-B4** (own table, own migration); this design only needs to guarantee Main revisions are stable/addressable, which they already are. |

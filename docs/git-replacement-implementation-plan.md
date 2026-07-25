# Git-Replacement Implementation Plan

Created 2026-07-23. Turns the product decisions in
[docs/git-replacement-decisions-2026-07.md](git-replacement-decisions-2026-07.md)
into delegation-ready engineering tasks. Written to be executed by an
orchestrating agent that spawns one subagent per task.

Sources of truth, in precedence order:

1. [docs/product-roadmap.md](product-roadmap.md) — vision and phase gating.
2. [docs/git-replacement-decisions-2026-07.md](git-replacement-decisions-2026-07.md) — the product decisions this plan implements.
3. [docs/remediation-plan-2026-07.md](remediation-plan-2026-07.md) — engineering conventions (one workstream per branch, verification battery).
4. [docs/agent-architecture.md](agent-architecture.md) — agent invariants ("safe before clever", journal-first recovery).

## 0. Hard guardrails (every subagent, no exceptions)

This repo backs a **live personal production system**: `hopit.dev` on Vercel,
production Cloudflare D1 + R2, and a running LaunchAgent
(`com.hopit.agent.hopit`) on the owner's Mac.

- **Never** run production-profile commands: anything with
  `--profile production`, `hop:*` npm scripts, deploy scripts, `vercel`,
  `wrangler` against live resources, or live D1 migrations.
- **Never** touch `/Users/robert/HopIt Workspaces/` or Application Support
  runtime paths.
- All work happens against local test harnesses (loopback servers, temp dirs,
  in-memory/file-backed D1 stubs) — the existing agent test suite shows how.
- Schema changes: update **both** `packages/backend-d1/src/schema.js` and
  `cloudflare/d1/schema.sql`, plus a dated migration file in
  `cloudflare/d1/migrations/`. Never apply a migration to live D1; the owner
  applies migrations manually.
- One task per branch. Move-only refactors stay move-only.

## 1. Verification battery and baseline

Before starting any task, a subagent must record the **baseline**: run the
battery once on an untouched checkout and save the pass/fail/skip counts.
Acceptance is always measured **relative to baseline** — some suites skip or
fail for environment-only reasons on Linux (loopback ports, missing `git`,
macOS-only launchd tests).

Battery (from the repo root):

```sh
npm run agent:test     # node --test, packages/agent/test — baseline ~262 pass
npm run test:worker    # node --test, cloudflare/d1/api-worker.test.js — ~23
npm run test:web       # vitest, src/ — ~47
npm run lint
npm run build
npm run typecheck:agent
node packages/agent/src/cli.js --help   # CLI boot check
```

Definition of done for every task:

1. New tests written first or alongside, exercising the acceptance criteria.
2. Full battery passes with **zero regressions vs baseline**.
3. The task's quantitative metrics (below) are demonstrated by a test or a
   reproducible script, not by claim.
4. Docs updated when behavior or schema changed (`agent-architecture.md` for
   agent invariants, this plan's checkbox, `docs/progress.md` entry).
5. A final report: what changed, files touched, test evidence (pasted output),
   metrics results, known limitations.

## 2. Execution waves and dependency graph

Tasks within a wave are independent and may run in parallel (use worktree
isolation — several tasks touch `packages/agent/src/` and will conflict
textually otherwise). A wave starts only when its listed dependencies are
merged.

- **Wave 1 (no dependencies):** GR-S1, GR-A1, GR-C1, GR-D1, GR-E1, GR-G2,
  GR-G3, GR-H1, GR-H2, GR-H3, GR-H4
- **Wave 2:** GR-A2 (needs A1), GR-A3 (needs A1), GR-B1 (needs S1),
  GR-F1, GR-F2 (need A1's classification helpers), GR-G1 (needs H5 invariants
  defined; H5 is part of G1), GR-E2 (needs E1)
- **Wave 3:** GR-A4 (needs A2, A3), GR-B2 (needs B1), GR-D2 (needs D1),
  GR-E3 (needs E2, B2)
- **Wave 4:** GR-B3, GR-B4, GR-B5 (need B2), GR-X1 integration suite (needs
  A4, B2, C1, F2)

Phase alignment: Tracks A, C, D, F, G, H, S serve Phase 1–2 (daily driver /
sync you can show off). Track E serves Phase 1 (the owner's own deploys) but
per-proposal commits depend on Track B. Track B builds the propose/review data
model now but its **team-facing UI stays behind the collaboration-surface
freeze until Phase 4** — build primitives and CLI, gate dashboard surfaces
behind a flag.

---

## Track S — Schema foundations

### GR-S1: Re-sync `schema.sql` with the runtime schema, add drift guard

- **Why:** `cloudflare/d1/schema.sql` is stale vs
  `packages/backend-d1/src/schema.js` (missing `codebase_settings`,
  `trail_episodes`, `device_authorizations.requested_codebase_id/_name`).
  Every later schema task inherits this landmine.
- **Files:** `cloudflare/d1/schema.sql`, `packages/backend-d1/src/schema.js`,
  new test.
- **Do:** Regenerate `schema.sql` from `schema.js` (or vice versa — pick the
  runtime file as canonical). Add a test that parses both and fails on drift
  (table names + column names + indexes).
- **Accept:** drift test exists and passes; battery green.
- **Metric:** drift test fails when a column is intentionally removed from one
  side (demonstrate in the report, then restore).

---

## Track A — Reconnect protocol and same-owner divergence (decisions §1)

The journal (`packages/agent/src/journal.js`, `status-state.js`) and revision
guards (`packages/backend-d1/src/graph.js:909` `base_revision_mismatch`,
client-side `assertEntryBaseRevision`) already detect staleness. These tasks
build what happens next.

### GR-A1: Reconnect classification engine (three buckets)

- **Files:** `packages/agent/src/commands/sync.js` (`recoverJournal`),
  `packages/agent/src/status-state.js`, new
  `packages/agent/src/reconnect.js`, new test
  `packages/agent/test/reconnect-divergence.test.js`.
- **Do:** Before replaying journal entries on reconnect/restart, fetch the
  cloud head and classify each pending path: (1) only-local-touched → replay;
  (2) both-touched, identical content hash → auto-resolve as one step;
  (3) both-touched, differing → mark diverged, do **not** replay, do **not**
  clobber local. Ordering by base revision (causality), never wall clock.
- **Accept:** scenario tests using the two-device loopback harness pattern
  from `packages/agent/test/remote-push.test.js` / `agent-cli.test.js`:
  clean replay, identical-hash auto-resolve, real divergence, mixed batch,
  clock-skew (device clock set years off must not change outcomes),
  delete-vs-edit (classified as divergence with "deleted" as one side).
- **Metrics:** ≥ 12 new scenario tests; a 1,000-file journal with 3 divergent
  files classifies in < 5 s in the test harness; bucket-1 replay outcome
  byte-identical to pre-change `recoverJournal` behavior on a no-divergence
  journal (regression fixture).

### GR-A2: Divergence persistence — nothing silently dropped

- **Depends:** GR-A1.
- **Files:** `packages/agent/src/reconnect.js`, `journal.js`
  (`recordChangeSetConflict` exists — extend), `packages/backend-d1/src/graph.js`,
  schema (likely a `divergences` record or reuse of `agent_events` +
  file-version rows), migration file.
- **Do:** On bucket-3, upload the offline device's version to cloud storage as
  trail data **before** resolution (both sides recoverable forever); persist a
  divergence record (codebase, path, both revision refs, device labels,
  state open/resolved); resolution writes a normal journaled step and closes
  the record. Local file stays untouched until the user resolves.
- **Accept:** test proves both blobs retrievable from the (test) backend after
  reconnect and after resolution either way; agent restart mid-divergence
  preserves the open record; local file bytes unchanged until resolve.
- **Metrics:** 0 code paths that discard a diverged version (assert via test
  that picking "theirs" still leaves "mine" fetchable by revision); battery
  green.

### GR-A3: Divergence surfaces — status API, CLI, dashboard flag

- **Depends:** GR-A1.
- **Files:** agent status server (`status`/`status-server` command,
  `src/lib/client/agent-status/*`), new `hop conflicts` command
  (`packages/agent/src/commands/`, register in `cli.js`, `help.js`,
  `options.js`), dashboard: extend `src/components/features/review/`
  (`file-inspector.tsx` side-by-side pattern) with a device-labeled conflict
  view behind the existing codebase page.
- **Do:** `hop conflicts` lists open divergences (device labels, paths, ages)
  and `hop conflicts resolve <path> --keep local|cloud` resolves from the
  terminal. Status API exposes a `divergences` array; dashboard shows
  "MacBook version / Desktop version" side by side with pick-or-combine.
  No automatic line-level merge anywhere.
- **Accept:** CLI resolution round-trips in tests (both `--keep` directions);
  web tests (vitest) for the conflict component render both sides and labels;
  status JSON schema documented.
- **Metrics:** resolve-from-CLI covered for keep-local, keep-cloud, and
  combined (user-edited file counts as combined); battery green.

### GR-A4: Unified reconciliation path + reconnect ordering

- **Depends:** GR-A2, GR-A3.
- **Files:** `packages/agent/src/watch.js` (startup path),
  `workspace-manifest.js` (diff-scan), `reconnect.js`, `sync.js`.
- **Do:** On startup, diff-scan the workspace against last-known manifest,
  synthesize journal entries for unwatched changes (agent was dead), then run
  GR-A1 classification — one path for offline, crash, force-quit, and
  restored-from-backup. Enforce ordering: reconcile personal change set fully
  before the safe-refresh path applies missed Main updates; never interleaved.
- **Accept:** scenario tests: kill agent, edit files, restart → edits
  journaled and classified; restore an old manifest snapshot (simulated
  Time-Machine restore) → no mass-delete, divergences opened (reuse the
  `refresh_would_mass_delete` guard expectations); Main-moved-while-away →
  reconcile completes before refresh (event ordering asserted from
  `events.ndjson`).
- **Metrics:** ≥ 8 new scenario tests; the existing
  `refresh-mass-delete-guard` and `workspace-manifest-heal` suites unmodified
  and green (they encode invariants this task must not weaken).

---

## Track B — Propose, proposals-as-pinned-steps, releases (decisions §2–§4, §9)

`review_threads` already carries `change_set_id`, `base_revision`,
`head_revision`; `mergeChangeSet` and `openChangeSetReview` exist in
`packages/agent/src/commands/sync.js`. There is **no first-class proposals
table** — change sets are `selected_state_json` blobs. Team-facing dashboard
surfaces stay behind a feature flag until Phase 4 (collaboration freeze).

### GR-B1: Proposal data model design + migration (design-gated)

- **Depends:** GR-S1.
- **Deliverable:** a short design doc `docs/proposal-data-model-design.md` +
  draft migration. Must answer: proposal row shape (codebase, change set id,
  **pinned revision**, title, state draft/proposed/approved/stale/merged),
  how "saves since proposal" are computed (revision comparison via the WS7c
  `compareRevisions` engine — no new diff machinery), how review staleness is
  derived (`review_decisions` at revision X, head now Y ⇒ stale), and how the
  merge queue serializes (reuse `action_jobs`? new queue table?).
- **Accept:** doc reviewed by the orchestrator against decisions §3–§4
  invariants: propose pins a step; queue lands only reviewed pinned steps;
  propose is all-or-nothing per change set. Migration passes GR-S1 drift test.
- **Metric:** every §3–§4 sentence in the decisions doc maps to a design
  element or an explicit "deferred" line (traceability table in the doc).

### GR-B2: `hop propose` + merge-queue serialization

- **Depends:** GR-B1.
- **Files:** new `packages/agent/src/commands/propose.js`, `sync.js`
  (`mergeChangeSet` becomes queue-consuming), `packages/backend-d1/src/`
  (proposals module), worker routes, tests.
- **Do:** `hop propose [--title]` pins the current change-set head as a
  proposal. Queue merges ready proposals serially: refresh against latest
  Main, then merge; a proposal whose pinned revision no longer matches its
  reviewed revision is not merged (state → stale). Solo path: owner
  self-approves in the same command (`hop propose --merge`) — same door,
  zero extra ceremony.
- **Accept:** tests: propose pins; post-propose saves do not change what
  merges; two ready proposals merge serially with the second refreshed
  against the first's result (no merge races — assert final Main content);
  stale proposal refuses to merge.
- **Metrics:** ≥ 10 new tests; concurrent merge attempt test proves
  serialization (second attempt observes first's Main revision); battery
  green.

### GR-B3: Stale-review automation

- **Depends:** GR-B2.
- **Do:** updating a proposal (re-pinning to a newer step) automatically marks
  existing `review_decisions` stale; dashboard review page (existing
  `src/components/features/review/`) shows "changed since your review" via
  `compareRevisions(reviewedRev, pinnedRev)`.
- **Accept:** worker + web tests; approval at rev X then re-pin to Y ⇒
  decision flagged stale and merge blocked until re-approval.
- **Metric:** zero paths where the queue lands a revision with no non-stale
  approval (asserted by test on the queue guard).

### GR-B4: Releases

- **Depends:** GR-B2 (proposal/Main model settled).
- **Do:** `releases` table (name, notes, pinned Main revision, created_at);
  `hop release <name> [--notes]`; dashboard list on the codebase page;
  release emits a git tag via Track E when a mirror is configured (GR-E3).
- **Accept:** create/list round-trip tests; releasing pins the exact Main
  revision (compare engine shows zero diff between release rev and the
  revision captured); duplicate names rejected.
- **Metric:** release visible in dashboard test render; battery green.

### GR-B5: CI on propose (actions-runner hardening)

- **Depends:** GR-B2. `packages/actions-runner/src/runner.js` is a working
  seed with **no tests**.
- **Do:** enqueue an `action_job` on propose and in the merge queue (merge
  blocked on job success); add runner tests (claim → hydrate → run → complete,
  failure path, timeout path); add retry/backoff on claim errors. No
  containerization yet (deferred).
- **Accept:** runner test suite exists (target ≥ 8 tests: success, command
  failure, timeout, output cap, env lockdown — job step must not see cloud
  credentials, poll retry); queue-blocks-on-red-CI test in the merge path.
- **Metrics:** runner package goes from 0 → ≥ 8 tests; env-lockdown test
  asserts `HOPIT_D1_*` absent from the job step's env.

---

## Track C — Derived files (decisions §6)

### GR-C1: Derived-path classification: never journaled, never synced

- **Files:** `packages/agent/src/constants.js` (curated list),
  `workspace-manifest.js` (classification — follow the existing
  `isLocalOnlySecretPath` pattern), `packages/backend-d1/src/` +
  `codebase_settings` (per-codebase overrides), dashboard settings surface
  (flag-gated), `hop status` display of excluded roots.
- **Do:** Curated built-in list (`node_modules/`, `.venv/`, `venv/`,
  `target/`, `dist/`, `build/`, `.next/`, `__pycache__/`, `.cache/`,
  `.turbo/`, `.gradle/`, `vendor/bundle/`, extend during implementation).
  Derived paths are a distinct classification — not `.private/`, not an
  ignore file: not watched (or watched-and-dropped), not journaled, not
  synced, not counted in presence. Per-codebase add/remove overrides stored in
  `codebase_settings`, editable via `hop` and (flag-gated) dashboard.
- **Accept:** simulation test: create a workspace, write 500 files under
  `node_modules/` plus 3 source files → journal contains exactly 3 entries;
  override test: user un-derives a path → it syncs; user adds a custom derived
  path → it stops syncing. Existing suites green (several fixtures may write
  into paths that are now derived — fix fixtures, not the classification).
- **Metrics:** derived-burst test journals 0 derived entries; classification
  overhead in the watch path < 1 ms per event (benchmark assertion in test);
  battery green.

---

## Track D — Secret scanning (decisions §7)

Trail immutability is a **non-task**: build no redaction. (Compliance-only
erasure is a deferred Phase-3 item, not in this plan.)

### GR-D1: Warn-only outbound secret scanner

- **Files:** new `packages/agent/src/secret-scan.js`, wire into the journal
  path in `sync.js`/`journal.js` (scan before upload, never block),
  `agent_events` (`secret.suspected` event), status API, `codebase_settings`
  (per-project on/off), `setup.js` (onboarding question; `--yes` ⇒ **on**).
- **Do:** High-signal patterns only (AWS `AKIA…`, GitHub `ghp_`/`gho_`,
  Stripe `sk_live_`, Slack `xox…`, private-key PEM headers, generic
  high-entropy assignment heuristic tuned conservative). Scans only
  non-derived, non-`.private/` outbound text files. Upload proceeds; event +
  status flag fire immediately.
- **Accept:** seeded corpus test: ≥ 20 fixture files with planted secrets
  across pattern types → 100% flagged; clean corpus (representative real
  source: this repo's own `src/` sample) → 0 flags; setting off ⇒ no scan;
  `hop setup --yes` writes scanning=on.
- **Metrics:** 100% recall on seeded corpus, 0 false positives on clean
  corpus (both are test assertions); median scan overhead < 5 ms per file at
  journal time (benchmark test); battery green.

### GR-D2: Dashboard/menu-bar secret flag

- **Depends:** GR-D1.
- **Do:** dashboard activity/notifications surface (`notifications-card.tsx`,
  `event-ledger.tsx`) and desktop menu bar show "possible secret in <path>"
  with a link to the file and rotation guidance copy ("rotate, don't
  redact" — decisions §7). Dismissible per finding.
- **Accept:** web + desktop component tests; event → notification round-trip
  test in the worker suite.
- **Metric:** notification appears in test render within one poll/push cycle
  of the event; battery green.

---

## Track E — Continuous git mirror (decisions §8)

`hop export-git` already exists (`packages/agent/src/commands/export.js`);
git import machinery in `import.js` shows the hardened-arg conventions
(`validateGitRemoteUrl`, `assertSafeGitOptionValue`).

### GR-E1: Deterministic incremental mirror engine

- **Files:** extend `export.js` or new `commands/mirror.js`; mirror state
  (last-mirrored Main revision) in `codebase_settings` or local agent state;
  tests using a local bare repo as the remote.
- **Do:** `hop mirror sync` builds git commits from Main snapshots: one commit
  per merged proposal since the last mirrored revision (pre-Track-B interim:
  one commit per Main revision advance), commit message from proposal title
  (interim: episode/step summary), pushes to a configured remote URL over a
  deploy key. One-way only; derived and `.private/` paths never enter the
  mirror. Deterministic: same Main history ⇒ identical commit hashes (fixed
  author/committer identity + timestamps from trail metadata, never
  wall-clock).
- **Accept:** tests with a local bare repo: merge 3 changes → 3 commits;
  re-run → 0 new commits (idempotent); checkout of mirror HEAD is
  **byte-identical** to the Main snapshot (recursive hash compare, asserted);
  `.private/` and derived paths absent from the git tree; malformed remote
  URLs rejected via the existing validators.
- **Metrics:** byte-identical tree assertion; idempotency assertion; two
  independent mirror runs from the same history produce identical commit
  SHAs (determinism assertion).

### GR-E2: Mirror automation on merge

- **Depends:** GR-E1.
- **Do:** enqueue a mirror-push `action_job` on merge-to-Main (runner executes
  `hop mirror sync` — no cloud-side git). Failure surfaces as a dashboard
  notification, never blocks the merge itself. Config surface:
  `hop mirror set-remote <url>` + deploy-key storage (client-encrypted, reuse
  the keys machinery — the deploy private key must never reach D1/R2
  unencrypted, same rule as `.private/env/`).
- **Accept:** merge → job enqueued → mirror advanced (integration test with
  loopback backend + local bare repo); mirror failure → notification event,
  Main unaffected; deploy key storage test asserts ciphertext-only at rest.
- **Metric:** mirror lag in test = one job cycle; key-at-rest assertion.

### GR-E3: Releases → git tags

- **Depends:** GR-E2, GR-B4.
- **Do:** creating a release pushes an annotated tag (release name + notes) at
  the mirror commit for that Main revision.
- **Accept:** release → tag exists on the bare-repo remote at the correct
  commit; tag message carries the notes.
- **Metric:** tag commit's tree hash equals the release revision's mirrored
  tree hash (asserted).

---

## Track F — Refresh race (decisions §10)

Today `remoteRefreshDecision` blocks the **whole** apply when the workspace is
dirty. Decisions §10 requires per-file granularity.

### GR-F1: Per-file refresh — untouched files apply, dirty files delay + flag

- **Files:** `packages/agent/src/watch.js` (`remotePullOnce`,
  `remoteRefreshDecision`), `sync.js` (`materializeCloudToWorkspace`),
  status API.
- **Do:** split refresh application per path: paths with no local edits apply
  immediately; paths with journaled local edits are withheld and flagged
  ("Main changed under you") in status/dashboard/menu bar. Existing whole-
  workspace safety gates (journal-unresolved, mass-delete guard) stay as
  outer guards — this only relaxes the clean-file subset.
- **Accept:** two-device test: device A merges changes to files X and Y;
  device B has local edits to Y only → X applies within one push cycle, Y is
  withheld and flagged; resolving Y (via GR-A3 surface) applies it. Skip
  reasons in events distinguish `file_withheld_local_edits` from existing
  whole-workspace skips.
- **Metrics:** untouched-file apply latency in test = one push cycle (today:
  blocked indefinitely while dirty — assert the improvement); mass-delete and
  manifest-heal suites unmodified and green.

### GR-F2: Save-side clobber detection

- **Depends:** GR-A1 helpers.
- **Files:** `watch.js` snapshot path, `workspace-manifest.js` (track
  last-writer per file: remote-refresh vs local-save), `reconnect.js`
  classification reuse.
- **Do:** if a file was remote-refreshed since the user's last local save and
  the next local save does not contain the refreshed content, treat that save
  as a potential stale-editor-buffer clobber: journal it as a divergence
  (GR-A2) instead of a clean edit, surface via GR-A3. If the save builds on
  the refreshed content (hash lineage matches), it is a clean edit.
- **Accept:** simulated stale-buffer test: refresh file, then write content
  derived from the pre-refresh version → divergence opened, Main's version
  still recoverable; write content that includes the refresh → clean edit,
  no false conflict.
- **Metrics:** clobber scenario produces zero silent reverts (Main's
  content asserted recoverable); the no-conflict path stays no-conflict
  (false-positive guard test).

---

## Track G — Disk, large files, save storms (decisions §11)

**Design conflict, resolved:** decisions §11 wants OneDrive-style dehydration,
but the approved WS7b design **rejected placeholder files for source** (silent
corruption risk) and deferred FS providers. v1 dehydration therefore means:
whole-codebase or whole-directory **dematerialization back to metadata-only
state** (the existing `dehydrateWorkspace` / `pruneWorkspaceCache` /
`--auto-prune` machinery), re-materialized via `hop workspace open` /
hydration — never per-file placeholder stubs inside a materialized tree.
True per-file files-on-demand waits for the native FS-provider work already
deferred by WS7b. Record this in the decisions doc when this track lands.

### GR-G1: Idle dehydration with user-tunable window + safety invariants

- **Files:** `packages/agent/src/commands/hydrate.js`
  (`dehydrateWorkspace`, `pruneWorkspaceCache`), `watch.js`
  (`createAutoPruneScheduler`), settings plumbing, status surfaces.
- **Do:** promote auto-prune from opt-in to default-on with a per-user/
  per-codebase idle window setting (default 7 days, existing threshold);
  add per-folder "keep on this device" pins; add disk-pressure acceleration
  (low free disk ⇒ shorten window), with the journal itself last-sacrificed.
  Hard invariant (already in cache design — extend to all eviction paths):
  **never evict content with unacknowledged journal writes**.
- **Accept:** harness-time tests (inject clock, not wall time): idle codebase
  dehydrates after window; pinned folder survives; file with a pending
  journal entry refuses eviction (assert refusal event); disk-pressure path
  shortens window; re-open re-materializes byte-identical content.
- **Metrics:** unacked-write eviction attempts = 0 succeed (invariant test);
  dehydrated codebase's on-disk footprint = metadata-only (asserted size
  bound); battery green.

### GR-G2: Large-file warning threshold

- **Files:** `journal.js`/`sync.js` (size check at journal time),
  `codebase_settings` (threshold, default 100 MB), events + notification
  surface.
- **Do:** files over threshold sync normally but emit a `file.large` event and
  dashboard note. No cap, no gate.
- **Accept:** sparse-file test (do not write real GB): over-threshold file
  syncs and flags; under-threshold does not; per-codebase threshold override
  respected.
- **Metric:** sync behavior identical with/without flag (byte-identical
  cloud content assertion) — warning is purely additive.

### GR-G3: Save-storm coalescing verification + grouped steps

- **Files:** existing `sync-coalescing.test.js` machinery, `sync.js`,
  `journal.js`.
- **Do:** verify and extend coalescing so a burst (format-on-save sweep,
  generator output on non-derived paths) batches into grouped cloud commits
  (`commitJournalEntries` batch path) and a bounded number of trail episodes,
  not thousands of steps. GR-C1 removes the worst offenders first; this
  covers legitimate source bursts.
- **Accept:** burst test: 1,000 rapid non-derived file writes → journal
  coalesces to ≤ N batch commits (pick N from the existing batch size, assert
  it), workspace converges to correct content, no entry lost (content-hash
  audit of all 1,000 paths).
- **Metrics:** commits-per-burst bound asserted; zero lost writes (full
  content audit in test); watch debounce (250 ms) unchanged.

---

## Track H — Agent reliability envelope (decisions §12)

### GR-H1: Periodic full diff-scan (missed-event healing)

- **Files:** `watch.js` (`createWorkspacePoller` exists — verify cadence and
  scope), `workspace-manifest.js`.
- **Do:** ensure a periodic full workspace diff-scan runs (independent of the
  5-min graph-head reconciliation, which covers the *cloud* side) so a missed
  watcher event heals within one interval; scan results feed the normal
  journal path. Interval configurable; default conservative (e.g. 10 min);
  scan must skip derived paths (GR-C1) for cost.
- **Accept:** test: write a file while the watcher is suppressed (harness
  hook) → next scan journals it; scan on a 5,000-file synthetic workspace
  completes within a bounded time in the harness (assert, generous bound).
- **Metric:** missed-write heal latency ≤ one scan interval (harness-time
  assertion).

### GR-H2: Watch-limit degradation surfaced (Linux)

- **Files:** `watch.js` (watcher setup error paths), status API, `hop doctor`.
- **Do:** on `fs.watch`/inotify failures (ENOSPC watch-limit exhaustion),
  fall back to scan-only mode (GR-H1's scanner at a tighter interval), set a
  `degraded_watch` status with the fix instructions (raising
  `fs.inotify.max_user_watches`), and report it in `hop doctor`.
- **Accept:** injected-failure test: watcher constructor throws ENOSPC →
  agent stays up, status shows `degraded_watch`, writes still sync via scan;
  doctor output includes the remedy string.
- **Metric:** zero missed writes in degraded mode (content audit in test).

### GR-H3: One agent per workspace (lock)

- **Files:** `watch.js`/`service.js` startup, lockfile under
  `.hopit-agent/`.
- **Do:** agent takes an exclusive lock (lockfile with pid + liveness check,
  stale-lock takeover if holder is dead) on the Workspace Root; a second
  agent or second attach of the same folder exits non-zero with a clear
  message naming the holder.
- **Accept:** tests: second start refuses (exit code + message asserted);
  stale lock from a dead pid is taken over; lock released on clean shutdown.
- **Metric:** concurrent double-start race test (spawn both, exactly one
  wins) passes 20/20 iterations in the harness.

### GR-H4: Setup blocks nested cloud-sync paths

- **Files:** `setup.js` (folder-picker validation), `workspace-root.js`,
  `add.js`.
- **Do:** refuse Workspace Roots under Dropbox / iCloud Drive
  (`~/Library/Mobile Documents/`) / OneDrive / Google Drive paths — detect by
  well-known path segments and marker files (`.dropbox`, `.dropbox.cache`,
  Drive/OneDrive markers). Refusal explains why (two sync engines,
  unrecoverable). Applies to `hop setup`, `hop add`, and root migration.
- **Accept:** tests with simulated marker dirs for each provider → refusal
  with message; normal paths unaffected; `--advanced` offers no bypass
  (decision was block, not warn).
- **Metric:** all four provider simulations refused; battery green.

*(Disk-pressure and cloud-unreachable behavior — decisions §12 items 5–6 —
are covered inside GR-G1 and the existing journal/pause machinery; GR-X1
verifies them end-to-end rather than as separate build tasks.)*

---

## Track X — Integration proof

### GR-X1: End-to-end adversarial suite for the new invariants

- **Depends:** GR-A4, GR-B2, GR-C1, GR-F2 (runs last).
- **Files:** new `packages/agent/test/git-replacement-e2e.test.js` following
  the `agent-cli.test.js` two-device loopback pattern.
- **Do:** scripted multi-device scenarios chaining the new behavior:
  (1) offline-divergence → reconnect → resolve → propose → merge → mirror
  advances one commit; (2) crash-while-editing → restart → synthesized
  journal → clean replay; (3) derived-storm + secret-plant + big-file in one
  session → 0 derived entries, secret flagged, large-file flagged, all source
  synced; (4) refresh-race clobber attempt → divergence, zero silent revert;
  (5) cloud-unreachable mid-edit → journal accumulates, backlog surfaced,
  reconnect converges byte-identical.
- **Accept:** all five scenarios pass; each asserts final content by
  recursive hash compare across devices and cloud.
- **Metrics:** 5/5 scenarios; full battery green; suite added to `test:all`.

---

## Orchestrator notes

- **Subagent prompt template:** give each subagent (a) the guardrails section
  verbatim, (b) its single task section, (c) the decisions-doc section it
  implements, (d) the baseline numbers, (e) the report format from §1.
- **Worktree isolation** for parallel tasks in the same wave — Tracks A, F,
  G, H all touch `packages/agent/src/watch.js`/`sync.js` and will conflict.
  Merge order within a wave: smallest diff first.
- **Design-gated tasks** (GR-B1) block their track until the orchestrator (or
  the owner) approves the design doc against the decisions doc.
- **Scope discipline:** anything discovered out-of-scope (e.g. the dead
  `hst_` token path, encryption phases, multi-tenant flags) is reported, not
  fixed — those belong to the Phase-3 plans.
- **Checklist** (orchestrator updates as tasks merge):
  - [x] GR-S1  - [x] GR-A1  - [x] GR-A2  - [x] GR-A3  - [x] GR-A4
  - [x] GR-B1  - [x] GR-B2  - [x] GR-B3  - [x] GR-B4  - [x] GR-B5
  - [x] GR-C1  - [x] GR-D1  - [x] GR-D2
  - [x] GR-E1  - [x] GR-E2  - [x] GR-E3
  - [x] GR-F1  - [x] GR-F2
  - [x] GR-G1  - [x] GR-G2  - [x] GR-G3
  - [x] GR-H1  - [x] GR-H2  - [x] GR-H3  - [x] GR-H4
  - [x] GR-X1

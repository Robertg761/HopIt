# HopIt Product Roadmap

Decided by the owner (Robert) on 2026-07-11. This is the authoritative product
plan. It sets direction and phase sequencing; engineering workstream detail still
lives in [docs/remediation-plan-2026-07.md](remediation-plan-2026-07.md).

## Vision

HopIt's goal is to replace GitHub — by being much better and much easier to use.
It is a multi-tenant SaaS product at `hopit.dev`.

HopIt is a clean break from git, not a friendlier git. HopIt's graph is the real
format. Git import (already implemented) and git export/publish are escape
hatches, not a live bridge — you can get code in and get code out, but day-to-day
work never touches git and never surfaces a git concept.

The flagship experience is the invisible sync: a normal folder that is present on
all your machines within seconds of any save. No commit, no push, no clone, no
branch, no git concepts, ever. You save a file; moments later it exists, current,
on every device you own.

The target audience is everyone, eventually. The narrow starting point (the owner
as the sole daily driver) is a sequencing tactic to force the product to be real
before it is broad — not a statement about who HopIt is for.

Platforms: macOS and Linux agents first; Windows later.

AI agents are a core differentiator. HopIt is the code host built for the AI era:
first-class scoped agent sessions and tokens, AI-readable APIs, and agents treated
as collaborators whose work arrives as reviewable change sets rather than as
opaque commits. Simple built-in CI — "run this command on every change or merge" —
is part of the core promise, not a later add-on.

The eventual product is a full public platform: public project pages, profiles,
stars, remixes, and search, with browsing of public code free to everyone.
Monetization is a cheap flat subscription for hosting and syncing your own code.

## Collaboration model

Decided 2026-07-11.

Principle: git makes coordination a skill you have to learn; HopIt makes it
ambient. Work is visible early, conflicts are prevented rather than managed, and
there is nothing to name, switch, or clean up.

Mechanically, change sets are divergence-tracking like git branches. The entire
difference is ergonomics and lifecycle: change sets are automatic, always-on,
bound to a person, continuously kept fresh against Main, and require zero
ceremony.

1. **Personal change sets, automatic isolation.** Every person's workspace *is*
   their change set. It is permanently attached to them, never named, never
   switched, never cleaned up. Edits journal to that person's own cloud change set
   within seconds of a save. No path exists for one person's edits to reach
   another person's folder except a reviewed merge to Main. The only verbs are
   **propose** (submit your change set for review) and **discard** (snap your
   folder back to Main).

2. **Presence, not surprise ("toe detection").** The hub knows which files each
   change set touches within seconds of any save. When two people's in-progress
   work overlaps the same file, both see it — on the dashboard, in the menu bar,
   and later as editor hints. This is informational only; nothing blocks. v1 is
   presence-only: no claims, no locks. Hard locks for unmergeable binary assets
   are deferred and revisited only if real teams need them.

3. **Freshness, not merge hell.** When a proposal merges to Main, every other
   workspace auto-applies it through the existing safe-refresh path. Untouched
   files update silently. Files with local edits are flagged "Main changed under
   you" immediately. Conflicts therefore surface per-file, minutes old, never as
   one giant stale merge.

4. **Conflicts are a choice, not a ritual.** A conflict is shown side by side,
   yours and theirs, in the dashboard; you pick one or combine them. No rebase, no
   conflict markers in files by default.

5. **Merge queue.** The lifecycle is propose → review → ready. HopIt merges ready
   proposals serially: each is refreshed against the latest Main and run through
   the CI check before it lands. There are no merge races.

6. **Sandboxes: parallel work is a second folder, never a switch in place.** "New
   sandbox" creates a second folder such as
   `~/HopIt/myproject (experiment)/` — the same codebase with a separate change
   set. Delete it or propose it when done. A sandbox can be flagged as an
   experiment so its edits do not generate presence warnings for teammates.

7. **Vocabulary is PR-familiar but branch-free.** propose → review → merge, with
   reviewers. No branch, fork, rebase, or worktree concepts appear anywhere. For
   public codebases, outsiders get a **remix** — their own linked copy — and can
   propose changes back. A project's automatically recorded revision history is
   its **trail**: every save leaves a step on the trail (timestamp, device,
   changed paths). Users never author history — they leave it by walking, so
   there is nothing to write, squash, or amend.

8. **Live-shared change sets** (a Google-Docs-style mode for real-time pairing)
   are an explicit later-phase opt-in, added only after the review flow is solid.

## Phases

Phases are strictly sequenced. Each one gates the next; do not start a phase
before its predecessor's exit criterion is met.

### Phase 1 — Daily driver (current)

HopIt becomes the place where all of the owner's projects live.

Work items:

- Migrate every project in.
- Eliminate the restart full-rehydration window (~4,491 files / ~15 minutes
  before push reconnects — see the 2026-07-11 section of
  [docs/progress.md](progress.md)).
- Add retry-with-backoff inside `hop hydrate`.
- Run a real backup/restore drill.
- Code signing plus notarization so installs are clean.
- Linux agent parity check.

Exit criterion: two weeks without touching GitHub.

### Phase 2 — Sync you can show off

Deliver WS7b demand hydration and WS7c object-backed diffs/history from the
remediation plan (designs approved in `docs/ws7b-*` and `docs/ws7c-*`), plus a
dashboard where "what changed while I was away" is instantly legible.

**Trail summaries** (consumes WS7c's diff reconstruction). Raw trail steps are
too fine-grained to browse one by one, so they are clustered into **episodes** by
a time-gap-plus-device heuristic: a run of steps from the same device with no long
pause becomes one episode. A cheap AI model then writes a one-line label per
episode — the commit message nobody had to write. Episodes, not individual steps,
become the primary browsing and rollback unit in both the dashboard and the
desktop app, and nightly backups reference the nearest episode label so a restore
point reads as a sentence rather than a revision number.

The summarization is bounded by hard privacy rules:

- **Opt-in per codebase.** No trail is summarized unless its codebase has
  explicitly turned summarization on. Off is the default.
- **Metadata-only by default.** The default mode sends the model only metadata —
  changed paths, per-step counts, timestamps. File contents never leave the box
  in this mode.
- **Full-diff summaries are a separate, explicit opt-in.** Feeding actual diff
  text to the model is a second switch a codebase must deliberately flip; turning
  on summarization does not turn it on.
- **Model choice is deferred to implementation.** Whether labels come from a
  mini/haiku-class API model or, later, a local model is a cost decision made when
  this ships, not now.

Exit criterion: the invisible-sync demo, plus a legible history/compare view and a
trail view showing labeled episodes, all working on real projects.

### Phase 3 — Real tenants

Stand up true multi-tenant signup at `hopit.dev`: per-user isolation and quotas,
flat-subscription billing plumbing, and security hardening. Hardening includes
properly wiring the `hst_` agent-token API path that is currently dead behind the
Clerk middleware in `src/proxy.ts` — it becomes load-bearing for the AI story.

Exit criterion: a stranger can sign up, pay, and sync, and their data is provably
isolated.

### Phase 4 — Collaboration + CI + AI collaborators

Ship invitations, presence/toe-detection, propose/review/merge queue, sandboxes,
the simple CI runner (`packages/actions-runner` is the seed), and agents as scoped
first-class collaborators.

Exit criterion: one real team (2–5 people) uses HopIt daily without git knowledge,
and an AI agent lands a reviewed change.

### Phase 5 — Public platform

Ship public project pages, profiles, stars, remixes, and search, with free
browsing.

Exit criterion: a public project gets a remix and a proposal from a stranger.

## Relationship to existing plans

[docs/remediation-plan-2026-07.md](remediation-plan-2026-07.md) remains the source
of truth for engineering workstream detail (WS7b, WS7c, and the rest), but its
sequencing is superseded by this roadmap.

[docs/mvp-plan.md](mvp-plan.md) described the foundation phase.

The collaboration-surface freeze from the remediation plan stays in effect through
Phases 1–3 and lifts in Phase 4.

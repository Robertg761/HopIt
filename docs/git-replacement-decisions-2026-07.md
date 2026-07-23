# Git-Replacement Edge-Case Decisions

Decided by the owner (Robert) on 2026-07-23. This records product decisions for
the edge cases HopIt must handle to actually replace git day to day. It extends
[docs/product-roadmap.md](product-roadmap.md); where the two disagree, the
roadmap's vision governs and this file refines it.

## 1. Same-owner multi-device divergence

A single person's devices all write to the same personal change set, so two of
their devices editing offline can diverge with no change-set boundary to protect
them. The existing safe sync journal and per-file revision guards already detect
this; what was undesigned is the reconnect protocol.

**Reconnect protocol.** Before replaying its journal, a reconnecting agent
fetches the current trail head and sorts pending edits per file:

1. **Only this device touched the file** → replay cleanly onto the trail.
   Expected to be the overwhelming majority; invisible to the user.
2. **Both devices touched it, content is identical** (same hash) → auto-resolve
   as one step.
3. **Both devices touched it, contents differ** → a real divergence, presented
   in the same side-by-side conflict UI used for cross-person conflicts, labeled
   by device ("MacBook version / Desktop version") instead of by person.

**Invariants:**

- Nothing is ever silently dropped. The offline device's version is uploaded as
  trail steps before resolution; the resolution is itself a step. Either side is
  always recoverable from the trail.
- The local folder is never clobbered while diverged. The offline device keeps
  showing its own version, with the divergence flagged in the dashboard and menu
  bar, until the user resolves it.
- No automatic line-level merging inside a diverged file in v1, even for
  non-overlapping hunks. Per-file pick-or-combine only.
- Trail steps from a reconnecting device are ordered by causality (their base
  revision), never by wall-clock time. Clock skew must not affect ordering.

**Unified reconciliation path.** "Agent was offline" and "agent was
dead/crashed while the user kept editing" are the same code path: on restart the
agent diff-scans the workspace against its last known state, synthesizes journal
entries for anything that changed unwatched, then runs the reconnect protocol.
This covers plane mode, crashes, force-quits, and machines restored from backup.

**Reconnect ordering.** If Main also advanced while the device was away,
reconcile the personal change set's divergence first, then apply the normal
safe-refresh path. Never both in one step.

**Sub-cases:** delete-on-one-device vs edit-on-another is a conflict type in
the same UI, with "deleted" as one side. Offline renames/moves are treated as
delete+add in v1.

## 2. Authority: who decides what lands on Main

Resolving a conflict — device-vs-device or "Main changed under you" — only ever
edits the resolver's own change set. Main has exactly one door:
propose → review → merge queue.

- **The proposer owns the content** of their change set, including how it
  incorporates changes from Main.
- **The reviewer owns acceptance** — whether that change set is allowed onto
  Main. This is the PR's precedence-deciding role, unchanged.
- **The merge queue owns ordering.** Ready proposals land serially, refreshed
  against latest Main and CI-checked. Nobody wins by pushing faster.

Outside contributors work in a remix (their own linked copy) and propose back;
they never have any write path to upstream Main.

## 3. Propose is the same for solo and team

Solo codebases use the same "Propose Changes" button as teams — no auto-flow
mode. This is acceptable ceremony because sync already decoupled git's two
conflated jobs: "save my work durably on all my devices" is handled continuously
by sync, so propose only carries "publish to Main," which is rare and
deliberate. Solo and team flows are identical, so adding a collaborator changes
nothing structurally.

**Proposals are the known-good markers.** A save asserts nothing about
coherence; a propose asserts "this state is intentional" and the merge queue
CI-checks it. Consequences:

- Rollback UI leads with merged proposals, then episodes, then raw steps.
- Bisect-style debugging anchors on proposals.
- CI's default trigger is on propose and in the merge queue, not on every save.

**Propose is all-or-nothing per change set.** HopIt deliberately has no
selective staging; parallel efforts belong in sandboxes. The product should
nudge users toward a sandbox before they interleave work (e.g., the propose
screen suggests it when a change set has grown large or old), because there is
no way to split a change set afterward.

## 4. What a proposal is: propose pins a trail step

A proposal is the change set as of a specific trail step, pinned at
propose time. Saves after proposing accumulate as "since proposal"; the proposer
explicitly updates the proposal, which automatically marks existing reviews as
stale. The merge queue only lands a reviewed, pinned step. This gives review a
stable artifact and prevents landing states nobody reviewed.

## 5. Maintainer edits to incoming proposals: comment-only in v1

Maintainers cannot write into a contributor's change set. Structural reason:
under the wrapped-key/device-trust encryption model, cross-account write access
is a key-grant problem, not an ACL checkbox, and is not worth it for a
convenience feature.

- Later: **one-click suggestions** — a maintainer attaches a proposed patch to a
  review comment; the contributor applies it with one click, so the write
  happens under the contributor's own keys and identity.
- Abandoned-proposal escape hatch: a maintainer pulls the proposal's content
  into their own sandbox and lands their own proposal crediting the contributor.
  Requires no new permissions.

## 6. Derived files: never synced

Generated folders (`node_modules/`, `.venv/`, `target/`, `dist/`, build output)
are **local-only**. They are not synced, not versioned, and each device
regenerates its own. This is not an ignore file: it is a distinct
"derived/local-only" concept, because these files are machine-generated and
platform-specific, not private.

Detection: HopIt ships a curated built-in list, with per-codebase user
overrides (add/remove paths) in the dashboard. No config file in the repo.

## 7. Secrets

**The trail is immutable — no redaction feature.** Rationale (owner, decided
2026-07-23): redaction breeds false confidence; a captured secret is
compromised regardless of later deletion, so the only correct response is
rotation. HopIt's stance is "rotate, don't redact."

- Caveat recorded for the privacy plan: in the multi-tenant phases, some data is
  not rotatable (pasted PII, someone else's private key) and GDPR-style deletion
  requests may legally require an erasure path. Revisit before Phase 3 exit; the
  product stance can stay "rotate, don't redact" while a compliance-only
  erasure mechanism exists.

**Secret scanning: warn-only, per-project, asked at onboarding.** The agent
scans outgoing files for secret-looking content. Upload proceeds (never blocks
the invisible-sync promise); the dashboard and menu bar immediately flag
"possible secret in <file>." Whether scanning is on is a question in the setup
flow and a per-project setting. If the question is skipped (e.g.
`hop setup --yes`), scanning defaults to **on**.

## 8. Git mirror: continuous, one-way, tool-facing

Each codebase can keep an auto-generated git mirror that tools consume and
humans never touch. This is a carve-out from "escape hatches only": deploy
platforms (Vercel, Netlify), git-pinned dependencies, and git-reading tooling
need a live repo, and HopIt itself deploys through Vercel.

- **One-way**: HopIt → git only. Never a live bridge; nobody works in the
  mirror.
- **One commit per merged proposal.** The proposal title becomes the commit
  message. Trail detail stays in HopIt.
- **Destination: any remote URL the user provides** (GitHub, GitLab,
  self-hosted) plus a deploy key; HopIt pushes to it. A HopIt-hosted git
  endpoint (clone from git.hopit.dev) is deferred until the platform is larger.
- Mechanics: a cloud job builds a git tree from the Main snapshot's content
  hashes on each merge and pushes one commit. Deterministic; precedent in
  Google's internal-VCS-to-git mirroring and Jujutsu's git interop.

## 9. Releases

A lightweight **Release** concept: "mark this as a release" on any Main state —
name, optional notes, pinned forever, and emitted as a git tag on the mirror.
Answers "exactly what shipped as v1.2" without git tags in the product.

## 10. Refresh under a live editor

When a merge to Main updates a file the user has local edits to, that file's
refresh is **delayed and flagged** ("Main changed under you" in dashboard and
menu bar) while untouched files refresh instantly. No Dropbox-style conflicted
copies littering the workspace; no silent immediate overwrite.

The agent cannot see unsaved editor buffers (only disk), so the clobber
protection is save-side: if a file was remote-refreshed since the user's last
local save, the agent treats the next local save as a potential clobber and
surfaces the side-by-side conflict UI instead of accepting it silently. Editor
plugins can improve detection later.

## 11. Scale, disk, and large files

**Files on demand, both directions.** The workspace model is a Google
Docs/OneDrive hybrid: files hydrate locally on first access (WS7b demand
hydration) and are automatically dehydrated back to cloud-backed placeholders
after an idle period, so codebases do not permanently occupy device disk.
Eviction timing is a user setting, tuned against infrastructure cost.
Constraints:

- The agent must **never evict a file with unacknowledged journal writes**.
- A "keep on this device / download everything" override exists per folder for
  offline work.
- Dehydration must not break tooling: compilers, indexers, and `grep` touching
  placeholders will trigger hydration storms, so eviction should prefer files
  untouched by any process for the full idle window. (macOS File Provider
  supports this natively; the Linux mechanism is an implementation decision.)

**Sandboxes are lazy by default.** A new sandbox appears instantly as
placeholders and hydrates on access, so parallel folders cost almost no disk.

**Large files sync with a warning threshold.** Everything syncs regardless of
size, but files over a threshold (default 100 MB, adjustable per codebase)
trigger a dashboard note so storage surprises are visible. No hard cap, no
opt-in gate.

**Partial attach is deferred.** Monorepos are handled by lazy hydration —
attaching a huge codebase is already cheap — rather than by letting a device
attach only a subfolder. Revisit if real teams with giant repos need it.

**Save storms are coalesced.** Mass events (format-on-save sweeps, `npm
install`, generator output) are debounced and batched into grouped trail steps
rather than thousands of individual ones. Derived-folder exclusion (§6) removes
most of this class before it reaches the journal.

## 12. Agent reliability envelope

Engineering defaults, recorded here so they are deliberate:

- **Missed watcher events are assumed, not exceptional.** The agent runs a
  periodic full diff-scan (in addition to the restart diff-scan from §1) so a
  dropped FSEvents/inotify notification heals within one scan interval instead
  of persisting silently.
- **Linux watch limits degrade loudly.** If inotify watch limits are hit, the
  agent falls back to scan-based syncing and surfaces a degraded-watch state in
  the dashboard and menu bar with the fix (raising the limit), rather than
  silently missing edits.
- **One agent per workspace, enforced.** The agent holds a lock on the
  Workspace Root; a second agent (or second attach of the same folder) refuses
  to start and says why.
- **Nested cloud-sync is blocked.** `hop setup` detects Dropbox, iCloud Drive,
  OneDrive, and similar sync-managed paths and refuses to place a Workspace
  Root inside them, explaining that two sync engines fighting over the same
  files is unrecoverable.
- **Cloud unreachable = pause, never lose.** When the cloud is unreachable or
  the journal backlog grows, sync pauses and edits accumulate safely in the
  journal; the dashboard and menu bar show the backlog. Reconnection runs the
  §1 protocol.
- **Disk pressure is surfaced, not fatal.** If the device is low on disk, the
  agent accelerates dehydration of idle files and warns before the journal
  itself is at risk; journal writes are the last thing sacrificed.

## Open items intentionally deferred

- Hard locks for unmergeable binary assets (roadmap: revisit only if real teams
  need them).
- Live-shared change sets (roadmap: explicit later-phase opt-in).
- Hosted git endpoint at git.hopit.dev (see §8).
- Compliance-only erasure mechanism (see §7 caveat; revisit before Phase 3
  exit).
- One-click maintainer suggestions (see §5; after the review flow is solid).
- Partial attach for monorepos (see §11; revisit if real teams need it).

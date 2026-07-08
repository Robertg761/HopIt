# WS7b Demand Hydration Design

This document completes the design-first WS7b gate from [HopIt Remediation Plan July 2026](remediation-plan-2026-07.md). Implementation should start only after owner approval. The key constraint is that HopIt v1 uses a normal managed folder, not FUSE, macOS File Provider, FSKit, or another native filesystem provider.

## Goal

Opening a cloud codebase on a new device should feel immediate without pretending that a normal folder can intercept arbitrary reads. HopIt should improve practical hydration through workspace-open heuristics, editor signals, prefix hydration, and explicit controls while documenting the boundary where true read-triggered hydration requires a native filesystem provider.

## Current State

The agent already supports:

- metadata-only attach
- single-file hydration
- recursive prefix hydration
- full refresh/hydration
- pin, unpin, prune, and dehydrate
- per-path local cache state in `workspaces.json`
- manifest-based clean/dirty detection

These are compatible with a normal folder. They do not let HopIt notice a tool opening a cloud-only file because that file does not exist as real content on disk.

## Options Considered

### Option 1: Hydrate on workspace open

When the dashboard, CLI, or local service sees a workspace open event, hydrate a selected working set. The default set should be:

- root metadata files, such as `README.md`, package manifests, lockfiles, and config files
- visible files changed recently in the selected active change set
- files pinned by the user or previous usage
- small files under common source roots up to a bounded byte and file-count budget

This is the practical winner for v1. It preserves the managed-folder model, is fixture-testable, and avoids surprising placeholder behavior.

### Option 2: Editor integration signals

Use editor-specific signals to hydrate likely-needed files. For VS Code this can start with:

- a generated `.code-workspace` file that points at the managed folder
- a small optional extension later that asks the local agent to hydrate files on open, search, and symbol navigation
- recently opened file tracking where available

This is useful, but should not be the base contract. The base product must still work from Finder, Terminal, and arbitrary editors.

### Option 3: Placeholder files

Create small placeholder files for cloud-only entries, then replace them with real content when the placeholder changes or when a known tool reads or opens it.

This is risky in a normal folder. Many tools will read placeholders as real source, index them, format them, compile them, or save over them. A placeholder can corrupt user expectations because the OS has no native "this is a cloud file" semantics for plain files in a normal directory.

Placeholder files should not be used for code files in v1. A narrow exception can be considered for clearly marked `.hopit/` metadata files.

### Option 4: macOS File Provider, FSKit, or FUSE research

A native provider can make true demand hydration possible because the filesystem layer can intercept open/read operations. This is the long-term path for a Dropbox/iCloud-style experience.

It is out of scope for v1 because it adds installer, entitlement, kernel/system-extension, reliability, security, and cross-platform complexity before the graph, journal, encryption, and push-delivery contracts are finished.

## Recommended Design

Implement "open-time and intent-driven hydration" now:

1. Add a workspace-open command path that records `workspace.opened`.
2. On open, compute a bounded hydration plan from cloud metadata and local cache policy.
3. Hydrate the plan only if the journal is clean and the manifest has no unsafe local drift.
4. Prefer small, high-signal files first: root docs, package files, editor configs, recently changed files, and pinned paths.
5. Add prefix heuristics so opening a file under `src/` can hydrate sibling files or the containing folder within budget.
6. Surface the result in status: planned paths, hydrated paths, skipped paths, bytes, and budget reason.
7. Keep `workspace hydrate-file`, `workspace hydrate-path`, `pin`, and `prune` as explicit controls.
8. Document native filesystem demand hydration as future research, not v1.

No placeholder files for source content in v1.

## Free-Tier Cost Math

Cloudflare pricing checked on 2026-07-03:

- D1 Free includes 5 million rows read per day, 100,000 rows written per day, and 5 GB total storage.
- R2 Standard free tier includes 10 GB-month storage, 1 million Class A operations per month, 10 million Class B operations per month, and free internet egress.
- D1 does not charge data transfer/egress for database access.

References:

- <https://developers.cloudflare.com/d1/platform/pricing/>
- <https://developers.cloudflare.com/r2/pricing/>

Personal dogfood estimate:

- 1 workspace open/day, 1,000 visible files.
- Metadata listing: if backed by indexed D1 path/file queries, budget up to 1,000 D1 rows read.
- Hydrate 100 small files: 100 R2 Class B reads if object-backed, plus D1 metadata already read.
- Daily cost pressure: 1,000 D1 rows/day is 0.02 percent of D1 Free reads; 3,000 R2 reads/month is 0.03 percent of R2 Free Class B.

Small-team estimate:

- 5 users, 3 devices each, 10 workspace opens/day total, each hydrating 250 files.
- D1 reads: 10,000 metadata rows/day if each open scans 1,000 rows, 0.2 percent of D1 Free reads.
- R2 Class B: 2,500 reads/day, about 75,000/month, 0.75 percent of R2 Free Class B.
- D1 writes: a workspace-open event plus cache-policy updates can stay under 20 rows/open, 200 rows/day, 0.2 percent of D1 Free writes.

Cost guardrails:

- Hydration plans must have max file count and max byte budgets.
- Do not full-scan blob bodies during planning; use graph metadata.
- Cache local manifest state and do not re-read R2 objects that are already hydrated and clean.
- Rate-limit automatic open hydration per workspace to avoid repeated editor restarts causing churn.

## Failure Modes

- Local pending journal: skip open-time hydration and surface `journal_has_unresolved_entries`.
- Manifest drift: skip hydration and surface `workspace_has_unjournaled_changes`.
- R2 object missing: mark the path blocked, keep other paths independent, and surface the failed object key/hash without leaking private content.
- Decryption key missing: leave encrypted private/secret paths cloud-only and expose key health in status.
- Huge repo open: hydrate only the bounded plan and tell the user the workspace remains partial.
- Editor indexes before hydration finishes: root package/config files should hydrate first; status should clearly show `partial`.
- Prefix heuristic chooses too much: enforce budget and allow pinning for intentional local availability.
- Collaborator visibility: plan only from the visibility-filtered graph; hidden paths never appear as placeholders or path names.

## Fixture-Testable Acceptance Plan

1. Metadata-only attach followed by workspace-open hydrates root docs and package/config files under a file-count budget.
2. Workspace-open with a pending journal emits a skipped event and does not materialize new files.
3. Workspace-open with unjournaled local drift emits a skipped event and preserves disk files.
4. Prefix hydration for `src` hydrates visible files under `src/` and does not mark unhydrated cloud-only files as deletes on sync.
5. Reopening a clean workspace does not re-fetch already hydrated clean files.
6. Pinned paths are included in the next open-time plan.
7. Missing decryption key leaves secret-zone files cloud-only and reports key status.
8. Collaborator requester receives no `.private/` path names in the hydration plan.

Product acceptance:

- The dashboard can attach a workspace, open it, and hydrate a useful first working set without a full repo download.
- Status distinguishes `metadata-only`, `partial`, and `materialized`.
- The docs explicitly state that true read-triggered hydration is deferred until a native filesystem provider is chosen.

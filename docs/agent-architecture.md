# Local Agent Architecture

HopIt's local agent materializes selected cloud codebase state under a HopIt Workspace Root. For accepted project state that selected state can be Main; for day-to-day editing it is usually the user's active change set. The v1 architecture should optimize for OS and editor compatibility: a normal local folder, agent-owned cache metadata, lazy materialization where safe, a safety journal, automatic remote-update delivery, a status API, and an event log. A true OS filesystem mount is future optional research, not the default product path.

## Core Pieces

### HopIt Workspace Root

The Workspace Root is the local directory a user chooses for HopIt-managed codebases, such as `~/HopIt Workspaces`. It is not a Git checkout root and not a native filesystem mount in the first v1 path. It is the product-level entry point where cloud codebases appear as agent-owned managed project folders.

Workspace Root responsibilities:

- persist the selected root path and per-device identity
- list cloud codebases that belong to the signed-in user
- create or attach managed project folders for those codebases
- track whether a codebase is metadata-only, partially materialized, fully materialized, dirty, blocked, conflicted, or clean
- keep local cache metadata separate from user-authored files
- make same-owner device handoff automatic when the local journal is clean

The current implementation has a production-profile managed workspace path, a root-level `workspaces.json` index, hydration/materialized-revision status, and a remote cursor exposed through `hop status`. Solid v1 still needs account-scoped codebase discovery, metadata-only listings, lazy materialization policy, and production-grade event delivery before claiming the "install and boom" experience.

### Cloud File Graph

The cloud file graph is the durable model for a codebase:

- directory and file paths
- file revisions and metadata
- content hashes and blob references
- Main state
- active change sets
- owner and visibility metadata
- workspace revision number
- device/session sync state

The spike stores a simplified single selected state in `.hopit-agent/cloud.json`. A production service should split metadata into a database and content into content-addressed blob storage, but expose the same graph-shaped API to the agent with explicit Main, active change-set, owner, and visibility fields.

Solid v1 storage requirements:

- file metadata and file content are separate records
- file content is addressed by hash/blob id and deduplicated where practical
- writes are per-file mutations, not whole-graph replacement as the concurrency boundary
- every write carries a base revision or known cloud revision
- stale base revisions return explicit conflict state instead of silently winning
- snapshots can be reconstructed from file metadata and blob references

HopIt v1 does not have an ignore-file model. The graph should store visibility metadata for `.private/` paths: those files are snapshotted, synced, and versioned, but visible only to the owner. Files outside `.private/` are governed by the active change set's effective visibility and the codebase's permissions.

### Main And Active Change Sets

Main is the accepted shared state of a codebase. It advances through explicit review/merge actions, not merely because an editor saved a file.

An active change set is a cloud-backed working state created automatically when a user starts editing. The sync service should acknowledge writes into the active change set so the user's devices can hand off instantly without publishing directly to Main.

Active change-set visibility is user-configurable:

- global user default
- per-codebase override
- per-change-set override

The effective setting resolves in this order: per-change-set override, codebase override, global user default, product default. The product default should be private until shared or opened for review. `.private/` remains owner-only regardless of the change-set visibility setting.

The fixture-backed agent exposes the minimal review/merge skeleton as explicit
commands. Opening review updates the selected active change set and emits
`change_set.review_opened`. Merging applies that selected active change set to
Main, advances Main only at that point, records merge state, and emits
`change_set.merged`. Sync acknowledgements before merge continue to advance the
active change set, not Main.

### Workspace Adapter

The workspace adapter is the boundary between normal local tools and HopIt state.

V1 managed-folder adapter:

- creates managed folders under the HopIt Workspace Root, such as `~/HopIt Workspaces/<codebase>`
- can expose codebase structure and hydration status before every file body is present locally
- materializes files from Main or an active change set into the managed workspace folder when policy says the content should be local
- lets editors, terminals, language servers, and test runners use normal OS file APIs
- scans the folder for edits
- translates file creates, writes, and deletes into journal entries
- marks `.private/` paths as owner-visible without skipping sync or versioning
- preserves a "no clone to manage" product model

Future optional mount research:

- serves reads directly from the cloud graph or a volatile cache
- intercepts writes at the filesystem boundary
- records each unacknowledged mutation before reporting success to local tools
- keeps the same agent-facing read, write, journal, status, and event contracts

Native filesystem experiments should stay outside the v1 implementation path unless the managed-folder product has already proven the core workflow.

### Local Cache

The cache is an agent-owned working set, not a durable local source of truth. In v1, materialized disk files are intentional: they maximize compatibility with the OS, editors, file watchers, language servers, and command-line tools.

Responsibilities:

- materialize file content when the workspace opens, when files change remotely, when policy requests hydration, or when a supported demand-hydration path needs content
- keep files available for editors, language servers, and test runners through normal disk paths
- prune clean cached content when policy allows
- never evict writes that are still awaiting cloud acknowledgement
- record which local paths are metadata-only, partially hydrated, clean, dirty, blocked, or conflicted

RAM-only caching can be revisited later for specialized workflows, but it is not the v1 default.

### Safety Journal

The safety journal is the local durable record for writes that the cloud has not acknowledged yet. It protects the user's latest edits from process crashes, device sleep, and network loss.

Each journal entry should include:

- stable write id
- operation type: create, write, delete, move later
- cloud path
- visibility, including whether the path is under `.private/`
- target state, such as active change-set id
- owner/session id
- content hash and byte size when content exists
- base revision or known cloud revision
- created timestamp
- pending, acknowledged, or failed status

The spike writes this as NDJSON at `.hopit-agent/journal.ndjson`.

### Restart Recovery And Watch Loop

Restart recovery and the background watch loop are explicit agent contracts, not demo-only behavior. The current spike exposes recovery through `npm run agent:recover`, and `npm run agent:watch` runs recovery before hydrating the workspace.

Restart recovery expectations:

- agent startup reads the safety journal before accepting new workspace writes
- pending journal entries are replayed against the same selected cloud state, normally the active change set, in creation order
- acknowledged entries stay queryable for diagnostics but no longer count as pending work
- failed entries remain durable, visible in status, and retried only when the failure is retryable
- `.private/` scope is preserved during replay exactly as it was recorded in the journal
- the agent never prunes or overwrites local content for an unacknowledged journal entry

Watch-loop expectations:

- `npm run agent:watch` runs recovery, hydrates the managed folder only when recovery is safe, starts watching for local changes, journals writes, and runs bounded sync attempts
- if recovery cannot replay an unacknowledged journal entry, watch startup emits `watch.recovery_blocked`, exits, and leaves the entry visible as failed status instead of hydrating over local edits
- file create, write, and delete detection should be idempotent across repeated scans
- rapid editor saves should coalesce into stable journaled writes without losing the latest content; the spike currently debounces watch-triggered sync attempts by `250ms`
- transient cloud or filesystem errors after startup should emit `sync.failed`, update status with the failed/degraded state, and leave the watch loop running so later saves or retries can recover
- once a later sync succeeds, the agent should emit `sync.complete` and make the recovered/clean state visible through status
- the loop should treat the selected cloud state as the source of truth while preserving pending local edits until acknowledgement or conflict review

Recovery should be safe before it is clever. If the agent is unsure whether the cloud accepted a write, it should keep the journal entry pending and expose that uncertainty through status instead of silently discarding local state.

### Safe Refresh Contract

A refresh means making the managed workspace folder match the latest selected cloud state that is safe for this device/session to see. That selected state may be Main, the user's active change set, or a visible review change set. It is a cloud-to-local operation, not a Git pull, branch checkout, fork sync, worktree update, wiki fetch, star/social feed update, or ignore-file evaluation.

The current spike exposes `npm run agent:refresh` as the safe refresh command:

1. Inspect the local safety journal through the same journal/event classification used by status.
2. Refuse refresh if the local journal has pending or failed entries.
3. Mirror the managed folder from the selected cloud state when the journal is clean.

`npm run agent:watch` applies the same safety idea at startup: it runs recovery before hydration and emits `watch.recovery_blocked` instead of refreshing over unrecovered local writes. Bare `npm run agent:hydrate` is a low-level primitive and should only be used as a product refresh after the journal is known clean. If status shows pending or failed journal entries, run `npm run agent:recover` or resolve the entries before refreshing.

Refresh expectations:

- the selected cloud state remains the source of truth for clean content
- the local safety journal is the source of truth for writes not yet acknowledged by the cloud
- pending, failed, or uncertain journal entries block refresh until recovered, acknowledged, or explicitly resolved
- failed entries stay visible through status and events; refresh must not hide them by hydrating over the workspace
- `.private/` paths refresh like normal graph paths for the same owner, while retaining owner-private visibility metadata
- hash-only materialization manifests let the agent detect unjournaled local drift before automatic refresh paths overwrite disk content

### Automatic Remote-Update Delivery

Explicit `hop refresh` is the current safe primitive. The current worktree also has an opt-in `--remote-pull` polling loop for `watch` and `service start`; it calls the same safe refresh path only when local state is fully materialized, clean against the hash-only materialization manifest, and the per-workspace index cursor is behind the cloud revision. Solid v1 should keep that safety contract but make remote-update delivery production-grade, observable, and suitable for normal same-owner device handoff.

Remote-update delivery expectations:

- the agent stores a remote event cursor per codebase, selected state, and concrete workspace path
- the cloud emits or exposes file, review, visibility, conflict, and membership events in cursor order
- the local service receives those events through a subscription or bounded polling loop
- if the local journal is clean, the agent safely materializes the new selected cloud state
- if the local journal has pending, failed, or uncertain entries, or if disk content differs from the last materialized manifest, the agent does not overwrite the workspace and instead reports a blocked/conflict state
- metadata-only or partially materialized workspaces stay lazy until an explicit hydrate or refresh operation changes that state
- remote updates preserve `.private/` visibility and requester filtering
- status exposes whether the last update was applied, skipped as unchanged, blocked by local work, or failed

### Status API

The agent should expose a small local status API for the product UI, tray/menu UI, and diagnostics.

Suggested fields:

- workspace root path
- codebase folder hydration state
- local workspace clean/dirty state compared with the hash-only materialization manifest
- codebase id and display name
- selected state type: Main, active change set, or review change set
- active change-set id when applicable
- effective change-set visibility
- owner/session id
- requester id, requester session id, and requester role for visibility-filtered reads
- visible and hidden file counts, with hidden scope counts that do not expose hidden paths
- workspace path
- cloud revision currently visible locally
- last acknowledged revision
- pending journal entry count
- last cloud acknowledgement time
- latest remote-update event and state
- remote event cursor and last applied event id when available
- review state for the selected active change set
- merge state and latest merge event for Main
- conflict state and latest conflict event for stale file/base or Main revision mismatches
- connectivity state
- cache mode and approximate memory/disk use
- storage mode, such as inline prototype content or content-addressed blobs
- device/session token scope and expiry summary
- adapter type: managed folder, with optional research adapters later
- recent error summary

This can start as a local HTTP endpoint or CLI command. The current spike exposes the HTTP status surface with `npm run agent:status`; a direct CLI status command can use the same agent-state reader. The important part is that status reads from agent state instead of guessing from files on disk.

### Event Log

The event log is an append-only operational trace for development, debugging, and UI updates. It is not the source of truth for file content.

Important event types:

- `workspace.ready`
- `watch.started`
- `watch.recovery_blocked`
- `file.hydrated`
- `write.journaled`
- `cloud.acknowledged`
- `change_set.created`
- `change_set.visibility_changed`
- `change_set.review_opened`
- `change_set.merged`
- `change_set.conflict_detected`
- `journal.recovery_failed`
- `journal.recovery_complete`
- `sync.complete`
- `sync.failed`
- `remote-update`
- `cache.evicted`
- `connection.changed`

The spike writes events to `.hopit-agent/events.ndjson`. A production agent can stream the same events over the status API while retaining a short local diagnostic log.

## Editor Read/Write Flow

```text
Editor or tool
  -> Workspace adapter
  -> Local cache
  -> Selected cloud state / blob API
  -> Safety journal for writes
  -> Cloud acknowledgement
  -> Status API and event log
```

Read path:

1. An editor, language server, or command-line tool reads a path in the HopIt workspace.
2. The OS reads a normal disk file in the managed workspace folder.
3. The agent keeps that file aligned with the Main or active change-set revision it has made visible locally.
4. On workspace open or remote change, the agent asks the cloud file graph for metadata about the selected state and hydrates blob content into the local cache.
5. The agent emits `file.hydrated` or a remote-update event when local content changes.

Write path:

1. An editor saves a file into the managed workspace folder.
2. The agent computes the content hash and creates a durable safety journal entry before treating the write as locally accepted.
3. The local cache records the visible content and pending write state.
4. The agent streams the mutation to the selected active change set in the cloud file graph service.
5. The cloud validates the base revision, stores new content if needed, advances the active change-set file/workspace revision, and returns an acknowledgement.
6. The agent marks the journal entry acknowledged, updates local revision state, and emits `cloud.acknowledged`.
7. The status API reports a clean workspace when no pending journal entries remain. Main is unchanged until the active change set is merged.

If the cloud cannot acknowledge immediately, the journal entry remains pending and the status API should make that visible.

## Next Milestones

The local-agent contract is good enough for personal dogfooding, but the solid v1 target now requires finishing the Workspace Root and cross-device handoff contract before HopIt can claim the "install and keep going anywhere" experience. GitHub-lite collaboration still matters, but it should advance alongside the storage, auth, and automatic remote-update foundations it depends on. The detailed collaboration plan lives in [GitHub-Lite Collaboration Plan](github-lite-collaboration-plan.md).

### 0. Promote The Workspace Root To A Product Contract

- Persist a user-selected Workspace Root outside the source checkout. Production-profile paths and the root index path are in place.
- Track codebase folders independently from one selected workspace path. The index now keys entries by codebase and concrete workspace path.
- Add root-level codebase discovery and attach/hydrate state. Hydration state is in place; account-scoped cloud discovery and attach flows remain.
- Surface metadata-only, partial, hydrated, dirty, blocked, and conflicted states in `hop status` and the web UI. Hydrated/materialized and cursor state are in place; metadata-only/partial/lazy states remain.
- Keep the current managed-folder implementation as the first adapter.

### 1. Lock The Managed-Folder Contracts

- Keep the current deterministic demo working.
- Treat cloud graph shape, journal entries, event names, and status fields as explicit contracts.
- Align docs and examples with the actual spike commands: `npm run agent:demo`, `npm run agent:watch`, `npm run agent:sync`, and `npm run agent:status`.
- Keep `.private/` as owner-private workspace scope, not an ignored or skipped path.
- Add contract names for Main, active change-set id, owner/session id, and effective change-set visibility.

### 2. Stabilize Restart Recovery

- Persist pending writes durably before cloud acknowledgement.
- Keep `npm run agent:recover` replaying pending journal entries in order before reporting a clean workspace.
- Keep `npm run agent:watch` blocked before hydration when recovery cannot safely replay unacknowledged journal entries.
- Keep acknowledged, pending, failed, and uncertain entries visible through status.
- Preserve owner-private `.private/` scope during replay.
- Expand focused recovery fixtures that simulate process exit after journal append and before cloud acknowledgement.

### 3. Harden The Watch Loop

- Make `npm run agent:watch` the primary continuous-agent proof path.
- Preserve the recovery-before-hydration startup gate.
- Debounce and coalesce repeated editor saves without dropping the final content.
- Keep the watch loop alive across transient sync failures after startup.
- Emit status and event-log evidence for started, blocked, degraded, recovered, sync-complete, and sync-failed states.
- Keep clean cloud content, pending local edits, and failed writes distinguishable in status.

### 4. Extend Cloud-Service Boundaries

- Keep the local fixture implementation behind the service-shaped cloud graph interface for tests and demos.
- Preserve explicit contract names for Main, the selected active change set, owner/session identity, effective visibility, acknowledgements, and status summaries.
- Extend the service boundary with validation failures, connectivity loss, review, merge, and retry timing.
- Add file-level mutation methods with base revision checks.
- Add content-addressed blob references and snapshot reconstruction.
- Preserve the same editor read/write flow from the managed-folder spike.

### 5. Prove Two-Device Continuity

- Run two agent sessions against the same active change set.
- Show that writes acknowledged from device/session A become visible to same-owner device/session B after B performs the safe refresh flow.
- Then promote the opt-in remote-pull proof to production-grade automatic remote-update delivery when B's local journal is clean.
- Simulate A syncing both non-private content and `.private/` owner-private content, then B refreshing as the same owner and seeing both sets of files with their visibility metadata preserved.
- Keep collaborator visibility simulations passing: private change sets stay hidden, team-visible and review-visible change sets expose non-private paths to permitted collaborators, and `.private/` remains owner-only in every mode.
- Emit event-log entries for remote updates and cache invalidation.
- Surface pending and acknowledged state through the status API.

### 6. Tighten Managed-Folder Behavior

- Handle creates, writes, deletes, renames, and `.private/` visibility paths consistently.
- Make local cache pruning explicit and conservative.
- Preserve normal editor and terminal compatibility as the primary v1 constraint.

### 7. Add Review And Merge

Status: done for the fixture-backed skeleton.

- Keep Main unchanged while an active change set syncs.
- Open the selected active change set for review with an explicit agent command.
- Merge the selected active change set into Main with an explicit agent command.
- Emit `change_set.review_opened` and `change_set.merged`.
- Surface review and merge state through status.
- Preserve visibility settings and owner metadata in review/merge history.

### 8. Tighten Conflict Handling

Status: done for the fixture-backed skeleton.

- Detect writes based on stale selected-state or Main revisions.
- Surface conflicts as reviewable workspace states through status and events.
- Keep clean acknowledged content evictable while preserving unacknowledged local edits.

### 9. Scope Device And Session Auth

- Issue device/session credentials that are scoped to one user, device, and allowed codebases. Convex can now register, list, touch, revoke, and authorize scoped agent-session tokens.
- Keep service credentials separate from dashboard user auth.
- Support revocation and rotation without deleting the local workspace.
- Make every cloud write path enforce the scoped actor and codebase permissions. Graph reads, per-file mutations, and event appends accept scoped session tokens; bootstrap/admin paths still use the deployment service token.

## Future Optional Research

A true OS filesystem mount, macFUSE backend, or RAM-only working set may become useful after the managed-folder product is proven. If that work resumes, it should keep the same cloud graph, safety journal, status API, event log, and acknowledgement contracts so the product model does not change.

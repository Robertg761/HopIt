# HopIt MVP Plan

## Goal

Build the smallest useful version of a cloud-native managed workspace for codebases. The MVP should prove that a developer can open a HopIt codebase on a device, see it as a normal local folder, edit it with normal tools, and have those changes become cloud-backed active change-set state automatically.

The product promise is:

> It feels local. It lives in the cloud.

HopIt should start as a managed workspace folder for codebases, not as social Git hosting or a true OS filesystem mount.

The v1 sharing model has two layers. Path visibility is controlled by `.private/`: files under `.private/` are snapshotted, synced, and versioned like any other workspace file, but they are visible only to the owner. Change-set visibility controls whether in-progress work outside `.private/` is private, visible to the team, or opened for review.

Change-set visibility should be configurable as a global user default, a per-codebase override, and a per-change-set override. The effective rule is: per-change-set override, then codebase override, then global user default, then product default. The product default should be conservative: private until shared or opened for review.

## First-Version Experience

1. A user creates or imports a codebase into HopIt.
2. HopIt stores Main, active change sets, file content, metadata, collaborators, visibility settings, and snapshots in the cloud.
3. The user installs or runs the HopIt agent on a device.
4. The agent creates a managed local folder for the cloud codebase.
5. Files are materialized into the folder when the workspace opens or when local tools need them.
6. Edits are captured by the agent, written into a small safety journal, and streamed to the user's active change set in the cloud.
7. Once the cloud acknowledges the write into the active change set, the local cache can keep or prune clean content according to policy.
8. Another device owned by the same user opens the same active change set and receives the current cloud state without a manual sync ritual.
9. Collaborators see in-progress work according to the active change set's effective visibility.
10. The user can request review, merge the change set into Main, import from Git, export a snapshot, or publish a clean Git commit when ready.

## Core Concepts

### Codebase

The main object users interact with. A codebase contains Main state, active change sets, content-addressed blobs, workspace snapshots, collaborators, permissions, connected devices, visibility preferences, and sync state.

### Main

The accepted shared state of a codebase. Main advances through an explicit merge/review action, not merely because an editor saved a file.

### Active Change Set

A cloud-backed working state created automatically when a user starts editing. It behaves like an automatic branch internally, but V1 should present it as a change set or draft rather than a user-managed Git branch. Live sync writes into the active change set so the user's devices can continue instantly without publishing directly to Main.

### Managed Workspace Folder

A normal local folder materialized and watched by the HopIt agent. Editors, terminals, language servers, and test runners should treat it like any other folder, while HopIt treats it as an agent-owned view of cloud state with no clone to manage.

### HopIt Agent

A local process that creates and watches the managed workspace folder, manages local cache policy, records unsynced writes in a safety journal, and streams changes to HopIt.

### Local Cache

The agent-owned local working set. Files are materialized on disk for OS and editor compatibility, with metadata that lets HopIt distinguish clean cached content from unacknowledged user edits.

### Safety Journal

A small durable local record of writes that have not been acknowledged by the cloud. The safety journal protects recent edits from process crashes, network drops, and device sleep.

### Workspace Snapshot

An addressable cloud state for Main or an active change set at a point in time. A snapshot can include file revisions, in-progress workspace changes, device metadata, conflict markers, visibility metadata, review state, and publish metadata.

### Workspace Visibility

HopIt does not treat ignore files as a product sharing control. The reserved `.private/` directory is the v1 owner-only workspace area, and it still participates in snapshots, sync, and versioning. Files outside `.private/` can be shared, reviewed, and merged according to the active change set's visibility and codebase permissions.

### Change-Set Visibility

The visibility state for in-progress work outside `.private/`. V1 should support at least private, team-visible, and review-visible states. Settings are resolved in this order: per-change-set override, codebase override, global user default, product default. `.private/` remains owner-only regardless of the change-set setting.

### Cloud File Graph

The durable representation of directories, files, blobs, revisions, visibility metadata, Main state, active change sets, and snapshot metadata. Git can be imported from and exported to this graph, and a snapshot or merged state can be published as a Git commit, but the graph is optimized for live sync, device handoff, review, merge, and on-demand hydration.

## Workspace Modes

### Managed Folder Mode

The v1 default. The agent materializes a normal local folder, watches it for changes, journals writes before cloud acknowledgement, and keeps the currently selected cloud state as the source of truth. For day-to-day editing, that state is usually the user's active change set; for browsing accepted project state, it can be Main.

### Safe Cache Mode

The same managed folder model with explicit pruning and recovery rules. HopIt owns the cache and can prune clean content, while unsynced writes stay protected by the safety journal.

### Offline Mode

Optional later mode for travel or unreliable networks. The agent keeps enough local state to continue working and reconciles with cloud state when connectivity returns.

### Native Mount Research

Optional future research. A true OS filesystem mount, macFUSE backend, or RAM-only working set may become useful later for large repos or specialized workflows, but it is not the v1 default or next main milestone.

## Suggested Architecture

- Web app: Next.js product shell for codebases, files, live sync state, active change sets, connected devices, recent activity, collaborators, review/merge state, and snapshots.
- API: TypeScript service for auth, codebase metadata, change-set coordination, snapshot coordination, workspace sessions, visibility settings, review/merge actions, and realtime events.
- Sync service: agent-facing API for file graph reads, blob hydration, active change-set write acknowledgements, cache invalidation, and conflict responses.
- Storage: object storage for file blobs plus Postgres for metadata, permissions, device state, active change sets, visibility settings, merge records, and snapshot indexes.
- Realtime: WebSocket or server-sent events for file changes, collaborator presence, sync status, visibility changes, review events, merge events, and device handoff.
- Local agent: managed-folder process with auth token storage, local cache, safety journal, retry queue, and `.private/` visibility handling. Git import/export/publish can stay as later snapshot interoperability, not the everyday sync model.

The local agent contract is detailed in [Local Agent Architecture](agent-architecture.md). That document is the implementation guide for the cloud file graph, managed-folder adapter, local cache, safety journal, status API, event log, two-device simulation, and editor read/write acknowledgement flow.

For a detailed done/in-progress/next view with proof commands, milestone status, contract tracking, and known gaps, see [Progress Tracker](progress.md).

## MVP Milestones

### Milestone 1: Product Shell

- Build the logged-in dashboard around codebases, files, active change sets, connected devices, sync state, collaborators, visibility, and recent activity.
- Remove GitHub-social concepts from the first prototype surface.
- Document the codebase, Main, active change set, managed workspace folder, `.private/` visibility model, change-set visibility model, agent, cache, journal, and snapshot model.

### Milestone 2: Agent Managed-Folder Spike

- Create a local agent that can materialize a tiny cloud-backed file tree into a normal managed folder.
- Hydrate or refresh file content from the cloud file graph.
- Capture writes and print deterministic write events.
- Prove that a normal editor can open and save files in the managed folder.

Current spike:

- `packages/agent` implements a managed-folder version of this lifecycle.
- `npm run agent:demo` seeds a local cloud graph, hydrates a workspace, simulates an editor save, journals the write, and acknowledges the cloud revision. The current spike treats that graph as a stand-in for one selected active change set.
- `npm run agent:recover` replays unacknowledged journal entries into the cloud graph.
- `npm run agent:watch` is the continuous managed-folder proof path: it runs recovery before hydration, blocks safely when recovery cannot replay, and coalesces watch-triggered sync attempts.
- `npm run agent:refresh` is the safe cloud-to-workspace path: it refuses pending or failed local journal state, then mirrors the cloud file graph into the managed folder when the journal is clean.
- `npm run agent:sync` runs one explicit scan/journal/acknowledgement pass.
- `npm run agent:status` serves read-only local agent state for status, event, journal, and cloud inspection.
- The agent now reaches the fixture-backed cloud graph through a service-shaped boundary, while preserving the same managed-folder, `.private/`, refresh, and journal contracts.
- The fixture graph now names Main, the selected active change set, owner identity, session identity, and effective change-set visibility. Acknowledged writes advance the selected active change set, while Main stays stable until the explicit merge command runs.
- Requester-aware fixture reads now prove collaborator visibility rules: private change sets hide active work from collaborators, team-visible and review-visible change sets expose non-private paths, and `.private/` remains owner-only.
- Minimal review/merge fixture commands open the selected active change set for review, merge it into Main, emit `change_set.review_opened` and `change_set.merged`, and surface review/merge state through status. Main stays stable until the explicit merge command runs.
- Fixture conflict handling detects stale selected-state revisions, stale file/base revisions, and stale Main revisions, emits `change_set.conflict_detected`, and surfaces conflict state while preserving local edits for review.

Next after the managed-folder spike:

1. Lock the managed-folder contracts for graph shape, journal entries, event names, command names, and status fields.
2. Introduce active change-set identity, Main identity, owner identity, and visibility metadata into the fixture graph.
3. Replace local cloud JSON reads with a service-shaped cloud file graph interface while keeping fixture-backed demos.
4. Keep collaborator visibility simulations passing on top of the same-owner two-session refresh proof.
5. Keep remote-update events passing on top of the two-session refresh proof.
6. Keep review/merge status and events passing on top of the selected active change-set proof.
7. Keep conflict handling for stale selected-state or Main revisions passing before moving into Git compatibility.

### Milestone 3: Recovery And Watch Loop

- Treat the safety journal as the durable recovery boundary for writes awaiting cloud acknowledgement.
- Stabilize replay of pending journal entries after restarting the agent, preserving `.private/` owner-private scope.
- Keep watch startup blocked before hydration when recovery cannot safely replay unacknowledged entries.
- Keep failed and uncertain entries durable and visible through the status surface.
- Coalesce repeated editor saves into stable sync work without losing final file contents.
- Make the watch loop resilient to transient filesystem and cloud errors after startup.
- Emit `sync.failed` and `sync.complete` evidence so the web app can show live clean, pending, failed, degraded, and recovered sync states.

### Milestone 4: Cloud Service Boundary

- Replace the local cloud JSON file with a service-shaped file graph API.
- Model Main, active change sets, owner identity, change-set visibility, and merge targets.
- Store blobs content-addressably.
- Store file graph metadata and revisions.
- Reconstruct a Main or active change-set snapshot from metadata and blobs.

### Milestone 5: Two-Session Continuity

- Open the same codebase and active change set from a second device or second agent session owned by the same user.
- Show that an acknowledged write from one session becomes visible to the other without merging to Main.
- Use the same-owner simulation as the first proof: device/session A syncs a non-private file and a `.private/` owner-private file into the same active change set, then device/session B runs the safe refresh flow and sees both.
- Keep collaborator simulations passing: private change sets remain hidden, team-visible and review-visible change sets expose non-private paths, and `.private/` stays owner-only in every mode.
- Preserve pending local edits until acknowledgement or conflict review.
- Keep status and event-log evidence for remote updates.

### Milestone 6: Review And Merge

- Let a user open an active change set for review.
- Merge a reviewed change set into Main.
- Keep Main stable until merge.
- In the fixture-backed skeleton, `npm run agent:review` opens the selected active change set for review and emits `change_set.review_opened`.
- In the fixture-backed skeleton, `npm run agent:merge` merges the selected active change set into Main and emits `change_set.merged`.
- Surface review and merge state through the local agent status contract.
- Surface conflicts as reviewable change-set states instead of terminal-only chores.
- Preserve visibility settings in review and merge history.

### Milestone 7: Git Compatibility

- Import an existing Git repository into the cloud file graph.
- Export a workspace snapshot to a Git commit.
- Publish Main or a selected merged snapshot as Git history when the user chooses to publish.
- Preserve commit ancestry where possible.
- Keep Git out of the everyday continuity model; no user-managed Git-style branch, fork, or worktree product surfaces in v1. Automatic active change sets are a HopIt product concept, not Git branch management.

## Deliberate Non-Goals For V1

- Replacing every Git workflow on day one.
- User-managed Git-style branches, forks, worktrees, wiki pages, stars, public social discovery, trending pages, and marketplace features.
- Full browser IDE implementation.
- Enterprise admin, compliance, or audit-log features.
- Perfect merge conflict automation.
- True OS filesystem mount, macFUSE, RAM-only workspace mode, or large-repo virtual filesystem optimization.

# HopIt MVP Plan

## Goal

Build the smallest useful version of a cloud-native managed workspace for codebases. The MVP should prove that a developer can open a HopIt codebase on a device, see it as a normal local folder, edit it with normal tools, and have those changes become cloud state automatically.

The product promise is:

> It feels local. It lives in the cloud.

HopIt should start as a managed workspace folder for codebases, not as social Git hosting or a true OS filesystem mount.

The v1 sharing model is explicit and simple: there is no ignore-file model. Files under `.private/` are snapshotted, synced, and versioned like any other workspace file, but they are visible only to the owner. Every file outside `.private/` is shared with collaborators who have access to the codebase.

## First-Version Experience

1. A user creates or imports a codebase into HopIt.
2. HopIt stores the canonical file graph, file content, metadata, collaborators, and snapshots in the cloud.
3. The user installs or runs the HopIt agent on a device.
4. The agent creates a managed local folder for the cloud codebase.
5. Files are materialized into the folder when the workspace opens or when local tools need them.
6. Edits are captured by the agent, written into a small safety journal, and streamed to the cloud.
7. Once the cloud acknowledges the write, the local cache can keep or prune clean content according to policy.
8. Another device opens the same codebase and receives the current cloud state without a manual sync ritual.
9. The user can import from Git, export a snapshot, or publish a clean Git commit when ready.

## Core Concepts

### Codebase

The main object users interact with. A codebase contains the cloud file graph, content-addressed blobs, workspace snapshots, collaborators, permissions, connected devices, and sync state.

### Managed Workspace Folder

A normal local folder materialized and watched by the HopIt agent. Editors, terminals, language servers, and test runners should treat it like any other folder, while HopIt treats it as an agent-owned view of cloud state with no clone to manage.

### HopIt Agent

A local process that creates and watches the managed workspace folder, manages local cache policy, records unsynced writes in a safety journal, and streams changes to HopIt.

### Local Cache

The agent-owned local working set. Files are materialized on disk for OS and editor compatibility, with metadata that lets HopIt distinguish clean cached content from unacknowledged user edits.

### Safety Journal

A small durable local record of writes that have not been acknowledged by the cloud. The safety journal protects recent edits from process crashes, network drops, and device sleep.

### Workspace Snapshot

An addressable cloud state for a codebase at a point in time. A snapshot can include file revisions, uncommitted workspace changes, device metadata, conflict markers, and publish metadata.

### Workspace Visibility

HopIt does not treat ignore files as a product sharing control. The reserved `.private/` directory is the only v1 owner-only workspace area, and it still participates in snapshots, sync, and versioning. Everything outside `.private/` is shared workspace content.

### Cloud File Graph

The durable representation of directories, files, blobs, revisions, visibility metadata, and snapshot metadata. Git can be imported from and exported to this graph, and a snapshot can be published as a Git commit, but the graph is optimized for live sync, device handoff, and on-demand hydration.

## Workspace Modes

### Managed Folder Mode

The v1 default. The agent materializes a normal local folder, watches it for changes, journals writes before cloud acknowledgement, and keeps the cloud file graph as the source of truth.

### Safe Cache Mode

The same managed folder model with explicit pruning and recovery rules. HopIt owns the cache and can prune clean content, while unsynced writes stay protected by the safety journal.

### Offline Mode

Optional later mode for travel or unreliable networks. The agent keeps enough local state to continue working and reconciles with cloud state when connectivity returns.

### Native Mount Research

Optional future research. A true OS filesystem mount, macFUSE backend, or RAM-only working set may become useful later for large repos or specialized workflows, but it is not the v1 default or next main milestone.

## Suggested Architecture

- Web app: Next.js product shell for codebases, files, live sync state, connected devices, recent activity, collaborators, and snapshots.
- API: TypeScript service for auth, codebase metadata, snapshot coordination, workspace sessions, and realtime events.
- Sync service: agent-facing API for file graph reads, blob hydration, write acknowledgements, cache invalidation, and conflict responses.
- Storage: object storage for file blobs plus Postgres for metadata, permissions, device state, and snapshot indexes.
- Realtime: WebSocket or server-sent events for file changes, collaborator presence, sync status, and device handoff.
- Local agent: managed-folder process with auth token storage, local cache, safety journal, retry queue, and `.private/` visibility handling. Git import/export/publish can stay as later snapshot interoperability, not the everyday sync model.

The local agent contract is detailed in [Local Agent Architecture](agent-architecture.md). That document is the implementation guide for the cloud file graph, managed-folder adapter, local cache, safety journal, status API, event log, two-device simulation, and editor read/write acknowledgement flow.

## MVP Milestones

### Milestone 1: Product Shell

- Build the logged-in dashboard around codebases, files, connected devices, sync state, collaborators, and recent activity.
- Remove GitHub-social concepts from the first prototype surface.
- Document the codebase, managed workspace folder, `.private/` visibility model, agent, cache, journal, and snapshot model.

### Milestone 2: Agent Managed-Folder Spike

- Create a local agent that can materialize a tiny cloud-backed file tree into a normal managed folder.
- Hydrate or refresh file content from the cloud file graph.
- Capture writes and print deterministic write events.
- Prove that a normal editor can open and save files in the managed folder.

Current spike:

- `packages/agent` implements a managed-folder version of this lifecycle.
- `npm run agent:demo` seeds a local cloud graph, hydrates a workspace, simulates an editor save, journals the write, and acknowledges the cloud revision.
- `npm run agent:recover` replays unacknowledged journal entries into the cloud graph.
- `npm run agent:watch` is the continuous managed-folder proof path: it runs recovery before hydration, blocks safely when recovery cannot replay, and coalesces watch-triggered sync attempts.
- `npm run agent:sync` runs one explicit scan/journal/acknowledgement pass.
- `npm run agent:status` serves read-only local agent state for status, event, journal, and cloud inspection.
- The next technical step is stabilizing restart recovery and watch-loop hardening while preserving the same cloud graph, `.private/` scope, and journal contracts.

Next after the managed-folder spike:

1. Lock the managed-folder contracts for graph shape, journal entries, event names, command names, and status fields.
2. Stabilize restart recovery around `npm run agent:recover` and the watch startup recovery gate.
3. Harden `npm run agent:watch` so it survives transient sync failures after startup, coalesces rapid editor saves, blocks unsafe hydration before startup, emits sync failure events, and surfaces failed/degraded/recovered status.
4. Replace local cloud JSON reads with a service-shaped cloud file graph interface while keeping fixture-backed demos.
5. Prove two-session continuity against one cloud file graph.
6. Surface clean, pending, failed, uncertain, and remote-update states through status and events.

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
- Store blobs content-addressably.
- Store file graph metadata and revisions.
- Reconstruct a workspace snapshot from metadata and blobs.

### Milestone 5: Two-Session Continuity

- Open the same codebase from a second device or second agent session.
- Show that an acknowledged write from one session becomes visible to the other.
- Preserve pending local edits until acknowledgement or conflict review.
- Emit status and event-log evidence for remote updates.

### Milestone 6: Git Compatibility

- Import an existing Git repository into the cloud file graph.
- Export a workspace snapshot to a Git commit.
- Publish a selected snapshot as Git history when the user chooses to publish.
- Preserve commit ancestry where possible.
- Keep Git out of the everyday continuity model; no branch, fork, or worktree product surfaces in v1.

## Deliberate Non-Goals For V1

- Replacing every Git workflow on day one.
- Branches, forks, worktrees, wiki pages, stars, public social discovery, trending pages, and marketplace features.
- Full browser IDE implementation.
- Enterprise admin, compliance, or audit-log features.
- Perfect merge conflict automation.
- True OS filesystem mount, macFUSE, RAM-only workspace mode, or large-repo virtual filesystem optimization.

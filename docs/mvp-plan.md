# HopIt MVP Plan

## Goal

Build the smallest useful version of a cloud-native codebase filesystem. The MVP should prove that a developer can open a HopIt codebase on a device, see it as a normal local folder, edit it with normal tools, and have those changes become cloud state automatically.

The product promise is:

> It feels local. It lives in the cloud.

HopIt should not start as a social Git hosting clone. It should start as a mounted cloud workspace for codebases.

## First-Version Experience

1. A user creates or imports a codebase into HopIt.
2. HopIt stores the canonical file graph, file content, metadata, collaborators, and snapshots in the cloud.
3. The user installs or runs the HopIt agent on a device.
4. The agent mounts the cloud codebase as a normal-looking folder.
5. Files hydrate on demand when an editor, terminal, language server, or test runner reads them.
6. Edits are captured by the agent, written into a small safety journal, and streamed to the cloud.
7. Once the cloud acknowledges the write, the local RAM/cache copy can be evicted or kept according to policy.
8. Another device opens the same codebase and receives the current cloud state without a manual sync ritual.
9. The user can publish a clean Git commit or export a snapshot when ready.

## Core Concepts

### Codebase

The main object users interact with. A codebase contains the cloud file graph, content-addressed blobs, workspace snapshots, collaborators, permissions, mounted devices, and sync state.

### Mounted Workspace

A local path that looks like a normal folder to editors and command-line tools, but is served by the HopIt agent. The workspace should not be treated as a user-managed checkout. It is a live view into cloud state.

### HopIt Agent

A local process that mounts a codebase, handles file reads and writes, manages local cache policy, records unsynced writes in a safety journal, and streams changes to HopIt.

### RAM-First Cache

The preferred local working cache. Files should hydrate into memory when accessed and be evictable after use. This keeps the device from needing a full persistent copy of the codebase.

### Safety Journal

A small durable local record of writes that have not been acknowledged by the cloud. Pure RAM mode is magical but risky; the safety journal protects recent edits from process crashes, network drops, and device sleep.

### Workspace Snapshot

An addressable cloud state for a codebase at a point in time. A snapshot can include file revisions, uncommitted workspace changes, device metadata, conflict markers, and publish metadata.

### Cloud File Graph

The durable representation of directories, files, blobs, revisions, and metadata. Git can be imported from and exported to this graph, but the graph is optimized for live sync, device handoff, and on-demand hydration.

## Mount Modes

### Cloud Live Mode

The default aspirational experience. Files are fetched into memory when touched, writes stream to the cloud immediately, and local storage use stays minimal.

### Safe Cache Mode

The pragmatic first implementation target. Files can be cached locally for performance, but HopIt owns the cache and can evict it. Unsynced writes are protected by the safety journal.

### Offline Mode

Optional later mode for travel or unreliable networks. The agent keeps enough local state to continue working and reconciles with cloud state when connectivity returns.

## Suggested Architecture

- Web app: Next.js product shell for codebases, files, live sync state, mounted devices, recent activity, collaborators, and snapshots.
- API: TypeScript service for auth, codebase metadata, snapshot coordination, mount sessions, and realtime events.
- Mount service: agent-facing API for file graph reads, blob hydration, write acknowledgements, cache invalidation, and conflict responses.
- Storage: object storage for file blobs plus Postgres for metadata, permissions, device state, and snapshot indexes.
- Realtime: WebSocket or server-sent events for file changes, collaborator presence, sync status, and device handoff.
- Local agent: mounted filesystem process with auth token storage, RAM-first cache, safety journal, retry queue, ignore rules, and Git compatibility commands.

## MVP Milestones

### Milestone 1: Product Shell

- Build the logged-in dashboard around codebases, files, mounted devices, sync state, collaborators, and recent activity.
- Remove GitHub-social concepts from the first prototype surface.
- Document the codebase, mounted workspace, agent, cache, journal, and snapshot model.

### Milestone 2: Agent Filesystem Spike

- Create a local agent that can expose a tiny cloud-backed file tree as a mounted folder.
- Hydrate file content on read.
- Capture writes and print deterministic write events.
- Prove that a normal editor can open and save files through the mount.

Current spike:

- `packages/agent` implements a managed-folder version of this lifecycle.
- `npm run agent:demo` seeds a local cloud graph, hydrates a workspace, simulates an editor save, journals the write, and acknowledges the cloud revision.
- The next technical step is replacing the managed-folder adapter with a real filesystem mount while preserving the same cloud graph and journal contracts.

### Milestone 3: Safe Sync Prototype

- Add a local safety journal for writes awaiting cloud acknowledgement.
- Stream write deltas to a local or hosted API.
- Show live sync status in the web app.
- Recover pending writes after restarting the agent.

### Milestone 4: Cloud File Graph

- Store blobs content-addressably.
- Store file graph metadata and revisions.
- Reconstruct a workspace snapshot from metadata and blobs.
- Open the same codebase from a second device or second mount session.

### Milestone 5: Git Compatibility

- Import an existing Git repository into the cloud file graph.
- Export a workspace snapshot to a Git commit.
- Preserve commit ancestry where possible.

## Deliberate Non-Goals For V1

- Replacing every Git workflow on day one.
- Public social discovery, stars, trending pages, and marketplace features.
- Full browser IDE implementation.
- Enterprise admin, compliance, or audit-log features.
- Perfect merge conflict automation.
- Large-repo virtual filesystem optimization beyond the first mount proof.

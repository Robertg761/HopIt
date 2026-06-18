# HopIt MVP Plan

## Goal

Build the smallest useful version of a GitHub alternative where projects are shared primarily as cloud-synced codebases. The MVP should prove that a developer can move between devices without manually pushing and pulling every unfinished change.

## First-Version Experience

1. A user creates or imports a codebase.
2. HopIt builds a cloud file graph and a Git-compatible baseline snapshot.
3. A local sync agent watches file changes and streams deltas to the cloud.
4. The web app shows live sync status, recent file activity, devices, collaborators, and branch/workspace state.
5. Another device opens the same codebase and receives the latest workspace state.
6. The user can publish a clean Git commit or share a review snapshot when ready.

## Core Concepts

### Codebase

The main object users interact with. It contains files, branches, workspace snapshots, collaborators, permissions, and sync devices.

### Workspace Snapshot

An addressable cloud state for a codebase at a point in time. This can include uncommitted changes, branch metadata, device metadata, and conflict markers.

### Sync Agent

A local process that watches the filesystem, computes file deltas, encrypts or signs payloads where needed, and uploads changes to HopIt.

### Cloud File Graph

The durable representation of directories, files, blobs, revisions, and metadata. Git can be imported from and exported to this graph, but the graph is optimized for live sync and handoff.

## Suggested Architecture

- Web app: React product shell for codebases, files, activity, reviews, and settings.
- API: TypeScript service for auth, codebase metadata, snapshot coordination, and realtime events.
- Sync service: append-only delta ingestion with idempotency keys per device.
- Storage: object storage for file blobs plus Postgres for metadata, permissions, and snapshot indexes.
- Realtime: WebSocket or server-sent events for device presence and sync status.
- Local agent: file watcher with ignore rules, auth token storage, retry queue, and Git compatibility commands.

## MVP Milestones

### Milestone 1: Product Shell

- Build the logged-in dashboard.
- Model codebases, sync status, device presence, and recent activity with local state.
- Document the codebase/snapshot/sync-agent model.

### Milestone 2: Local Agent Prototype

- Create a CLI that initializes `.hopit/`.
- Watch a directory and print a deterministic file delta stream.
- Respect `.gitignore` and a future `.hopitignore`.

### Milestone 3: Cloud Metadata API

- Create codebase records, devices, and workspace snapshots.
- Accept signed delta envelopes without full file storage yet.
- Stream sync events back to the web app.

### Milestone 4: File Storage

- Store blobs content-addressably.
- Reconstruct a workspace snapshot from metadata and blobs.
- Download a snapshot onto a second device.

### Milestone 5: Git Compatibility

- Import an existing Git repository.
- Export a workspace snapshot to a Git commit.
- Preserve branch names and commit ancestry where possible.

## Deliberate Non-Goals For V1

- Replacing all Git workflows on day one.
- Public social discovery, stars, trending pages, and marketplace features.
- Full browser IDE implementation.
- Enterprise admin, compliance, or audit-log features.
- Perfect merge conflict automation.

# HopIt

HopIt is an early-stage cloud-native code workspace. The core idea is that a codebase lives in the cloud as the source of truth, while each device gets a managed workspace folder that behaves like a normal local folder and syncs edits back automatically.

The first product bet is simple: working on code should feel local, but live in the cloud. A developer should be able to open a HopIt codebase on any device, edit it with normal tools, and continue somewhere else without a clone to manage, stale checkout, push, pull, stash, or half-finished recovery flow.

Git compatibility still matters, but Git is not the primary day-to-day workspace model. Git should become an import/export and publish-history layer around a cloud workspace that is always current.

HopIt does not use an ignore-file model for product sharing. Files under `.private/` are still snapshotted, synced, and versioned, but they are owner-visible only. All other files in the workspace are shared with the codebase's collaborators according to workspace permissions.

## Initial Scope

- Cloud-backed codebase dashboard with live workspace and sync state.
- Cloud codebase file graph, recent activity, collaborator presence, and connected device visibility.
- Local HopIt agent that materializes a cloud codebase into a normal managed folder.
- Agent-owned local cache for hydration, editor compatibility, sync, and recovery.
- Safe sync journal for writes that have not been acknowledged by the cloud yet.
- Git compatibility as an import/export and publish layer, not the source of continuity.
- Explicit `.private/` visibility: synced and versioned, but owner-visible only.

## Product Principles

- The cloud codebase is the source of truth.
- Local files are a managed cache, not a user-owned checkout.
- Git history still matters, but saving work and publishing work are separate actions.
- Device handoff should be boring: open the project and keep going.
- Conflicts should be surfaced as reviewable workspace states, not surprise terminal chores.
- The prototype should prove the managed workspace folder before chasing broad hosting features.
- The first version should optimize for personal and small-team code sharing before broad open-source network features.
- V1 should avoid branches, forks, worktrees, wiki pages, stars, and social discovery surfaces.

## Development

```bash
npm install
npm run dev
```

Build the production bundle with:

```bash
npm run build
```

Run the local agent spike with:

```bash
npm run agent:demo
```

The demo seeds a local cloud file graph, hydrates a managed workspace, simulates an editor save, journals the write, and acknowledges it back into the cloud graph.

For the local agent architecture, including the cloud file graph, managed-folder adapter, local cache, safety journal, status API, event log, and future optional filesystem research, see [docs/agent-architecture.md](docs/agent-architecture.md).

## Repository Layout

```text
src/
  app/          Next.js app routes, layout, and global styles
  components/   HopIt product shell and shared UI primitives
  hooks/        shared React hooks
  lib/          shared utilities
packages/
  agent/        local agent spike for cloud graph hydration and write journaling
docs/
  agent-architecture.md  local agent architecture and read/write acknowledgement flow
  mvp-plan.md  first-version product and architecture plan
```

# HopIt

HopIt is an early-stage cloud-native codebase filesystem. The core idea is that a codebase lives in the cloud as the source of truth, while each device mounts a local-looking workspace that fetches files on demand and syncs edits back immediately.

The first product bet is simple: working on code should feel local, but live in the cloud. A developer should be able to open a HopIt codebase on any device, edit it with normal tools, and continue somewhere else without managing a local clone, stale checkout, push, pull, stash, or half-finished recovery flow.

Git compatibility still matters, but Git is not the primary day-to-day workspace model. Git should become an import/export and publish-history layer around a cloud workspace that is always current.

## Initial Scope

- Cloud-backed codebase dashboard with live mount and sync state.
- Repository-style file graph, recent activity, collaborator presence, and mounted device visibility.
- Local HopIt agent that exposes a cloud codebase as a normal folder without asking the user to manage a clone.
- On-demand hydration so files are pulled into a RAM-first working cache when editors or tools touch them.
- Safe sync journal for writes that have not been acknowledged by the cloud yet.
- Git compatibility as an import/export and publish layer, not the source of continuity.

## Product Principles

- The cloud codebase is the source of truth.
- Local files are a managed cache, not a user-owned checkout.
- Git history still matters, but saving work and publishing work are separate actions.
- Device handoff should be boring: open the project and keep going.
- Conflicts should be surfaced as reviewable workspace states, not surprise terminal chores.
- The prototype should prove the mounted workspace feeling before chasing broad hosting features.
- The first version should optimize for personal and small-team code sharing before broad open-source network features.

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
  mvp-plan.md  first-version product and architecture plan
```

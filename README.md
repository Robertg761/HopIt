# HopIt

HopIt is an early-stage attempt at a GitHub alternative where the default unit of work is an always-synced cloud codebase instead of a local clone that happens to have a remote.

The first product bet is simple: editing code should feel closer to working in a shared document. A save on one device becomes cloud state immediately, and every other device can continue from that state without the developer remembering to push, pull, stash, or recover half-finished work.

## Initial Scope

- Cloud-backed codebase dashboard with live sync state.
- Repository-style file graph, sync metadata, recent activity, and collaborator presence.
- Device-aware sync model for moving between computers, tablets, and cloud workspaces.
- Clear path toward a local agent that watches a working directory and streams file deltas to HopIt.
- Git compatibility as an import/export layer, not the only source of truth.

## Product Principles

- The cloud state is the source of continuity.
- Git history still matters, but saving work and publishing work are separate actions.
- Device handoff should be boring: open the project and keep going.
- Conflicts should be surfaced as reviewable workspace states, not surprise terminal chores.
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

## Repository Layout

```text
src/
  App.tsx       primary product shell and demo state
  styles.css   design tokens, layout, and responsive UI
docs/
  mvp-plan.md  first-version product and architecture plan
```

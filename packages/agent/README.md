# HopIt Agent Spike

This package is the first local agent spike for HopIt.

It is intentionally not a real FUSE or OS filesystem provider yet. Instead, it models the same lifecycle with a managed local workspace:

1. Seed a local cloud file graph.
2. Hydrate files into a local-looking workspace.
3. Let normal tools edit those files.
4. Scan writes into an append-only safety journal.
5. Acknowledge those writes back into the cloud graph.

The goal is to prove the product loop before taking on native filesystem mounting.

## Commands

Run the full deterministic demo:

```bash
npm run agent:demo
```

Run the pieces manually:

```bash
npm run agent:init
npm run agent:hydrate
npm run agent:sync
npm run agent:watch
```

Generated state is ignored by git:

```text
.hopit-agent/
mounts/
```

## Next Step

Replace the managed-folder adapter with a real mount adapter while keeping the same cloud graph, journal, and acknowledgement flow.

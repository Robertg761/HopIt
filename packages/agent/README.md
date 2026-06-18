# HopIt Agent Spike

This package is the first local agent spike for HopIt.

It is intentionally not a real FUSE, OS filesystem provider, or clone manager. Instead, it models the v1 lifecycle with a normal managed workspace folder backed by a local cache:

1. Seed a local cloud file graph.
2. Hydrate files into a managed workspace folder.
3. Let normal tools edit those files.
4. Scan writes into an append-only safety journal.
5. Acknowledge those writes back into the cloud graph.

The cloud graph remains the source of truth. The local folder is a materialized cache that HopIt manages so OS file pickers, editors, CLIs, and search tools can work without a special mount or a user-managed clone.

HopIt does not use ignore files as product sharing controls. Files under `.private/` are still snapshotted, synced, and versioned, but owner-visible only; all other workspace files are shared with the codebase's collaborators.

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

Serve local agent status JSON:

```bash
npm run agent:status
```

The status server is dependency-free and listens on `127.0.0.1:4785` by default. It is read-only and reports `adapter: managed-folder`, `cacheMode: local-cache`, the workspace folder, local cloud graph summary, pending journal count, recent events, and the latest acknowledgement/sync events.

Query it with curl:

```bash
curl http://127.0.0.1:4785/status
curl http://127.0.0.1:4785/events
curl http://127.0.0.1:4785/journal
curl http://127.0.0.1:4785/cloud
```

Use the same local-state options as the other commands when you want to inspect the demo state:

```bash
npm run agent:status -- \
  --cloud .hopit-agent/demo/cloud.json \
  --workspace .hopit-agent/demo/workspaces/hopit-core \
  --journal .hopit-agent/demo/journal.ndjson \
  --events .hopit-agent/demo/events.ndjson
```

Generated local agent state is demo/runtime state, not workspace content:

```text
.hopit-agent/
```

## Next Step

Harden the managed-folder adapter around conflict handling, offline behavior, and background sync. A true virtual filesystem or RAM-only mount can remain future optional research against the same cloud graph, journal, and acknowledgement flow.

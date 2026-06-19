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
npm run agent:recover
npm run agent:watch
```

Restart recovery is explicit and dependency-free. `recover` reads the append-only
journal, the local cloud JSON graph, and the event log, then replays journal
entries that do not yet have a `cloud.acknowledged` event. Writes are recovered
from the cloud graph when the cloud already contains the journaled hash, or from
the managed workspace when the on-disk file still matches the journal hash.
Deletes are acknowledged when the cloud file is already gone or replayed into the
cloud graph when it is still present.

The command exits nonzero when any entry cannot be replayed. Failed entries are
kept in the event-derived status so the next `recover` can retry them after the
workspace or cloud state is fixed.

`watch` runs recovery before hydrating the workspace. If any unacknowledged
journal entry cannot be replayed, startup is blocked so hydrate does not overwrite
local edits that still need to be recovered. Status reports journal entries as
pending, failed, or acknowledged from the journal/events pair.

After successful recovery, `watch` hydrates the managed folder, starts the
recursive filesystem watcher, and coalesces rapid filesystem notifications into a
single `sync-once` attempt after a short debounce window. The current debounce is
`250ms`, so repeated editor saves should settle into one journaled latest write
rather than a burst of stale intermediate syncs.

Watch-loop hardening should keep the process alive after transient sync failures.
Those failures should be emitted as `sync.failed`, reflected in status as
failed/degraded sync state, and followed by normal `sync.complete` evidence once a
later attempt succeeds. Recovery failures are intentionally different: they block
startup before hydration with `watch.recovery_blocked` because replaying the
journal safely is required before the workspace can be refreshed from cloud state.

Serve local agent status JSON:

```bash
npm run agent:status
```

The status server is dependency-free and listens on `127.0.0.1:4785` by default. It is read-only and reports `adapter: managed-folder`, `cacheMode: local-cache`, the workspace folder, local cloud graph summary, pending/failed/acknowledged journal counts, recent events, and the latest acknowledgement/sync/recovery events.

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

Harden the managed-folder watch loop around debounced/coalesced sync,
transient-failure events and status, retry-after-failure behavior, and safe
startup blocking when recovery cannot replay. Conflict handling and offline
behavior can build on the same cloud graph, journal, and acknowledgement flow. A
true virtual filesystem or RAM-only mount remains future optional research, not
the current product path.

# HopIt Agent Spike

This package is the first local agent spike for HopIt.

It is intentionally not a real FUSE, OS filesystem provider, or clone manager. Instead, it models the v1 lifecycle with a normal managed workspace folder backed by a local cache:

1. Seed a local cloud file graph that stands in for one selected active change set.
2. Hydrate files into a managed workspace folder.
3. Let normal tools edit those files.
4. Scan writes into an append-only safety journal.
5. Acknowledge those writes back into the selected cloud state.

The selected cloud state remains the source of truth for the managed folder. In the production model, day-to-day edits should sync into an active change set; Main advances only after review or merge. The local folder is a materialized cache that HopIt manages so OS file pickers, editors, CLIs, and search tools can work without a special mount or a user-managed clone.

HopIt does not use ignore files as product sharing controls. Files under `.private/` are still snapshotted, synced, and versioned, but owner-visible only. Files outside `.private/` are governed by the active change set's effective visibility and the codebase's permissions.

## Commands

Run the full deterministic demo:

```bash
npm run agent:demo
```

Run the pieces manually:

```bash
npm run agent:init
npm run agent:hydrate
npm run agent:refresh
npm run agent:sync
npm run agent:recover
npm run agent:watch
```

`npm run agent:refresh` is the safe cloud-to-workspace command. It refuses to
touch the managed folder while the local journal has pending or failed entries,
then mirrors the current selected cloud state into the workspace when the journal is
clean. `watch` applies the same safety idea at startup by recovering before
hydrating. Bare `hydrate` is a low-level primitive and should not be treated as
safe refresh unless the local journal is already clean.

Restart recovery is explicit and dependency-free. `recover` reads the append-only
journal, the local cloud JSON graph, and the event log, then replays journal
entries that do not yet have a `cloud.acknowledged` event. Writes are recovered
from the selected cloud state when it already contains the journaled hash, or from
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

Safe refresh refuses pending or failed local journal state:

```bash
npm run agent:status -- \
  --cloud .hopit-agent/demo/cloud.json \
  --workspace .hopit-agent/demo/workspaces/hopit-core \
  --journal .hopit-agent/demo/journal.ndjson \
  --events .hopit-agent/demo/events.ndjson

npm run agent:refresh -- \
  --cloud .hopit-agent/demo/cloud.json \
  --workspace .hopit-agent/demo/workspaces/hopit-core \
  --journal .hopit-agent/demo/journal.ndjson \
  --events .hopit-agent/demo/events.ndjson
```

Run `npm run agent:recover` first when status shows pending or failed journal
entries that should be replayed before refreshing. Refresh treats the selected
cloud state as source of truth when the journal is clean, so unjournaled local
edits can be overwritten or removed.

Two-session continuity should use the same selected active change set and
separate local journals/events for each session. The first simulation target is:

1. Device/session A and B point at the same `--cloud` file and use separate
   `--workspace`, `--journal`, and `--events` paths.
2. A hydrates, edits a non-private file and a `.private/` file, then runs
   `npm run agent:sync`.
3. B runs `npm run agent:refresh`.
4. B sees the non-private file and, because this simulation is the same owner, the
   `.private/` file with owner-private scope preserved.

The current fixture does not yet model Main, active change-set id, owner identity,
or change-set visibility. The next cloud-service boundary should add those fields
so tests can distinguish same-owner device handoff from collaborator visibility
and merge into Main.

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

Replace the fixture-backed local cloud JSON access with a service-shaped cloud
file graph interface while keeping the same managed-folder, `.private/`, journal,
refresh, and status contracts. That boundary should add Main, active change-set
identity, owner/session identity, and change-set visibility. Conflict handling,
review/merge, and offline behavior can build on that boundary. A true virtual
filesystem or RAM-only mount remains future optional research, not the current
product path.

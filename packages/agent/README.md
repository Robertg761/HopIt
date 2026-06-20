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
npm exec -- hop demo
```

Import a real local folder into the managed HopIt graph:

```bash
npm exec -- hop import --source /path/to/project --force
```

The import path skips `.git`, `.hopit-agent`, `node_modules`, build outputs,
`.env*`, common logs, large files, and binary-ish assets, then hydrates the
managed workspace from the imported cloud graph.

Point the same import at the real Convex backend with:

```bash
npm exec -- hop import \
  --source /path/to/project \
  --codebase-id hopit \
  --convex-url "$HOPIT_CONVEX_URL" \
  --agent-token "$HOPIT_AGENT_TOKEN" \
  --force
```

Any command can use `--convex-url` and `--agent-token`; when those are present,
the selected cloud graph is read from and written to Convex instead of the local
JSON file. Local journal and event files still exist as the device safety log.

Build a Node/npm-free artifact for the current macOS or Linux platform with:

```bash
npm run package:hop
```

The output lives under `artifacts/hop-<platform>-<arch>/` with a compressed
`.tar.gz` beside it. The packaged command is `./bin/hop`. Windows packaging
currently exits unsupported instead of producing a broken artifact because the
official Windows Node runtime is distributed as a `.zip`, not the `.tar.gz`
runtime this packager handles.

Run the pieces manually:

```bash
npm exec -- hop init
npm exec -- hop hydrate
npm exec -- hop refresh
npm exec -- hop sync
npm exec -- hop recover
npm exec -- hop watch
npm exec -- hop status
npm exec -- hop serve
npm exec -- hop review
npm exec -- hop merge
```

`hop refresh` is the safe cloud-to-workspace command. It refuses to
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
single `hop sync` attempt after a short debounce window. The current debounce is
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
npm exec -- hop status \
  --cloud .hopit-agent/demo/cloud.json \
  --workspace .hopit-agent/demo/workspaces/hopit-core \
  --journal .hopit-agent/demo/journal.ndjson \
  --events .hopit-agent/demo/events.ndjson

npm exec -- hop refresh \
  --cloud .hopit-agent/demo/cloud.json \
  --workspace .hopit-agent/demo/workspaces/hopit-core \
  --journal .hopit-agent/demo/journal.ndjson \
  --events .hopit-agent/demo/events.ndjson
```

Run `hop recover` first when status shows pending or failed journal
entries that should be replayed before refreshing. Refresh treats the selected
cloud state as source of truth when the journal is clean, so unjournaled local
edits can be overwritten or removed.

Two-session continuity should use the same selected active change set and
separate local journals/events for each session. The first simulation target is:

1. Device/session A and B point at the same `--cloud` file and use separate
   `--workspace`, `--journal`, and `--events` paths.
2. A hydrates, edits a non-private file and a `.private/` file, then runs
   `hop sync`.
3. B runs `hop refresh`.
4. B sees the non-private file and, because this simulation is the same owner, the
   `.private/` file with owner-private scope preserved.
5. A collaborator requester can refresh the same active change set with
   `--requester-id user_demo_collaborator --session-id session_demo_collaborator`
   and sees only the files allowed by the change-set visibility rules.

The current fixture models Main, the selected active change set, owner identity,
session identity, and effective change-set visibility. The local implementation
still stores that graph in JSON, but commands now reach it through a
cloud graph service boundary. That keeps the demos dependency-free while also
allowing the same command flow to target Convex for the real shared backend.

Requester-aware reads are fixture-only but explicit. Owner requesters see shared
and `.private/` files. Collaborator requesters see no active change-set files when
visibility is `private`, see shared files when visibility is `team-visible` or
`review-visible`, and never see `.private/` files.

Review and merge are also fixture-level commands. `hop review` opens
the selected active change set for review and emits `change_set.review_opened`.
`hop merge` merges that selected active change set into Main and emits
`change_set.merged`. Local sync continues to acknowledge writes into the selected
active change set; Main should remain stable until the explicit merge command
advances it. Status should expose the selected change set's review state, merge
state, and latest review/merge events so the product UI can distinguish synced
draft work from accepted Main.

Conflict handling is fixture-level as well. Stale selected-state or file/base
revision recovery and stale Main revision merge attempts emit
`change_set.conflict_detected`, persist conflict state on the selected active
change set, and leave local unacknowledged edits in place for review.

Serve local agent status JSON:

```bash
npm run agent:serve
```

The status server is dependency-free and listens on `127.0.0.1:4785` by default. It is read-only and reports `adapter: managed-folder`, `cacheMode: local-cache`, the workspace folder, local cloud graph summary, requester identity and visibility-filtered file counts, pending/failed/acknowledged journal counts, recent events, and the latest acknowledgement, sync, recovery, remote-update, review, merge, and conflict state.

For a one-shot status JSON printout without starting the server, run:

```bash
npm run agent:status
```

Query it with curl:

```bash
curl http://127.0.0.1:4785/status
curl http://127.0.0.1:4785/events
curl http://127.0.0.1:4785/journal
curl http://127.0.0.1:4785/cloud
```

Use the same local-state options as the other commands when you want to inspect the demo state:

```bash
npm exec -- hop status \
  --cloud .hopit-agent/demo/cloud.json \
  --workspace .hopit-agent/demo/workspaces/hopit-core \
  --journal .hopit-agent/demo/journal.ndjson \
  --events .hopit-agent/demo/events.ndjson \
  --requester-id user_demo_collaborator \
  --session-id session_demo_collaborator
```

Generated local agent state is demo/runtime state, not workspace content:

```text
.hopit-agent/
```

## Next Step

Build Git compatibility on top of the fixture-backed graph contract. The
same-owner, collaborator visibility, remote-update, review, merge, and conflict
simulations now define how active change-set state becomes visible locally, how it
becomes accepted Main, and how stale revisions become reviewable state. The next
proof should import/export or publish snapshots without leaking `.private/`
owner-only content. Offline behavior can build on that boundary. A true virtual
filesystem or RAM-only mount remains future optional research, not the current
product path.

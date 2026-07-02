# HopIt Agent

This package is the local HopIt agent and CLI.

It is intentionally not a real FUSE, OS filesystem provider, or clone manager. Instead, it models the first v1 lifecycle with a normal managed workspace folder backed by a local cache:

1. Seed a local cloud file graph that stands in for one selected active change set.
2. Hydrate files into a managed workspace folder.
3. Let normal tools edit those files.
4. Scan writes into an append-only safety journal.
5. Acknowledge those writes back into the selected cloud state.

The selected cloud state remains the source of truth for the managed folder. In the production model, day-to-day edits should sync into an active change set; Main advances only after review or merge. The local folder is a materialized cache that HopIt manages so OS file pickers, editors, CLIs, and search tools can work without a special mount or a user-managed clone.

The solid v1 target is a HopIt Workspace Root, such as `~/HopIt Workspaces`, where cloud codebases appear as HopIt-managed project folders. This package currently proves selected managed folders, a durable workspace-root index, configured-codebase discovery and metadata-only attach, hydration/cursor status, metadata-only/dehydrate and single-file hydrate primitives, S3-compatible object-blob storage for file bodies, activity-gated safe remote-pull plus one-shot remote-pull checks, Cloudflare D1 graph storage, and legacy scoped Convex agent-session tokens. It does not yet provide account-wide codebase discovery, a full automatic lazy-materialization policy, D1 device-session auth, or production-grade push/subscription remote-update delivery.

HopIt does not use ignore files as product sharing controls. Files under `.private/` are still snapshotted, synced, and versioned, but owner-visible only. Files outside `.private/` are governed by the active change set's effective visibility and the codebase's permissions.

Temporary secret-safety exception: `.private/env/` is local-only unless client-side encrypted secret sync is configured. With either the legacy local `HOPIT_CLIENT_ENCRYPTION_KEY` or a `hop keys init-device` keyring plus `HOPIT_CLIENT_ENCRYPTION_SCOPE=secrets` and an object-blob provider, routed env files sync as encrypted object blobs. Without a local decrypt-capable key source, production-safe mirror/import leaves those secrets local and skips cloud sync rather than uploading raw secret bytes.

The full security target is broader than this package's current routed-secret
bridge. Private repos should eventually encrypt all private file bytes, grant
decryption through trusted device keyrings and wrapped keys, keep `.private/`
and secret groups on separate keys, and rotate/revoke grants independently. The
first local device-key layer now exists through `hop keys`, and the end-to-end
plan lives in [../../docs/privacy-encryption-plan.md](../../docs/privacy-encryption-plan.md).
The current foundation for that work is `src/crypto.js`, which owns privacy-zone
classification, legacy secret-envelope encryption/decryption, device key
generation, wrapped-key helpers, passphrase recovery export, blob wrap/unwrap,
and envelope validation shared by the CLI and tests.

Current personal production setup details, including the `hopit.dev` domain, active Vercel/D1/legacy Convex/Clerk/R2 accounts, LaunchAgent paths, env file locations, and temporary safety boundaries, live in [../../docs/personal-production.md](../../docs/personal-production.md).

## Commands

Run the full deterministic demo:

```bash
npm run hop -- demo
```

Import a real local folder into the managed HopIt graph:

```bash
npm run hop -- import --source /path/to/project --force
```

The import path skips `.git`, `.hopit-agent`, `node_modules`, build outputs,
`.env*`, common logs, large files, and binary-ish assets, then hydrates the
managed workspace from the imported cloud graph.

For a literal local mirror into a managed workspace, use `mirror` instead of
`import`. The mirror path copies regular files as byte-safe payloads, binary
files, symlinks, empty directories, generated folders, and `.git/`; routes root
`.env.local` to `.private/env/repo-root/.env.local`; backs up the destination;
compares source and destination manifests; and skips cloud sync when the
storage budget or encrypted-secret prerequisites are not satisfied.

For Git checkout conversion, use:

```bash
npm run hop -- import-git --source /path/to/repo --production-safe
npm run hop -- import-git-url --url https://github.com/org/repo.git
```

`import-git` requires a `.git` entry and uses the literal mirror path. With a
local `HOPIT_CLIENT_ENCRYPTION_KEY`, routed secrets can sync as encrypted object
blobs; without it, the local mirror completes but cloud sync is skipped.
`import-git-url` clones the remote URL into a temporary checkout, then runs the
same production-safe import path. Pass `--branch <name>` to import a specific
branch or tag.

Object storage maintenance is dry-run by default:

```bash
npm run hop -- storage status
npm run hop -- storage gc
npm run hop -- storage gc --execute
```

`storage gc` only deletes HopIt-managed, content-addressed object keys that are
not reachable from the current graph, and `--execute` is required for deletion.

```bash
npm run hop -- mirror \
  --profile production \
  --source /path/to/project \
  --codebase-id "$HOPIT_CODEBASE_ID" \
  --storage-budget-bytes "$HOPIT_BLOB_STORAGE_BUDGET_BYTES" \
  --production-safe
```

Normal sync skips `.private/env/` unless object storage and the local
`HOPIT_CLIENT_ENCRYPTION_KEY` or `hop keys` user-vault bridge are configured;
when configured, those files sync only as client-encrypted object blobs.
`.git/` entries are owner-private when present in a literal graph, but uploading
Git internals is still a sensitive operation and should only happen after the
budget, retention, and data-sensitivity policy is deliberate.

Initialize or inspect the local encryption device keyring:

```bash
npm run hop -- keys init-device --profile production
npm run hop -- keys status --profile production
npm run hop -- keys export-recovery --profile production --output "$HOME/HopIt-Backups/hopit-recovery.json"
```

By default, keyrings live under
`$HOPIT_AGENT_STATE_ROOT/keys/<codebaseId>.device.json` with mode `0600`; the
parent `keys` directory is mode `0700`. The keyring stores device private keys
locally and stores the user vault key only as a self-wrapped payload. `keys
status` prints only redacted fingerprints and booleans. `keys export-recovery`
encrypts the user vault key with a passphrase; set the passphrase only for that
one command through `--recovery-passphrase` or `HOPIT_RECOVERY_PASSPHRASE`, and
do not leave it in persistent env files. Use `--skip-cloud-registration` only
for local fixture tests or offline setup; production device cloud registration
now works with the D1 backend and remains available through the legacy Convex
fallback.

Point the same import at the real D1 backend with:

```bash
npm run hop -- import \
  --source /path/to/project \
  --codebase-id hopit \
  --profile production \
  --cloud-backend d1 \
  --force
```

Any command can use `--cloud-backend d1` plus `HOPIT_D1_API_BASE_URL` and the
D1 identity fields; server/bootstrap contexts use `HOPIT_D1_API_TOKEN`, while
installed devices can use `HOPIT_AGENT_SESSION_TOKEN` against the D1 proxy after
session registration. The selected cloud graph is then read from and written to
D1 instead of the local JSON file. Convex flags remain as a legacy fallback.
Local journal and event files still exist as the device safety log.

Production file bytes should use the object-blob layer instead of D1/Convex document storage:

```bash
HOPIT_BLOB_PROVIDER=r2
HOPIT_BLOB_PREFIX=production
HOPIT_BLOB_FREE_ONLY=1
HOPIT_BLOB_STORAGE_BUDGET_BYTES=8000000000
HOPIT_R2_ACCOUNT_ID=<cloudflare-account-id>
HOPIT_R2_BUCKET=hopit-blobs
HOPIT_R2_ACCESS_KEY_ID=<r2-access-key-id>
HOPIT_R2_SECRET_ACCESS_KEY=<r2-secret-access-key>
```

With those variables set, `hop sync` uploads regular file bytes to Cloudflare R2 first, then commits only metadata to the active cloud graph: storage mode, provider, object key, SHA-256, size, revision, path, and scope. `HOPIT_BLOB_FREE_ONLY=1` makes R2 use an 8 GB default budget, below Cloudflare R2's free storage tier, and fails before uploading a blob that would exceed that cap. `hydrate`, `refresh`, `hydrate-file`, recovery, export, and publish download object bytes and verify the hash before writing locally. Tests can use `--blob-provider filesystem --blob-root /tmp/hopit-blobs`. A later Backblaze B2 migration should use the same S3-compatible adapter with `HOPIT_BLOB_PROVIDER=b2`, `HOPIT_B2_BUCKET`, `HOPIT_B2_ENDPOINT`, `HOPIT_B2_REGION`, `HOPIT_B2_KEY_ID`, and `HOPIT_B2_APPLICATION_KEY`.

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
npm run hop -- init
npm run hop -- hydrate
npm run hop -- refresh
npm run hop -- sync
npm run hop -- recover
npm run hop -- watch
npm run hop -- status
npm run hop -- serve
npm run hop -- review
npm run hop -- merge
npm run hop -- validate
npm run hop -- doctor --profile production --codebase-id hopit
npm run hop -- backup --profile production --codebase-id hopit --output /path/to/private-backup
npm run hop -- install --profile production --codebase-id hopit --write-env
npm run hop -- workspace status
npm run hop -- workspace list
npm run hop -- workspace discover
npm run hop -- workspace ensure
npm run hop -- workspace attach
npm run hop -- workspace files
npm run hop -- workspace hydrate-file --path README.md
npm run hop -- workspace dehydrate --force
npm run hop -- remote-pull --profile production --codebase-id hopit
npm run hop -- device status
npm run hop -- session register --profile production --codebase-id hopit
npm run hop -- session list --profile production --codebase-id hopit
npm run hop -- export --output /path/to/git-export
npm run hop -- publish --output /path/to/git-publish
npm run hop -- service start --profile production --codebase-id hopit
npm run hop -- service run --profile production --codebase-id hopit
npm run hop -- service status --profile production --codebase-id hopit
```

`hop refresh` is the safe cloud-to-workspace command. It refuses to touch the
managed folder while the local journal has pending or failed entries or while
the disk has unjournaled local drift, then mirrors the current selected cloud
state into the workspace when the journal and manifest are clean. `watch`
applies the same safety idea at startup by recovering before hydrating. Bare
`hydrate` is a low-level primitive and should not be treated as safe refresh
unless the local journal is already clean.

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
npm run hop -- status \
  --cloud .hopit-agent/demo/cloud.json \
  --workspace .hopit-agent/demo/workspaces/hopit-core \
  --journal .hopit-agent/demo/journal.ndjson \
  --events .hopit-agent/demo/events.ndjson

npm run hop -- refresh \
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

The local fixture models Main, the selected active change set, owner identity,
session identity, and effective change-set visibility. The development fixture
still stores that graph in JSON, but commands reach it through a cloud graph
service boundary. That keeps demos dependency-free while allowing the same
command flow to target Convex for the real shared backend.

Requester-aware reads are explicit in both the fixture path and hosted Convex
dashboard path. Owner requesters see shared and `.private/` files. Collaborator
requesters see no active change-set files when visibility is `private`, see
shared files when visibility is `team-visible` or `review-visible`, and never
see `.private/` files.

Review and merge are agent-level commands in the current graph contract. `hop
review` opens the selected active change set for review and emits
`change_set.review_opened`. `hop merge` merges that selected active change set
into Main and emits `change_set.merged`. Local sync continues to acknowledge
writes into the selected active change set; Main should remain stable until the
explicit merge command advances it. Status exposes the selected change set's
review state, merge state, and latest review/merge events so the product UI can
distinguish synced draft work from accepted Main.

Conflict handling is part of the current graph contract. Stale selected-state or
file/base revision recovery and stale Main revision merge attempts emit
`change_set.conflict_detected`, persist conflict state on the selected active
change set, and leave local unacknowledged edits in place for review.

`hop validate` checks the configured cloud graph contract before dogfooding it:
schema version, codebase/Main/active-change-set identity, visibility enums,
review/merge/conflict states, file content/revisions, safe relative paths, and
path-derived `.private/` owner-private scope.

`hop workspace status|list|discover|ensure|attach|files|hydrate-file|dehydrate`
is the first product-facing workspace-root surface. It reports the configured
HopIt root, the current codebase folder, whether the codebase has been attached
or initialized, hydration state, dirty-state, visible cloud files, hydrated path
count, and the durable root index path. `discover` lists the configured visible
cloud codebase plus any indexed local workspaces. `attach` binds the configured
cloud codebase into the Workspace Root as metadata-only without downloading file
bodies, writes `.hopit/metadata.json`, and refuses non-empty unmanaged folders
unless `--force` is explicit. `hydrate-file` materializes one visible cloud path
into the managed folder. `dehydrate --force` removes clean cached file bodies,
writes workspace metadata, and marks the workspace metadata-only. `ensure`
creates the configured root and current managed codebase folder without claiming
a true virtual filesystem: the adapter remains `managed-folder`, cache mode
remains `local-cache`, and the status payload explicitly reports
`virtualized: false`.

Hydrate, refresh, and sync update `workspaces.json` under the agent state root
unless `HOPIT_WORKSPACE_INDEX` or `--workspace-index` overrides the path. Index
entries are scoped to the codebase and the concrete workspace path, so same
codebase materializations on different devices keep independent hydration
cursors. The index stores a hash-only content manifest for hydrated paths, not
file bodies, so status and remote-pull can detect unjournaled local drift without
duplicating workspace content.

`hop device` is an alias for `hop session`. `device status` reports the local
session id, device name, and whether the command is using a scoped per-device
session token. Session register/list/touch/revoke work on the D1 backend and
the legacy Convex fallback.

When both a legacy bootstrap token and `HOPIT_AGENT_SESSION_TOKEN` are present,
normal cloud commands prefer the scoped session token. Pass the bootstrap token
explicitly only for legacy Convex bootstrap/admin work.

`hop backup` writes a restorable diagnostic folder with cloud/status/event
state. `hop export` and `hop publish` are the current Git escape hatch. They create a
clean Git repository at `--output`, refuse outputs inside the managed workspace,
and omit `.private/` owner-only files by default. `hop export --include-private`
is available for an explicit owner-private backup. `hop publish` is stricter: it
requires the selected active change set to be reviewed and merged, and it always
omits `.private/`.

`hop service start|stop|status|restart` runs the watcher and local status server
as one background process. Use `--profile production` to keep agent state under
the platform app-state directory and managed workspaces under `~/HopIt
Workspaces` unless `HOPIT_AGENT_STATE_ROOT` or `HOPIT_WORKSPACE_ROOT` overrides
those defaults. `service start` waits for the local status endpoint and watcher
to become ready before it reports success, and failed startup removes the pid
file instead of leaving stale service state behind.

For user-level supervisors such as launchd or systemd, run the foreground
`hop service run` process. In the current macOS LaunchAgent install, launchd is
the process owner, so health is verified with `launchctl print` plus
`curl http://127.0.0.1:4785/status`. `hop service status` remains pid-file
oriented for the `service start` debug path until direct supervisor-owned
`service run` installs write a pid record.

Service mode syncs local workspace edits from the current device. It does not
run remote-pull by default, so the conservative cross-device handoff remains:
let device A sync, then run `hop remote-pull` or `hop refresh` on device B
before continuing there. This avoids pretending concurrent multi-device editing
is safe before the graph has stronger conflict/concurrency guards.

For personal dogfooding, `watch` and `service start` can opt into activity-gated
safe cloud refresh:

```bash
npm run hop -- service start \
  --profile production \
  --codebase-id hopit \
  --remote-pull
```

The remote-pull scheduler wakes only after local workspace activity has drained
through the local sync scheduler, then checks for a clean local journal, an idle
local sync scheduler, a fully materialized workspace, and the workspace index
cursor before calling the same safe `hop refresh` path. For D1 and legacy Convex
workspaces, it first reads only the codebase-level graph head. It performs the
heavier local hash-manifest scan and full graph refresh only after that cursor
shows the cloud revision moved. `hop remote-pull` runs that decision once, which
makes same-Mac and cross-device handoff verification deterministic without
starting a service. If pending or failed journal entries exist, the workspace is
partial/metadata-only, or disk content differs from the last materialized
manifest after a remote move, HopIt emits `remote-pull.skipped` and leaves the
workspace alone. Tune the activity cooldown with
`--remote-pull-cooldown-ms <ms>` or `HOPIT_REMOTE_PULL_COOLDOWN_MS`; the default
is `300000` (five minutes). `--remote-refresh-interval-ms` and
`HOPIT_REMOTE_REFRESH_INTERVAL_MS` remain legacy aliases for existing scripts.

Serve local agent status JSON:

```bash
npm run agent:serve
```

The status server is dependency-free and listens on `127.0.0.1:4785` by default. It is read-only and reports `adapter: managed-folder`, `cacheMode: local-cache`, the workspace root and current codebase folder, workspace index summary, hydration/materialized revision, hash-manifest summary, local clean/dirty state, remote cursor state, local cloud graph summary, requester identity and visibility-filtered file counts, pending/failed/acknowledged journal counts, recent events, and the latest acknowledgement, sync, recovery, remote-update, remote-pull, review, merge, and conflict state.

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
npm run hop -- status \
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

Promote this selected managed-folder proof into the full HopIt Workspace Root
contract. The root-level index, hydration/materialized revision state,
metadata-only and single-file hydrate primitives, scoped agent-session tokens,
object-backed content-addressed blobs, per-file agent mutations, configured-codebase
discover/attach, and opt-in remote-pull cursor are now in place. The next agent
work should add account-wide cloud codebase discovery, richer per-file cache
metadata, automatic lazy materialization policy, and production-grade
remote-update delivery.

In parallel, the cloud graph needs durable history reconstruction,
object-retention/garbage-collection policy, and full product write-path coverage
before concurrent multi-device editing is treated as production safe. Git compatibility can
continue as an escape hatch on top of
snapshots, but it should not displace Workspace Root, automatic device handoff,
or active change sets as the primary v1 product path. A true virtual filesystem
or RAM-only mount remains future optional research.

# Personal Production Runbook

This runbook is the first real-use path for one-person HopIt dogfooding. It keeps the local JSON graph as a development fallback, but treats Convex as the canonical cloud graph and Vercel as the protected hosted dashboard. Hosted workspace commands are disabled; hosted collaboration/member/work-item mutations exist in the codebase but remain behind the current Basic Auth/product-auth boundary.

## Current Deployment

- Vercel production dashboard: `https://hopit-ten.vercel.app`
- Vercel project: `robertg761s-projects/hopit`
- Convex project: `robertgordon761/hopit`
- Convex dev URL: `https://vibrant-ermine-445.convex.cloud`
- Convex production URL: `https://sincere-jaguar-17.convex.cloud`
- Seeded codebase id: `hopit`
- Production workspace: `/Users/robert/HopIt Workspaces/hopit`

## Required Configuration

Use long random secrets. Do not commit `.env.local`.
Routed env files under `.private/env/` are intentionally local-only for now.
They are not uploaded by the agent until HopIt has client-side encrypted secret
sync, where secret values are encrypted on-device for the intended user/device
set and remain unreadable to Convex, R2/B2/S3, and HopIt cloud operators.

```bash
HOPIT_CODEBASE_ID=hopit
HOPIT_AGENT_TOKEN=<long-random-agent-token>
HOPIT_CONVEX_URL=https://<deployment>.convex.cloud
NEXT_PUBLIC_CONVEX_URL=https://<deployment>.convex.cloud
HOPIT_AUTH_PROVIDER=basic
HOPIT_ALLOW_BASIC_AUTH_FALLBACK=1
HOPIT_DASHBOARD_USERNAME=hopit
HOPIT_DASHBOARD_PASSWORD=<long-random-dashboard-password>
HOPIT_AGENT_STATE_ROOT="$HOME/Library/Application Support/HopIt/Agent"
HOPIT_WORKSPACE_ROOT="$HOME/HopIt Workspaces"
HOPIT_WORKSPACE_INDEX="$HOME/Library/Application Support/HopIt/Agent/workspaces.json"
HOPIT_SESSION_ID=<this-device-session-id-after-register>
HOPIT_DEVICE_NAME="<your-device-name>"
HOPIT_AGENT_SESSION_TOKEN=<scoped-session-token-after-register>
HOPIT_AGENT_SESSION_CAPABILITIES=read,write,sync,watch
HOPIT_REMOTE_PULL=1
HOPIT_REMOTE_REFRESH_INTERVAL_MS=5000
HOPIT_BACKUP_ROOT="$HOME/HopIt-Backups"
HOPIT_EXPORT_ROOT="$HOME/HopIt-Exports"
HOPIT_BLOB_PROVIDER=r2
HOPIT_BLOB_PREFIX=production
HOPIT_BLOB_FREE_ONLY=1
HOPIT_BLOB_STORAGE_BUDGET_BYTES=8000000000
HOPIT_R2_ACCOUNT_ID=<cloudflare-account-id>
HOPIT_R2_BUCKET=hopit-blobs
HOPIT_R2_ACCESS_KEY_ID=<r2-access-key-id>
HOPIT_R2_SECRET_ACCESS_KEY=<r2-secret-access-key>
```

Validate local configuration without printing secrets:

```bash
set -a; source .env.local; set +a
npm run check:production-config
```

## Convex Backend

Deploy or update the production Convex functions, then make the agent token mandatory in Convex:

```bash
npm run convex:deploy
npx convex env set HOPIT_AGENT_TOKEN "$HOPIT_AGENT_TOKEN"
```

Convex functions now fail closed when `HOPIT_AGENT_TOKEN` is missing. `HOPIT_ALLOW_UNAUTHENTICATED_AGENT=1` exists only as a deliberate local-development escape hatch.

For local development against a dev Convex deployment, use `npm run convex:dev`
instead.

## Object Blob Storage

HopIt uses Convex for graph metadata, permissions, sessions, events, and dashboard reads. File bytes for production should live in object storage. The first provider is Cloudflare R2 through HopIt's S3-compatible adapter:

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

The agent uploads file bytes to R2 before committing Convex metadata. Convex stores `contentStorage=object-blob`, provider, object key, hash, and size; hydrate, refresh, export, and recovery download the object and verify the SHA-256 before writing it locally. For personal use, keep `HOPIT_BLOB_FREE_ONLY=1` and the default 8 GB budget so HopIt stops before crossing Cloudflare R2's free storage tier. To migrate to Backblaze B2 later, keep the same graph contract and switch the provider variables to `HOPIT_BLOB_PROVIDER=b2`, `HOPIT_B2_BUCKET`, `HOPIT_B2_ENDPOINT`, `HOPIT_B2_REGION`, `HOPIT_B2_KEY_ID`, and `HOPIT_B2_APPLICATION_KEY`.

Current no-charge R2 posture:

- Bucket: `hopit-blobs`
- Default storage class: Standard
- Public `r2.dev` access: disabled
- Stored objects: `0`
- Stored bytes: `0 B`
- Lifecycle: `free-only-auto-delete` expires objects after 1 day and aborts incomplete multipart uploads after 1 day
- Agent credentials: configured locally in `.env.local` and `~/.config/hopit/production.env` as a scoped account token with Object Read & Write access to `hopit-blobs` only
- Verification: a 44-byte HopIt object-blob smoke file was uploaded through the R2 adapter, hydrated back through HopIt, deleted, and the bucket returned to `0 B`

## Vercel Dashboard

Set these Vercel environment variables for Production, Preview, and Development unless a narrower scope is intentional:

```text
HOPIT_CODEBASE_ID
HOPIT_AGENT_TOKEN
HOPIT_CONVEX_URL
NEXT_PUBLIC_CONVEX_URL
HOPIT_AUTH_PROVIDER
HOPIT_ALLOW_BASIC_AUTH_FALLBACK
HOPIT_DASHBOARD_USERNAME
HOPIT_DASHBOARD_PASSWORD
HOPIT_BLOB_PROVIDER
HOPIT_BLOB_PREFIX
HOPIT_BLOB_FREE_ONLY
HOPIT_BLOB_STORAGE_BUDGET_BYTES
HOPIT_R2_ACCOUNT_ID
HOPIT_R2_BUCKET
HOPIT_R2_ACCESS_KEY_ID
HOPIT_R2_SECRET_ACCESS_KEY
```

Hosted HopIt requires Convex-backed status. The `/api/agent/command` route refuses local workspace commands on Vercel, and `src/proxy.ts` requires Basic authentication when deployed on Vercel. Vercel Deployment Protection can be enabled as an additional account-level guard.

## Domain-Deferred Work

HopIt does not need a custom domain for the current one-person production setup. Keep the generated Vercel URL and Basic Auth guard for now.

Pinned until an owned HopIt domain exists:

- Clerk production instance completion with `pk_live_` and `sk_live_` keys.
- Clerk production issuer and DNS verification.
- Retiring `HOPIT_AUTH_PROVIDER=basic` and product-level Basic Auth from the hosted deployment.
- Production OAuth callback and invite-acceptance smoke tests on an owned domain.

Continue without a domain:

- Convex-backed dashboard reads.
- R2-backed object blob sync from the local agent.
- Local production-profile agent commands.
- Git export/publish escape hatch.
- Membership, invitation, code browser, issue, discussion, and release implementation that can run behind Basic Auth.

Pull Vercel envs locally only after the project is linked:

```bash
vercel link
vercel env pull .env.local --yes --environment=production
```

## Standalone Install

The source checkout can run the agent with `npm run hop -- ...`, but the
production-shaped install path is the standalone `hop` package:

```bash
npm run package:hop
tar -xzf artifacts/hop-darwin-arm64.tar.gz -C /tmp
/tmp/hop-darwin-arm64/bin/hop help
```

The packaged artifact contains:

- `bin/hop`: the HopIt command.
- `runtime/node`: the embedded Node runtime.
- `examples/production.env.example`: a local env template for this device.
- `support/install-macos-launch-agent.sh`: user-level macOS start-on-login setup. It copies the package into `~/Library/Application Support/HopIt/Runtime` before writing the LaunchAgent so launchd does not need to execute from a project or downloads folder.
- `support/install-systemd-user-service.sh`: user-level Linux start-on-login setup.

Create the local env file before installing a login service:

```bash
mkdir -p "$HOME/.config/hopit"
cp /tmp/hop-darwin-arm64/examples/production.env.example "$HOME/.config/hopit/production.env"
$EDITOR "$HOME/.config/hopit/production.env"
```

Do not put the generated `production.env` file in this repo. It contains the
bootstrap token or scoped device token for this machine. When running source
checkout commands from a shell, export the file first:

```bash
set -a; source "$HOME/.config/hopit/production.env"; set +a
```

## Local Agent Service

Import one real project into Convex and hydrate a production-profile managed workspace:

```bash
npm run hop -- import \
  --profile production \
  --source /path/to/project \
  --codebase-id "$HOPIT_CODEBASE_ID" \
  --convex-url "$HOPIT_CONVEX_URL" \
  --agent-token "$HOPIT_AGENT_TOKEN" \
  --force
```

Register this device after the initial bootstrap. The returned `sessionToken`
is shown only once; store it as `HOPIT_AGENT_SESSION_TOKEN` on this device.

```bash
npm run hop -- device register \
  --profile production \
  --codebase-id "$HOPIT_CODEBASE_ID" \
  --convex-url "$HOPIT_CONVEX_URL" \
  --agent-token "$HOPIT_AGENT_TOKEN" \
  --device-name "$(hostname)"

npm run hop -- device list \
  --profile production \
  --codebase-id "$HOPIT_CODEBASE_ID" \
  --convex-url "$HOPIT_CONVEX_URL" \
  --agent-token "$HOPIT_AGENT_TOKEN"
```

After `HOPIT_AGENT_SESSION_TOKEN` is set, normal graph reads, per-file sync
mutations, and agent events can use the scoped device token. Keep
`HOPIT_AGENT_TOKEN` available for bootstrap/admin tasks only. When both tokens
are present, normal commands prefer the scoped session token; pass
`--agent-token` explicitly when you intend to use the bootstrap/admin secret.

Start the local agent service manually. It runs the watcher and local status server from one background process, writes a pid file under the agent state root, and binds status to `127.0.0.1:4785` by default. `service start` only reports success after the status endpoint is reachable and the watcher is running, and the spawned `service run` process stays alive until it receives a stop signal.

```bash
npm run hop:service:start -- --codebase-id "$HOPIT_CODEBASE_ID"

npm run hop:service:status -- --codebase-id "$HOPIT_CODEBASE_ID"
npm run hop:service:stop -- --codebase-id "$HOPIT_CODEBASE_ID"
```

For start on login, prefer a user-level supervisor that runs the foreground
service process (`hop service run`) rather than nesting `service start` inside
launchd or systemd. On macOS, the generated installer first installs the runtime
under HopIt's Application Support folder, then writes and starts the plist:

```bash
/tmp/hop-<platform>-<arch>/support/install-macos-launch-agent.sh
/tmp/hop-<platform>-<arch>/support/install-systemd-user-service.sh
```

The installer creates the env file from the example and exits if it does not
already exist, so the first run is safe. Edit the env file, rerun the installer,
then check service health:

```bash
npm run hop:service:status -- --codebase-id "$HOPIT_CODEBASE_ID"
curl http://127.0.0.1:4785/status
```

For cross-device handoff today, the safe primitive is still refresh, and
`--remote-pull` is the personal-dogfood automation around that primitive. The
service syncs local edits from the device you are using; another device can run
the remote-pull loop, a one-shot remote-pull check, or an explicit safe refresh
before you continue there.
Remote-pull only applies when the workspace is fully materialized, the journal is
clean, and disk content still matches the hash-only materialization manifest; if
status shows `workspace.localChanges.state` as `dirty`, sync or recover that
device before trusting handoff:

```bash
npm run hop -- remote-pull \
  --profile production \
  --codebase-id "$HOPIT_CODEBASE_ID" \
  --convex-url "$HOPIT_CONVEX_URL" \
  --session-token "$HOPIT_AGENT_SESSION_TOKEN"
```

```bash
npm run hop -- refresh \
  --profile production \
  --codebase-id "$HOPIT_CODEBASE_ID" \
  --convex-url "$HOPIT_CONVEX_URL" \
  --session-token "$HOPIT_AGENT_SESSION_TOKEN"
```

Do not edit the same codebase on two devices at the same time yet. The current
dogfood path is sequential handoff: finish or pause on device A, let its service
sync, refresh device B, then continue on device B.

Production-profile defaults keep state and workspaces out of the source checkout:

- macOS state: `~/Library/Application Support/HopIt/Agent`
- Linux state: `${XDG_STATE_HOME:-~/.local/state}/hopit/agent`
- workspace root: `~/HopIt Workspaces`
- workspace index: `~/Library/Application Support/HopIt/Agent/workspaces.json`

## Observability

The local status server is intentionally read-only. `/status` is a fast daemon
health snapshot built from local agent state files; it avoids a full workspace
dirty scan so it stays responsive even when the workspace is large. Use
`hop status` or `hop doctor` when you need the heavier local clean/dirty audit.
`/cloud` returns the visible graph for the dashboard without running that local
workspace audit. Use these checks to confirm the daemon, journal, remote cursor,
and latest events before trusting a device handoff:

```bash
npm run hop -- status --profile production --codebase-id "$HOPIT_CODEBASE_ID"
npm run hop:service:status -- --codebase-id "$HOPIT_CODEBASE_ID"
curl http://127.0.0.1:4785/status
curl http://127.0.0.1:4785/events
curl http://127.0.0.1:4785/journal
```

Healthy personal-production service status should show:

- `running: true` from `hop service status`.
- `agent.readiness: "ready"`.
- `agent.watch.state: "watching"`.
- `agent.journal.pendingCount: 0` before refresh or cross-device handoff.
- `agent.journal.failedCount: 0`.
- `agent.remotePull.state: "enabled"` when `HOPIT_REMOTE_PULL=1`, unless the current service run has safely skipped because local work needs attention.

If the LaunchAgent installer is used, logs go to
`~/Library/Logs/HopIt/agent.out.log` and
`~/Library/Logs/HopIt/agent.err.log`. For `service start`, the log path is
reported in the JSON start output and lives next to the pid file under the
agent state root by default.

## Git Escape Hatch

Before trusting HopIt with valuable work, keep a restorable agent-state backup,
an owner-private Git export, and a publishable Git export available.

```bash
npm run hop -- validate --profile production --codebase-id "$HOPIT_CODEBASE_ID"
mkdir -p "$HOPIT_BACKUP_ROOT" "$HOPIT_EXPORT_ROOT"
npm run hop:backup -- --codebase-id "$HOPIT_CODEBASE_ID" --output "$HOPIT_BACKUP_ROOT/hopit-$(date +%Y%m%d-%H%M%S)" --force
npm run hop:private-export -- --codebase-id "$HOPIT_CODEBASE_ID" --output "$HOPIT_EXPORT_ROOT/hopit-private-export" --force
npm run hop:export -- --codebase-id "$HOPIT_CODEBASE_ID" --output "$HOPIT_EXPORT_ROOT/hopit-export" --force
```

`hop:backup` writes a restorable agent-state folder and should be treated as
owner-private operational data. `hop:private-export` creates a Git export with
`.private/` included for owner backup. `export` omits `.private/` by default.
`publish` is stricter: it requires a reviewed and merged active change set and
always omits `.private/`.

```bash
npm run hop -- review --profile production --codebase-id "$HOPIT_CODEBASE_ID"
npm run hop -- merge --profile production --codebase-id "$HOPIT_CODEBASE_ID"
npm run hop:publish -- --codebase-id "$HOPIT_CODEBASE_ID" --output "$HOPIT_EXPORT_ROOT/hopit-publish" --force
```

Keep at least one recent private backup outside the Workspace Root and outside
the agent state root. The production checker warns when backup/export roots are
not configured, and fails if state/index paths are nested into the Workspace
Root.

## Token Rotation

Rotate scoped device tokens without deleting the local workspace:

1. Register a new session with the bootstrap token.
2. Replace `HOPIT_AGENT_SESSION_TOKEN` in `~/.config/hopit/production.env` or `.env.local`.
3. Restart the local service.
4. Confirm status reads through the new token.
5. Revoke the old session id.

```bash
npm run hop -- session register \
  --profile production \
  --codebase-id "$HOPIT_CODEBASE_ID" \
  --convex-url "$HOPIT_CONVEX_URL" \
  --agent-token "$HOPIT_AGENT_TOKEN" \
  --device-name "$HOPIT_DEVICE_NAME"

npm run hop:service:restart -- --codebase-id "$HOPIT_CODEBASE_ID"
npm run hop:service:status -- --codebase-id "$HOPIT_CODEBASE_ID"

npm run hop -- session revoke \
  --profile production \
  --codebase-id "$HOPIT_CODEBASE_ID" \
  --convex-url "$HOPIT_CONVEX_URL" \
  --agent-token "$HOPIT_AGENT_TOKEN" \
  --session-id old-session-id
```

If the bootstrap `HOPIT_AGENT_TOKEN` itself rotates in Convex or Vercel, update
Convex env, Vercel env, and local bootstrap storage together, then rerun
`set -a; source .env.local; set +a; npm run check:production-config`. Installed devices should continue using
their scoped session token for normal operation.

## Current Limits

- Hosted workspace commands are intentionally disabled; local workspace commands run through the local agent. Hosted collaboration/member/work-item APIs exist, but production is still guarded by the current Basic Auth/product-auth boundary.
- Basic Auth is the current domain-deferred deployment guard. The repo has Clerk-backed product auth code, durable users, memberships, invitations, and first server-side permission checks, but production Clerk rollout is pinned until HopIt has an owned domain.
- Convex now separates graph/file metadata from file bytes and supports object-backed blobs through the agent sync path with per-file revision-guarded mutations. Durable history reconstruction, garbage collection for unreferenced objects, and full product write-path coverage are still incomplete.
- Git export/publish creates a clean local Git repo; it does not push to a remote.
- The standalone artifact includes start-on-login support scripts, but it is not signed, notarized, or packaged as a native installer yet.
- Token rotation is CLI/runbook driven; there is no dashboard UX for device credential recovery yet.
- The dashboard now has a first read-only code browser plus issue, discussion, release, and member/invite surfaces. Real diffs, inline review comments, durable merge records, project boards, richer release artifacts, and push-style live updates remain future work.

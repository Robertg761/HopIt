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
- `support/install-macos-launch-agent.sh`: user-level macOS start-on-login setup.
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

Start the local agent service manually. It runs the watcher and local status server from one background process, writes a pid file under the agent state root, and binds status to `127.0.0.1:4785` by default. `service start` only reports success after the status endpoint is reachable and the watcher is running.

```bash
npm run hop:service:start -- --codebase-id "$HOPIT_CODEBASE_ID"

npm run hop:service:status -- --codebase-id "$HOPIT_CODEBASE_ID"
npm run hop:service:stop -- --codebase-id "$HOPIT_CODEBASE_ID"
```

For start on login, prefer a user-level supervisor that runs the foreground
service process (`hop service run`) rather than nesting `service start` inside
launchd or systemd:

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
the remote-pull loop or an explicit safe refresh before you continue there.
Remote-pull only applies when the workspace is fully materialized, the journal is
clean, and disk content still matches the hash-only materialization manifest; if
status shows `workspace.localChanges.state` as `dirty`, sync or recover that
device before trusting handoff:

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

The local status server is intentionally read-only. Use it to confirm the
daemon, journal, workspace dirty-state, remote cursor, and latest events before
trusting a device handoff:

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
- `agent.remotePull.state: "enabled"` when `HOPIT_REMOTE_PULL=1`.

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
- Convex now separates graph/file metadata from content-addressed `fileBlobs` for the agent text-file path and supports per-file revision-guarded mutations. Large-file/object storage, durable history reconstruction, and full product write-path coverage are still incomplete.
- Git export/publish creates a clean local Git repo; it does not push to a remote.
- The standalone artifact includes start-on-login support scripts, but it is not signed, notarized, or packaged as a native installer yet.
- Token rotation is CLI/runbook driven; there is no dashboard UX for device credential recovery yet.
- The dashboard now has a first read-only code browser plus issue, discussion, release, and member/invite surfaces. Real diffs, inline review comments, durable merge records, project boards, richer release artifacts, and push-style live updates remain future work.

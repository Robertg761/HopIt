# HopIt

HopIt is an early-stage cloud-native code workspace. The core idea is that a codebase lives in the cloud, while each device gets a HopIt Workspace Root that exposes managed local folders and syncs edits back automatically.

The first product bet is simple: working on code should feel local, but live in the cloud. A developer should be able to open a HopIt codebase on any device, edit it with normal tools, and continue somewhere else without a clone to manage, stale checkout, push, pull, stash, or half-finished recovery flow.

Git compatibility still matters, but Git is not the primary day-to-day workspace model. Git should become an import/export and publish-history layer around cloud workspaces, active change sets, and accepted Main history.

HopIt does not use an ignore-file model for product sharing. Files under `.private/` are still snapshotted, synced, and versioned, but they are owner-visible only. Files outside `.private/` are eligible for collaboration, review, and merge according to the active change set's visibility settings and the codebase's permissions.

## Initial Scope

- Cloud-backed codebase dashboard with live workspace and sync state.
- Cloud codebase file graph, Main state, active change sets, recent activity, collaborator presence, and connected device visibility.
- HopIt Workspace Root: a user-chosen local root where cloud codebases appear as agent-owned managed folders.
- Local HopIt agent that materializes cloud metadata and file content into normal folders when needed.
- Agent-owned local cache for lazy hydration, editor compatibility, sync, pruning, and recovery.
- Safe sync journal for writes that have not been acknowledged by the cloud yet.
- Active change sets that receive live synced edits before review or merge into Main.
- Change-set visibility controls with global defaults, per-codebase overrides, and per-change-set overrides.
- Automatic remote-update delivery so same-owner devices can receive current active change-set state without a manual refresh ritual.
- Production storage based on file metadata, content-addressed blobs, and per-file revision guards rather than whole-graph overwrites.
- Scoped device/session auth separate from human product auth.
- Git compatibility as an import/export and publish layer, not the source of continuity.
- Explicit `.private/` visibility: synced and versioned, but owner-visible only.

## Current State

HopIt has moved past a local-only spike. The current dogfood baseline is a deployed, production-shaped personal system:

- Vercel production dashboard at `https://hopit-ten.vercel.app`.
- Convex production graph at `https://sincere-jaguar-17.convex.cloud`.
- A seeded `hopit` codebase graph with 58 source files.
- A production-profile managed workspace at `/Users/robert/HopIt Workspaces/hopit`.
- Hosted dashboard code supports Clerk product auth, but domain-dependent Clerk production rollout is intentionally paused. The current production deployment remains behind Basic Auth while HopIt uses the generated Vercel URL.
- Hosted status reads from Convex; hosted workspace commands are intentionally disabled.
- Local production-profile `hop` commands can import, hydrate, sync, refresh, recover, review, merge, export, publish, and validate.
- `hop workspace` persists a root-level `workspaces.json` index with per-workspace hydration/cursor state, can discover the configured cloud codebase, attach it into the Workspace Root as metadata-only, list visible cloud files, hydrate one file, and dehydrate clean workspaces back to metadata-only state.
- `hop device` / `hop session` can report local device identity, and Convex can issue, list, touch, revoke, and authorize scoped agent-session tokens for graph reads, per-file writes, and event sync.
- The dashboard now includes provider sign-in routes, owner claim, member/invite management, a read-only code browser, and first issue/discussion/release workflows backed by Convex.

The system is now usable as a one-person private dogfood environment, but it is not yet a full GitHub or Git replacement. The next major product phase is a solid v1 workspace: HopIt Workspace Root, managed-folder/lazy materialization, automatic remote update delivery, content-addressed storage with revision guards, scoped device/session auth, and GitHub-like collaboration surfaces. Work that requires an owned production domain, such as Clerk `pk_live_`/`sk_live_` rollout and retiring Basic Auth, is pinned until a domain is purchased.

See [docs/github-lite-collaboration-plan.md](docs/github-lite-collaboration-plan.md) for the overall implementation plan, plus [docs/auth-collaboration-plan.md](docs/auth-collaboration-plan.md), [docs/review-code-browser-plan.md](docs/review-code-browser-plan.md), and [docs/work-items-releases-plan.md](docs/work-items-releases-plan.md) for the detailed sub-plans.

## Solid V1 Direction

The v1 target is not a Git clone manager and not yet a true native filesystem provider. It is a production-shaped HopIt Workspace Root:

- A user chooses a local root such as `~/HopIt Workspaces`.
- Cloud codebases appear there as HopIt-managed project folders.
- Metadata can be visible before every file body is downloaded.
- Files are materialized safely when the workspace opens, when a tool needs them, or when remote updates arrive.
- Local edits are journaled before cloud acknowledgement and sync into the user's active change set.
- Other same-owner devices receive acknowledged changes automatically when the local journal is clean, or get a visible conflict/blocked state when it is not.
- Web surfaces show code, diffs, review state, history, issues, discussions, projects, releases, members, invitations, and permissions.

Today HopIt has the managed-folder spike, workspace-root command surface with a durable index, configured-codebase discovery, metadata-only attach, hydration/cursor status, metadata-only/dehydrate and single-file hydrate primitives, service wrapper, Convex graph, Basic Auth protected dashboard, first collaboration objects, explicit refresh-based two-session continuity, scoped agent-session token groundwork, and opt-in safe remote-pull polling plus one-shot remote-pull checks for personal dogfooding. Remaining v1 work is account-wide codebase discovery, full lazy materialization policy, production-grade push/subscription remote-update delivery, large-file/object storage, routeable diff/review/history UI, installer/tray setup, and broader cross-device verification.

## Product Principles

- Main is the accepted shared source of truth for a codebase.
- Active change sets are cloud-backed working states that sync live across a user's devices before merge.
- Local files are a managed cache, not a user-owned checkout.
- The Workspace Root is the user-facing entry point; managed folders are the first implementation strategy.
- Git history still matters, but saving work and publishing work are separate actions.
- Device handoff should be boring: open the project and keep going.
- Sync is not merge: live edits are acknowledged into an active change set, then reviewed or merged into Main when ready.
- Change-set visibility is user-configurable, with the effective setting resolved as per-change-set override, then codebase override, then global user default, then product default.
- Conflicts should be surfaced as reviewable workspace states, not surprise terminal chores.
- The prototype should prove the managed workspace root and lazy materialization path before native filesystem-provider research.
- The first version should optimize for personal and small-team code sharing before broad open-source network features.
- V1 should avoid user-managed Git-style branches, forks, worktrees, wiki pages, stars, and social discovery surfaces. Automatic active change sets are part of the core model.

## Development

```bash
npm install
npm run dev
```

Run the local workspace agent through the `hop` command:

```bash
npm run hop -- help
```

For local development, `npm link` makes `hop` available globally from this checkout.
Use `npm run agent:status` for a one-shot local status JSON printout, and
`npm run agent:serve` to start the read-only local agent status server.

Build the production bundle with:

```bash
npm run build
```

Build a standalone `hop` artifact for the current macOS or Linux platform with:

```bash
npm run package:hop
```

The packager downloads the official Node runtime for the current `darwin` or
`linux` `x64`/`arm64` host, bundles the HopIt agent CLI, writes an unpacked
artifact to `artifacts/hop-<platform>-<arch>/`, and creates
`artifacts/hop-<platform>-<arch>.tar.gz`. The packaged command runs as
`./bin/hop` and does not require Node or npm on the target machine. Windows
packaging exits unsupported until the packager handles Node's Windows `.zip`
runtime archives. The artifact also includes `examples/production.env.example`
plus macOS LaunchAgent and Linux systemd user-service support scripts under
`support/`. These artifacts are unsigned for now.

## Hosted Backend

HopIt now supports a Convex-backed cloud graph for the real shared backend. The local JSON graph remains useful for offline development, but Convex is the intended shared source of truth when these variables are configured:

```bash
HOPIT_CODEBASE_ID=hopit
HOPIT_AGENT_TOKEN=replace-with-a-long-random-secret
HOPIT_CONVEX_URL=https://your-convex-deployment.convex.cloud
NEXT_PUBLIC_CONVEX_URL=https://your-convex-deployment.convex.cloud
HOPIT_AUTH_PROVIDER=basic
HOPIT_ALLOW_BASIC_AUTH_FALLBACK=1
HOPIT_DASHBOARD_USERNAME=hopit
HOPIT_DASHBOARD_PASSWORD=replace-with-a-long-random-dashboard-password
HOPIT_AGENT_STATE_ROOT="/Users/you/Library/Application Support/HopIt/Agent"
HOPIT_WORKSPACE_ROOT="/Users/you/HopIt Workspaces"
HOPIT_WORKSPACE_INDEX="/Users/you/Library/Application Support/HopIt/Agent/workspaces.json"
HOPIT_SESSION_ID=replace-with-this-device-session-id
HOPIT_DEVICE_NAME="Your Mac"
HOPIT_AGENT_SESSION_TOKEN=replace-after-hop-device-register
HOPIT_AGENT_SESSION_CAPABILITIES=read,write,sync,watch
HOPIT_REMOTE_PULL=1
HOPIT_REMOTE_REFRESH_INTERVAL_MS=5000
HOPIT_BACKUP_ROOT=/Users/you/HopIt-Backups
HOPIT_EXPORT_ROOT=/Users/you/HopIt-Exports
```

Start Convex locally and link the project with:

```bash
npm run convex:dev
```

That command prompts for Convex login/project setup, pushes the `convex/` backend functions, and writes the real development deployment URL. Production updates should use:

```bash
npm run convex:deploy
```

Set the same `HOPIT_AGENT_TOKEN` in Convex with:

```bash
npx convex env set HOPIT_AGENT_TOKEN replace-with-a-long-random-secret
```

Import a real local project into the Convex backend with:

```bash
npm run hop -- import --source /path/to/project --codebase-id hopit --convex-url "$HOPIT_CONVEX_URL" --agent-token "$HOPIT_AGENT_TOKEN" --force
```

After the bootstrap token is configured, register this device and store the returned `sessionToken` as `HOPIT_AGENT_SESSION_TOKEN`:

```bash
npm run hop -- device register --profile production --codebase-id "$HOPIT_CODEBASE_ID"
```

The deployment-wide `HOPIT_AGENT_TOKEN` remains the bootstrap/admin secret. Installed devices should use scoped session tokens for normal reads, per-file sync, and event writes.
When both tokens are present, normal commands prefer `HOPIT_AGENT_SESSION_TOKEN`; pass `--agent-token` explicitly for bootstrap/admin operations.

For current personal production hosting, deploy the Next.js app to Vercel and set `HOPIT_CODEBASE_ID`, `HOPIT_AGENT_TOKEN`, `HOPIT_CONVEX_URL`, `NEXT_PUBLIC_CONVEX_URL`, `HOPIT_AUTH_PROVIDER=basic`, `HOPIT_ALLOW_BASIC_AUTH_FALLBACK=1`, `HOPIT_DASHBOARD_USERNAME`, and `HOPIT_DASHBOARD_PASSWORD` as environment variables. Keep Clerk production variables unset until HopIt has an owned production domain. The hosted dashboard reads from Convex through `/api/agent/status`; local workspace commands still run through the local HopIt agent on your machine and are refused on Vercel.

Validate production configuration with:

```bash
set -a; source .env.local; set +a
npm run check:production-config
```

Run the local agent with production-profile paths outside the source checkout:

```bash
npm run hop:service:start -- --codebase-id "$HOPIT_CODEBASE_ID"
```

Start-on-login supervisors should run the long-lived foreground service process:

```bash
npm run hop:service:run
```

Use the generated standalone package support scripts for user-level login startup:

```bash
./artifacts/hop-<platform>-<arch>/support/install-macos-launch-agent.sh
./artifacts/hop-<platform>-<arch>/support/install-systemd-user-service.sh
```

Keep a restorable agent-state backup, an owner-private Git export, and a public
Git export available:

```bash
mkdir -p "$HOPIT_BACKUP_ROOT" "$HOPIT_EXPORT_ROOT"
npm run hop:backup -- --codebase-id "$HOPIT_CODEBASE_ID" --output "$HOPIT_BACKUP_ROOT/hopit-$(date +%Y%m%d-%H%M%S)" --force
npm run hop:private-export -- --codebase-id "$HOPIT_CODEBASE_ID" --output "$HOPIT_EXPORT_ROOT/hopit-private-export" --force
npm run hop:export -- --codebase-id "$HOPIT_CODEBASE_ID" --output "$HOPIT_EXPORT_ROOT/hopit-export" --force
```

Use `npm run hop:publish` only after the selected active change set has been
reviewed and merged.

For scoped device-token rotation, register the replacement session, update
`HOPIT_AGENT_SESSION_TOKEN`, restart the service, then revoke the old session id:

```bash
npm run hop -- session register --profile production --device-name "$HOPIT_DEVICE_NAME"
npm run hop:service:restart -- --codebase-id "$HOPIT_CODEBASE_ID"
npm run hop -- session revoke --profile production --session-id old-session-id
```

Observe the local agent before trusting a handoff:

```bash
npm run hop:service:status -- --codebase-id "$HOPIT_CODEBASE_ID"
npm run hop -- status --profile production --codebase-id "$HOPIT_CODEBASE_ID"
curl http://127.0.0.1:4785/status
curl http://127.0.0.1:4785/events
```

For the full one-person production setup, see [docs/personal-production.md](docs/personal-production.md).

Import a real local project into HopIt's managed workspace state with:

```bash
npm run hop -- import --source /path/to/project --force
```

The import command scans text files from the source folder, skips generated folders and sensitive files such as `.git`, `.hopit-agent`, `.next`, `node_modules`, build outputs, and `.env*`, writes `.hopit-agent/cloud.json`, and hydrates `.hopit-agent/workspaces/hopit-core`.

To run the live local prototype, start the agent status server in one terminal:

```bash
npm run agent:serve
```

Then start the web app in another terminal:

```bash
npm run dev
```

The dashboard proxies `http://127.0.0.1:4785/status` through `/api/agent/status` and shows live local-agent state, including the managed workspace path, cloud/Main revisions, pending and failed journal counts, `.private/` visibility, review/merge/conflict state, codebase files, and recent events. Set `HOPIT_AGENT_BASE_URL` if the agent status server is listening somewhere else.

The local agent panel exposes real workspace actions backed by a whitelisted local API route:

- `Sync`: journal and acknowledge local workspace edits into the active change set.
- `Refresh`: safely mirror clean selected cloud state into the workspace.
- `Recover`: replay pending journal entries.
- `Review`: open the selected active change set for review.
- `Merge`: merge the reviewed active change set into Main.

For the local agent architecture, including the cloud file graph, managed-folder adapter, local cache, safety journal, status API, event log, and future optional filesystem research, see [docs/agent-architecture.md](docs/agent-architecture.md).

For the current done/in-progress/next tracker with proof commands and milestone status, see [docs/progress.md](docs/progress.md).

## Repository Layout

```text
src/
  app/          Next.js app routes, layout, and global styles
  components/   HopIt product shell and shared UI primitives
  hooks/        shared React hooks
  lib/          shared utilities
packages/
  agent/        local HopIt agent and CLI for workspace hydration, sync, service, and exports
docs/
  agent-architecture.md  local agent architecture and read/write acknowledgement flow
  auth-collaboration-plan.md  accounts, memberships, permissions, and invitations plan
  github-lite-collaboration-plan.md  collaboration sub-plan for auth, review, issues, and releases
  review-code-browser-plan.md  code browsing, diffs, reviews, comments, and history plan
  work-items-releases-plan.md  issues, projects, discussions, and releases plan
  mvp-plan.md  first-version product and architecture plan
  personal-production.md  one-person production setup and dogfood runbook
  progress.md  current milestone progress, evidence, and next work queue
```

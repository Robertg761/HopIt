# HopIt

HopIt is an early-stage cloud-native code workspace. The core idea is that a codebase lives in the cloud, while each device gets a managed workspace folder that behaves like a normal local folder and syncs edits back automatically.

The first product bet is simple: working on code should feel local, but live in the cloud. A developer should be able to open a HopIt codebase on any device, edit it with normal tools, and continue somewhere else without a clone to manage, stale checkout, push, pull, stash, or half-finished recovery flow.

Git compatibility still matters, but Git is not the primary day-to-day workspace model. Git should become an import/export and publish-history layer around cloud workspaces, active change sets, and accepted Main history.

HopIt does not use an ignore-file model for product sharing. Files under `.private/` are still snapshotted, synced, and versioned, but they are owner-visible only. Files outside `.private/` are eligible for collaboration, review, and merge according to the active change set's visibility settings and the codebase's permissions.

## Initial Scope

- Cloud-backed codebase dashboard with live workspace and sync state.
- Cloud codebase file graph, Main state, active change sets, recent activity, collaborator presence, and connected device visibility.
- Local HopIt agent that materializes a cloud codebase into a normal managed folder.
- Agent-owned local cache for hydration, editor compatibility, sync, and recovery.
- Safe sync journal for writes that have not been acknowledged by the cloud yet.
- Active change sets that receive live synced edits before review or merge into Main.
- Change-set visibility controls with global defaults, per-codebase overrides, and per-change-set overrides.
- Git compatibility as an import/export and publish layer, not the source of continuity.
- Explicit `.private/` visibility: synced and versioned, but owner-visible only.

## Product Principles

- Main is the accepted shared source of truth for a codebase.
- Active change sets are cloud-backed working states that sync live across a user's devices before merge.
- Local files are a managed cache, not a user-owned checkout.
- Git history still matters, but saving work and publishing work are separate actions.
- Device handoff should be boring: open the project and keep going.
- Sync is not merge: live edits are acknowledged into an active change set, then reviewed or merged into Main when ready.
- Change-set visibility is user-configurable, with the effective setting resolved as per-change-set override, then codebase override, then global user default, then product default.
- Conflicts should be surfaced as reviewable workspace states, not surprise terminal chores.
- The prototype should prove the managed workspace folder before chasing broad hosting features.
- The first version should optimize for personal and small-team code sharing before broad open-source network features.
- V1 should avoid user-managed Git-style branches, forks, worktrees, wiki pages, stars, and social discovery surfaces. Automatic active change sets are part of the core model.

## Development

```bash
npm install
npm run dev
```

Run the local workspace agent through the `hop` command:

```bash
npm exec -- hop help
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
runtime archives. These artifacts are unsigned for now.

## Hosted Backend

HopIt now supports a Convex-backed cloud graph for the real shared backend. The local JSON graph remains useful for offline development, but Convex is the intended shared source of truth when these variables are configured:

```bash
HOPIT_CODEBASE_ID=hopit
HOPIT_AGENT_TOKEN=replace-with-a-long-random-secret
HOPIT_CONVEX_URL=https://your-convex-deployment.convex.cloud
NEXT_PUBLIC_CONVEX_URL=https://your-convex-deployment.convex.cloud
HOPIT_DASHBOARD_USERNAME=hopit
HOPIT_DASHBOARD_PASSWORD=replace-with-a-long-random-dashboard-password
HOPIT_AGENT_STATE_ROOT=/Users/you/Library/Application Support/HopIt/Agent
HOPIT_WORKSPACE_ROOT=/Users/you/HopIt Workspaces
```

Start Convex locally and link the project with:

```bash
npm run convex:dev
```

That command prompts for Convex login/project setup, pushes the `convex/` backend functions, and writes the real deployment URL. Set the same `HOPIT_AGENT_TOKEN` in Convex with:

```bash
npx convex env set HOPIT_AGENT_TOKEN replace-with-a-long-random-secret
```

Import a real local project into the Convex backend with:

```bash
npm exec -- hop import --source /path/to/project --codebase-id hopit --convex-url "$HOPIT_CONVEX_URL" --agent-token "$HOPIT_AGENT_TOKEN" --force
```

For production hosting, deploy the Next.js app to Vercel and set `HOPIT_CODEBASE_ID`, `HOPIT_AGENT_TOKEN`, `HOPIT_CONVEX_URL`, `NEXT_PUBLIC_CONVEX_URL`, `HOPIT_DASHBOARD_USERNAME`, and `HOPIT_DASHBOARD_PASSWORD` as Vercel environment variables. The hosted dashboard reads from Convex through `/api/agent/status`; local workspace commands still run through the local HopIt agent on your machine and are refused on Vercel.

Validate production configuration with:

```bash
npm run check:production-config
```

Run the local agent with production-profile paths outside the source checkout:

```bash
npm exec -- hop service start --profile production --codebase-id "$HOPIT_CODEBASE_ID"
```

Export or publish a clean Git escape hatch with:

```bash
npm exec -- hop export --profile production --codebase-id "$HOPIT_CODEBASE_ID" --output /path/to/export --force
npm exec -- hop publish --profile production --codebase-id "$HOPIT_CODEBASE_ID" --output /path/to/publish --force
```

For the full one-person production setup, see [docs/personal-production.md](docs/personal-production.md).

Import a real local project into HopIt's managed workspace state with:

```bash
npm exec -- hop import --source /path/to/project --force
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
  agent/        local agent spike for cloud graph hydration and write journaling
docs/
  agent-architecture.md  local agent architecture and read/write acknowledgement flow
  mvp-plan.md  first-version product and architecture plan
  personal-production.md  one-person production setup and dogfood runbook
  progress.md  current milestone progress, evidence, and next work queue
```

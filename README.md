# HopIt

HopIt is an early-stage cloud-native code workspace. The core idea is that a codebase lives in the cloud, while each device gets a HopIt Workspace Root that exposes managed local folders and syncs edits back automatically.

The first product bet is simple: working on code should feel local, but live in the cloud. A developer should be able to open a HopIt codebase on any device, edit it with normal tools, and continue somewhere else without a clone to manage, stale checkout, push, pull, stash, or half-finished recovery flow.

Git compatibility still matters, but Git is not the primary day-to-day workspace model. Git should become an import/export and publish-history layer around cloud workspaces, active change sets, and accepted Main history.

HopIt does not use an ignore-file model for product sharing. Files under `.private/` are still snapshotted, synced, and versioned, but they are owner-visible only. Files outside `.private/` are eligible for collaboration, review, and merge according to the active change set's visibility settings and the codebase's permissions.

Temporary secret-safety exception: `.private/env/` stays local-only unless object storage and a local decrypt-capable key source are configured. Today that source can be either the legacy local-only `HOPIT_CLIENT_ENCRYPTION_KEY` or the new `hop keys init-device` keyring, which unwraps the user vault key locally and feeds the secret-sync bridge in memory. Env files routed there are usable on this device and can sync only as client-encrypted object blobs; raw secret bytes must never be uploaded to Convex, R2, B2, or another cloud provider.

The long-term privacy contract is broader than the current routed-secret bridge:
private repo files, owner-private files, secrets, Git internals, and public
published snapshots need separate encryption zones and separate sharing grants.
The implementation plan lives in [docs/privacy-encryption-plan.md](docs/privacy-encryption-plan.md).

The current setup source of truth is [docs/personal-production.md](docs/personal-production.md). That runbook records the active Vercel, D1, legacy Convex export, Cloudflare R2, LaunchAgent, local env, workspace, backup, and export locations without exposing secret values.

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
- Production storage based on Cloudflare D1 graph metadata, S3-compatible object blobs, content hashes, and per-file revision guards rather than whole-graph overwrites. Convex remains a disabled legacy fallback and export source, not the free-first production path.
- Scoped device/session auth separate from human product auth.
- Client-side encryption, device trust, and wrapped key grants so private repos,
  `.private/`, and secrets are decrypted only by intended users/devices.
- Git compatibility as an import/export and publish layer, not the source of continuity.
- Explicit `.private/` visibility: synced and versioned, but owner-visible only.

## Current State

HopIt has moved past a local-only spike. The current dogfood baseline is a deployed, production-shaped personal system:

- Vercel production dashboard at `https://hopit.dev` with `https://www.hopit.dev` and generated Vercel aliases attached to the same deployment.
- Vercel project `robertg761s-projects/hopit`, project id `prj_hO8U1QmyliQjGODz4R339UkgE86S`, org/team id `team_x1SyEPIryEghBSkkwoXSTIZ2`.
- Cloudflare D1 is now the free-first graph backend target. The codebase includes a D1 HTTP backend, schema at `cloudflare/d1/schema.sql`, D1 API proxy worker at `cloudflare/d1/api-worker.js`, and Convex-export migration script `npm run d1:migrate:convex-export`.
- Legacy Convex production graph at `https://sincere-jaguar-17.convex.cloud`; as of 2026-06-30 the deployment is disabled for Convex Free-plan limits. A snapshot backup is available for D1 migration.
- Cloudflare R2 bucket `hopit-blobs`, private/public access disabled, configured as the first S3-compatible object-blob provider.
- Porkbun domain `hopit.dev` points at Vercel, and Clerk production DNS for `clerk.hopit.dev`, `accounts.hopit.dev`, and mail/DKIM subdomains is verified.
- A seeded `hopit` codebase graph with 58 source files.
- A production-profile managed workspace at `/Users/robert/HopIt Workspaces/hopit`.
- An installed and running local LaunchAgent service, `com.hopit.agent.hopit`, for the packaged `hop-darwin-arm64` runtime from `/Users/robert/Library/Application Support/HopIt/Runtime`; it now reports D1-backed cloud status on `http://127.0.0.1:4785`.
- Hosted dashboard now uses Clerk product auth on `hopit.dev`; Google OAuth is enabled through the production Clerk instance and allowed for `robertgordon761@gmail.com` while the Google app remains in Testing mode. Owner sign-in and owner claim are verified, so Basic Auth fallback is no longer part of the production posture.
- Hosted status reads from D1 when `HOPIT_CLOUD_BACKEND=d1` is configured, with Convex as a legacy fallback. Hosted workspace commands are intentionally disabled.
- Local production-profile `hop` commands can import, attach, hydrate, sync, refresh, recover, review, merge, export, publish, and validate.
- `hop workspace` persists a root-level `workspaces.json` index with per-workspace hydration/cursor state, can discover account-visible D1 cloud codebases with local readiness when credentials allow it, falls back to the configured codebase under scoped device tokens, can attach a cloud codebase into the Workspace Root as metadata-only, list visible cloud files, hydrate one file, and dehydrate clean workspaces back to metadata-only state.
- `hop device` / `hop session` can report local device identity. Scoped session registration, listing, touch, and revocation now work against D1 as well as the legacy Convex fallback.
- `hop keys` can initialize a local per-codebase device keyring, report redacted key status, and export a passphrase-encrypted recovery file. The keyring stores device private keys locally and stores the user vault key only as a self-wrapped payload.
- The dashboard now includes provider sign-in routes, owner claim, member/invite management, first-run Workspace Root setup and attach for discovered cloud codebases, a read-only code browser, routeable codebase review/compare/history pages, first issue/discussion/release workflows, release assets, project-board movement, durable issue/discussion comments, snapshot-anchored inline review threads, review-linked follow-up comments, and a redacted key-grant status/rotation panel. Codebase listing, file reads/edits, status, account sync, hosted action jobs, member/invite routes, work-item collaboration routes, review-thread routes, and key-grant status now use the D1 backend selector, with scoped-token configured-codebase fallback and Convex retained as a legacy fallback.
- The literal mirror path supports binary files, symlinks, empty directories, `.git/`, root `.env.local` routing into `.private/env/repo-root/.env.local`, production-safe `import-git`, client-encrypted routed-secret sync, and dry-run object GC. The full repository still should not be treated as safely uploaded until the production-safe conversion flow has been run and verified.
- Client-side encryption currently covers routed secrets only. Device keyrings,
  user vault keys, recovery export, D1/legacy Convex device/wrapped-key APIs, and
  dashboard key-grant visibility and key-rotation state tracking now exist, but full private-repo encryption,
  repo/private/secret zone keys, invite-time key sharing, independent secret
  sharing, path encryption, and complete cryptographic revocation/rekey flows remain the next
  security milestone.
- The first privacy/encryption foundation is implemented: shared agent
  crypto/envelope helpers, derived file privacy zones, local device keyrings,
  encrypted recovery export, D1 and legacy Convex key-management tables and APIs, and
  validation that rejects plaintext secret-zone files.

The system is now usable as a one-person private dogfood environment, but it is not yet a full GitHub or Git replacement. The next major product phase is a solid v1 workspace: HopIt Workspace Root, managed-folder/lazy materialization, automatic remote update delivery, broader history/review reconstruction on top of object blobs, deeper client-side privacy/key grants, and GitHub-like collaboration surfaces. The owned-domain work is no longer blocked: `hopit.dev` is live, Clerk production auth is the primary hosted auth layer, production Google OAuth is configured for owner testing, and the owner identity is claimed in D1.

See [docs/github-lite-collaboration-plan.md](docs/github-lite-collaboration-plan.md) for the overall implementation plan, [docs/privacy-encryption-plan.md](docs/privacy-encryption-plan.md) for the end-to-end privacy/key-grant plan, plus [docs/auth-collaboration-plan.md](docs/auth-collaboration-plan.md), [docs/review-code-browser-plan.md](docs/review-code-browser-plan.md), and [docs/work-items-releases-plan.md](docs/work-items-releases-plan.md) for the detailed sub-plans.

## Solid V1 Direction

The v1 target is not a Git clone manager and not yet a true native filesystem provider. It is a production-shaped HopIt Workspace Root:

- A user chooses a local root such as `~/HopIt Workspaces`.
- Cloud codebases appear there as HopIt-managed project folders.
- Metadata can be visible before every file body is downloaded.
- Files are materialized safely when the workspace opens, when a tool needs them, or when remote updates arrive.
- Local edits are journaled before cloud acknowledgement and sync into the user's active change set.
- Other same-owner devices receive acknowledged changes automatically when the local journal is clean, or get a visible conflict/blocked state when it is not.
- Web surfaces show code, diffs, review state, history, issues, discussions, projects, releases, members, invitations, and permissions.

Today HopIt has the managed-folder spike, workspace-root command surface with a durable index, D1 account-visible codebase discovery when credentials allow it, scoped-token configured-codebase fallback, dashboard-driven first-run Workspace Root setup/metadata-only attach, hydration/cursor status, metadata-only/dehydrate and single-file hydrate primitives, service wrapper, a Cloudflare D1 graph backend, S3-compatible object-blob storage support, Clerk-protected hosted dashboard, routeable status-backed review/compare/history pages, first collaboration/project/comment/release-asset/key-grant surfaces, explicit refresh-based two-session continuity, D1-backed scoped session and trusted-device/key metadata, and opt-in activity-gated safe remote-pull plus one-shot remote-pull checks for personal dogfooding. Remote-pull uses a lightweight graph-head cursor before any full graph read and only runs in watch/service mode after local workspace activity, with a default five-minute cooldown. The current personal production D1 database is provisioned, schema-applied, seeded from the saved Convex export, and fronted by the `hopit-d1-api` Worker for Vercel. Remaining v1 work is automatic account bootstrap, richer hydrate onboarding, full lazy materialization policy, production-grade push/subscription remote-update delivery, true object-backed diff/history reconstruction, installer/tray setup, and broader cross-device verification.

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

HopIt now supports a Cloudflare D1-backed cloud graph for the free-first shared backend. The local JSON graph remains useful for offline development, and Convex remains a legacy fallback, but D1 is the intended no-budget production source of truth when these variables are configured:

```bash
HOPIT_CODEBASE_ID=hopit
HOPIT_CLOUD_BACKEND=d1
HOPIT_D1_ACCOUNT_ID=replace-with-cloudflare-account-id
HOPIT_D1_DATABASE_ID=replace-with-cloudflare-d1-database-id
HOPIT_D1_API_TOKEN=replace-with-cloudflare-d1-api-token-or-hopit-d1-proxy-token
HOPIT_D1_API_BASE_URL=https://hopit-d1-api.<account-subdomain>.workers.dev
HOPIT_AUTH_PROVIDER=clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_replace-with-your-clerk-publishable-key
CLERK_SECRET_KEY=sk_live_replace-with-your-clerk-secret-key
CLERK_JWT_ISSUER_DOMAIN=https://clerk.hopit.dev
HOPIT_OWNER_EMAIL=you@example.com
HOPIT_AGENT_STATE_ROOT="/Users/you/Library/Application Support/HopIt/Agent"
HOPIT_WORKSPACE_ROOT="/Users/you/HopIt Workspaces"
HOPIT_WORKSPACE_INDEX="/Users/you/Library/Application Support/HopIt/Agent/workspaces.json"
HOPIT_SESSION_ID=replace-with-this-device-session-id
HOPIT_DEVICE_NAME="Your Mac"
HOPIT_AGENT_SESSION_TOKEN=replace-after-hop-session-register
HOPIT_AGENT_SESSION_CAPABILITIES=read,write,sync,watch
HOPIT_REMOTE_PULL=1
HOPIT_REMOTE_PULL_COOLDOWN_MS=300000
HOPIT_BACKUP_ROOT=/Users/you/HopIt-Backups
HOPIT_EXPORT_ROOT=/Users/you/HopIt-Exports
HOPIT_BLOB_PROVIDER=r2
HOPIT_BLOB_PREFIX=production
HOPIT_BLOB_FREE_ONLY=1
HOPIT_BLOB_STORAGE_BUDGET_BYTES=8000000000
HOPIT_R2_ACCOUNT_ID=replace-with-cloudflare-account-id
HOPIT_R2_BUCKET=hopit-blobs
HOPIT_R2_ACCESS_KEY_ID=replace-with-r2-access-key-id
HOPIT_R2_SECRET_ACCESS_KEY=replace-with-r2-secret-access-key
# Prefer `hop keys init-device` for new devices. This legacy bridge remains for
# explicit local secret-key transfer while the full key-grant model comes online.
HOPIT_CLIENT_ENCRYPTION_KEY=base64:replace-with-32-random-bytes
HOPIT_CLIENT_ENCRYPTION_SCOPE=secrets
```

D1 is the graph, event, codebase, file-metadata, account-sync, and hosted-action queue backend. File bytes should use the object-blob layer for real production. `HOPIT_BLOB_PROVIDER=r2` targets Cloudflare R2 through HopIt's S3-compatible adapter. For current personal use, keep `HOPIT_BLOB_FREE_ONLY=1` and the 8 GB storage budget so HopIt stops before crossing Cloudflare R2's free storage tier. The same adapter can migrate to Backblaze B2 later by switching to `HOPIT_BLOB_PROVIDER=b2` plus the B2 S3 endpoint/key variables.

`HOPIT_CLIENT_ENCRYPTION_KEY` is local-only; it must not be configured in Vercel, D1, Convex, R2, docs, commits, or chat. It lets routed `.private/env/` secrets sync as encrypted object blobs that only trusted devices with the key can hydrate. For new devices, prefer `hop keys init-device`: it stores device private keys locally, keeps the user vault key self-wrapped, and exposes the vault key to the current secret-sync bridge only in memory. The remaining encryption model still needs repo/zone keys, file data-encryption keys, invite-time wrapped grants, and rotation/revocation flows. That work is planned in [docs/privacy-encryption-plan.md](docs/privacy-encryption-plan.md).

Important local config locations for the current setup:

- `.env.local`: repo-local development and dashboard config. It is not committed.
- `/Users/robert/.config/hopit/production.env`: LaunchAgent/packaged-agent config. It is not committed.
- `.vercel/project.json`: Vercel project binding. It contains project/org ids but no runtime secrets.
- `/Users/robert/Library/Application Support/HopIt/Agent`: local agent state and workspace index.
- `/Users/robert/HopIt Workspaces`: managed workspace root.
- `/Users/robert/HopIt-Backups` and `/Users/robert/HopIt-Exports`: operational recovery and Git escape hatches.

Create/apply the D1 schema from `cloudflare/d1/schema.sql`, then migrate the saved Convex export:

```bash
npm run d1:migrate:convex-export -- \
  --export /Users/robert/HopIt-Backups/convex/hopit-convex-prod-2026-06-30-disabled-snapshot.zip \
  --codebase-id hopit \
  --dry-run
```

Remove `--dry-run` only after `HOPIT_D1_ACCOUNT_ID`, `HOPIT_D1_DATABASE_ID`, and `HOPIT_D1_API_TOKEN` are configured. When using Vercel, set `HOPIT_D1_API_BASE_URL` to the deployed `hopit-d1-api` Worker so production does not need a broad Cloudflare account API token. The migration imports the graph and latest 500 events by default; pass `--all-events` only if the D1 daily write budget can absorb the full history.

Legacy Convex development is still available with:

```bash
npm run convex:dev
```

That command prompts for Convex login/project setup, pushes the `convex/` backend functions, and writes the real development deployment URL. Production updates should use the explicit production deployment script so `.env.local` does not accidentally aim at the dev deployment:

```bash
npm run convex:deploy:prod
```

For the legacy Convex fallback, set the same `HOPIT_AGENT_TOKEN` in Convex with:

```bash
npx convex env set HOPIT_AGENT_TOKEN replace-with-a-long-random-secret
```

Import a real local project into the active cloud backend with:

```bash
npm run hop -- import --source /path/to/project --codebase-id hopit --profile production --force
```

Register a scoped device session against the active D1 backend with:

```bash
npm run hop -- session register --profile production --codebase-id "$HOPIT_CODEBASE_ID" --device-name "$HOPIT_DEVICE_NAME"
```

Store the returned `sessionToken` as `HOPIT_AGENT_SESSION_TOKEN` on that device. When the device talks to the `hopit-d1-api` Worker, that scoped token can replace `HOPIT_D1_API_TOKEN` for codebase-scoped graph reads/writes. The deployment-wide `HOPIT_AGENT_TOKEN` remains only the legacy Convex bootstrap/admin secret.

For current personal production hosting, deploy the Next.js app to Vercel and set `HOPIT_CODEBASE_ID`, `HOPIT_CLOUD_BACKEND=d1`, `HOPIT_D1_ACCOUNT_ID`, `HOPIT_D1_DATABASE_ID`, `HOPIT_D1_API_TOKEN`, `HOPIT_D1_API_BASE_URL`, `HOPIT_AUTH_PROVIDER=clerk`, Clerk live-key variables, and the object-storage variables beginning with `HOPIT_BLOB_`/`HOPIT_R2_` as environment variables. The hosted dashboard reads from D1 through `/api/agent/status`; local workspace commands still run through the local HopIt agent on your machine and are refused on Vercel. Local dashboard server routes merge `~/.config/hopit/production.env` under the Next.js process env, and command routes use `--profile production` when installed-agent paths are configured, so D1 credentials and Workspace Root paths stay aligned even when `.env.local` is stale. Installed devices should use scoped session tokens for normal D1 proxy access after registration. Google OAuth provider credentials live in Clerk/Google Cloud, not in Vercel env or repo files. Keep `HOPIT_ALLOW_BASIC_AUTH_FALLBACK` unset in production unless you are deliberately using the emergency fallback path.

Validate production configuration with:

```bash
set -a; source "$HOME/.config/hopit/production.env"; set +a
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
launchctl kickstart -k "gui/$(id -u)/com.hopit.agent.hopit"
curl http://127.0.0.1:4785/status
npm run hop -- session revoke --profile production --session-id old-session-id
```

Observe the local agent before trusting a handoff:

```bash
launchctl print "gui/$(id -u)/com.hopit.agent.hopit"
npm run hop -- status --profile production --codebase-id "$HOPIT_CODEBASE_ID"
curl http://127.0.0.1:4785/status
curl http://127.0.0.1:4785/events
```

For the installed macOS LaunchAgent, trust `launchctl print` plus the loopback
`/status` endpoint. `hop service status` is for the pid-file-managed
`service start` debug path and may not report the direct launchd-owned
`service run` process as running until that integration is tightened.

For the full one-person production setup, see [docs/personal-production.md](docs/personal-production.md).

Import a real local project into HopIt's managed workspace state with:

```bash
npm run hop -- import --source /path/to/project --force
```

The import command scans text files from the source folder, skips generated folders and sensitive files such as `.git`, `.hopit-agent`, `.next`, `node_modules`, build outputs, and `.env*`, writes `.hopit-agent/cloud.json`, and hydrates `.hopit-agent/workspaces/hopit-core`.

For a literal local mirror into the managed workspace, use the `mirror` command instead of `import`. The mirror path includes binary files, symlinks, empty directories, generated folders, and `.git/`, routes root `.env.local` into `.private/env/repo-root/.env.local`, compares source/destination manifests, and skips cloud sync when the storage budget or encrypted-secret prerequisites say the upload is not safe. For Git checkout conversion, use `hop import-git --source /path/to/repo --production-safe`; it requires `.git/`, uses the literal mirror path, keeps `.git/` owner-private, and only syncs routed secrets when the local client encryption key is present. To import directly from a remote Git URL, use `hop import-git-url --url https://github.com/org/repo.git`; it clones into a temporary checkout first, then runs the same production-safe Git import path.

Object storage maintenance is available through `hop storage status` and dry-run-by-default `hop storage gc`; pass `--execute` only when the orphaned object plan is correct.

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
  privacy-encryption-plan.md  private repo encryption, key grants, secret sharing, and recovery plan
  review-code-browser-plan.md  code browsing, diffs, reviews, comments, and history plan
  work-items-releases-plan.md  issues, projects, discussions, and releases plan
  mvp-plan.md  first-version product and architecture plan
  personal-production.md  one-person production setup and dogfood runbook
  progress.md  current milestone progress, evidence, and next work queue
```

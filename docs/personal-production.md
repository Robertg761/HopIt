# Personal Production Runbook

This runbook is the first real-use path for one-person HopIt dogfooding. It keeps the local JSON graph as a development fallback, and now treats Cloudflare D1 as the canonical cloud graph target. The retired hosted graph export remains available for migration/recovery history only. Vercel hosts the protected dashboard. Hosted workspace commands are disabled; collaboration/member/work-item/session/key APIs now route through the D1 backend selector. Basic Auth is not part of normal production access and should stay unset unless deliberately re-enabled for emergency recovery.

Last updated: 2026-07-10

## Current Deployment

- Canonical production dashboard: `https://hopit.dev`
- Secondary production dashboard alias: `https://www.hopit.dev`
- Current Vercel deployment URL: inspect `https://hopit.dev` with `vercel inspect https://hopit.dev`; generated deployment aliases change on every production deploy.
- Existing generated Vercel aliases, including `https://hopit-ten.vercel.app`, remain attached to the current deployment.
- Vercel project: `robertg761s-projects/hopit`
- Vercel project id: `prj_hO8U1QmyliQjGODz4R339UkgE86S`
- Vercel org/team id: `team_x1SyEPIryEghBSkkwoXSTIZ2`
- Registrar/DNS provider: Porkbun account owning `hopit.dev`
- Product auth provider: Clerk production instance provisioned through the Vercel Marketplace integration `hopit-auth`
- Clerk production domain: `hopit.dev`
- Clerk frontend API: `https://clerk.hopit.dev`
- Clerk account portal: `https://accounts.hopit.dev`
- Clerk DNS status: verified
- Clerk SSL status: issued
- Google OAuth provider: enabled in Clerk production through Google Cloud project `hopit-auth-prod-rg`
- Google Auth Platform status: Testing, with `robertgordon761@gmail.com` added as the current test user
- Cloud graph target: Cloudflare D1, schema at `cloudflare/d1/schema.sql`
- Historical graph export: `/Users/robert/HopIt-Backups/convex/hopit-convex-prod-2026-06-30-disabled-snapshot.zip`
- Cloudflare R2 bucket: `hopit-blobs`
- Cloudflare R2 public access: disabled
- Seeded codebase id: `hopit`
- Production workspace: `/Users/robert/HopIt Workspaces/hopit`
- Local LaunchAgent label: `com.hopit.agent.hopit` (running with D1-backed cloud status and push enabled; the long-standing push skip was diagnosed as a stale content manifest and healed on 2026-07-10, so the workspace is scan-clean at revision 4436 with a live push-applied proof still pending)
- LaunchAgent plist: `/Users/robert/Library/LaunchAgents/com.hopit.agent.hopit.plist`
- Packaged runtime: `/Users/robert/Library/Application Support/HopIt/Runtime/hop-darwin-arm64`
- Agent state root: `/Users/robert/Library/Application Support/HopIt/Agent`
- Agent logs: `/Users/robert/Library/Logs/HopIt/agent.out.log` and `/Users/robert/Library/Logs/HopIt/agent.err.log`

## Accounts And Setup Sources

These are the accounts and source-of-truth locations for the current personal production setup. Do not copy secret values into documentation, issues, commits, or chat. Document variable names and paths only.

| Area | Current account/service | Source of truth | Why it exists |
| --- | --- | --- | --- |
| Domain and DNS | Porkbun domain `hopit.dev` | Porkbun dashboard/API DNS records | Owns the production hostname and routes app plus Clerk subdomains without using temporary generated URLs as the canonical address. |
| Hosted dashboard | Vercel project `robertg761s-projects/hopit` | `.vercel/project.json`, Vercel project env, Vercel dashboard | Hosts the private Next.js dashboard on a production-shaped deployment at `hopit.dev`. |
| Product auth | Clerk production instance through Vercel Marketplace app `hopit-auth` | Clerk dashboard, Vercel Marketplace integration, Vercel env | Provides real account sign-in for hosted HopIt. Owner sign-in and D1 owner claim are verified. |
| Google OAuth | Google Cloud project `HopIt` / `hopit-auth-prod-rg` under `robertgordon761@gmail.com` | Google Cloud Console Auth Platform, Clerk social connection settings, macOS Keychain credential entries | Enables Sign in with Google for the production Clerk instance without putting OAuth secrets in Vercel, docs, or repo files. |
| Cloud graph | Cloudflare D1 | Cloudflare dashboard/API, `cloudflare/d1/schema.sql`, `cloudflare/d1/api-worker.js`, `HOPIT_D1_*` | Stores graph metadata, file metadata, account sync, action jobs, events, members, invitations, first work-item/release records, scoped sessions, and trusted-device/key metadata on a free-first backend. |
| Historical graph export | Saved export ZIP | `/Users/robert/HopIt-Backups/convex/` | Retained as migration/recovery history; the retired backend implementation was removed by WS1 in `docs/remediation-plan-2026-07.md`. |
| Object blobs | Cloudflare R2 bucket `hopit-blobs` | Cloudflare dashboard, `HOPIT_R2_*`, `HOPIT_BLOB_*` | Stores file bytes through an S3-compatible adapter so D1 is not used for large repository content. |
| Local agent service | macOS LaunchAgent `com.hopit.agent.hopit` | `/Users/robert/Library/LaunchAgents/com.hopit.agent.hopit.plist` | Keeps the production-profile watcher/status service running outside the source checkout. It is running against D1 with push enabled and periodic graph-head reconciliation at the configured refresh cadence. |
| Local runtime | Standalone `hop-darwin-arm64` package | `/Users/robert/Library/Application Support/HopIt/Runtime/hop-darwin-arm64` | Runs the same packaged agent shape another device would install, instead of depending on this repo's `node_modules`. |
| Local agent config | Production env file | `/Users/robert/.config/hopit/production.env` | Provides the LaunchAgent with cloud backend, R2, workspace, session, backup, and auth settings. |
| Local device keyring | HopIt production keyring for `hopit` | `/Users/robert/Library/Application Support/HopIt/Agent/keys/hopit.device.json` | Stores this Mac's device private keys locally and keeps user vault key `uvk_99d350e5-2b2e-453a-b7a4-739cdb8893a7` self-wrapped. Trusted-device cloud registration works on D1. |
| Repo-local dev config | `.env.local` | `/Users/robert/Documents/Projects/HopIt/.env.local` | Lets this checkout run Next.js and local commands against the same personal production resources. |
| Workspace data | Managed workspace | `/Users/robert/HopIt Workspaces/hopit` | The dogfood workspace HopIt watches and syncs. |
| Backups and exports | Local operational folders | `/Users/robert/HopIt-Backups`, `/Users/robert/HopIt-Exports` | Keeps private recovery and Git escape hatches outside the managed workspace and source checkout. |

The current LaunchAgent command loads `/Users/robert/.config/hopit/production.env`, then runs:

```bash
/Users/robert/Library/Application\ Support/HopIt/Runtime/hop-darwin-arm64/bin/hop service run --profile production
```

This is intentionally close to the future installed-device model: packaged binary, local env outside the repo, loopback-only status endpoints, scoped device/session token support, and workspace/state roots outside the source checkout.

## What Is Temporary

- Clerk is now the primary hosted auth provider on `hopit.dev`.
- Basic Auth fallback is not the long-term product auth model and is no longer needed after owner sign-in and D1 owner claim were verified. Keep `HOPIT_ALLOW_BASIC_AUTH_FALLBACK` unset in production unless deliberately re-enabled for emergency recovery.
- Clerk production auth is configured for `hopit.dev` with live Vercel env vars, a verified Clerk frontend API DNS target, a verified account portal DNS target, issued SSL certificates, production Google OAuth, owner sign-in, and D1 owner claim.
- Google Auth Platform remains in Testing mode for personal dogfooding. Before public release, add public privacy policy and terms pages for `hopit.dev`, publish/verify the Google OAuth app, and re-check the OAuth consent screen branding/scopes.
- Cloudflare R2 is the first object-storage provider because it has a useful free tier and an S3-compatible API. Personal use keeps `HOPIT_BLOB_FREE_ONLY=1`, an 8 GB app budget, and public access disabled. The former `free-only-auto-delete` 1-day object-expiry lifecycle rule was removed on 2026-07-08 because it silently deleted blob bodies that graph metadata still referenced, breaking cross-device hydration and future object-backed history; durable blob retention now relies on `hop storage gc` plus the free-only budget. A public release should still move to a production storage posture before storing real customer data long term.
- The repo has D1 graph/status/file/codebase/account/action-job/member/invite/work-item/session/key backend support and a historical-export migration script. The live D1 database is created, schema-applied, seeded from the historical export, reachable through the `hopit-d1-api` Worker, deployed through Vercel, and used by the restarted local LaunchAgent for cloud status. Scoped session SQL now passes a conservative statement-shape and exact-codebase policy, and multi-statement D1 mutations use the binding's atomic batch API when available. Raw scoped SQL remains transitional; typed Worker operations are still the durable target.
- A production snapshot export from the retired hosted graph is saved at `/Users/robert/HopIt-Backups/convex/hopit-convex-prod-2026-06-30-disabled-snapshot.zip` with SHA-256 `0e83df9ab7e80a81a9a3b06e1cd3399ff5b532fa968bded3c14334640b4c9f3d`.
- Backblaze B2 remains the planned compatible object-storage migration path, but it is not active in the current personal setup.
- `.private/env/` is local-only unless the local client encryption key is configured. Secrets routed there are usable on this Mac and can sync as client-encrypted object blobs with the current key; without that key, production-safe import/mirror skips cloud sync.
- The current local workspace is a managed folder, not a native filesystem provider. Native mount/FUSE/RAM-only experiments remain later research.
- The standalone package is unsigned and not notarized. Public release publication fails closed; there is no unsigned upload escape hatch. Use `npm run package:hop` for local/private dogfood artifacts. The LaunchAgent setup is good enough for private dogfooding, not public installer distribution.
- Full literal mirror upload of this repository to cloud storage has not been performed. The local mirror workflow supports binary files, symlinks, empty directories, `.git/`, and secret routing, but cloud upload should wait until the safety, budget, and secret-encryption requirements are satisfied for the intended data.

## Long-Term Goals

- Replace Basic Auth with real account sign-in, durable HopIt users, memberships, invitations, and complete server-side permission checks.
- Make the HopIt Workspace Root the normal device experience: install HopIt, choose a root, see cloud codebases, materialize files safely on demand, and hand off between devices automatically.
- Store file bytes in scalable object storage with hash verification, deduplication where practical, production retention, garbage collection, and a clean migration path across R2, B2, or another S3-compatible provider.
- Evolve client-side encrypted secret sync from the current routed-secret bridge into full repo/zone encryption with wrapped keys, rotation, revocation, recovery import, and dashboard-guided trusted-device onboarding.
- Build the GitHub-like product layer around HopIt's own model: code browsing, diffs, review comments, history, issues, projects, discussions, releases, permissions, and invitations.
- Keep Git as import/export/publish interoperability rather than the everyday continuity mechanism.
- Ship signed/notarized installers, tray/menu UX, dashboard-guided device recovery, and fully proven multi-device push/subscription handoff.

## Required Configuration

Use long random secrets. Do not commit `.env.local`.
Routed env files under `.private/env/` remain local-only unless object storage
and a local decrypt-capable key source are configured. Today that source can be
the legacy `HOPIT_CLIENT_ENCRYPTION_KEY` or a `hop keys init-device` keyring
that unwraps the user vault key locally. Secret values are encrypted on-device
before upload and remain unreadable to D1, R2/B2/S3, and HopIt cloud
operators. Do not store raw encryption keys in Vercel, D1, R2, committed
files, docs, issues, or chat.

```bash
HOPIT_CODEBASE_ID=hopit
HOPIT_CLOUD_BACKEND=d1
HOPIT_D1_ACCOUNT_ID=<cloudflare-account-id>
HOPIT_D1_DATABASE_ID=<d1-database-id>
HOPIT_D1_API_TOKEN=<cloudflare-api-token-or-hopit-d1-proxy-token>
HOPIT_D1_API_BASE_URL=https://hopit-d1-api.<account-subdomain>.workers.dev
HOPIT_D1_ASSUME_SCHEMA=1
HOPIT_AUTH_PROVIDER=clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_<redacted>
CLERK_SECRET_KEY=sk_live_<redacted>
CLERK_JWT_ISSUER_DOMAIN=https://clerk.hopit.dev
HOPIT_OWNER_EMAIL=<owner-email-for-first-account-claim>
HOPIT_AGENT_STATE_ROOT="$HOME/Library/Application Support/HopIt/Agent"
HOPIT_WORKSPACE_ROOT="$HOME/HopIt Workspaces"
HOPIT_WORKSPACE_INDEX="$HOME/Library/Application Support/HopIt/Agent/workspaces.json"
HOPIT_SESSION_ID=<this-device-session-id-after-register>
# Required alongside HOPIT_SESSION_ID: a bare session id is treated as an
# unauthenticated guest by visibility-filtered reads (zero visible files).
# Without it, hop refresh fails closed via the mass-delete guard and hop
# doctor reports a requester-identity failure. Set to the codebase owner id.
HOPIT_REQUESTER_ID=<codebase-owner-user-id>
HOPIT_DEVICE_NAME="<your-device-name>"
HOPIT_AGENT_SESSION_TOKEN=<scoped-session-token-after-register>
HOPIT_AGENT_SESSION_CAPABILITIES=read,write,sync,watch
HOPIT_REMOTE_PULL=1
HOPIT_REMOTE_PULL_COOLDOWN_MS=300000
HOPIT_REMOTE_PUSH=1
HOPIT_REMOTE_PUSH_URL=wss://hopit-d1-api.<account-subdomain>.workers.dev/events
# Optional conservative cache maintenance. Leave disabled until deliberately enabled.
# HOPIT_AUTO_PRUNE=1
# HOPIT_AUTO_PRUNE_INTERVAL_MS=21600000
# HOPIT_AUTO_PRUNE_INACTIVE_MS=604800000
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

## D1 Backend

Create a Cloudflare D1 database, apply `cloudflare/d1/schema.sql`, deploy the D1 API proxy worker from `cloudflare/d1/wrangler.proxy.jsonc`, then configure these variables in Vercel and local production env:

```bash
HOPIT_CLOUD_BACKEND=d1
HOPIT_D1_ACCOUNT_ID=<cloudflare-account-id>
HOPIT_D1_DATABASE_ID=<d1-database-id>
HOPIT_D1_API_TOKEN=<cloudflare-api-token-or-hopit-d1-proxy-token>
HOPIT_D1_API_BASE_URL=https://hopit-d1-api.<account-subdomain>.workers.dev
HOPIT_D1_ASSUME_SCHEMA=1
```

Validate the saved historical snapshot before importing:

```bash
npm run d1:migrate:convex-export -- \
  --export /Users/robert/HopIt-Backups/convex/hopit-convex-prod-2026-06-30-disabled-snapshot.zip \
  --codebase-id hopit \
  --dry-run
```

The production import on 2026-06-30 wrote `58` files and the latest `500` events from `11,638` exported events into D1. Use `--dry-run` for future rehearsals. Use `--all-events` only if the daily D1 write budget can absorb the full event history.

The D1 path currently covers agent graph reads/writes, graph-head status polling, hosted dashboard status, codebase list/create/update/delete, text file read/edit, account sync, automatic verified-owner bootstrap for migrated `local-owner` codebases, hosted action jobs, member/invite routes, issue/discussion/release/comment/project collaboration tables, project-board UI operations, scoped D1 proxy session auth, scoped device sessions, trusted-device/key metadata, redacted key-grant status, per-file version rows, per-file and chunked-bulk D1 agent journal commits, and object-backed revision compare. Active-change-set reads now enforce the effective private/team/review visibility matrix for owner, member, viewer, and guest, including consistent visible/hidden head counts. Browser text edits use the guarded journal mutation boundary, require a writable active change set, preserve Main until merge, and reject stale or object-backed edits with explicit conflicts. Mirror-backlog and first-run import syncs are viable because small journal commits no longer save the whole graph and large drains use guarded 40-entry chunks. Scoped session SQL now accepts only conservative, codebase-equality statement shapes; this is a transition control, not the final API design. Bootstrap/import/admin full-graph saves remain available for their narrow use cases. Typed Worker operations, production retention policy, web compare UI wiring, full private-repo key-grant approval/rotation flows, richer release assets, and complete product write-path coverage still need work.

### D1 Proxy Token Rotation

The `hopit-d1-api` Worker accepts `HOPIT_D1_PROXY_TOKEN` for trusted server-side calls and scoped `hst_` agent session tokens for device calls. Rotate the proxy token without exposing the value in logs, docs, issues, commits, or chat:

1. Mint a new long random secret locally and store it only in the password manager or provider env UI.
2. Update the Worker secret `HOPIT_D1_PROXY_TOKEN` in Cloudflare and deploy/reload the Worker.
3. Update Vercel `HOPIT_D1_API_TOKEN` for Production, Preview, and Development if those environments call the Worker with the proxy token.
4. Update `.env.local` and `/Users/robert/.config/hopit/production.env` only if this Mac still needs proxy-token access; prefer `HOPIT_AGENT_SESSION_TOKEN` for installed-device paths.
5. Verify the dashboard and local agent can read D1 status, then remove the old token from every provider/local secret store where it was present.
6. Run `npm run check:production-config` from a shell with the intended env loaded and confirm it does not print secret values.

### File Versions Migration

WS7c adds per-file version rows for object-backed history reconstruction. Do not run this from Codex; the owner applies it to the existing production D1 database when ready.

```sql
create table if not exists file_versions (
  version_id integer primary key autoincrement,
  codebase_id text not null,
  selected_state_type text,
  selected_state_id text,
  main_state_id text,
  graph_revision integer not null,
  path text not null,
  operation text not null,
  kind text not null default 'file',
  old_revision integer,
  new_revision integer,
  old_file_json text,
  new_file_json text,
  scope text not null,
  privacy_zone text,
  zone_id text,
  content_storage text not null default 'inline',
  blob_provider text,
  blob_key text,
  blob_hash text,
  encoding text not null default 'utf8',
  target text,
  size integer,
  actor_user_id text,
  session_id text,
  device_name text,
  created_at text not null,
  foreign key (codebase_id) references codebases(codebase_id) on delete cascade
);

create index if not exists idx_file_versions_codebase_revision_path on file_versions(codebase_id, graph_revision, path);
create index if not exists idx_file_versions_codebase_path_revision on file_versions(codebase_id, path, graph_revision);
create index if not exists idx_file_versions_codebase_blob_key on file_versions(codebase_id, blob_key);
```

Cloudflare dashboard rate-limit rule to configure alongside the in-worker failed-auth throttle:

- Name: `hopit-d1-api-failed-auth`
- Scope/filter: requests where `http.host` equals the D1 Worker hostname and `http.request.uri.path` ends with `/query`
- Counting expression: same as the scope/filter, grouped by source IP
- Mitigation: block or managed challenge after `20` requests per `5 minutes`
- Response code: `429` when using a block action
- Notes: keep Worker logs enabled for `hopit.d1.proxy.request`; never log bearer tokens, SQL text, or SQL params.

### Push Hub Deployment And Reconciliation

WS7a Stage 2 adds the D1 API Worker's `HOPIT_PUSH_HUB` Durable Object binding
and the SQLite-backed `CodebasePushHub` migration in
`cloudflare/d1/wrangler.proxy.jsonc`. That push path is deployed and enabled on
the current personal-production agent.

The "workspace drift" that skipped every push apply through 2026-07-10 was
diagnosed as a stale content manifest, not real drift: a manual `hop sync`
committed 24 files to D1 (revision 4436, all acknowledged), but the manifest is
only rebuilt on materialize/refresh/hydrate, and the scan that gates refresh
compares disk against the manifest — so the stale manifest blocked the one
operation that would rebuild it. Refresh and the remote-push decision now
exonerate scan findings that already match the cloud graph byte-for-byte and
self-heal the manifest (`manifestSelfHealed` in `refresh.complete`); genuine
drift still fails closed. The live manifest was healed on 2026-07-10 with a
repo-checkout `hop refresh --profile production` (0 written, 0 deleted, 24
exonerated) and the LaunchAgent was restarted with a clean scan at revision
4436. The live push-applied proof landed on 2026-07-11: a second isolated
device synced revision 4436 → 4437 and the production service applied it over
the hub (trigger `remote-push`, ~8s later) — see "Verified 2026-07-11" below.

Two related hardenings from the same investigation:

- A device env with `HOPIT_SESSION_ID` but no `HOPIT_REQUESTER_ID` reads the
  graph as a guest with zero visible files; a refresh would then have deleted
  the whole workspace. `materializeCloudToWorkspace` now fails closed before
  deleting when the visible graph is empty while disk files exist, or when a
  refresh would delete more than 100 files and half the workspace
  (`--allow-mass-delete` overrides), and `hop doctor` flags the missing
  requester identity. This Mac's `production.env` gained `HOPIT_REQUESTER_ID`
  on 2026-07-10 (previous file kept as `production.env.bak-2026-07-10`).
- Journal commit paths stamped `files`/`file_versions.zone_id` with a
  hardcoded `unknown` codebase id. The normalizer now threads the real id, and
  the 8,865 affected live rows were rewritten with the one-time
  `scripts/repair-zone-ids.sql`.

Use this command for a future Worker update:

```bash
npx wrangler deploy --config cloudflare/d1/wrangler.proxy.jsonc
```

Expected Cloudflare bindings and secrets:

- D1 binding `HOPIT_D1_DB` points at the `hopit` database.
- Durable Object binding `HOPIT_PUSH_HUB` points at class `CodebasePushHub`.
- Migration tag `v1` includes `new_sqlite_classes = ["CodebasePushHub"]`.
- Secret `HOPIT_D1_PROXY_TOKEN` remains configured for trusted proxy-token calls.
- Scoped `hst_` agent sessions continue to work through the same auth layer.

Agent opt-in example after deployment:

```bash
HOPIT_REMOTE_PUSH=1
HOPIT_REMOTE_PUSH_URL=wss://hopit-d1-api.<account-subdomain>.workers.dev/events
```

For Node's standard WebSocket transport, Bearer headers are not assumed. Use a
scoped `HOPIT_AGENT_SESSION_TOKEN` in the agent env; the agent will attach it as
an auth query param for `ws://`/`wss://` push connections and redact it from
event-log hub URLs. Keep proxy tokens out of checked-in URLs and prefer scoped
session tokens for device installs.

Verification for the current deployment or after a future update:

```bash
curl http://127.0.0.1:4785/status
curl http://127.0.0.1:4785/events
npm run hop -- status --profile production --codebase-id "$HOPIT_CODEBASE_ID"
```

Healthy push state should show `remotePush.state` moving through
`push-connected`, `push-applied`, `push-skipped`, or
`push-fallback-polling`. If a pushed event is missed, reconnect fallback and a
periodic graph-head check at `HOPIT_REMOTE_PULL_COOLDOWN_MS` still catch up
through the same safe-refresh decision path; reconciliation no longer waits for
another local edit.

#### Verified 2026-07-11 (both prior manual items closed)

The two items left pending as of 2026-07-10 were both verified live on
2026-07-11 after a runtime repackage and reinstall. The installed runtime at
`~/Library/Application Support/HopIt/Runtime/hop-darwin-arm64` now includes
commits `0492579`, `2955f8e`, `6a1f7a7`, and `c916def`; the pre-reinstall
binary was backed up alongside as
`hop-darwin-arm64.pre-guards-20260710233509.bak`.

1. Live `push-applied` proof (the last open item for cross-device handoff) is
   proven. A second isolated device workspace (same packaged binary; separate
   state root, workspace root, `HOPIT_SESSION_ID=session_robert_proof_device2`)
   hydrated codebase `hopit` at revision 4436, scanned clean, then appended one
   line to `docs/progress.md`; `hop sync` journaled exactly 1 write and the
   cloud acknowledged revision 4437. The production service, push-connected to
   `wss://hopit-d1-api.hopit-robert.workers.dev/events`, received hub event
   `evt_hopit_4437_913f1166-a104-49b8-8bf9-16607751d1b3` and emitted
   `remote-push.applied` (trigger `remote-push`, revision 4436 → 4437) at
   `2026-07-11T02:41:38Z`, ~8 seconds after the second device's sync.
   `remotePush.lastApplied` is now non-null, `lastAppliedRevision` is 4437, and
   the edited line materialized in
   `/Users/robert/HopIt Workspaces/hopit/docs/progress.md`. The proof used a
   genuinely new hub event, not the old `evt_hopit_1759` event (which was never
   retried, as designed).
2. Post-reinstall checks pass:
   - `hop service status --profile production` with launchd owning the process
     reports `running: true` with `source: "health-probe"` (pid null).
   - `hop doctor --profile production` passes all checks (cloud, workspace,
     hydration, journal, remote-cursor, requester-identity, service). Negative
     test confirmed: unsetting `HOPIT_REQUESTER_ID` flips the
     `requester-identity` check to a failure warning that visibility-filtered
     reads would run as guest and see zero files.
   - Optional guard spot-check on a scratch profile (a refresh whose visible
     graph is empty while disk files exist must block with
     `visible_graph_empty_local_files_present`) remains optional and is already
     covered by tests.

Use Cloudflare Worker logs
as the connection-count source: each active agent should produce an
authenticated `hopit.d1.proxy.request` entry for `/events` on connect or
reconnect. Normal D1 writes should not produce
`hopit.d1.proxy.push_notify_failed`.

Rollback: redeploy the previous Worker version from Cloudflare's deployment
history or from the previous git revision of `cloudflare/d1/api-worker.js` and
`cloudflare/d1/wrangler.proxy.jsonc`. Agents fall back to periodic graph-head
reconciliation and safe refresh when the push socket disconnects; disabling
`HOPIT_REMOTE_PUSH` on the local service returns the device to polling-only
handoff.

## Historical Graph Export

The retired hosted graph export remains at `/Users/robert/HopIt-Backups/convex/` for migration/recovery reference. The backend implementation was removed by WS1 in [HopIt Remediation Plan July 2026](remediation-plan-2026-07.md); inspect git history if that code is ever needed again.

## Object Blob Storage

HopIt uses D1 for graph metadata/events and R2 for file bytes. The first object provider is Cloudflare R2 through HopIt's S3-compatible adapter:

```bash
HOPIT_BLOB_PROVIDER=r2
HOPIT_BLOB_PREFIX=production
HOPIT_BLOB_FREE_ONLY=1
HOPIT_BLOB_STORAGE_BUDGET_BYTES=8000000000
HOPIT_R2_ACCOUNT_ID=<cloudflare-account-id>
HOPIT_R2_BUCKET=hopit-blobs
HOPIT_R2_ACCESS_KEY_ID=<r2-access-key-id>
HOPIT_R2_SECRET_ACCESS_KEY=<r2-secret-access-key>
HOPIT_CLIENT_ENCRYPTION_KEY=<local-only-32-byte-key>
HOPIT_CLIENT_ENCRYPTION_SCOPE=secrets
# Optional override. Default: $HOPIT_AGENT_STATE_ROOT/keys/hopit.device.json
# HOPIT_DEVICE_KEYS_PATH=/Users/robert/.config/hopit/keys/hopit.device.json
```

The agent uploads file bytes to R2 before committing graph metadata. D1 stores `contentStorage=object-blob`, provider, object key, plaintext hash/size, object hash/size, and optional client-encryption metadata; hydrate, refresh, export, and recovery download the object, verify the object hash, decrypt locally when required, then verify the plaintext SHA-256 before writing it locally. For personal use, keep `HOPIT_BLOB_FREE_ONLY=1` and the default 8 GB budget so HopIt stops before crossing Cloudflare R2's free storage tier. To migrate to Backblaze B2 later, keep the same graph contract and switch the provider variables to `HOPIT_BLOB_PROVIDER=b2`, `HOPIT_B2_BUCKET`, `HOPIT_B2_ENDPOINT`, `HOPIT_B2_REGION`, `HOPIT_B2_KEY_ID`, and `HOPIT_B2_APPLICATION_KEY`.

`HOPIT_CLIENT_ENCRYPTION_KEY` is local-only. It belongs in `.env.local` and `/Users/robert/.config/hopit/production.env`, not Vercel, D1, R2, docs, commits, or chat. The current key is configured on this Mac with `HOPIT_CLIENT_ENCRYPTION_SCOPE=secrets`, which means routed secret files under `.private/env/` can sync as encrypted object blobs while normal source files keep their usual storage path. `hop keys init-device` is the forward path for new devices: it now writes `/Users/robert/Library/Application Support/HopIt/Agent/keys/hopit.device.json`, stores device private keys locally, and stores the user vault key only as a self-wrapped payload. A second trusted device will need either the legacy local key or an approved/recovered keyring before it can hydrate encrypted secret files.

Current no-charge R2 posture:

- Bucket: `hopit-blobs`
- Default storage class: Standard
- Public `r2.dev` access: disabled
- HopIt-managed stored objects: `0` under the configured `production/codebases/hopit/blobs/sha256/` prefix as verified by `hop storage status`
- HopIt-managed stored bytes: `0 B` under the configured HopIt prefix
- Lifecycle: only the default rule aborting incomplete multipart uploads after 7 days. The former `free-only-auto-delete` rule (expire all objects after 1 day) was removed on 2026-07-08 — it deleted referenced blob bodies out from under D1 metadata. Verified at removal time: production D1 had `0` object-backed file rows (all 58 files `content_storage='inline'`), so no referenced blobs were lost while the rule was active.
- Agent credentials: configured locally in `.env.local` and `~/.config/hopit/production.env` as a scoped account token with Object Read & Write access to `hopit-blobs` only
- Verification: a 44-byte HopIt object-blob smoke file was uploaded through the R2 adapter, hydrated back through HopIt, and deleted; `hop storage status --profile production` and dry-run `hop storage gc --profile production` both report the HopIt-managed prefix at `0` objects / `0 B`

R2 is intentionally private. Do not enable public `r2.dev` access for HopIt blobs. The dashboard and agent should read through authenticated HopIt paths, not direct public object URLs.

## Literal Mirror State

The current mirror goal is to make `/Users/robert/HopIt Workspaces/hopit` a literal local copy of `/Users/robert/Documents/Projects/HopIt`, including generated folders, binary files, symlinks, empty directories, and `.git/`. The mirror command also routes a root `.env.local` to `.private/env/repo-root/.env.local` so the secret value is not left at the workspace root.

Important current boundary:

- Local literal mirror support exists in the agent.
- Root `.env.local` should not exist in the managed workspace root.
- Routed secret files under `.private/env/` stay local-only unless object storage and a local decrypt-capable key source are configured. With the current local key or `hop keys` bridge, they can sync as client-encrypted object blobs; without one, production-safe mirror/import skips cloud sync instead of uploading raw secrets.
- `.git/` entries are owner-private when included in a literal graph, but uploading Git internals to cloud storage is still a sensitive operation.
- Do not assume this full repository has already been uploaded to R2. Use `hop import-git --production-safe` or `hop mirror --production-safe` with the local encryption key loaded, then verify object counts and storage budget before treating a conversion as complete.
- Before any large production upload, run a manifest/storage-budget dry run and confirm the provider budget and data-sensitivity policy.

## Vercel Dashboard

Set these Vercel environment variables for Production, Preview, and Development unless a narrower scope is intentional:

```text
HOPIT_CODEBASE_ID
HOPIT_AUTH_PROVIDER
HOPIT_ALLOW_BASIC_AUTH_FALLBACK
HOPIT_DASHBOARD_USERNAME
HOPIT_DASHBOARD_PASSWORD
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
CLERK_SECRET_KEY
CLERK_JWT_ISSUER_DOMAIN
HOPIT_OWNER_EMAIL
HOPIT_BLOB_PROVIDER
HOPIT_BLOB_PREFIX
HOPIT_BLOB_FREE_ONLY
HOPIT_BLOB_STORAGE_BUDGET_BYTES
HOPIT_R2_ACCOUNT_ID
HOPIT_R2_BUCKET
HOPIT_R2_ACCESS_KEY_ID
HOPIT_R2_SECRET_ACCESS_KEY
```

Hosted HopIt requires cloud-backed status. The `/api/agent/command` route refuses local workspace commands on Vercel. The current production env uses `HOPIT_AUTH_PROVIDER=clerk`; keep `HOPIT_ALLOW_BASIC_AUTH_FALLBACK` unset for normal production access. Vercel Deployment Protection can be enabled as an additional account-level guard.

## Domain And Auth Rollout

The canonical HopIt domain is now `https://hopit.dev`. It is owned in Porkbun and routed to the Vercel project `robertg761s-projects/hopit`.

Current Vercel aliases:

- `hopit.dev` -> current production deployment, inspect with `vercel inspect https://hopit.dev`
- `www.hopit.dev` -> current production deployment, inspect with `vercel inspect https://hopit.dev`
- Existing generated aliases, including `hopit-ten.vercel.app`, are still attached to the current deployment for recovery/backward compatibility.

Current Porkbun DNS records:

| Purpose | Type | Host | Value | Porkbun id |
| --- | --- | --- | --- | --- |
| Vercel apex | A | `hopit.dev` | `76.76.21.21` | `558004917` |
| Vercel www | A | `www.hopit.dev` | `76.76.21.21` | `558004894` |
| Clerk frontend API | CNAME | `clerk.hopit.dev` | `frontend-api.clerk.services` | `558020407` |
| Clerk account portal | CNAME | `accounts.hopit.dev` | `accounts.clerk.services` | `558020398` |
| Clerk mail | CNAME | `clkmail.hopit.dev` | `mail.obq238gfi19r.clerk.services` | `558020403` |
| Clerk DKIM 1 | CNAME | `clk._domainkey.hopit.dev` | `dkim1.obq238gfi19r.clerk.services` | `558020406` |
| Clerk DKIM 2 | CNAME | `clk2._domainkey.hopit.dev` | `dkim2.obq238gfi19r.clerk.services` | `558020390` |

The default Porkbun wildcard parking record `*.hopit.dev -> pixie.porkbun.com` was deleted because it conflicted with clean production DNS verification and is not part of HopIt's routing model.

Current Clerk/Vercel auth state:

- Clerk Marketplace integration name: `hopit-auth`
- Clerk plan: Free, with paid add-ons left off
- Clerk production domain: `hopit.dev`
- Clerk frontend API: `https://clerk.hopit.dev`
- Clerk account portal: `https://accounts.hopit.dev`
- Clerk DNS: verified
- Clerk SSL certificates: issued
- Vercel Production env contains redacted `pk_live_`/`sk_live_` Clerk values plus `CLERK_JWT_ISSUER_DOMAIN=https://clerk.hopit.dev`
- Clerk Google social connection: enabled for sign-up and sign-in
- Clerk Google social connection: email subaddress blocking enabled
- Google Cloud account used for OAuth setup: Robert Gordon (`robertgordon761@gmail.com`)
- Google Cloud project: `HopIt` (`hopit-auth-prod-rg`)
- Google OAuth client: `HopIt Clerk Production`, type `Web application`
- Google OAuth authorized JavaScript origins: `https://hopit.dev`, `https://www.hopit.dev`
- Google OAuth authorized redirect URI: `https://clerk.hopit.dev/v1/oauth_callback`
- Google Auth Platform publishing status: Testing
- Google Auth Platform test user: `robertgordon761@gmail.com`
- Google OAuth credentials: stored in macOS Keychain for account `hopit-auth-prod-rg:HopIt Clerk Production` under services `HopIt Google OAuth Client ID` and `HopIt Google OAuth Client Secret`

Current safe runtime posture:

- `https://hopit.dev/` responds over HTTPS and redirects signed-out users to `/sign-in`.
- `https://hopit.dev/sign-in` renders the Clerk sign-in route.
- Owner Google sign-in and D1 owner claim are verified on the live domain.
- Basic Auth fallback env vars were removed from Vercel Production after owner access was verified.
- Clerk production is configured and `HOPIT_AUTH_PROVIDER=clerk` is active in Vercel Production.
- Google Auth Platform Audience shows `1 user (1 test, 0 other) / 100 user cap` with `robertgordon761@gmail.com`.
- Local agent status/watch is running against D1. R2-backed object sync is configured for the local agent, push is enabled, and a lightweight periodic graph-head reconciliation covers missed hints without full graph reads when unchanged; hosted workspace commands remain disabled.

Auth handoff state:

- `/api/me` can upsert the owner into the active cloud backend.
- The seeded `hopit` codebase owner is claimed by the real Clerk user in D1.
- Basic Auth fallback variables are removed from Vercel Production; re-add `HOPIT_ALLOW_BASIC_AUTH_FALLBACK=1` plus dashboard credentials only for deliberate emergency recovery.

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

### First-run setup

`hop setup` is the interactive front door for a new device. Its default terminal
wizard has four visible stages: choose a projects folder through the system
picker, prepare the local device-encryption keyring, approve the device and
select a cloud codebase in the signed-in browser, then review a human-readable
readiness summary. Existing directories are allowed; a non-empty
choice requires confirmation after a warning that its contents will be uploaded
to HopIt Cloud and local copies removed only after safe acknowledgement. Setup
creates a scoped session whose token is encrypted to the local device public
key, writes the connected `~/.config/hopit/production.env`, attaches the chosen
cloud codebase, and starts the service plus macOS start-on-login agent. Interactive
setup does not dump JSON by default; use `--json` to include it, `--advanced`
for agent-state/codebase/env/login-agent prompts, `--no-connect` for local-only
setup, or `--yes` and explicit flags for automation.

When a signed-in account has no cloud codebase, the browser approval page can
create the first project inline and select it before approving the device. Once
connected, the dashboard exposes the same outcome as a four-step checklist:
choose/create the cloud project, connect the local agent, attach the managed
folder under the Workspace Root, and prepare the first bounded working set.

Adding further codebases from an already-connected device does not require a
fresh `hop setup`. `hop add <path>` (alias `hop project add`) onboards any local
folder as a new codebase in one command: it derives the codebase id, runs
browser device approval (which can create the requested project), stores the
scoped token in a `0600` per-codebase connection entry under the agent state
root (`connections/<codebaseId>.json`), imports through the production-safe
path, and attaches the result under the Workspace Root. The approval flow hard
-fails before any side effect if the approved codebase differs from the
requested one, so a misrouted approval cannot overwrite the primary workspace.
LunarLog was migrated this way on 2026-07-11 (816 files at revision 816) while
the primary `hopit` codebase stayed untouched at revision 4437.

```bash
/tmp/hop-darwin-arm64/bin/hop setup
```

Run it non-interactively in scripts or CI with `--yes` (accept local defaults) or
explicit flags: `--workspace-root`, `--state-root`, `--codebase-id`,
`--env-path`, `--write-env`/`--no-write-env`, `--force-env`, `--advanced`, and
`--launch-agent`/`--no-launch-agent`. Add `--connect` to a scripted invocation
when browser approval is intended; otherwise `--yes` remains offline and does
not require cloud credentials or network access. Connected setup securely merges
the managed connection values into an existing env file instead of replacing
unrelated entries.

Create the local env file before installing a login service (or let `hop setup`
write it for you):

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

Local dashboard server routes read the same file as a fallback under the Next.js
process env, and command routes use `--profile production` when installed-agent
paths are configured. That keeps status/codebase reads plus sync, refresh,
recover, review, merge, and Workspace Root attach actions on the installed-agent
D1 config and Workspace Root even if `.env.local` still contains older rollback
values.

### Releases

The public one-liner installer (`curl -fsSL https://hopit.dev/install | sh`,
served from `public/install.sh`) pulls prebuilt bundles from a public R2 release
channel. The checked-in publisher blocks unsigned uploads by default:

```bash
npm run release:hop -- --dry-run   # print the wrangler upload plan, no writes
npm run package:hop                # local/private host artifact; no upload
npm run package:hop -- --target all  # local verification for every target
```

`scripts/release-hop.mjs` cross-builds every target via `scripts/package-hop.mjs`
(`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`), computes a unique
version string `<package.json version>+<short git sha>.<UTC build id>`, and uploads through
`npx wrangler r2 object put ... --remote`. It stages every immutable object
before publishing the one mutable channel pointer. A failure can therefore leave
unreferenced immutable objects, but it cannot advance `latest` to a mixed set.
Targeted plans publish only their versioned objects and never replace the
multi-platform `latest` pointer.
Do not remove the unsigned gate until real signing and macOS notarization are in
place.

This section describes the checked-in publication contract. No release was
uploaded while adding these gates, and the live bucket should be inspected for
a schema-v2 manifest before treating it as migrated. Do not publish merely to
exercise the flow; use the local tests and `--dry-run` until signing/notarization
is implemented. Local dogfood builds use `package:hop` instead.

- Bucket: `hopit-releases` (public, wrangler-authed on the release machine).
- Public base URL: `https://pub-3d89002dcb6c4d71b6d1188f39cc7731.r2.dev`.
- Layout:
  - `releases/<version>/hop-<target>.tar.gz` and `.sha256` sidecars — immutable
    target artifacts.
  - `releases/<version>/manifest.json` — immutable schema-v2 manifest whose
    `key` and `checksumKey` fields point only to the same version prefix.
  - `latest/manifest.json` — the only mutable short-cache channel pointer; it is
    uploaded last. The publisher no longer writes mutable `latest/hop-*`
    artifacts, and the installer ignores any legacy objects at those keys.

Each `.tar.gz.sha256` sidecar is written in `<hex>  <name>.tar.gz` format, so the
installer resolves `latest/manifest.json` to one immutable release, validates
that the one-line sidecar names that exact archive, and hashes the archive
directly with `shasum -a 256` / `sha256sum`. Installation fails closed when
neither checksum utility exists. Before replacing the current runtime, the
installer extracts the candidate and runs its `bin/hop help`; it then stages an
immutable versioned runtime and atomically replaces the launcher under an
installer lock, so the prior launcher/runtime remain usable until activation.
Cross-target bundles are verified structurally at
build time (launcher + runtime present, and the bundled `hop.mjs` parses); only
the host target is executed during packaging, and each target records a
`verified` flag in the manifest.

Repository CI runs lint, TypeScript checks, web/Worker/config tests and a
production build on Ubuntu, then runs the agent suite and standalone packaging
on Ubuntu and macOS. Locally, `npm run verify` mirrors the quality gate and
`npm run verify:release` adds `npm run package:hop -- --target all`.

## Local Agent Service

Import one real project into D1 and hydrate a production-profile managed workspace:

```bash
npm run hop -- import \
  --profile production \
  --source /path/to/project \
  --codebase-id "$HOPIT_CODEBASE_ID" \
  --force
```

Register this device after the initial bootstrap. The returned `sessionToken`
is shown only once; store it as `HOPIT_AGENT_SESSION_TOKEN` on this device.

```bash
npm run hop -- session register \
  --profile production \
  --codebase-id "$HOPIT_CODEBASE_ID" \
  --device-name "$(hostname)"

npm run hop -- session list \
  --profile production \
  --codebase-id "$HOPIT_CODEBASE_ID"
```

After `HOPIT_AGENT_SESSION_TOKEN` is set, normal graph reads, per-file sync
mutations, and agent events use the scoped device token.

For debugging, the local agent service can still be started manually. It runs the watcher and local status server from one background process, writes a pid file under the agent state root, and binds status to `127.0.0.1:4785` by default. `service start` only reports success after the status endpoint is reachable and the watcher is running, and the spawned `service run` process stays alive until it receives a stop signal.

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
launchctl print "gui/$(id -u)/com.hopit.agent.hopit"
curl http://127.0.0.1:4785/status
```

`hop service status` is useful for the pid-file-managed `service start`
debug path, and now also trusts a codebase-verified loopback `/status` probe, so
the current LaunchAgent's pid-file-less `hop service run` process reports
`running: true` with `source: "health-probe"`. `launchctl print` plus the
loopback `/status` endpoint remain the primary source of truth for that
always-running install.

For cross-device handoff today, the safety primitive is still refresh. Push
hints, periodic graph-head reconciliation, one-shot remote pull, and explicit
refresh all enter through that same decision gate. The service syncs local edits
from the device you are using; another clean device can apply a pushed or
reconciled revision without waiting for a local edit.
Remote-pull only applies when the workspace is fully materialized, the journal is
clean, and disk content still matches the hash-only materialization manifest; if
status shows `workspace.localChanges.state` as `dirty`, sync or recover that
device before trusting handoff:

```bash
npm run hop -- remote-pull \
  --profile production \
  --codebase-id "$HOPIT_CODEBASE_ID" \
  --session-token "$HOPIT_AGENT_SESSION_TOKEN"
```

```bash
npm run hop -- refresh \
  --profile production \
  --codebase-id "$HOPIT_CODEBASE_ID" \
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
launchctl print "gui/$(id -u)/com.hopit.agent.hopit"
curl http://127.0.0.1:4785/status
curl http://127.0.0.1:4785/events
curl http://127.0.0.1:4785/journal
```

Healthy personal-production service status should show:

- `state = running` from `launchctl print`.
- `ok: true` and `readiness: "ready"` from `curl http://127.0.0.1:4785/status`.
- `watch.state: "watching"`.
- `journal.pendingCount: 0` before refresh or cross-device handoff.
- `journal.failedCount: 0`.
- `remotePull.enabled: true` when pull or push reconciliation is active, with `remotePull.reconciliationIntervalMs: 300000` unless intentionally tuned and `remotePull.state` possibly `skipped` when local work needs attention.
- `remotePush.connectionState`, `fallbackState`, `lastPushedRevision`, `lastAppliedRevision`, and `lastSkippedReason` explain whether the socket, periodic fallback, and safe-refresh decision have converged. The dashboard shows matching recovery guidance for blocked or degraded states.
- `hop remote-pull --profile production` should return `state: "up-to-date"` without a `remote-pull.skipped` event when the codebase-level D1 graph head matches the local materialized cursor.

Push hints are not the only handoff trigger: when remote push is enabled, the
watch/service loop performs a periodic graph-head reconciliation at the same
configured cadence even if there has been no local edit. Optional automatic
cache maintenance is separate and remains off unless `HOPIT_AUTO_PRUNE=1` or
`--auto-prune` is set. Its default schedule is every six hours and it considers
only content inactive for seven days; it skips while local sync or the journal
is unresolved and reuses the normal prune contract that preserves pinned and
non-clean content.

Service-status detection: when launchd owns the foreground `service run` process
directly there is no pid-file record, but `hop service status` now trusts a
healthy loopback `/status` probe that matches the expected codebase id and
reports `running: true` with `source: "health-probe"`. A `running: false` result
therefore means the probe could not confirm the expected service, not merely a
missing pid file.

In the current Mac setup, the LaunchAgent is the preferred always-running path.
Logs go to
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

1. Register a new session with the current admin-capable scoped session.
2. Replace `HOPIT_AGENT_SESSION_TOKEN` in `~/.config/hopit/production.env` or `.env.local`.
3. Restart the local service.
4. Confirm status reads through the new token.
5. Revoke the old session id.

```bash
npm run hop -- session register \
  --profile production \
  --codebase-id "$HOPIT_CODEBASE_ID" \
  --device-name "$HOPIT_DEVICE_NAME"

launchctl kickstart -k "gui/$(id -u)/com.hopit.agent.hopit"
curl http://127.0.0.1:4785/status

npm run hop -- session revoke \
  --profile production \
  --codebase-id "$HOPIT_CODEBASE_ID" \
  --session-id old-session-id
```

If you are using the manual pid-file debug service instead of LaunchAgent, use
`npm run hop:service:restart -- --codebase-id "$HOPIT_CODEBASE_ID"` and
`npm run hop:service:status -- --codebase-id "$HOPIT_CODEBASE_ID"` instead.


## Desktop App (dogfood)

`packages/desktop` is a menu-bar-first Electron app that is a THIN shell over the
existing local engine: it reads live state from each codebase's loopback
`/status` and `/events` endpoints (default port 4785 for `hopit`, derived
per-codebase ports for everything else, matching the agent's FNV-1a derivation)
and performs every action by spawning the installed `hop` CLI. It contains no
agent logic; if the desktop app and the CLI ever disagree, the CLI is right and
the shell has a bug.

What it shows: a project sidebar (from the workspace index plus the per-codebase
connection store), a per-project view with Now/History/Activity/Files tabs, an
"Add a project" flow that wraps `hop add --source <folder>` with a native folder
picker and a streamed human-output log pane (browser device approval opens
exactly as it does from the terminal), and a tray icon reflecting the aggregate
state (all synced / syncing / attention / service stopped). Closing the window
keeps it in the tray. hopit.dev always opens in the external browser; the window
never loads remote content (context isolation on, sandbox on, no node in the
renderer).

Run and test:

```bash
npm run desktop:dev        # launch from the repo (electron .)
npm run test:desktop       # node:test suite for the pure logic modules
npm run desktop:package    # unsigned .app under artifacts/desktop/ (local dogfood only)
```

The packaged app is unsigned and deliberately NOT wired into any release
publication (that stays blocked pending signing, same as the CLI). Electron and
@electron/packager are devDependencies of `packages/desktop` only, so
`npm run package:hop` and the agent runtime artifact are unaffected.
`HOPIT_DESKTOP_SMOKE=1 electron . --no-window` boots to tray creation, prints a
one-line readiness marker, and exits 0 after ~2.5 s (used as a headless smoke
check). `HOPIT_HOP_BIN` overrides hop binary discovery (default order:
`~/.local/bin/hop`, `/opt/homebrew/bin/hop`, `/usr/local/bin/hop`, the packaged
Application Support runtime).


## Current Limits

- Hosted workspace commands are intentionally disabled; local workspace commands run through the local agent. Hosted collaboration/member/work-item APIs exist behind Clerk product auth.
- Basic Auth is now emergency-only code and should stay disabled in production. The repo has Clerk-backed product auth code, production Google OAuth, durable users, memberships, invitations, D1 owner claim, and first server-side permission checks.
- D1 separates graph/file metadata from file bytes and supports object-backed blobs through the agent sync path with per-file and chunked-bulk revision-guarded journal commits, per-file version rows, object-backed compare, and retention-aware dry-run-by-default object GC. Browser text writes now use that guarded active-change-set path and preserve Main; object-backed browser edits still require an agent because the server has no blob-upload mutation path. The previous whole-graph-save cost warning is resolved for agent sync and text browser edits, while production retention policy and other non-agent product write paths remain incomplete.
- Scoped session raw SQL is restricted to conservative operation/table/statement shapes, exact codebase equality, parameter-count checks, and capability-specific writes. This closes the known cross-codebase escape but is still a transitional API; move device calls to typed Worker operations before treating the boundary as final.
- The full privacy/key-grant model is documented in [HopIt Privacy And
  Encryption Plan](privacy-encryption-plan.md). The first device keyring,
  encrypted recovery export, trusted-device public-key registration, and
  wrapped-key APIs now exist, but encrypted file coverage is still limited to
  routed secrets. Normal private repo files, repo/private/secret zone keys,
  private path metadata, invite-time key wrapping, independent secret grants,
  dashboard recovery import, and complete revocation/rekey flows remain future
  work before HopIt should claim full private-repo encryption.
- The current R2 setup is no-charge/private dogfood storage, not a public-release storage commitment. It has a free-only app budget; the former 1-day object-expiry lifecycle rule was removed on 2026-07-08 so stored blobs now persist, but the posture is still not a permanent customer repository storage commitment.
- Full literal cloud sync of the current HopIt repository should be performed through the production-safe import/mirror flow, not by raw copying. Treat `/Users/robert/HopIt Workspaces/hopit` as the local managed workspace and verify cloud object counts before assuming large file bodies are uploaded.
- Git export/publish creates a clean local Git repo; it does not push to a remote.
- The standalone artifact includes start-on-login support scripts and the release channel now publishes immutable objects before its manifest pointer, but it is not signed, notarized, or packaged as a native installer. Public unsigned publication is blocked with no escape hatch; private dogfood stays local through `package:hop`.
- LaunchAgent health is verified with `launchctl print` plus the loopback `/status` endpoint. `hop service status` now also trusts a codebase-verified loopback `/status` probe, so direct supervisor-owned `service run` installs without a pid file report `running: true` with `source: "health-probe"`.
- Token rotation is CLI/runbook driven; there is no dashboard UX for device credential recovery yet.
- The dashboard now has first-project device approval, a four-step Workspace Root checklist, a first read-only code browser, plus issue, discussion, release, project-board, durable comment, member/invite, and key-grant status surfaces. Web compare UI wiring, richer release artifacts, key approval/rotation UX, and a successful clean-workspace live push-apply proof remain future work.
- Public privacy-policy and terms pages, Google OAuth publication/verification, artifact signing, and macOS notarization are not complete. Do not treat the private dogfood controls as public-launch clearance.

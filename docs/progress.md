# HopIt Progress Tracker

Last updated: 2026-07-23

This tracker is the working view of what is done, what is in progress, what is next, and what is still deliberately out of scope. The roadmap source remains [MVP Plan](mvp-plan.md), and the agent contract source remains [Local Agent Architecture](agent-architecture.md). This file turns those plans into a practical implementation ledger.

## Status Legend

- `Done`: implemented, documented, and covered by a repeatable proof command or deterministic test.
- `Mostly done`: implemented enough for the current spike, with known gaps before it can be treated as a product contract.
- `In progress`: partially implemented or recently started, but not yet fully proven.
- `Next`: the next intended implementation target.
- `Blocked`: cannot move safely without a design decision, dependency, or earlier milestone.
- `Not started`: planned but no meaningful implementation yet.
- `Later`: intentionally outside the current MVP path.

## Current Snapshot

HopIt has a working local managed-folder agent spike plus a deployed personal production baseline. The agent can seed a cloud graph, hydrate a normal folder, capture local writes, journal them durably, upload regular file bodies to S3-compatible object storage, acknowledge object metadata into the selected active change set, recover unacknowledged writes after restart, safely refresh a second same-owner workspace, export/publish a clean Git escape hatch, and expose local status/event/journal/cloud state.

The solid v1 target is now broader than the current spike: a HopIt Workspace Root, managed-folder/lazy materialization first, production-grade automatic remote-update delivery, object-backed content-addressed storage with per-file revision guards, scoped device/session auth, and GitHub-like code/review surfaces. True native filesystem-provider work remains future research; v1 should prove the managed-folder Workspace Root before going there.

The web app polls `/api/agent/status`. In local mode that route requires the local agent `/status` response and treats `/events` and `/cloud` as best-effort payloads so a slow graph read does not take the dashboard offline; in production it reads the configured D1 cloud dashboard backend. Local dashboard server routes merge `~/.config/hopit/production.env` under the Next.js process env, merge `hop workspace discover` readiness into `/api/codebases`, and the command route can run whitelisted sync, refresh, recover, review, merge, first-run Workspace Root setup, and Workspace Root attach actions with `--profile production` when installed-agent paths are configured. Hosted deployments remain read-only for workspace commands and require dashboard authentication.

Fixture-backed conflict handling is in place for stale selected-state revisions, stale file/base revisions, and stale Main revisions. Conflicts are persisted on the selected active change set, emitted as `change_set.conflict_detected`, and surfaced through status while preserving local edits for review.

Current live deployment:

- Vercel project: `robertg761s-projects/hopit`
- Vercel project id: `prj_hO8U1QmyliQjGODz4R339UkgE86S`
- Vercel org/team id: `team_x1SyEPIryEghBSkkwoXSTIZ2`
- Production URL: `https://hopit.dev`
- Secondary production alias: `https://www.hopit.dev`
- Current Vercel deployment: inspect `https://hopit.dev` with `vercel inspect https://hopit.dev` because every production Git push creates a new immutable deployment URL.
- Cloud graph target: Cloudflare D1 with schema at `cloudflare/d1/schema.sql`
- Historical export source: saved snapshot under `/Users/robert/HopIt-Backups/convex/`
- Cloudflare R2 bucket: `hopit-blobs`, private public-access-disabled object storage for HopIt blobs
- Clerk production domain: `hopit.dev`, with `https://clerk.hopit.dev` as the verified production issuer/frontend API
- Local LaunchAgent: `com.hopit.agent.hopit`
- Production env file: `/Users/robert/.config/hopit/production.env`
- Production device keyring: `/Users/robert/Library/Application Support/HopIt/Agent/keys/hopit.device.json`
- Production trusted device id: `dev_70cbc6c5-737c-451e-b39e-db630be69e55`
- Production user vault key id: `uvk_99d350e5-2b2e-453a-b7a4-739cdb8893a7`
- Seeded codebase id: `hopit`
- Seeded graph size: 58 source files
- Production workspace: `/Users/robert/HopIt Workspaces/hopit`
- Second onboarded codebase (2026-07-11, via `hop add`): `lunarlog`, 816 files at revision 816, managed folder `/Users/robert/HopIt Workspaces/lunarlog`, scoped session for `lunarlog` only

Domain-dependent production auth setup is no longer pinned. `hopit.dev` is live, Clerk production DNS/SSL are verified, Vercel has the redacted live Clerk env vars, and Vercel Production now uses `HOPIT_AUTH_PROVIDER=clerk`. Google OAuth is enabled in Clerk production through the Google Cloud project `hopit-auth-prod-rg`, and the Google app is published `In production`. Clerk's production allowlist is disabled, so public signup is open. Production owner sign-in and D1 owner claim are smoke-tested, and Basic Auth fallback env vars have been removed from Vercel Production.

The current setup source of truth is [Personal Production Runbook](personal-production.md). It records the Vercel, D1 migration target, historical export, R2, LaunchAgent, local env, workspace, backup, and export locations without documenting secret values.

The literal mirror path can copy binary files, symlinks, empty directories, generated folders, `.git/`, and route root `.env.local` into `.private/env/repo-root/.env.local`. Routed secrets stay local-only unless object storage and a local decrypt-capable key source are configured; with the current Mac config they can sync as client-encrypted object blobs through the legacy local key or the new `hop keys` user-vault bridge. The full repository should still be converted through `hop import-git --production-safe`/`hop mirror --production-safe` and verified before assuming it is uploaded to R2; the current no-charge R2 posture is still private dogfood, not a public-release storage commitment.

The full privacy/security framework is documented in [HopIt Privacy And
Encryption Plan](privacy-encryption-plan.md). The current implementation
encrypts routed secrets with either the legacy local key bridge or the new local
device keyring user-vault bridge. Device keyrings, passphrase-encrypted recovery
export, trusted-device public-key registration, user/codebase keyring metadata,
wrapped-key grants, key audit events, and a redacted dashboard key-grant status
panel now have first implementations. Full private-repo encryption,
repo/private/secret zone keys, invite-time key sharing, independent secret
grants, private path metadata, and complete revocation/rekey flows remain next
work.

The installed macOS service is owned by LaunchAgent `com.hopit.agent.hopit`; it is verified with `launchctl print` plus `curl http://127.0.0.1:4785/status`. `hop service status` now also trusts a healthy loopback `/status` probe that positively matches the expected codebase id, so a launchd-owned `service run` process without a pid file reports `running: true` with `source: "health-probe"`.

Current production state as of 2026-07-10: HopIt uses Cloudflare D1 as the only hosted graph backend. Vercel aliases and Clerk sign-in routing are live. The D1 database `hopit` is created, schema-applied, seeded from the historical export, reachable through `hopit-d1-api.hopit-robert.workers.dev`, configured in Vercel/local env for graph/status/file/codebase/account/action-job/member/invite/session/key paths, and serving the deployed `hopit.dev` app. The push hub is deployed and the installed personal-production service reports push enabled. The long-standing "workspace drift" that skipped every push apply was diagnosed on 2026-07-10 as a stale content manifest rather than real drift; refresh and the remote-push decision now self-heal that case, the live manifest was healed (24 phantom paths exonerated, clean scan at revision 4436), and the service was restarted clean. A live `push-applied` proof landed on 2026-07-11: a second isolated device workspace synced revision 4436 → 4437 and the production service applied it over the hub (trigger `remote-push`, ~8s after the remote sync). Push-enabled watch/service mode supplements socket hints with a lightweight periodic graph-head reconciliation at the configured five-minute cadence.

History: the retired hosted graph export was saved to `/Users/robert/HopIt-Backups/convex/hopit-convex-prod-2026-06-30-disabled-snapshot.zip` with SHA-256 `0e83df9ab7e80a81a9a3b06e1cd3399ff5b532fa968bded3c14334640b4c9f3d`. The migration script is retained for export rehearsals; the backend code path was removed by WS1 in [Remediation Plan July 2026](remediation-plan-2026-07.md).

Current proof commands:

```bash
node --test packages/agent/test/agent-cli.test.js
node --test packages/agent/test/crypto.test.js
node --test cloudflare/d1/api-worker.test.js
node --test packages/agent/test/d1-backend.test.js
node --test packages/agent/test/remote-push.test.js
npm run agent:test
npm run lint
npm run typecheck
npm run typecheck:agent
set -a; source /Users/robert/.config/hopit/production.env; set +a
npm run check:production-config
npm run build
npm run package:hop
```

Current verified result:

- `node --test packages/agent/test/agent-cli.test.js`: passes with 88 tests, 88 passing, and 0 failures.
- `node --test packages/agent/test/crypto.test.js`: passes with 8 tests, 8 passing, and 0 failures.
- `node --test cloudflare/d1/api-worker.test.js`: passes with 10 tests, 10 passing, and 0 failures.
- `node --test packages/agent/test/d1-backend.test.js`: passes with 12 tests, 12 passing, and 0 failures.
- `npm run agent:test`: passes with 119 tests, 119 passing, and 0 failures.
- `npm run lint`: passes.
- `npm run typecheck`: passes.
- `npm run typecheck:agent`: passes the WS4 checkJs allowlist.
- `npm run check:production-config`: passes when the current local production env is loaded; the checker now requires D1 backend config and fails Vercel production when Basic Auth fallback is enabled without `HOPIT_ACKNOWLEDGE_BASIC_AUTH_RISK=1`.
- `npm run build`: passes when rerun with network permission for Next Google Fonts fetches.
- `npm run package:hop`: builds the current macOS artifact with env/install support files.
- `npm run d1:migrate:convex-export -- --export /Users/robert/HopIt-Backups/convex/hopit-convex-prod-2026-06-30-disabled-snapshot.zip --codebase-id hopit`: live D1 import completed with `58` files and the latest `500` events selected from `11,638` exported events; dry-run mode is still useful for future rehearsals.
- Installed packaged runtime: LaunchAgent `com.hopit.agent.hopit` reports push enabled and, since the 2026-07-10 manifest heal and restart, a clean workspace scan at revision 4436. The runtime was repackaged and reinstalled on 2026-07-11 and now includes the self-heal/guard commits (`0492579`, `2955f8e`, `6a1f7a7`) and the per-codebase port fix (`c916def`); the prior binary was backed up as `hop-darwin-arm64.pre-guards-20260710233509.bak`. The 300000 ms periodic graph-head reconciliation means missed hints no longer wait for another local edit.
- `hop keys status --profile production`: packaged runtime reports the local keyring at `/Users/robert/Library/Application Support/HopIt/Agent/keys/hopit.device.json`, mode `0600`, device key `trusted`, user keyring `active`, and user vault wrap `active`.
- `launchctl print gui/501/com.hopit.agent.hopit` plus `curl http://127.0.0.1:4785/status`: LaunchAgent is running and the loopback status endpoint reports `service=cloudflare-d1-graph`, `cloudExists=true`, and `fileCount=58`.
- `node --test packages/agent/test/d1-backend.test.js`: passes D1 graph sync, collaboration routes, scoped session registration/list/touch/revoke, trusted device key registration, user keyring, and wrapped user-vault key metadata.
- `vercel deploy --prod`: deployed the D1-backed app and aliased it to `https://hopit.dev`.
- `curl -I https://hopit.dev/`: returns `HTTP/2 307` to `/sign-in` for signed-out users, confirming Clerk protects the dashboard.
- Production Clerk sign-in and D1 owner claim were smoke-tested on `https://hopit.dev`; Basic Auth fallback is no longer needed for the owner handoff.
- Google Auth Platform Audience for project `hopit-auth-prod-rg`: shows `1 user (1 test, 0 other) / 100 user cap` and the test-user row `robertgordon761@gmail.com`.

## 2026-07-12 WS7c Closed: Trail Diffs In The Desktop App And Dashboard, Plus A Reliability Sweep

WS7c is now closed end to end: the object-backed compare engine was verified as already built and passing, and both the desktop app and the dashboard grew real trail-step diffs on top of it: the compare/history surfaces are no longer dashboard-pending. A reliability sweep landed alongside: merged CI, human-readable sync copy, an events-journal rotation, connection-fault resilience, and scheduled nightly backups. All work is live: commits pushed, dashboard deployed to `hopit.dev`, desktop app relaunched.

Reliability sweep (`25247aa`, `04d6ae7`, `ccbc883`, `d4823df`):

- Merged CI: `verify` and `desktop` jobs were added to the pre-existing passing workflow, the macOS/packaging matrix was retained, and a status badge landed in the README.
- Copy/UX: human sync-state labels via `syncStateLabel`; `hop add` error strings now name `hop add`; friendly expired-approval guidance on the device page; two renderer races fixed. The desktop renderer is now an ES module importing the tested lib modules.
- Events journal rotation: the events journal rotates at 16 MB via atomic rename, keeping one prior generation (`HOPIT_EVENTS_MAX_BYTES`); backups capture both generations, and `readEventsWithHistory` serves deep readers.
- Connection resilience: remote-pull and head-reconciliation cloud reads retry transient faults through `cloud-retry.js`, emitting `cloud.fetch_recovered`. A new `remote-push.resumed` event makes `/status` report push-connected when the socket is alive after a reconnect catch-up poll, so push-fallback-polling now means genuinely socketless. `remote-push.disconnected` carries `closeCode`/`closeReason`/`wasClean`/`errorDetail`, and the initial push cursor read survives rotation.
- Nightly backups scheduled via launchd (`com.hopit.backup`, 3:30 AM, every connected codebase plus the device keyring, 14-day retention), with a validated first run.

WS7c engine verification (`d681765`):

- The engine implementation (`file_versions` rows, blob-lazy `compareRevisions` with a request-scoped cache, honest `missing_blob`/`integrity_failure`/`requiresLocalKey`/`binary_changed` states, dry-run-default storage GC, and the three-revision `hop demo` chain) was found already committed and passing every design-doc acceptance item.
- A dated implementation-notes addendum on [WS7c Object-Backed Diff And History Reconstruction Design](ws7c-object-backed-diff-history-design.md) records the resolved choices.

Desktop Trail consumer (`c4603dc`):

- Trail steps remain event-derived (real revisions/timestamps/triggers: no revision-list surface exists in the engine), but expanding a step now runs a real metadata-only directory compare for the step's revision span (`fromRevision` → `revision` when present), filtered of unchanged files.
- Each file row opens a real unified line diff via `hop compare --path`; failure states read in plain language; a fetch-once-per-pair session cache avoids re-fetching; revision args are validated as safe integers before spawn.
- Desktop suite grew 90 → 112.

Dashboard compare consumer (`7c7f787`):

- `/api/codebases/compare` exposes three modes: revision enumeration (distinct `file_versions` revisions after a fail-closed authorization probe: revision numbers only), metadata-only directory compare, and single-file line diff.
- The compare page has step pickers with swap, summary chips, a per-file change list, expandable unified diffs, and client caches (directory per revision-pair, file per pair+path) so nothing re-fetches. Trail vocabulary is used throughout, and the status-snapshot shell (`compare-view.tsx`) is deleted.
- Web suite grew 20 → 47 (a new `vitest.config.ts` supplies the `@/` alias). Deployed to `hopit.dev`.

Suite totals after all of the above: agent 262, worker 23, web 47, desktop 112: all green locally and in CI.

Honest ops note: an intermediate commit (`c4603dc`) accidentally swept a staged deletion from concurrent in-progress work, briefly breaking HEAD's web build; it was healed by `f201e8e` (restore) and the deletion re-landed properly in `7c7f787`. Process lesson recorded: stage explicitly when multiple work streams share a tree.

## 2026-07-11 hop add Onboarding, Wrong-Codebase Incident, And First Real Migration

A one-command `hop add` onboarding path landed, a live wrong-codebase incident during its first use was contained with zero cloud data loss, the flow was hardened until the same misroute fails closed, and the first genuinely new codebase (LunarLog) was migrated end to end through the hardened path.

`hop add` onboarding (`39a5035`):

- `hop add` (alias `hop project add`) onboards any local folder as a new codebase in one command: it derives the codebase id from the folder, runs browser device approval (the approval page can create the requested project), stores the returned scoped token in a `0600` per-codebase connection entry under the agent state root (`connections/<codebaseId>.json`), imports through the production-safe path, and attaches the result under the Workspace Root.
- Option resolution transparently uses the stored connection entries for non-primary codebases, so later commands against an added codebase reuse its scoped token without re-approval.
- The additive D1 columns `requested_codebase_id`/`requested_codebase_name` were migrated on production with `wrangler` to carry the requested project through device authorization.

Wrong-codebase incident during the first live `hop add` (LunarLog): local-only damage, zero cloud data loss:

- The browser approval returned the EXISTING primary codebase `hopit` instead of creating the requested `lunarlog` (the page made approving an existing project too easy), and `runAdd` proceeded with the approved id. It mirrored LunarLog into the primary `hopit` managed workspace (the mirror step took its designed pre-wipe backup) and journaled roughly 14,879 pending deletes/creates against `cs_hopit_local`.
- The process was killed before any journal entry was acknowledged to cloud, so cloud and R2 were never touched. Damage was local only.
- Recovery: the poisoned journal and the bad connection entry were quarantined, the contaminated workspace was removed and re-hydrated from the intact cloud (revision 4437, 4,491 files, scan-clean afterward, all `hop doctor` checks pass), and the mis-issued session was revoked directly in D1 because `hop session revoke` itself was broken (fixed below). Zero data loss.

Hardening so the same misroute fails closed (`cfd5d57`; all deployed: runtime reinstalled, worker redeployed, dashboard deployed to hopit.dev):

- `hop add` hard-fails before ANY side effect when the approved codebase differs from the requested one, with a louder variant when the approval matches the device's primary codebase; there is no override flag.
- `importLocalProject` and `mirrorLocalProject` each independently fail closed before wiping a workspace directory that the index says belongs to a different codebase.
- The device approval page makes "Create <requested>" the only one-click action; approving a different existing project now requires expanding a secondary section and ticking an acknowledgment.
- Scoped-session revoke/touch SQL now binds `codebase_id`, so the worker statement policy accepts same-codebase revokes (cross-codebase stays rejected).
- Tests at that commit: agent 218, worker 23, web 20.

Device-authorization resilience (`c2f099a`):

- The device-authorization create fetch retries transient faults with bounded backoff, and the poll loop treats dropped sockets, 5xx, 429, and non-JSON responses as missed polls until the code's own expiry. Observed live failure that motivated it: a `read EADDRNOTAVAIL` killed a pending approval. Agent tests 221.

First real migration succeeded through the hardened flow (LunarLog):

- Approval matched (`Approved codebase: lunarlog`), the codebase was created, and 816 files landed at revision 816 in cloud, with the managed folder at `~/HopIt Workspaces/lunarlog` fully hydrated (816/816) and a scoped session active for `lunarlog` only.
- The primary `hopit` codebase stayed at revision 4437 and healthy throughout.
- Remaining projects are self-service via `hop add --source <path>`; approval codes are single-use with roughly a 10-minute expiry.

Supporting context from earlier the same day (already in the ledger, referenced not duplicated):

- Storage/pricing research is in [storage-pricing-research-2026-07.md](storage-pricing-research-2026-07.md) (`ad62c97`); the R2 blob budget was raised from 8 GB to 9.5 GB in the local env files (`production.env` and `.env.local`), which are env-only and not tracked in the repo.

Follow-up issues found during this session (recorded, not fixed):

- The expired-approval page still says "Run hop setup again" even when reached from `hop add`, and offers no refresh path.
- Stale approval tabs linger after auto-open; each attempt opens a new tab rather than reusing one.
- The orphan `~/HopIt Workspaces/token-addicts-anonymous` folder from the first failed canary attempt should be cleaned up.
- `hop add --service` exists but was not exercised live yet.

## 2026-07-11 Runtime Reinstall, Live Push-Apply Proof, And Per-Codebase Ports

The 2026-07-10 self-heal/guard commits were repackaged into the deployed runtime, the last open cross-device handoff item was closed with a live clean-workspace `push-applied`, and a port-collision fix landed for non-default codebases.

Runtime reinstall:

- `npm run package:hop` rebuilt the runtime and the bundled `support/install-macos-launch-agent.sh` installed it to `~/Library/Application Support/HopIt/Runtime/hop-darwin-arm64` with `HOPIT_LAUNCHD_LABEL=com.hopit.agent.hopit`; the previous runtime was backed up alongside as `hop-darwin-arm64.pre-guards-20260710233509.bak`. The deployed agent now carries the self-heal/guard commits (`0492579`, `2955f8e`, `6a1f7a7`) and the per-codebase port fix (`c916def`).
- With launchd owning the process, `hop service status --profile production` reports `running: true` with `source: "health-probe"` (pid null): launchd-owned detection works.
- `hop doctor --profile production` passes all checks: cloud, workspace, hydration, journal, remote-cursor, requester-identity, service. Negative test: unsetting `HOPIT_REQUESTER_ID` flips the requester-identity check to a failure warning that visibility-filtered reads would run as guest and see zero files.

Live `push-applied` proof (closes the last open cross-device handoff item):

- A second isolated device workspace (same packaged binary; separate state root, workspace root, `HOPIT_SESSION_ID=session_robert_proof_device2`) fully hydrated codebase `hopit` at revision 4436 and scanned clean.
- One line was appended to `docs/progress.md` in that workspace; `hop sync` journaled exactly 1 write and the cloud acknowledged revision 4437.
- The primary production service, push-connected over websocket to `wss://hopit-d1-api.hopit-robert.workers.dev/events`, received hub event `evt_hopit_4437_913f1166-a104-49b8-8bf9-16607751d1b3` and emitted `remote-push.applied` (trigger `remote-push`, fromRevision 4436 → toRevision 4437) at `2026-07-11T02:41:38Z`, about 8 seconds after the second device's sync. The edited line materialized in `/Users/robert/HopIt Workspaces/hopit/docs/progress.md`. `remotePush.lastApplied` is now non-null and `lastAppliedRevision` is 4437.
- The proof used a genuinely new hub event, not the old `evt_hopit_1759` event, which was never retried (as designed).

Per-codebase service ports (`c916def`):

- Non-default codebases now derive a stable service port in `[4786, 5785]` (FNV-1a hash of the codebase id); default `hopit` keeps 4785; explicit `--port` and `HOPIT_AGENT_PORT` override; `writeLaunchAgent` embeds the resolved `--port`.
- Root cause observed live: `com.hopit.agent.Projects` crashed with `EADDRINUSE` on `127.0.0.1:4785`. Caveat: that `Projects` LaunchAgent executes from `~/.hopit/runtime` (public-installer layout), which has NOT been updated; it heals once that runtime is next updated, since the port derives from the codebase id at startup.

Follow-up issues found during verification (recorded, not fixed):

- Every service restart re-runs a full hydration pass over all 4,491 workspace files (~15 minutes at ~5 files/sec) before the remote-push client starts, so a restarted device has no push connection during that window. Resolved: restart hydration now verifies clean files locally without per-file cloud reads, so a clean workspace reaches ready state in seconds (see `packages/agent/test/hydrate-startup-verify.test.js`).
- The Clerk middleware in `src/proxy.ts` blocks the agent-session-token (`hst_`) auth path supported by `src/lib/request-cloud-actor.ts` for all `/api` routes: verified live against `https://hopit.dev/api/codebase-files` (307 → `/sign-in`): so that API auth path is currently dead code.
- `hop hydrate` of a fresh large workspace failed once mid-run with a dropped TLS socket (`UND_ERR_SOCKET`, "other side closed") and needed a retry to complete; hydrate is resumable, but the failure is worth a retry-with-backoff inside the command. Resolved: hydration cloud fetches now run inside a bounded transient-retry wrapper that journals `cloud.fetch_recovered` (see `packages/agent/src/cloud-retry.js`).

## 2026-07-10 Product-Goal Hardening Proof Ledger

Implemented:

- Active private change sets now hide all draft files from non-owner requesters; team/review visibility exposes shared paths to authorized members/viewers, Main exposes shared paths, and `.private/` remains owner-only.
- Browser text edits now use guarded active-change-set journal commits, preserve Main, retain concurrent different-path writes, and fail with explicit conflicts for stale or unsupported object-backed edits.
- Push-enabled watch/service mode now performs periodic graph-head reconciliation after missed hints, with more explicit connection/fallback/revision status and dashboard recovery guidance. Conservative scheduled cache pruning is opt-in and skips unresolved journal/sync state.
- Device approval can create the account's first project, and the dashboard joins project, local agent, Workspace Root attach, and first-working-set readiness into one checklist.
- The release publisher writes uniquely versioned objects before the mutable manifest pointer; partial-target plans never replace `latest`. The installer validates the exact sidecar/archive pair, hashes the archive directly, smoke-tests it, serializes installers, and atomically switches a launcher to the staged version. Public unsigned publication has no escape hatch; private dogfood uses local `package:hop` artifacts. Repository CI now covers quality, agent, build, and cross-platform packaging gates.

Focused proof commands run from this worktree:

```bash
node --test cloudflare/d1/api-worker.test.js
node --test --test-name-pattern "D1 backend supports scoped sessions|scoped D1 session can commit" packages/agent/test/d1-backend.test.js
node --test packages/agent/test/access-security.test.js packages/agent/test/watch-schedulers.test.js packages/agent/test/remote-push.test.js packages/agent/test/release-channel.test.js packages/agent/test/install-script.test.js
node --test --test-name-pattern "browser D1 file mutations" packages/agent/test/d1-backend.test.js
npx vitest run src/app/device/codebase-options.test.ts
npm run verify
npm run package:hop -- --target all
```

Verified results:

- The Worker security/atomicity command passed `21/21` tests, and the focused scoped-session D1 compatibility command passed `2/2` tests.
- The combined visibility, reconciliation, auto-prune, release-channel, and installer command passed `28/28` tests.
- The focused browser mutation command passed `1/1` test, including Main preservation and concurrent different-path writes.
- The device codebase normalization command passed `2/2` tests.
- The complete verification gate passed: agent `170/170`, web `16/16`, Worker `21/21`, and production-config `2/2`, plus lint, root/core types, agent types, and the production Next.js build.
- Cross-platform packaging passed for all four supported targets: `darwin-arm64`, `darwin-x64`, `linux-arm64`, and `linux-x64`.

Still external or deliberately incomplete:

- Signing, notarization, public privacy/terms pages, and Google OAuth publication were not completed or claimed by this work.
- No R2 release was uploaded; the immutable channel implementation was verified locally and publication remains gated.
- The production push service is deployed/enabled and the workspace scan is clean after the 2026-07-10 manifest heal; a live `push-applied` proof still needs one genuinely remote change (for example a dashboard file edit) delivered over the hub.
- Scoped raw SQL remains a transition boundary and should be replaced with typed Worker operations.

## 2026-07-10 Push-Apply Deadlock Diagnosis And Continuity Guards

The push-blocking "workspace drift" was diagnosed against live production and closed with three fixes plus two data/config repairs.

Diagnosis: a manual `hop sync` on 2026-07-09 committed 24 files to D1 (revision 4412 → 4436, all journal entries acknowledged), but the workspace content manifest is only rebuilt on materialize/refresh/hydrate, and the service restart preserved the pre-sync manifest. The local-changes scan diffs disk against the manifest, so it reported 24 phantom "added" files, which marked the workspace dirty and blocked refresh: the only operation that rebuilds the manifest. Every push apply skipped with `workspace_has_unjournaled_changes` while cloud, journal, and disk were fully consistent.

Implemented:

- `hop service status` trusts a codebase-verified loopback health probe, so launchd-owned services without a pid file report `running: true` (`source: "health-probe"`).
- Refresh and the remote-push decision exonerate scan findings that already match the cloud graph byte-for-byte (kind/hash/size/scope/target) and proceed, rebuilding the manifest; `refresh.complete` reports `manifestSelfHealed`, `manifestStaleSamplePaths` (≤10), and `manifestStalePathCount`. Genuine drift still fails closed, and all event/status payloads keep the compact scan shape (counts plus ≤10 samples).
- `materializeCloudToWorkspace` fails closed before deleting when the visible cloud graph is empty while disk files exist (`visible_graph_empty_local_files_present`) or when a refresh would delete more than 100 files and half the workspace (`refresh_would_mass_delete`); `--allow-mass-delete` overrides. This guards the observed guest/zero-visibility hazard: a device env with `HOPIT_SESSION_ID` but no `HOPIT_REQUESTER_ID` reads zero visible files, and a clean-workspace refresh would have deleted all 4,491 files. `hop doctor` now flags the missing requester identity.
- D1 journal commit paths stamped `files`/`file_versions.zone_id` with a hardcoded `unknown` codebase id; the normalizer now threads the real codebase id (or leaves null for the writer to fill).

Live repairs:

- `scripts/repair-zone-ids.sql` rewrote the 8,865 affected live rows to `<codebaseId>:<zone>`; verified zero `unknown:` rows remain and revision/file counts unchanged.
- `HOPIT_REQUESTER_ID` was added to this Mac's `production.env` (backup kept), restoring owner visibility (4,491 visible / 0 hidden).
- A repo-checkout `hop refresh --profile production` healed the live manifest: `manifestSelfHealed: true`, 24 paths exonerated, 0 written, 0 deleted, unchanged 4,491; the LaunchAgent was restarted and reports a clean scan at revision 4436.

Verified: agent `190/190`, web `16/16`, Worker `21/21`, lint and all typecheck gates clean (commits `0492579`, `2955f8e`, `6a1f7a7`).

Still open from this work:

- The live `push-applied` proof needs one genuinely remote change (dashboard edit) delivered over the hub to the clean workspace.
- The installed packaged runtime predates these commits; repackage/reinstall at the next release so the self-heal and mass-delete guards run in production.

## 2026-07-08 Per-file D1 Journal Commits

This incident fix replaces the D1 agent journal hot path that previously called full `writeGraph` for every acknowledged entry. A single-file commit now persists a bounded guarded batch: optimistic codebase head update, one file row mutation, and one file-version row when the entry changes file state.

Implemented:

- Added D1 client batch support while preserving existing single-statement `query` callers.
- Added a single-entry file-version row builder so journal commits do not diff the whole graph.
- Reworked D1 `commitJournalEntry` to call `applyJournalEntry` first, then persist only the changed path with an optimistic `codebases.revision` guard.
- Guarded file/version statements on the freshly updated codebase revision and timestamp so remote-head races do not partially apply file rows.
- Changed D1 acknowledgements to `storageMode: "d1-file-mutation"`.
- Reworked the agent D1 service to upload only the entry's object blob before metadata commit; fixture JSON commits now append exactly the single entry version row instead of invoking whole-graph history rediff.
- Covered scoped `hst_` session commits and Worker push notification for the new batched statements.

Proof commands:

```bash
node --test packages/agent/test/d1-backend.test.js
node --test cloudflare/d1/api-worker.test.js
npm run agent:test
npm run lint
npm run typecheck
npm run typecheck:agent
node packages/agent/src/cli.js help
```

Result:

- `node --test packages/agent/test/d1-backend.test.js`: passes with 12 tests, 12 passing, and 0 failures.
- `node --test cloudflare/d1/api-worker.test.js`: passes with 10 tests, 10 passing, and 0 failures.
- `npm run agent:test`: passes with 119 tests, 119 passing, and 0 failures.
- A journal write against a 120-file D1 graph records 3 statements for the commit batch and rewrites only the target file row.
- Delete commits remove the file row, advance the head, and write a tombstone `file_versions` row.
- Remote-head races throw `ConflictError` with `selected_state_revision_mismatch` detail and leave file/version rows unchanged.
- Scoped session commits through the Worker are accepted and emit one compact push envelope.

## 2026-07-09 Bulk Chunked Journal Commits

Large first-run imports and mirror backlogs now drain the local safety journal through guarded D1 chunks instead of one HTTP request per file. The per-file path remains unchanged for small edits.

Implemented:

- Added `commitJournalEntries` to the D1 backend. Each chunk sends one `queryBatch` request with one optimistic codebase head update, one guarded file mutation per entry, and one guarded `file_versions` insert per changed file.
- Chose a chunk size of `40`: this keeps a full write chunk to `81` statements while each statement stays under D1's 100-bound-variable limit; a 4,000-file import drops from about 4,000 commit requests to about 100 chunk requests.
- Added the agent threshold constant `20`, so normal small edits keep `storageMode: "d1-file-mutation"` and large drains switch to `storageMode: "d1-bulk-mutation"`.
- Planned sync entries against a shadow graph before committing so bulk journal entries keep sequential selected-state/base revision context without advancing the real cloud state until the guarded chunk succeeds.
- Preserved per-entry `cloud.acknowledged` events and added `sync.bulk_commit` chunk summaries with counts, revisions, paths, scopes, and storage mode.
- Added fixture JSON bulk commits with one JSON write per chunk and matching version rows.
- Kept object-backed entry preparation before an entry's metadata is included in a chunk.
- Verified the Worker push path emits one remote-update envelope per chunk request, not one per file.
- Verified a raced second chunk throws `ConflictError`, acknowledges only earlier chunks, and writes no file/version rows for the failed chunk.

Proof commands:

```bash
node --test packages/agent/test/d1-backend.test.js
node --test cloudflare/d1/api-worker.test.js
npm run agent:test
npm run lint
npm run typecheck
npm run typecheck:agent
node packages/agent/src/cli.js help
```

Current result:

- `node --test packages/agent/test/d1-backend.test.js`: passes with 14 tests, 14 passing, and 0 failures.
- `node --test cloudflare/d1/api-worker.test.js`: passes with 10 tests, 10 passing, and 0 failures.
- `npm run agent:test`: passes with 122 tests, 122 passing, and 0 failures.
- `npm run lint`: passes.
- `npm run typecheck`: passes.
- `npm run typecheck:agent`: passes.
- `node packages/agent/src/cli.js help`: prints the command help successfully.

## 2026-07-08 WS7c Object-Backed Diff History Log

WS7c from [HopIt Remediation Plan: July 2026](remediation-plan-2026-07.md) implements the owner-approved Option 2 model from [WS7c Object-Backed Diff And History Reconstruction Design](ws7c-object-backed-diff-history-design.md): per-file version rows, snapshot reconstruction by latest version at or before a graph revision, and full content-addressed blobs rather than delta chains.

Implemented:

- Added D1 `file_versions` schema and backend setup statements with indexes by codebase/revision/path and codebase/path/revision.
- Added per-file version recording to D1 and fixture JSON graph writes, including tombstones for deletes and old/new file metadata with blob references.
- Added `compareRevisions(leftRevision, rightRevision, requester)` to `@hopit/backend-d1` and equivalent fixture compare support used by the agent.
- Added lazy selected-file body diffing with per-call blob fetch cache, text diff summaries, binary metadata states, `requiresLocalKey` encrypted states, `revision_expired`, `missing_blob`, and integrity-failure handling.
- Added read-only `hop compare --from <revision> --to <revision>` JSON output with `--requester-id`, `--session-id`, and optional `--path` body diff.
- Made `hop storage status` and dry-run-by-default `hop storage gc` retention-aware by retaining blobs referenced by current graph files and retained file-version rows.
- Extended `hop demo` to reset its deterministic demo paths, create revisions 1, 2, and 3, store demo bodies in local object blobs, and print a compare proof for revision 1 to 3 plus a README text diff reconstructed from blobs.

Proof commands run:

```bash
npm run agent:test
node --test --test-concurrency=1 packages/agent/test/agent-cli.test.js
node --test packages/agent/test/d1-backend.test.js
npm run lint
npm run typecheck
npm run typecheck:agent
node packages/agent/src/cli.js help
npm run agent:demo
node packages/agent/src/cli.js demo
node packages/agent/src/cli.js compare --from 1 --to 3 --path README.md --cloud .hopit-agent/demo/cloud.json --workspace .hopit-agent/demo/workspaces/hopit-core --journal .hopit-agent/demo/journal.ndjson --events .hopit-agent/demo/events.ndjson --blob-provider filesystem --blob-root .hopit-agent/demo/blobs --requester-id user_demo_owner
```

Current WS7c test coverage:

- Three-revision demo chain.
- Added, modified, deleted, and unchanged compare counts between revisions 1 and 3.
- Deterministic README text diff reconstructed from object blobs.
- Directory-level compare with zero body fetches.
- Binary change metadata without text body diff.
- Owner-visible `.private/` compare and collaborator-hidden private path names.
- Retention-aware GC keeping blobs referenced only by retained version rows.
- Missing retained blob reported as `missing_blob` without crashing compare.
- D1-side version row recording and `compareRevisions` reconstruction.

Known follow-up:

- Web compare/review UI wiring is intentionally out of scope for WS7c; the dashboard can later call `compareRevisions`/`hop compare` and request selected-file body diffs lazily.
- Production migration is documented in [Personal Production Runbook](personal-production.md), but no live D1 migration was run in this session.

## 2026-07-03 WS6 Frontend Hardening Log

WS6 from [HopIt Remediation Plan: July 2026](remediation-plan-2026-07.md) hardens frontend failure handling, centralizes client API envelope parsing, fixes the command-refresh race, and adds web-focused normalization tests.

Implemented:

- Added Next.js error boundaries at `src/app/global-error.tsx` and `src/app/(app)/error.tsx` using the existing `Card`, `Button`, and `EmptyState` primitives with humanized error text and reset actions.
- Added `src/lib/client/api.ts` as the shared JSON/envelope client for browser-side feature fetches, with humanized `ApiFetchError` details and an opt-in path for routes that intentionally return `{ ok: false }` payloads.
- Migrated codebase mutations, file reads/writes, action jobs, the collaboration client, and the workspace provider to the shared API helper; `rg -n "fetch\\(|response\\.json\\(|\\.json\\(\\)\\.catch|RawEnvelope" src/components src/lib/client src/lib/collaboration.ts` now finds only `src/lib/client/api.ts`.
- Fixed the workspace command completion race by awaiting both `refresh()` and `refreshCodebases()` before `runCommand` returns.
- Split `src/lib/client/agent-status.ts` into `src/lib/client/agent-status/normalize.ts`, `defaults.ts`, `formatters.ts`, `mappers.ts`, and `index.ts` while preserving the existing import surface.
- Added Vitest, `npm run test:web`, and normalization/error-humanization coverage for local-agent payloads, hosted-D1 payloads built from `packages/agent/fixtures/demo-cloud.json`, missing-status fallbacks, `offlineAgentStatus`, and `humanizeApiError`.

Proof commands:

- `npm run test:web`: passes with 1 Vitest file and 9 tests.
- `npm run lint`: passes.
- `npm run typecheck`: passes.
- `npm run typecheck:agent`: passes.
- `npm test`: sandboxed run reaches 75 passing tests and 6 skipped loopback service cases, then the D1 subset fails only on `listen EPERM: operation not permitted 127.0.0.1`.
- `node --test packages/agent/test/d1-backend.test.js`: passes with 6 tests when rerun with loopback permission.
- `npm run build`: passes when rerun with network permission for Next Google Fonts fetches.
- Temporary page-throw verification on `/status`: the in-app browser rendered the `(app)/error.tsx` boundary with "This page hit a snag" and a working reset affordance, then the temporary throw was removed and `/status` rendered the normal Agent page again.

## 2026-07-03 WS5 Auth Hardening Log

WS5 from [HopIt Remediation Plan: July 2026](remediation-plan-2026-07.md) hardens the Cloudflare D1 Worker proxy-token path and makes emergency Basic Auth fallback noisy and explicitly acknowledged in production.

Implemented:

- Replaced direct D1 proxy-token equality checks in `cloudflare/d1/api-worker.js` with a SHA-256 digest comparison and added an in-worker soft failed-auth throttle keyed by client IP.
- Added structured Worker request logging for success and 4xx paths with auth mode, codebase id, statement count, status, and rejected reason while avoiding bearer tokens, SQL text, and SQL params.
- Added `cloudflare/d1/api-worker.test.js` as a Node test harness with mocked D1 bindings for proxy-token auth, scoped session auth, failed-auth throttling, and rejected request logging.
- Added a Basic Auth fallback guard that logs one prominent server-side warning per process when `HOPIT_ALLOW_BASIC_AUTH_FALLBACK=1` is first used.
- Updated `scripts/check-production-config.mjs` so Basic Auth fallback emits a warning and fails Vercel production checks unless `HOPIT_ACKNOWLEDGE_BASIC_AUTH_RISK=1` is also set.
- Updated `src/lib/cloud-backend.ts` to log the missing D1 variables once when partial or explicitly requested D1 config leaves the backend unavailable.
- Added the D1 proxy-token rotation runbook and Cloudflare WAF rate-limit rule spec to [Personal Production Runbook](personal-production.md).

Proof commands:

- `node --test cloudflare/d1/api-worker.test.js`: passes with 4 tests.
- `node --test src/lib/basic-auth-fallback-guard.test.js scripts/check-production-config.test.js`: passes with 3 tests.
- `node --test packages/agent/test/d1-backend.test.js`: passes with 6 tests after the Worker fixture disables request logs for test readability.
- `npm run lint`: passes.
- `npx tsc --noEmit`: passes.
- `npm run build`: passes when rerun with network permission for Next Google Fonts fetches.
- `node packages/agent/src/cli.js help`: passes.
- `npm run agent:test`: rerun with loopback permission reaches 83 passing tests and 4 service-start readiness failures with empty service logs; the failures are in pre-existing service lifecycle tests outside the WS5 files, while the D1 backend subset passes.

## 2026-07-03 WS4 Agent CLI Split Log

WS4 from [HopIt Remediation Plan: July 2026](remediation-plan-2026-07.md) splits the monolithic agent CLI into focused modules while keeping `packages/agent/src/cli.js` as the package/bin entrypoint.

Implemented:

- Replaced the 8,937-line `packages/agent/src/cli.js` with a 78-line dispatcher that keeps command normalization, option parsing, profile/keyring setup, and command routing at the public bin path.
- Extracted object blob stores, the cloud graph service adapters, journal/content helpers, workspace index/cache helpers, watch/remote-pull scheduling, service lifecycle/status serving, command families, options, constants, status readers, path helpers, and help text under `packages/agent/src/`.
- Removed the old `packages/agent/src/crypto.js` compatibility shim; agent modules and the crypto regression test now import the shared helpers from `@hopit/core/crypto` directly.
- Added `// @ts-check` to the extracted agent modules and introduced `tsconfig.agent.json` plus `npm run typecheck:agent` as an incremental checkJs allowlist for low-dynamic modules.
- Verified every extracted agent source file is under 1,000 lines; the largest files after the split are `commands/import.js` at 932 lines and `status-state.js` at 763 lines.
- Left full CLI TypeScript conversion as a follow-up after the checkJs allowlist expands beyond the low-dynamic modules.

Proof commands:

- `node packages/agent/src/cli.js help`: passes.
- `node --test packages/agent/test/agent-cli.test.js`: passes with 73 tests, 67 passing, 6 skipped, and 0 failures. The skipped cases are the expected local service loopback tests in this sandbox.
- `node --test packages/agent/test/crypto.test.js`: passes with 8 tests, 8 passing, and 0 failures.
- `node --test packages/agent/test/d1-backend.test.js`: passes with 6 tests, 6 passing, and 0 failures when rerun with loopback permission after the sandbox blocks `127.0.0.1` listeners.
- `npm run lint`: passes.
- `npm run typecheck`: passes.
- `npm run typecheck:agent`: passes.
- `npm run build`: passes when rerun with network permission for Next Google Fonts fetches.
- `npm run package:hop`: passes and builds `artifacts/hop-darwin-arm64.tar.gz`.
- `artifacts/hop-darwin-arm64/bin/hop help`: passes.

## 2026-07-03 WS3 D1 Backend Split Log

WS3 from [HopIt Remediation Plan: July 2026](remediation-plan-2026-07.md) splits the monolithic `@hopit/backend-d1` implementation into focused modules without changing the package root public API.

Implemented:

- Replaced the 4,773-line `packages/backend-d1/src/index.js` with a small package root that keeps `CloudflareD1HopBackend`, `createD1Backend`, `d1ConfigFromOptions`, `isD1Configured`, `d1CloudServiceType`, and `d1SchemaStatements` exported from the package root.
- Extracted client plumbing, schema setup, graph I/O/status, access filtering, action jobs, members/invitations, collaboration/review/notifications, sessions, key management, and shared helpers into focused modules under `packages/backend-d1/src/`.
- Added JSDoc type-import boundaries from `@hopit/core` in the extracted method modules.
- Kept callers on `@hopit/backend-d1`; no web, CLI, runner, or script import moved to an internal backend path.
- Verified every backend source file is under 800 lines; largest files after the split are `collaboration.js` at 711 lines and `graph.js` at 656 lines.

Proof commands:

- `node --test packages/agent/test/d1-backend.test.js`: passes with 6 tests, 6 passing, 0 failures. A sandboxed first run failed only on loopback `listen EPERM`; rerunning with loopback permission passed.
- `npm run agent:test`: passes with 87 tests, 87 passing, 0 failures.
- `npm run lint`: passes.
- `npm run build`: passes. A sandboxed first run could not fetch Google Fonts; rerunning with network permission passed.
- `npx tsc --noEmit`: passes.
- `node packages/agent/src/cli.js help`: passes.
- `npm run package:hop`: passes and builds `artifacts/hop-darwin-arm64.tar.gz`.
- Temporary scratch imports comparing the pre-split file to `@hopit/backend-d1`: root `Object.keys()` match exactly, and `CloudflareD1HopBackend.prototype` has the same 103 method names before and after.

## 2026-07-03 WS2 Workspaces and Core Package Log

WS2 from [HopIt Remediation Plan: July 2026](remediation-plan-2026-07.md) converts the repo into npm workspaces and extracts shared contracts into package boundaries.

Implemented:

- Added npm workspaces for `packages/*`, plus package manifests for `@hopit/agent`, `@hopit/actions-runner`, `@hopit/core`, and `@hopit/backend-d1`.
- Added `@hopit/core` as a TypeScript package that builds ESM JS and declarations into `dist/`.
- Moved privacy-zone classification into `@hopit/core/privacy-zone`; the CLI, D1 backend, and migration script now import one shared implementation.
- Moved crypto/key-material helpers into `@hopit/core/crypto`; `packages/agent/src/crypto.js` remains as a thin compatibility re-export until the CLI split workstream removes it.
- Added shared graph, journal, change-set, agent status, session, and capability types in `@hopit/core`, and wired the web status normalizer to consume those shared status types.
- Moved the monolithic D1 backend to `@hopit/backend-d1` unchanged in shape, with a broad declaration file for the current pre-WS3 dynamic surface.
- Updated web, CLI, runner, test, and script imports so no `packages/` code imports from `src/`.
- Added build hooks so `npm run agent:test`, `npm run build`, and `npm run package:hop` build `@hopit/core` first.

Proof commands:

- `npm run agent:test`: passes with 87 tests, 87 passing, 0 failures. A sandboxed first run failed only on loopback `listen EPERM`; rerunning with loopback permission passed.
- `npm run lint`: passes.
- `npm run build`: passes. A sandboxed first run could not fetch Google Fonts; rerunning with network permission passed.
- `npx tsc --noEmit`: passes.
- `node packages/agent/src/cli.js help`: passes.
- `npm run package:hop`: passes and builds `artifacts/hop-darwin-arm64.tar.gz`.
- `rg -n "src/lib/d1-backend|@/lib/d1-backend|\\.\\./\\.\\./\\.\\./src/lib/d1-backend|function privacyZoneForPath|function scopeForPath|function zoneIdForPath" packages src scripts --glob '!packages/core/dist/**'`: returns only the shared definitions in `packages/core/src/privacy-zone.ts`.

## 2026-07-03 WS1 Legacy Backend Removal Log

WS1 from [HopIt Remediation Plan: July 2026](remediation-plan-2026-07.md) removes the retired hosted backend implementation while keeping the historical export migration script.

Implemented:

- Deleted the retired backend source directory and generated files.
- Deleted the web helper modules for the old backend auth/client path.
- Reduced `configuredCloudBackend()` to exactly `d1` or `unavailable`; missing or partial D1 config now stays unavailable instead of falling through to another backend.
- Removed the old backend graph service, selection branch, bootstrap-token handling, package dependency, npm scripts, actions-runner fallback, and generated env-template variables.
- Kept `scripts/migrate-convex-export-to-d1.mjs` for saved export rehearsals.
- Updated README, this progress ledger, the production runbook, and `.env.example` so the retired backend appears as history/export only.

Proof commands:

- `node packages/agent/src/cli.js help`: passes.
- `npm run agent:test`: passes with 87 tests, 87 passing, 0 failures. The first sandboxed run failed only on loopback `listen EPERM`; rerunning with loopback permission passed.
- `npm run lint`: passes.
- `npm run build`: passes. The first sandboxed run could not fetch Google Fonts; rerunning with network permission passed.
- `npx tsc --noEmit`: passes.
- `npm run package:hop`: passes and builds `artifacts/hop-darwin-arm64.tar.gz`.
- `artifacts/hop-darwin-arm64/bin/hop help`: passes.
- `grep -rni convex src packages --include="*.ts" --include="*.tsx" --include="*.js"`: returns no matches.
- `rg -n "from ['\"]convex|convex/|anyApi|ConvexHttpClient" scripts/migrate-convex-export-to-d1.mjs package.json package-lock.json src packages scripts`: returns no matches, confirming the migration script has no package import from the retired backend.

## 2026-07-02 Workspace Cache Verification Log

This log records the lazy-materialization/cache work completed after the D1 migration baseline and the verification performed for the full change set.

Implemented:

- Workspace indexes now persist per-path local cache state alongside workspace hydration/cursor state.
- `hop workspace hydrate-path --path <prefix> --recursive` can materialize selected file/folder prefixes without hydrating the whole codebase.
- `hop workspace pin --path <path>` and `hop workspace unpin --path <path>` control whether clean local bodies are allowed to be evicted.
- `hop workspace prune` is dry-run by default, and `hop workspace prune --execute` removes only clean acknowledged cached bodies. Pruned files stay in the cloud graph and are removed from local manifests/hydrated path state so the next sync does not treat them as cloud deletes.
- `hop workspace files` now reports file-level local state from the workspace index, manifest, journal, and disk scan, including hydrated, dirty, pending upload, uploaded, pinned, blocked, cloud-only, and prunable states.
- `hop status` exposes `workspace.cache` and `workspace.files` so the dashboard and local status API can show local/cache health without requiring a full hydrate.
- The local command API now supports file-level hydrate, prune, pin, and unpin actions through `/api/agent/command`.
- The dashboard Files view shows local cache state, local/freeable counters, hydrate/keep/unpin/free-space actions, and the selected file's local status.
- Theme-toggle rendering now uses a stable light/dark fallback before client theme resolution to avoid a hydration mismatch in the app header and command deck.

Verification:

- `node --test packages/agent/test/agent-cli.test.js`: passes with 73 tests, including recursive path hydration, clean-cache prune/no-cloud-delete behavior, pin protection, and the existing production-profile handoff coverage.
- `npm test`: passes with 87 tests total.
- `npm run lint`: passes.
- `npm exec tsc -- --noEmit --pretty false`: passes.
- `npm run build`: passes.
- `git diff --check`: passes.
- Render verification: the in-app Browser loaded `http://localhost:3001/files`
  with dashboard auth disabled, verified the HopIt page title, populated Files
  page, local/freeable counters, search interaction, offline/no-codebase empty
  state, screenshot evidence at `/tmp/hopit-files-page-2026-07-02.png`, and no
  browser console warnings or errors. This dev run did not have a local file
  graph mounted, so file-specific hydrate/free buttons were covered by tests,
  type checks, build, and command-route wiring rather than a live-file visual
  state.

Still open:

- Native read-triggered hydration when a local tool asks for a file body that is still metadata-only.
- Production dogfood and default-policy decisions for the new opt-in automatic pruning scheduler.
- A successful clean-workspace live push apply, plus broader cross-device production verification for the full Workspace Root lifecycle.
- Broader blocked/conflicted UI detail and explicit conflict-resolution actions.

## Executive Progress

| Area | Status | Summary |
| --- | --- | --- |
| Product concept | Done | The repo has converged on cloud-native managed workspaces, active change sets, explicit Main, and `.private/` owner-only workspace scope. |
| Web product shell | Mostly done | The prototype UI polls live local agent state through `/api/agent/status`, maps files/events/revisions/review/merge/conflict/cache state, can read D1 dashboard state when configured, merges local workspace discovery into codebase cards, shows codebase-level workspace/remote-update readiness in the topology cards, and can run first-run Workspace Root setup/attach, hydrate/dehydrate, and file-level hydrate/pin/free-space actions through the local agent. |
| HopIt Workspace Root | In progress | Production-profile paths, a root-level workspace index, per-path local cache state, D1 account-visible codebase discovery when credentials allow it, scoped-token configured-codebase fallback, automatic verified-owner bootstrap for migrated `local-owner` codebases, local attach/readiness summaries, metadata-only attach, dashboard setup/attach/hydrate/dehydrate actions, `workspace open`, hydration/materialized revision state, metadata-only/dehydrate, single-file and recursive-prefix hydrate, sibling hydrate opt-in, explicit pin/unpin, clean-cache prune, explicit metadata-first lazy materialization policy, and a remote cursor are in place; true read-triggered hydration remains deferred to native filesystem-provider research. |
| Local managed-folder agent | Done for spike | The agent proves hydration, journaling, sync acknowledgement, recovery, watch startup gating, safe refresh, status, and same-owner continuity. |
| Lazy materialization | In progress | `workspace attach`, `workspace open`, `workspace files`, `workspace hydrate-file`, `workspace hydrate-file --with-siblings`, `workspace hydrate-path --recursive`, safe full hydrate through `refresh`, `workspace pin|unpin`, dry-run-by-default `workspace prune`, opt-in scheduled pruning, dashboard file cache controls, and `workspace dehydrate --force` prove metadata-first attach, open-time first-working-set hydration, metadata listing, path-level hydration, explicit full materialization, clean local-body eviction, and metadata-only/partial/materialized state. V1 still needs native provider-backed read-triggered hydration and pruning-policy dogfood. |
| Vercel/D1 production baseline | Active dogfood | Vercel hosts the protected dashboard and Clerk sign-in routing is live. The D1 database/env/seeding sequence is complete, `hopit-d1-api` proxies D1 for Vercel, hosted D1 reads can skip schema re-checks with `HOPIT_D1_ASSUME_SCHEMA=1`, hosted status reads are cached/coalesced and the hosted client polls less often to protect the free D1 budget, `hopit.dev` live API smoke checks pass, and the packaged LaunchAgent reports D1 cloud status with push enabled. Push/pull service mode uses a lightweight five-minute periodic graph-head reconciliation; the long-standing push block was diagnosed on 2026-07-10 as a stale content manifest rather than real drift and healed, and a live `push-applied` proof landed on 2026-07-11 (second device synced revision 4436 → 4437, applied over the hub ~8s later). |
| D1 cloud graph | In progress | D1 now has schema, HTTP API backend, agent service integration, hosted status/codebase/file/account/action-job/member/invite/key-grant routes, automatic verified-owner bootstrap for `local-owner` migrations, account-visible codebase heads with actor access summaries, scoped-token configured-codebase fallback, actions-runner support, scoped D1 proxy session auth, scoped agent sessions, device key/user keyring/wrapped key metadata, historical export migration script, and D1 graph/collaboration/session/key round-trip tests. History reconstruction, retention policy, and full product write-path coverage remain to port or complete. |
| Historical hosted graph export | Done | The retired export backup is retained under `/Users/robert/HopIt-Backups/convex/` as a migration/recovery source; the backend implementation was removed by WS1. |
| Object blob storage | Mostly done | The agent has an S3-compatible blob provider boundary, Cloudflare R2 env contract, Backblaze B2-compatible migration path, filesystem-backed tests, metadata-only D1 commits, hash-verified hydrate/refresh/export, client-encrypted secret-object metadata, and dry-run-by-default storage GC. The live `hopit-blobs` R2 bucket exists, scoped local R2 credentials are configured for that bucket only, and read/write/hydrate/delete smoke coverage exists. Personal use keeps R2 free-only with an 8 GB cap and public access disabled; the 1-day auto-delete lifecycle rule was removed on 2026-07-08 so stored blobs persist durably (verified: no object-backed rows existed while the rule was active). Production retention policy and storage tier decisions remain. |
| `.private/` model | Done for spike | `.private/` files are synced/versioned and classified as owner-private; they are not ignored or skipped. Routed `.private/env/` secrets remain local-only by default, and sync only when object storage plus the legacy local key or `hop keys` user-vault bridge are configured so raw secret bytes never go to D1/R2. |
| Privacy/encryption key model | In progress | The end-to-end plan is documented; agent crypto/envelope helpers now cover file envelopes, X25519 device wraps, user-vault unwrap, and encrypted recovery export; `hop keys` can create/status/export local keyrings; file entries carry derived privacy-zone metadata; D1 has key-management tables and first device/keyring/wrapped-key APIs; the dashboard can show redacted trusted-device and wrapped-key grant status; plaintext secret-zone files are rejected. Repo/private/secret zone keys, full private-repo file encryption, invite-time grants, independent secret grants, dashboard approval/recovery, revocation/rekey, and private path metadata remain. |
| Safety journal | Done for spike | Pending, acknowledged, and failed entries are derived from journal/events and exposed through status. |
| Watch loop | Done for spike | Watch startup runs recovery before hydration, blocks unsafe recovery, and syncs later editor writes. Service start waits for the watcher and status server to be ready before reporting success. |
| Fixture cloud graph service boundary | Done | Commands now use a fixture-backed service boundary instead of direct command-level cloud JSON access. |
| Main/change-set/owner/session/visibility contract | Done for fixture | The fixture graph and status surface include these identities and visibility fields. |
| Same-owner two-session continuity | Done for spike | Device/session B can refresh acknowledged shared and `.private/` changes from device/session A. |
| Automatic remote-update delivery | In progress | Remote-update events, explicit safe refresh, per-workspace materialization cursors, opt-in remote pull/push, five-minute periodic graph-head reconciliation, one-shot `hop remote-pull`, and the deployed Cloudflare Durable Object WebSocket hub/D1 notify path exist. Status exposes connection/fallback/revision/skip detail. A successful clean-workspace live apply, default policy, and broader production verification remain. |
| Collaborator visibility simulation | Done for fixture | Tests prove private change sets hide non-owner content, team/review-visible change sets expose non-private paths, and `.private/` remains owner-only. |
| Remote-update events | Done for spike | Refresh emits first-class `remote-update` events and status exposes the latest update. |
| Review and merge | Done for fixture | Fixture commands open the selected active change set for review, merge it into Main, emit review/merge events, and expose review/merge state through status. |
| Conflict handling | Done for fixture | Stale selected-state, file/base, and Main revisions become reviewable conflict state. |
| Packaging | Mostly done | The current packager builds macOS/Linux `x64`/`arm64` tarballs with an embedded Node runtime, verifies help plus production-profile status, ships a production env example, and includes user-level launchd/systemd support scripts. |
| Installer/daemon hygiene | In progress | Manual service start, supervised `service run`, env-file install templates, production config checks, scoped-token rotation runbook, backup/export roots, read-only observability endpoints, packaged runtime install, and the current macOS LaunchAgent are documented. `hop service status` now trusts a codebase-verified loopback health probe, so direct launchd-owned `service run` installs without a pid file report running. Native signed installers, notarization, and tray UX remain. |
| Git compatibility | In progress | Safe export/publish now creates clean Git repos while omitting `.private/` from publish, but ancestry preservation and remote publishing are still not started. |
| Real accounts/auth | In progress | The repo now has Clerk sign-in routes, middleware, `/api/me`, provider-token forwarding, owner email config, and D1-backed account sync. The production Clerk instance, DNS, SSL, Vercel live env, `HOPIT_AUTH_PROVIDER=clerk`, production Google OAuth, owner sign-in, and D1 owner claim are active for `hopit.dev`; Basic Auth fallback is no longer needed for production owner access. |
| Permissions and invitations | In progress | Durable memberships, invitation tables, requester-aware dashboard filtering, owner claim, member management, invite create/accept/revoke UI, and scoped agent-session token groundwork are in place; complete permission coverage remains. |
| Code browsing and reviews | In progress | The dashboard now has a read-only code-review browser slice and object-backed compare/history wired through to real UI. As of 2026-07-12 the compare page renders live trail-step directory compares and unified per-file diffs from the WS7c engine (via `/api/codebases/compare`), and the desktop app's Trail expands the same real diffs: so diff UI is no longer pending. Snapshot-anchored inline review comments and richer routeable history remain. The issues, discussions, project-board, and release surfaces were removed from scope in July 2026. |
| Native mount/FUSE/RAM-only cache | Later | Explicitly not the first v1 implementation path. Revisit only after the managed-folder Workspace Root proves core value. |

## Milestone Tracker

### Milestone 1: Product Shell

Status: `Mostly done`

Goal: Build the logged-in product surface around codebases, files, active change sets, connected devices, sync state, collaborators, visibility, and recent activity, while removing GitHub-social concepts from the first prototype.

Completed:

- Product direction is documented in [MVP Plan](mvp-plan.md).
- Core concepts are named: codebase, Main, active change set, managed workspace folder, HopIt agent, local cache, safety journal, workspace snapshot, workspace visibility, change-set visibility, and cloud file graph.
- The app surface exists under `src/app` and `src/components/hopit`.
- The app surface consumes `/api/agent/status` through `useAgentStatus`, maps live local status/events/cloud data into the dashboard, and falls back to offline state when the agent is unavailable.
- The status API can read either the local status server or the D1 dashboard query, depending on environment configuration.
- The command API exposes whitelisted local sync, refresh, recover, review, merge, first-run Workspace Root setup, and Workspace Root attach actions for the prototype UI.
- GitHub-social concepts are documented as non-goals for v1.
- `.private/` is documented as owner-visible, snapshotted, synced, and versioned.
- Change-set visibility resolution order is documented: per-change-set override, codebase override, global user default, product default.

Current evidence:

- `npm run lint` passes.
- The product plan and README consistently describe the same product model.
- The app has local-agent and D1 status adapters through `/api/agent/status` and the client status mapper.

Remaining:

- Add richer UI affordances for uncertain, degraded, retrying, remote-update, review, merge, and conflict detail.
- Keep the UI mapper aligned as the local status server and D1 dashboard shape evolve.
- Add production authentication and permission-aware command handling before exposing commands outside the local prototype.

Risks:

- The UI can drift if its mapper lags behind the local status server or D1 dashboard contract.
- Visibility UI should not imply `.private/` is an ignore mechanism.

Next product-shell step:

- Harden the live UI/D1 status contract around Workspace Root, hydration state, automatic remote-update state, storage mode, scoped device auth, and GitHub-like review/history surfaces.

### Milestone 2: Agent Managed-Folder Spike

Status: `Done`

Goal: Create a local agent that materializes a tiny cloud-backed file tree into a normal managed folder, hydrates from the cloud file graph, captures writes, and proves normal editor save behavior.

Completed:

- `packages/agent` implements the managed-folder spike.
- `npm run agent:init` seeds the local fixture cloud graph.
- `npm run agent:hydrate` materializes cloud files into the managed workspace.
- `npm run agent:demo` runs init, hydrate, simulated editor saves, sync, and verification.
- `npm run agent:sync` runs one explicit scan, journal, and acknowledgement pass.
- The managed folder is a normal OS folder, not a FUSE mount or user-managed clone.
- `.private/` paths are materialized and synced with owner-private scope.

Current evidence:

- `npm run agent:test` passes.
- Test coverage includes shared and `.private/` write classification.
- The demo verifies cloud acknowledgement for both shared and owner-private edits.

Contract details currently proven:

- File scope values:
  - `shared`
  - `owner-private`
- Important event names:
  - `cloud.initialized`
  - `file.hydrated`
  - `workspace.ready`
  - `write.journaled`
  - `cloud.acknowledged`
  - `sync.started`
  - `sync.complete`
  - `demo.editor_saved`
  - `demo.verified`
- Important commands:
  - `agent:init`
  - `agent:hydrate`
  - `agent:demo`
  - `agent:sync`
  - `agent:status`
  - `agent:serve`

Remaining:

- Add rename/move support.
- Add cache pruning rules after clean acknowledged content is proven safe to evict.

Risks:

- Current sync scans the whole workspace and is fine for a spike, but will need bounded/incremental behavior later.
- Large repo behavior is intentionally unproven.

### Milestone 3: Recovery And Watch Loop

Status: `Done for spike`

Goal: Treat the safety journal as the durable recovery boundary for writes awaiting cloud acknowledgement, and make `watch` the primary continuous-agent proof path.

Completed:

- `npm run agent:recover` replays unacknowledged journal entries.
- `npm run agent:watch` runs recovery before hydration.
- Watch startup blocks when unacknowledged entries cannot be recovered safely.
- Failed recovery entries stay visible through status.
- Pending, failed, and acknowledged journal states are derived from the journal/events pair.
- `.private/` scope is preserved during recovery.
- Watch-triggered sync attempts are coalesced.
- Transient sync failures emit `sync.failed`, and later success can emit recovered state.
- Watch tests were hardened so the full suite no longer flakes on slower process scheduling.

Current evidence:

- `npm run agent:test` passes all recovery and watch-loop tests.
- Recovery tests cover shared and owner-private pending writes.
- Unsafe recovery test proves watch startup blocks before hydration overwrites local edits.

Important event names:

- `journal.recovery_failed`
- `journal.recovery_complete`
- `watch.started`
- `watch.recovery_blocked`
- `watch.degraded`
- `sync.failed`
- `sync.recovered`

Important status fields:

- `journal.pendingCount`
- `journal.failedCount`
- `journal.acknowledgedCount`
- `journal.pendingScopeCounts`
- `journal.failedScopeCounts`
- `journal.acknowledgedScopeCounts`
- `sync.state`
- `refresh.state`
- `watch.state`

Remaining:

- Add `uncertain` journal state for cases where cloud acknowledgement may have happened but cannot be confirmed.
- Add retry classification so failed entries can distinguish retryable from terminal failures.
- Add more explicit degraded-state tests for transient filesystem and cloud failures after watch startup.

Risks:

- The watch loop is still a managed-folder proof, not a production sync engine.
- Recursive filesystem watch behavior can differ by platform; polling fallback exists, but cross-platform coverage is not complete.

### Milestone 4: Cloud Service Boundary

Status: `Done for fixture`

Goal: Replace command-level local cloud JSON access with a service-shaped file graph boundary while keeping fixture-backed demos and tests.

Completed:

- Commands now call a fixture-backed cloud graph service.
- Commands can target D1 with `--cloud-backend d1`, and the web app can read the D1 dashboard query for hosted status.
- The service exposes graph initialization, graph reads, graph writes, optional graph reads, existence checks, and journal-entry application.
- The local persistence file is still JSON, but command code no longer treats that JSON file as the product API.
- D1 persists codebase graph metadata, files, and agent events for the current cloud-backed prototype.
- The fixture graph now includes:
  - `schemaVersion`
  - `codebase.id`
  - `codebase.name`
  - `codebase.ownerId`
  - `main.id`
  - `main.revision`
  - `selectedState.type`
  - `selectedState.id`
  - `selectedState.ownerId`
  - `selectedState.baseMainId`
  - `selectedState.baseRevision`
  - `selectedState.revision`
  - `selectedState.visibility`
  - `selectedState.effectiveVisibility`
  - `owner.id`
  - `session.id`
  - `session.deviceName`
  - `visibility.productDefault`
  - `visibility.globalUserDefault`
  - `visibility.codebaseOverride`
  - `visibility.changeSetOverride`
  - `visibility.effective`
- Status now exposes top-level product-contract fields:
  - `codebaseId`
  - `codebaseName`
  - `selectedStateType`
  - `activeChangeSetId`
  - `mainId`
  - `ownerId`
  - `sessionId`
  - `effectiveChangeSetVisibility`
- New journal entries carry:
  - `targetStateType`
  - `targetStateId`
  - `ownerId`
  - `sessionId`
  - `effectiveChangeSetVisibility`
- Cloud acknowledgements include selected-state identity and selected-state revision.
- Acknowledged writes advance `selectedState.revision`, while `main.revision` stays stable.
- Older/simple graph fixtures are normalized into the newer contract shape on read/write.

Current evidence:

- `npm run agent:test` passes.
- Tests assert fixture contract fields exist.
- Tests assert new journal entries include target state and identity fields.
- Tests assert Main stays stable while the selected active change set advances.
- `npm run lint` passes.

Remaining:

- Move service code out of the CLI file once it grows beyond the current spike size.
- Add a formal graph schema or TypeScript types before integrating a real API.
- Add validation failures and explicit cloud error simulation.
- Add content-addressed blob storage abstraction.
- Add snapshot reconstruction for Main and active change sets.

Risks:

- The fixture service is a boundary, not yet a distributed service.
- JSON read/write is still single-process and not safe for real concurrent writers.
- The graph shape is now explicit but not yet enforced by a schema validator.

### Milestone 5: Two-Session Continuity

Status: `Mostly done`

Goal: Open the same codebase and active change set from a second same-owner device/session and see acknowledged writes without merging to Main.

Completed:

- Two-session test state uses one shared cloud graph and separate workspace, journal, and event paths per device/session.
- Device/session A can edit and sync a shared file.
- Device/session B can safely refresh and see the acknowledged shared file update.
- Device/session A can edit and sync a `.private/` file.
- Device/session B, as the same owner simulation, can safely refresh and see the owner-private file update.
- Refresh refuses to overwrite device B files when device B has pending or failed journal entries.
- Refresh emits `remote-update` when local files are written or deleted from cloud state.
- Remote-update events include selected state, from/to revisions, changed paths, deleted paths, changed/deleted scope counts, requester context, and hidden scope counts.
- Status exposes the latest remote update.
- The fixture graph includes a permitted collaborator identity.
- Visibility-filtered hydrate, refresh, and status reads can run with `--requester-id` and `--session-id`.
- A collaborator sees no active change-set files when visibility is private.
- A collaborator sees shared files when visibility is `team-visible` or `review-visible`.
- `.private/` stays owner-only in private, team-visible, and review-visible modes.
- Collaborator refresh refuses to overwrite pending local edits.

Current evidence:

- `npm run agent:test` passes two-session shared refresh tests.
- `npm run agent:test` passes same-owner `.private/` refresh tests.
- `npm run agent:test` passes same-owner remote-update event assertions for shared and `.private/` updates.
- `npm run agent:test` passes collaborator remote-update assertions that expose shared paths while only reporting hidden `.private` scope counts.
- `npm run agent:test` passes refresh-blocking tests for pending and failed device B journal entries.
- `npm run agent:test` passes requester visibility tests for owner, collaborator/private, collaborator/team-visible, collaborator/review-visible, and collaborator pending refresh.

Remaining:

- Use remote-update events to drive the web app or tray/menu status.
- Add remote-update behavior for future push-style live updates, not only explicit refresh.

Risks:

- This milestone's collaborator filtering proof is fixture-backed; the hosted D1 path now has requester-aware filtering, but complete authenticated permission enforcement is tracked in the permissions milestones.
- The fixture graph is still flattened around one selected active change set, so private collaborator reads show an empty file set rather than falling back to a separate Main snapshot.

Next two-session step:

- Use the review/merge graph contract as the boundary for conflict handling while preserving the same remote-update and visibility evidence.

### Milestone 6: Review And Merge

Status: `Done for fixture`

Goal: Let a user open an active change set for review and merge a reviewed change set into Main while preserving visibility metadata.

Completed:

- Main and selected active change-set identities exist in the fixture graph.
- Acknowledged writes advance the active change set rather than Main.
- Review state is represented on the selected active change set.
- The selected active change set can be opened for review with an explicit agent command.
- The selected active change set can be merged into Main with an explicit agent command.
- Main remains stable while the active change set syncs and advances only on explicit merge.
- Review and merge operations emit `change_set.review_opened` and `change_set.merged`.
- Status exposes review and merge state for the selected active change set and Main.

Current evidence:

- Tests assert `main.revision` stays stable while `selectedState.revision` advances.
- `npm run agent:test` covers review open, merge, status state, event emission, and Main revision advancement only on merge.

Remaining:

- Add merge records/history.

Risks:

- Merge records are still fixture metadata rather than durable history.

### Milestone 7: Git Compatibility

Status: `In progress`

Goal: Import an existing Git repository into the cloud file graph, export a workspace snapshot to a Git commit, and publish accepted Main or merged snapshots as Git history when requested.

Completed:

- Git is documented as compatibility/import/export/publish infrastructure, not the everyday continuity model.
- GitHub-social concepts are documented as non-goals for v1.
- `hop export` creates a clean Git repo from the selected graph state and omits `.private/` by default.
- `hop publish` requires the selected active change set to be reviewed and merged, creates a clean Git repo, and always omits `.private/`.
- Export/publish refuse to write inside or around the managed workspace.

Current evidence:

- Product docs consistently separate Git compatibility from live active change sets.
- `npm run agent:test` covers export, explicit owner-private export, publish gating, `.private/` omission, workspace-output refusal, and validation rejection for scope mismatches.

Remaining:

- Import Git tree into cloud file graph.
- Preserve commit ancestry where possible.
- Export a historical selected snapshot as a Git commit once snapshot indexes exist.
- Push or publish Main/merged snapshots to a remote Git host.
- Decide the long-term owner-private Git export UX separately from restorable agent-state backups.

Risks:

- Publishing must not leak `.private/` content.
- Git compatibility can pull the product back toward branch/worktree concepts if the UX is not kept strict.

### Future Optional: Native Mount Research

Status: `Later`

Goal: Explore true OS filesystem mounts, macFUSE, or RAM-only working sets only after the managed-folder product proves core value.

Completed:

- Documented as a non-goal for v1.
- Managed-folder mode is the current default.

Remaining:

- None for current MVP.

Risks:

- This can become a distraction before the sync/product contract is proven.

## Detailed Contract Tracker

### Commands

| Command | Status | Purpose | Current proof |
| --- | --- | --- | --- |
| `npm run agent:demo` | Done | Runs deterministic init, hydrate, edit, sync, verify flow. | Demo path covered indirectly by agent behavior tests. |
| `npm run agent:init` | Done | Seeds fixture cloud graph. | Contract fields asserted in tests. |
| `npm run agent:hydrate` | Done | Materializes graph files into workspace. | Used across tests. |
| `npm run agent:sync` | Done | Scans workspace, journals writes, acknowledges to selected state. | Shared/private sync tests. |
| `npm run agent:recover` | Done | Replays unacknowledged journal entries. | Recovery tests. |
| `npm run agent:watch` | Done for spike | Runs recovery-before-hydration and watches for local edits. | Watch-loop tests. |
| `npm run agent:refresh` | Done for spike | Safely mirrors selected cloud state into workspace when journal is clean. | Two-session and refresh-block tests. |
| `npm run agent:status` | Done for spike | Prints one-shot read-only local status JSON. | Status fields asserted through CLI status command. |
| `npm run agent:serve` | Done for spike | Serves read-only local state over HTTP. | Used by the live web app through `/api/agent/status`. |
| `npm run agent:status-server` | Done for spike | Explicit alias for the HTTP status server. | Same CLI target as `hop serve`. |
| `npm run agent:review` | Done for fixture | Opens the selected active change set for review. | Review-open tests. |
| `npm run agent:merge` | Done for fixture | Merges the selected active change set into Main. | Merge tests. |

### Event Names

| Event | Status | Notes |
| --- | --- | --- |
| `cloud.initialized` | Done | Includes service type, contract summary, file count, scope counts. |
| `cloud.exists` | Done | Emitted when init sees an existing cloud graph without `--force`. |
| `file.hydrated` | Done | Emitted for hydrated files. |
| `workspace.ready` | Done | Includes service type and contract summary. |
| `write.journaled` | Done | New entries include target state and identity context. |
| `cloud.acknowledged` | Done | Includes selected-state identity and revision. |
| `sync.started` | Done | Used for sync health. |
| `sync.complete` | Done | Includes service type, contract summary, revisions, and scope counts. |
| `sync.failed` | Done for spike | Captures sync failures and status state. |
| `sync.recovered` | Done for spike | Captures successful sync after unresolved failure. |
| `journal.recovery_failed` | Done | Marks failed recovery entries. |
| `journal.recovery_complete` | Done | Summarizes recovery attempts, acknowledgements, failures, revision, and scope counts. |
| `watch.started` | Done | Marks continuous watch as active. |
| `watch.recovery_blocked` | Done | Marks unsafe startup recovery failure. |
| `watch.degraded` | Done for spike | Used for polling fallback/unavailable states. |
| `refresh.started` | Done | Marks safe refresh attempt. |
| `refresh.blocked` | Done | Blocks refresh with pending/failed journal entries. |
| `refresh.complete` | Done | Summarizes written/deleted/unchanged/file counts. |
| `remote-update` | Done for spike | Emitted when refresh writes/deletes local files from cloud state. |
| `change_set.visibility_changed` | Not started | Needed for future user-driven visibility changes. |
| `change_set.review_opened` | Done for fixture | Emitted when the selected active change set is opened for review. |
| `change_set.merged` | Done for fixture | Emitted when the reviewed selected active change set is merged into Main. |
| `change_set.conflict_detected` | Done for fixture | Emitted when stale selected-state, file/base, or Main revisions are detected. |
| `cache.evicted` | Done for explicit prune | Emitted by `hop workspace prune --execute` after clean acknowledged local cached bodies are removed. |
| `connection.changed` | Not started | Needed for online/offline/retry state. |

### Status Fields

| Field | Status | Notes |
| --- | --- | --- |
| `ok` | Done | False when journal/sync/refresh/watch health is unsafe. |
| `mode.adapter` | Done | Currently `managed-folder`. |
| `mode.cacheMode` | Done | Currently `local-cache`. |
| `codebaseId` | Done | Top-level product status field. |
| `codebaseName` | Done | Top-level product status field. |
| `selectedStateType` | Done | Currently `active-change-set` in fixture. |
| `activeChangeSetId` | Done | Set when selected state is an active change set. |
| `mainId` | Done | Top-level Main identity. |
| `ownerId` | Done | Top-level owner identity. |
| `sessionId` | Done | Top-level local session identity. |
| `requesterId` | Done | Requester identity for visibility-filtered reads. |
| `requesterSessionId` | Done | Requester session identity for visibility-filtered reads. |
| `requesterRole` | Done | Fixture role: owner, member, or guest. |
| `visibleFileCount` | Done | Count of files visible to the requester. |
| `hiddenFileCount` | Done | Count of files hidden from the requester. |
| `hiddenScopeCounts` | Done | Scope counts for hidden files without exposing hidden paths. |
| `effectiveChangeSetVisibility` | Done | Top-level visibility field. |
| `workspace.path` | Done | Absolute workspace path. |
| `workspace.exists` | Done | Whether workspace exists locally. |
| `cloud.service` | Done | Currently `fixture-json-cloud-graph`. |
| `cloud.schemaVersion` | Done | Current fixture uses schema version 2. |
| `cloud.codebase` | Done | Includes id/name/ownerId. |
| `cloud.main` | Done | Includes id/revision. |
| `cloud.selectedState` | Done | Includes active change-set identity, base Main, revision, and visibility. |
| `cloud.owner` | Done | Includes owner id. |
| `cloud.session` | Done | Includes session id/device name. |
| `cloud.requester` | Done | Includes requester id, session id, role, ownership/collaborator flags, visibility, and visible/hidden counts. |
| `cloud.visibility` | Done | Includes defaults, overrides, and effective value. |
| `journal.*Counts` | Done | Pending/failed/acknowledged totals and scope counts. |
| `sync.state` | Done | `idle`, `syncing`, `healthy`, or `failed`. |
| `refresh.state` | Done | `idle`, `refreshing`, `healthy`, or `blocked`. |
| `remoteUpdate.state` | Done | `idle` or `updated` depending on whether a remote update has been observed. |
| `remoteUpdate.lastUpdate` | Done | Latest `remote-update` event for UI/tray evidence. |
| `watch.state` | Done | `unknown`, `watching`, `blocked`, or degraded states. |
| `recent error summary` | Mostly done | Exposed through sync/refresh/watch `lastError`; can be consolidated later. |
| `connectivity state` | Not started | Needs service connectivity simulation. |
| `cache size` | Not started | Needs cache accounting. |
| `remote update state` | Done for spike | Latest remote-update event is available through status. |
| `review state` | Done for fixture | Exposes whether the selected active change set is open for review. |
| `merge state` | Done for fixture | Exposes whether the selected active change set has been merged into Main and the latest merge event. |
| `conflict state` | Done for fixture | Exposes stale revision conflicts as reviewable selected change-set state. |

### Graph Contract

| Contract field | Status | Notes |
| --- | --- | --- |
| `schemaVersion` | Done | Version 2 fixture graph. |
| `codebase.id` | Done | Fixture: `hopit-core`. |
| `codebase.name` | Done | Fixture: `hopit-core`. |
| `codebase.ownerId` | Done | Fixture owner identity. |
| `main.id` | Done | Fixture: `main`. |
| `main.revision` | Done | Stable while active change set changes. |
| `selectedState.type` | Done | Fixture: `active-change-set`. |
| `selectedState.id` | Done | Fixture: `cs_demo_active`. |
| `selectedState.ownerId` | Done | Fixture owner identity. |
| `selectedState.baseMainId` | Done | Fixture: `main`. |
| `selectedState.baseRevision` | Done | Fixture base revision. |
| `selectedState.revision` | Done | Advances on acknowledged writes. |
| `selectedState.visibility` | Done | Fixture: `private`. |
| `selectedState.effectiveVisibility` | Done | Fixture: `private`. |
| `selectedState.reviewState` | Done for fixture | `not-open`, `open`, or `merged`. |
| `selectedState.mergeState` | Done for fixture | `unmerged` or `merged`. |
| `selectedState.conflictState` | Done for fixture | `none` or `conflicted`. |
| `selectedState.review` | Done for fixture | Review metadata for the selected active change set. |
| `selectedState.merge` | Done for fixture | Merge metadata including previous and resulting Main revisions. |
| `selectedState.conflict` | Done for fixture | Conflict metadata for stale file/base or Main revision mismatches. |
| `owner.id` | Done | Fixture owner identity. |
| `collaborators[]` | Done | Fixture permitted collaborator identities and roles. |
| `session.id` | Done | Fixture local session identity. |
| `session.deviceName` | Done | Fixture device label. |
| `visibility.productDefault` | Done | Fixture: `private`. |
| `visibility.globalUserDefault` | Done | Nullable. |
| `visibility.codebaseOverride` | Done | Nullable. |
| `visibility.changeSetOverride` | Done | Nullable. |
| `visibility.effective` | Done | Resolved effective visibility. |
| file `content` | Done | Inline for fixture/dev fallback; object-backed production entries keep body bytes outside D1. |
| file `hash` | Done | Computed from raw bytes. |
| file `size` | Done | Raw byte size. |
| file `scope` | Done | Derived from path; `.private/` becomes owner-private. |
| file `revision` | Done | Updated on acknowledged write. |
| content-addressed blob refs | Mostly done | Agent sync can store file bodies in S3-compatible object storage and persist provider/key/hash metadata. |
| snapshot indexes | Not started | Needed for review/merge/export. |
| merge records | Not started | Needed for review/merge. |

## Immediate Next Queue

The next major phase is a solid v1 workspace, not collaboration alone. The v1 sequence is: HopIt Workspace Root and hydration-state contract, object-backed content-addressed storage with per-file revision guards, privacy/encryption key grants, production-grade automatic remote-update delivery, scoped device/session auth, and GitHub-like web surfaces. The collaboration track is documented in [GitHub-Lite Collaboration Plan](github-lite-collaboration-plan.md), the privacy/security track is documented in [HopIt Privacy And Encryption Plan](privacy-encryption-plan.md), and the sub-plans remain [Auth And Collaboration Plan](auth-collaboration-plan.md) and [Code Browsing, Review, Comments, And History Plan](review-code-browser-plan.md).

Domain-dependent infrastructure is now configured and active: `hopit.dev` routes to Vercel, Clerk production DNS/SSL are verified, Vercel has the redacted `pk_live_`/`sk_live_` values, Vercel Production uses `HOPIT_AUTH_PROVIDER=clerk`, production Google OAuth is configured for the owner test user while the Google app stays in Testing mode, the seeded owner has been claimed by the real Clerk user in D1, and Basic Auth fallback env vars have been removed from Vercel Production. Continue building Workspace Root, storage, remote-update, permission checks, collaboration data, code browsing, review/history, and scoped agent-session hardening behind Clerk auth.

### 0. HopIt Workspace Root And Lazy Materialization

Status: `In progress`

Definition of done:

- Persist a user-selected Workspace Root outside the source checkout.
- List cloud codebases under that root without requiring manual clone/import per device.
- Track per-codebase hydration state: metadata-only, partial, hydrated, dirty, blocked, conflicted, and clean.
- Materialize file bodies safely on workspace open, policy prefetch, remote update, or supported demand-hydration path.
- Keep pending local writes protected by the safety journal before any cache pruning or remote refresh.
- Surface Workspace Root, codebase folder state, hydration state, and cache state through `hop status`, the service API, and the web dashboard.

Current foundation:

- Production-profile service paths already separate agent state from the source checkout.
- The agent can hydrate a selected codebase into `/Users/robert/HopIt Workspaces/hopit`.
- `hop workspace discover` lists the configured visible cloud codebase plus indexed local workspaces.
- `hop workspace attach` binds the configured cloud codebase into the Workspace Root as metadata-only without downloading file bodies.
- `hop workspace files` lists visible cloud file metadata with local states such as cloud-only, hydrated, dirty, pending-upload, uploaded, pinned, blocked, and prunable.
- `hop workspace hydrate-file --path <path>` materializes a single visible file and records partial hydration.
- `hop workspace hydrate-path --path <prefix> --recursive` materializes visible files under a folder prefix without hydrating the whole codebase.
- `hop workspace pin|unpin --path <path>` controls whether a hydrated file should stay local.
- `hop workspace prune --path <path> --execute` removes only clean acknowledged cached bodies, updates the hydrated path manifest, and does not become a cloud delete on the next sync.
- The dashboard can run first-run Workspace Root setup, attach metadata-only codebases, hydrate an attached codebase through the safe refresh path, show file-level local cache states, hydrate/pin/free selected files, and dehydrate clean cached file bodies back to metadata-only state.
- `hop workspace dehydrate --force` removes clean cached bodies, writes `.hopit/metadata.json`, and records metadata-only hydration state.
- The workspace mode now reports a metadata-first materialization policy: attach stays metadata-only, full local content requires explicit hydrate/refresh, single files can be hydrated explicitly, and automatic remote-pull only applies to clean fully materialized workspaces.
- Status exposes the managed workspace path, cache mode, materialization policy, visible file count, journal state, remote-update state, and backend.
- The dashboard labels the current path as a Workspace Root preview rather than a true ghost/native mount.

### 0.5. Content-Addressed Storage And Revision Guards

Status: `In progress`

Definition of done:

- Store file metadata separately from content.
- Store file content by hash/blob id instead of inline-only file rows.
- Replace whole-graph save semantics with file-level mutations for D1 agent journal commits.
- Require base revision or known cloud revision for each write.
- Return explicit conflict state on stale revisions.
- Keep snapshot reconstruction possible for Main, active change sets, review, merge, export, and publish.

Current foundation:

- D1 stores graph metadata, file rows, object-blob references, hashes, sizes, revisions, and agent events for the new free-first path.
- Production agent sync should upload file bytes to S3-compatible object storage before committing metadata with revision guards.
- The local fixture validates graph shape and detects stale selected-state/file/Main revisions.
- Bootstrap/import can still replace the graph as an admin operation; per-file D1 journal commits, per-file version history reconstruction, and retention-aware object GC now exist for the agent/D1 path, while production retention policy and non-agent product write paths remain.

### 0.6. Privacy, Encryption, And Key Grants

Status: `In progress`

Definition of done:

- Classify every path into an explicit privacy zone before sync.
- Encrypt all private/shared-private repo file bytes before object upload.
- Keep repo content, `.private/`, `.private/env/`, Git internals, and public
  snapshots under separate keys and sharing rules.
- Store trusted device public keys, user vault key wraps, repo/private/secret
  keyrings, wrapped grants, and key audit events.
- Make invitation acceptance grant normal repo content only, with `.private/`
  and secrets unshared by default.
- Add explicit secret-group grant/revoke/rotate flows.
- Require device approval or recovery before a new device can decrypt existing
  private data.
- Move private repos toward encrypted path manifests and keyed path ids.

Current foundation:

- `.private/` is already classified as owner-private.
- `.private/env/` stays local-only unless encrypted secret sync is configured.
- The agent can upload routed secrets as client-encrypted object blobs with the
  current local key bridge.
- Object blob metadata can carry encrypted-payload metadata.
- `@hopit/core/crypto` owns key decoding, privacy-zone classification,
  AES-GCM envelope encrypt/decrypt, X25519 device key wrapping, user-vault
  unwrap, PBKDF2 recovery export, blob wrap/unwrap, and envelope validation for
  the current secret-sync bridge.
- File metadata now carries a derived `privacyZone`; D1 rows carry the
  associated privacy zone metadata.
- D1 schema includes first-pass `privacyZones`, `deviceKeys`,
  `userKeyrings`, `codebaseKeyrings`, `wrappedKeys`, and `keyAuditEvents`
  tables, plus first APIs to register/list device keys, ensure user/codebase
  keyrings, create/list/revoke wrapped keys, and write key audit events.
- `hop keys init-device`, `hop keys status`, and `hop keys export-recovery`
  create a local per-codebase device keyring, keep the user vault key
  self-wrapped, register public device/wrapped vault metadata in D1 when
  production credentials are available, and write encrypted recovery exports.
- Local and D1 graph validation reject plaintext `.private/env/**` file
  entries unless they are encrypted object-backed content.
- Requester-aware reads can hide `.private/` from non-owner requesters.
- Clerk auth, durable memberships, invitations, and scoped agent sessions are
  available as the permission layer that key grants will build on.
- The full implementation plan is [HopIt Privacy And Encryption Plan](privacy-encryption-plan.md).

### 0.75. Automatic Remote-Update Delivery

Status: `In progress`

Definition of done:

- Store a remote event cursor per device, codebase, and selected state.
- Receive cloud updates through push/subscription delivery or a bounded polling loop.
- Apply safe refresh automatically when the local journal is clean.
- Block and expose conflict/dirty state when local pending, failed, or uncertain writes exist.
- Preserve `.private/` visibility and requester filtering during remote updates.
- Show applied, unchanged, blocked, and failed remote-update states in the dashboard.

Current foundation:

- Explicit `hop refresh` is safe and refuses pending or failed journal state and unjournaled local workspace drift.
- Refresh emits `remote-update` events and status exposes the latest remote update.
- Same-owner two-service simulation proves sequential handoff: device A syncs through the watcher, device B receives through explicit safe refresh.
- The current worktree includes opt-in `--remote-pull` support for `watch` and `service start`, plus `hop remote-pull` for a deterministic one-shot safe refresh attempt. Remote pull remains activity-triggered when enabled, and both pull- or push-enabled service modes run a periodic graph-head reconciliation at the configured cadence.
- Remote-pull checks the codebase-level graph head before full graph refresh, so unchanged activity-triggered checks do not repeatedly read all file metadata from the graph backend.
- The production-profile same-Mac dogfood test uses two isolated state/workspace roots against one fixture graph and covers metadata-only dehydrate, single-file hydrate, refresh fallback, one-shot remote-pull apply, unchanged cursor skip before dirty scanning, and dirty-state blocking after a remote move without requiring loopback service access.
- WS7a Stage 1 adds opt-in `--remote-push` / `HOPIT_REMOTE_PUSH=1` agent transport against a compact NDJSON hint stream. The client connects with codebase/state/device cursor context, treats envelopes as hints, calls the same safe remote-refresh decision path as `remote-pull`, reconnects with exponential backoff, and runs a fallback head check after reconnect.
- Status now exposes `remotePush` state and events for `push-connected`, `push-disconnected`, `push-fallback-polling`, `push-skipped`, and `push-applied`, including last event id, pushed revision, applied revision, and current skip/failure reason.
- Status and the dashboard now separate socket connection, fallback state, pushed/applied revisions, current skip reason, and recovery guidance. A missed push hint or reconnect gap can converge through the periodic head check without requiring another local edit.
- Fixture tests cover clean apply, pending-journal skip, manifest-drift skip, duplicate idempotence, out-of-order convergence, reconnect fallback catch-up, metadata-only no-body hydration, and same-owner/collaborator `.private/` visibility.
- The production push hub is deployed and the installed agent has push enabled. The long-standing push skip was diagnosed on 2026-07-10 as a stale content manifest rather than real drift and healed, so the workspace is scan-clean; the clean-workspace live `push-applied` proof landed on 2026-07-11 (a second isolated device synced revision 4436 → 4437 and the production service applied it over the hub via trigger `remote-push`, ~8s later, event `evt_hopit_4437_...`).

### 0.9. Installer, Daemon, And Production Hygiene

Status: `In progress`

Definition of done:

- Ship a standalone command that does not require Node or npm on the target machine.
- Provide a user-level start-on-login path for macOS and Linux.
- Keep service credentials in a local env file outside the repo.
- Preserve manual `service start/status/stop/restart` for debugging.
- Provide a supervised foreground `service run` mode for launchd/systemd.
- Document restorable agent-state backup, owner-private Git export, publishable export, and scoped token rotation.
- Make production config checks fail on unsafe path layouts, bad local-agent URLs, invalid remote-pull cooldowns, token reuse, placeholders, and malformed session capabilities.
- Expose enough status/events/journal evidence to diagnose service health before cross-device handoff.

Current foundation:

- `scripts/package-hop.mjs` builds a standalone tarball with embedded Node, env example, and launchd/systemd user-service support scripts.
- `hop service run` is available for supervisors; `service start` still owns pid-file/manual daemon mode.
- `hop service run` stays alive until a stop signal, so manual `service start` does not return success and then let the child exit.
- `service start` now carries scoped session-token env into the spawned child when passed through CLI options.
- The HTTP status server keeps `/status` lightweight, serves `/cloud` as a graph-only dashboard endpoint, and uses the pid file as the primary ownership signal for `service status`, falling back to a codebase-verified loopback health probe so pid-file-less launchd `service run` installs still report running.
- `npm run hop:service:*`, `hop:backup`, `hop:private-export`, `hop:export`, and `hop:publish` wrap production-profile operations.
- `docs/personal-production.md` covers install, login startup, observability, backup/export, and token rotation.
- `scripts/check-production-config.mjs` performs stricter personal-production hygiene checks without printing secrets.
- The dashboard and device-approval flow now join first-project creation, local-agent connection, Workspace Root attach, and bounded first-working-set hydration into one explicit checklist.
- Automatic cache pruning is opt-in through `--auto-prune` / `HOPIT_AUTO_PRUNE=1`, defaults to a six-hour schedule and seven-day inactivity threshold, and skips when sync or the journal is unresolved while preserving pinned and non-clean content through the existing prune contract.
- `.github/workflows/ci.yml` runs lint, web/Worker/config tests, TypeScript checks, and the production build on Ubuntu, plus agent tests and standalone packaging on Ubuntu and macOS. `npm run verify` and `npm run verify:release` provide the local equivalents.

### 1. Real Accounts And Auth

Status: `In progress`

Definition of done:

- Hosted dashboard uses real user sign-in instead of product-level Basic Auth.
- D1 user-facing queries and mutations resolve the requester to a durable user id.
- Local agent service tokens remain separate from human user identity.
- Docs cover provider setup, production env vars, local dev, and recovery.

Current foundation:

- D1 schema now includes durable user/account metadata.
- D1 exposes account sync and owner-claim entrypoints.
- The Next app includes Clerk provider wrapping, sign-in/sign-up pages, protected middleware, `/api/me`, and server-side Clerk-to-D1 account sync.
- The hosted dashboard has provider-auth code, production Clerk infrastructure, production Google OAuth, owner sign-in, and D1 owner mapping verified; Basic Auth fallback is now emergency-only and should stay unset in production.

### 1.5. Scoped Device And Session Auth

Status: `In progress`

Definition of done:

- Issue revocable device/session credentials scoped to one user and allowed codebases.
- Keep local service credentials separate from human dashboard identity.
- Enforce scoped actor permissions on every agent read/write path.
- Support token rotation, revocation, and recovery without deleting the local workspace.

Current foundation:

- D1 schema includes `agent_sessions` with token hashes, token prefixes, capabilities, expiry, revocation metadata, and codebase scope.
- D1 can register, list, touch, and revoke agent sessions.
- D1 graph reads, per-file mutations, and agent event appends accept scoped `sessionToken` credentials.
- The CLI exposes `hop device` / `hop session` for status, registration, listing, touch, and revocation.
- Normal installed-device operation can use `HOPIT_AGENT_SESSION_TOKEN`.
- Access helpers distinguish service-token actors from user actors.
- The current broad agent token remains a personal-production bridge and should not be treated as final v1 security.

### 2. Multi-User Permissions And Invitations

Status: `In progress`

Definition of done:

- Add durable users, memberships, roles, and invitations.
- Enforce server-side role checks for codebase reads, review/merge actions, member management, and future issue/release writes.
- Add invite creation, acceptance, expiry, and revocation.
- Preserve `.private/` owner-only semantics independently from role-based codebase access.

Current foundation:

- D1 schema now includes `codebase_members`, `codebase_invitations`, and `agent_sessions`.
- `saveGraph` seeds owner/collaborator membership rows from the graph during the bootstrap phase.
- Owner claim, member list, suspend/remove, and invitation create/accept/revoke mutations exist, including duplicate pending-invite checks and verified-email acceptance.
- The dashboard can filter visible graph files by requester role, with token-only reads still treated as the current owner bridge for personal dogfooding.
- The dashboard has member/invite UI for owner claim, member list, pending invites, invite creation, invite acceptance, revocation, suspension, and removal.

### 3. Web Code Browser

Status: `In progress`

Definition of done:

- Browse folders and files from the configured cloud graph.
- Show visible file contents, revision, size, hash, scope, and path metadata.
- Hide owner-private paths from non-owner requesters.
- Add routeable file selection and safe large-file fallbacks.

Current foundation:

- The status mapper now carries capped content previews for visible files.
- The dashboard renders a read-only `CodeReviewSection` with file search, scope/status filters, file selection, metadata, content preview, line anchors, review readiness, and history signals.
- Routeable file browsing, syntax highlighting, large-file fallbacks, and dedicated file-read queries are still pending.

### 4. Diffs, Reviews, Comments, And History

Status: `In progress`

Definition of done:

- Add durable change-set, review, comment, and merge-history records.
- Show diffs between Main and active change sets.
- Support inline comments and resolved review threads.
- Gate review/merge mutations by authenticated permissions.

Current foundation:

- The UI now surfaces current review, merge, conflict, file, and event state together.
- A real diff API now exists and is wired to UI: `/api/codebases/compare` and `hop compare` reconstruct object-backed directory and per-file line diffs, the dashboard compare page and the desktop Trail render them (2026-07-12). Durable review/comment/merge-history records are still pending.

### 5. Issues, Projects, Discussions, And Releases

Status: `Removed from scope`

The issue, project-board, discussion, and product-release surfaces were removed in the July 2026 scope simplification: their D1 tables, backend functions, API routes, and dashboard UI no longer exist. A redesigned version of these surfaces is deferred to roadmap Phase 4+.

The separate agent distribution channel is unaffected by this removal. It publishes versioned archives, checksums, and a schema-v2 manifest under immutable keys before uploading `latest/manifest.json` as the only mutable pointer. The installer resolves one immutable version, requires direct SHA-256 verification of the named archive, smoke-tests the downloaded runtime, and atomically activates a versioned runtime under an installer lock. Public unsigned publication is blocked; private dogfood uses local package artifacts. Signed/notarized bundles and native installers remain pending.

### Later: Deeper Git Replacement Work

Status: `Later`

Definition of done:

- Import Git history into the cloud file graph.
- Preserve ancestry and historical snapshots.
- Add remote Git publish and rollback.
- Eventually design immutable/content-addressed history, clone/fetch/push equivalents, tags, releases, and offline-first sync.

### July 2026 WS7 Remediation Gate

Status: `Design complete; adversarial tests added; WS7a Stage 2 implemented locally`

Definition of done:

- Write the WS7a push remote-update delivery design before implementation.
- Write the WS7b demand hydration design before implementation.
- Write the WS7c object-backed diff/history reconstruction design before implementation.
- Add WS7d hostile cross-device fixture coverage so the sync engine either converges or surfaces conflicts instead of silently losing work.

Current foundation:

- [WS7a Push Remote-Update Delivery Design](ws7a-push-remote-update-design.md) selects Durable Objects plus WebSocket hibernation as the preferred push path, preserves the existing safe refresh decision gate, and keeps head-cursor polling as fallback.
- [WS7b Demand Hydration Design](ws7b-demand-hydration-design.md) chooses open-time and intent-driven hydration for v1, rejects source-code placeholder files for the managed-folder adapter, and defers true read-triggered hydration to native filesystem-provider research.
- [WS7c Object-Backed Diff And History Reconstruction Design](ws7c-object-backed-diff-history-design.md) defines per-file object-backed version rows, retention-aware storage GC, lazy blob fetches for compare views, and fixture demo acceptance criteria.
- `packages/agent/test/agent-cli.test.js` now covers same-file two-device conflict preservation, crash-left pending journal recovery, skewed mtime/clock behavior, watch-mode sync racing refresh, and object-storage budget exhaustion.
- WS7a Stage 1 implements the agent-side push client plus local fake push hub tests.
- WS7a Stage 2 implements the Cloudflare Durable Object WebSocket fan-out hub, D1-route notify-after-commit wiring, Worker auth-gated WebSocket routing, Wrangler Durable Object config, and agent WebSocket transport selection. It was not deployed at this gate and has since been deployed to personal production.
- WS7b implements open-time and intent-driven demand hydration for managed folders: `hop workspace open`, bounded metadata-driven open plans, sibling hydration opt-in, last-open status, missing-key/blocked-path reporting, and collaborator-safe visibility filtering.

Proof command:

```bash
node --test --test-name-pattern "adversarial|crash-left|skewed|racing refresh|storage budget failure" packages/agent/test/agent-cli.test.js
```

WS7c implementation remains intentionally gated on owner approval of the design doc. WS7a Stage 2 was local-only at this gate; it has since been deployed to personal production, with a successful clean-workspace live apply still awaiting proof.

### 2026-07-08 WS7a Stage 1: Agent Push Delivery

Implemented:

- Added an opt-in agent-side push client behind `--remote-push` / `HOPIT_REMOTE_PUSH=1` and `--remote-push-url` / `HOPIT_REMOTE_PUSH_URL`.
- The Stage 1 transport consumes compact `codebase.remote_update` NDJSON envelopes with codebase id, selected state id, revision, event id, changed paths, and scope counts only. Envelopes are treated as hints and never carry file bytes.
- Push delivery reuses the existing `remoteRefreshDecision` safety path before calling `refreshWorkspace`, so pending journals, failed recovery state, metadata-only or partial hydration, and unjournaled manifest drift still block materialization.
- The client records `remote-push.started`, `connected`, `disconnected`, `fallback_polling`, `skipped`, `applied`, and `failed` events. Status exposes these as `remotePush` with last event id, last pushed revision, last applied revision, and last skip/failure reason.
- Reconnect uses exponential backoff and runs one fallback head-cursor refresh decision after reconnect to catch missed events.
- Added a loopback-only stdlib fake push hub in `packages/agent/test/remote-push.test.js`.

Proof commands:

```bash
node --test packages/agent/test/remote-push.test.js
```

Deferred to Stage 2:

- Cloudflare Durable Object/WebSocket hub.
- D1 mutation route notification after commit.
- Production push rollout/default policy beyond the opt-in agent flag.

### 2026-07-08 WS7a Stage 2: Cloudflare Push Hub And WebSocket Transport

Implemented:

- Added `cloudflare/d1/push-hub.js` with `CodebasePushHub`, one Durable Object hub per codebase, hibernating WebSocket acceptance through `state.acceptWebSocket`, compact cursor storage, stale-cursor catch-up, validated `codebase.remote_update` envelopes, and fan-out through `state.getWebSockets()`.
- Extended `cloudflare/d1/api-worker.js` so authenticated WebSocket upgrades route to `HOPIT_PUSH_HUB.idFromName(codebaseId)` and scoped session/proxy-token auth stays mandatory. The same token can be supplied as Bearer auth or an `access_token`/`token` query param for WebSocket clients.
- Added best-effort notify-after-commit wiring for successful graph-state mutations against `codebases`, `files`, or `file_blobs`. The worker reads the compact D1 head/file summary, sends it to the codebase Durable Object, and logs notify failures without failing the committed mutation.
- Extended `packages/agent/src/remote-push.js` to select transport by URL scheme: `ws://`/`wss://` use Node's global WebSocket, while `http://`/`https://` keep the Stage 1 NDJSON stream. Both transports share envelope validation, safe refresh decisions, reconnect/backoff, and reconnect fallback polling.
- Updated `cloudflare/d1/wrangler.proxy.jsonc` with `HOPIT_PUSH_HUB` and a `new_sqlite_classes` Durable Object migration.
- Added Worker/DO tests with mocked hibernation APIs and agent WebSocket tests using a small stdlib RFC 6455 loopback server.

Proof commands:

```bash
node --test cloudflare/d1/api-worker.test.js
node --test packages/agent/test/remote-push.test.js
npm run agent:test
npm run lint
npm run typecheck
npm run typecheck:agent
node packages/agent/src/cli.js help
```

Follow-up:

- Owner-side Cloudflare deployment is now complete. The installed service reports push enabled, but a successful clean-workspace live same-owner apply remains to be verified.
- Default enabling policy remains opt-in through `--remote-push` / `HOPIT_REMOTE_PUSH=1`.

### 2026-07-08 WS7b: Open-Time And Intent-Driven Demand Hydration

Implemented:

- Added `hop workspace open`, which records `workspace.opened`, gates open-time hydration on a clean journal plus clean content manifest, and emits/persists `workspace.open_hydration.applied`, `partial`, or `skipped` results.
- Open-time plans are computed from the visibility-filtered cloud graph metadata only. The priority order is root docs/package/config files, recently changed active-change-set files, pinned paths, then small files under common source roots.
- Added bounded open budgets with defaults of 64 files and 1 MiB, plus a 64 KiB small-source-file ceiling. CLI overrides are `--open-max-files`, `--open-max-bytes`, and `--open-small-file-bytes`.
- Added `hop workspace hydrate-file --with-siblings`, behind an explicit flag, with defaults of 8 files and 128 KiB for same-folder source-root sibling hydration.
- Shared path hydration now records per-path skipped and blocked outcomes so one missing blob or missing decryption key blocks only that path. Already hydrated clean files are skipped without re-fetching.
- `hop status` and the status server expose `workspace.openHydration` with planned paths, hydrated paths, skipped paths, blocked paths, bytes hydrated, budget reason, and state. Hydration state continues to distinguish `metadata-only`, `partial`, and `materialized`.
- The local command API allowlist now includes `openWorkspace` mapped to `workspace open`; no dashboard UI was added in this session.
- Added eight fixture-backed acceptance tests covering metadata-only open hydration, pending-journal skip, unjournaled-drift skip, sibling/prefix hydration and sync delete safety, clean reopen no-refetch, pinned paths, missing secret-zone decryption key, and collaborator `.private/` redaction.

Proof commands:

```bash
node --test --test-name-pattern "workspace open|hydrate-file with siblings|pinned paths|collaborator workspace open|reopening a clean workspace" packages/agent/test/agent-cli.test.js
node --test --test-name-pattern "workspace files and hydrate-file|workspace hydrate-path|metadata-only workspaces|workspace prune|workspace pin" packages/agent/test/agent-cli.test.js
npm run typecheck:agent
```

Deferred:

- True read-triggered hydration remains deferred until HopIt chooses a native filesystem provider such as macOS File Provider, FSKit, or FUSE. The v1 managed-folder adapter does not create source-code placeholder files and cannot intercept arbitrary OS reads.
- Editor-specific signals, production dogfood of the opt-in pruning policy, and production rollout of open-time hydration remain follow-up work.

### 2026-07-13 Phase 3: isolated staging rehearsal

Completed against isolated infrastructure with `HOPIT_MULTITENANT=1`,
`HOPIT_ENFORCE_QUOTA=1`, and `HOPIT_BILLING=1`:

- Deployed a protected Vercel preview at `hopit-phase3-staging.vercel.app`, a
  dedicated `hopit-staging` D1 database, `hopit-blobs-staging` R2 bucket, and
  `hopit-d1-api-staging` Worker. Production flags, schema, Clerk signup, and
  deployment were not changed.
- Created a brand-new Clerk staging user with no owner allowlist and no card.
  The first Free project succeeded; the second was rejected with the honest
  `1/1` upgrade wall.
- Fixed two failures found only by the real rehearsal: a server actor could not
  create its first not-yet-entitled codebase, and a fresh device authorization
  did not hand the agent the public R2 broker configuration. New-codebase creation
  is now limited to one plain actor-owned insert, and connected setup persists
  `HOPIT_BLOB_PROVIDER=r2`, broker mode, and the non-secret tenant prefix without
  persisting bucket credentials.
- Fixed scoped device/key registration so `device_keys` and `user_keyrings` are
  constrained to the authenticated session user, while wrapped-key operations
  remain codebase constrained. A real device, user keyring, and device-wrapped
  user-vault key registered successfully through the scoped session.
- Proved browser-to-device authorization, local attach, WebSocket connection,
  one-shot sync, inline D1 storage, and brokered R2 storage. The R2 object's
  remote SHA-256 matched its local descriptor, while the client environment held
  no D1 admin token and no R2 access key or secret.
- Proved live isolation with the real tenant session and a temporary victim
  tenant: foreign SQL parameters, a foreign codebase session header, and a
  foreign R2 key prefix all returned `403`; the victim fixture was removed.
- Proved the Free daily-write cap at exactly `2,000/2,000`: the write failed with
  `quota_exceeded_daily`, cloud data and the meter did not change, reads/status
  remained available, and the local journal retained the edit. Restoring the
  original staging meter replayed the same edit successfully and emitted
  `sync.recovered`.
- Completed Stripe Managed Payments sandbox checkout for Plus, including the
  signed webhook changing the authoritative tenant plan to `paid`. The same
  second-project create then succeeded. Canceled the test subscription with a
  test-key and `livemode=false` guard; the deletion webhook restored Free while
  preserving both projects and all files, and a third project was blocked.
- Staging schema provisioning required the base `cloudflare/d1/schema.sql` plus
  the additive `device_authorizations` migrations from
  `packages/backend-d1/src/schema.js`. Future rehearsals must apply both rather
  than assuming the base schema is the complete migration history.

Remaining before a production flag flip: configure production billing/webhook
secrets and schema deliberately, review public legal pages, open Clerk signup,
and repeat the checklist against the intended go-live environment. Monitor the
20,000-row paid allowance during the first 30–60 days of real usage as already
decided.

### 2026-07-13 Phase 3: production launch preparation

- Added an unauthenticated HopIt homepage plus public privacy and terms pages at
  `/`, `/privacy`, and `/terms`. The signed-in dashboard moved to `/overview`,
  and unauthenticated access to `/overview` still redirects through Clerk.
- Backed up production D1 before migration to
  `/Users/robert/HopIt-Backups/d1/hopit-production-pre-phase3-20260713.sql.gz`
  (compressed SHA-256
  `a19b39a6839df2826c825d249679a72ac1d479a05c8cd73b364e3baccd67fedc`),
  then applied the idempotent Phase 3 schema. Existing codebase and file counts
  were unchanged.
- Backfilled the production tenant meter from the current logical file graph so
  quota enforcement starts from real stored bytes rather than zero.
- Fixed current-storage accounting before the production flag flip: replacing a
  file now meters only its trusted net size change, and deleting a file releases
  its current size. Deletes remain available at the daily-write cap so an
  over-limit tenant can free space without losing read or export access.
- Enabled multi-tenant isolation, quota enforcement, the R2 broker, and the
  tenant blob prefix on the production Worker. The production dashboard received
  the matching server-actor and broker configuration; billing remains separately
  gated until the durable live Stripe key and webhook secret are installed.
- The production configuration checker now permits the intentional 9.5 GB R2
  personal-production ceiling while preserving 500 MB of the current 10 GB free
  storage allowance as headroom.
- Full verification passed after the changes: agent `315`, web `146`, Worker
  `74`, configuration `2`, desktop `124`, TypeScript, lint, and the production
  Next.js build. The packaged production agent doctor also passed with a clean
  journal, current workspace, requester identity, and running service.

This preparation checkpoint was completed by the production launch and
no-charge rehearsal below. The only intentionally unexecuted billing proof is a
real paid subscription; the rehearsal stopped at live Checkout before card entry
or charge.

### 2026-07-14 Phase 3: production launch and no-charge rehearsal

- Deployed production Vercel release `dpl_3sA6MnsvWgPBa42SKAt7X4t9Uuba`, now
  aliased to `https://hopit.dev`. `/`, `/privacy`, and `/terms` return `200`,
  while signed-in application routes still redirect signed-out visitors through
  Clerk.
- Installed the durable live Stripe restricted key and signature-verifying
  webhook secret in Vercel, enabled billing with the exact value
  `HOPIT_BILLING=1`, and repaired `HOPIT_D1_ASSUME_SCHEMA` to the exact value
  `1`. No secret value is recorded in this repository. Stripe's public support
  and legal details now point to `support@hopit.dev`, `https://hopit.dev`,
  `/privacy`, and `/terms`.
- Published the Google OAuth consent app (`In production`) and disabled Clerk's
  production allowlist. A brand-new public user completed Turnstile plus email
  verification, was auto-provisioned as a Free tenant, created its first project,
  and saw the second project rejected at the honest `1/1` upgrade wall.
- Opened live Plus Checkout and verified the `US$10/month` price plus the required
  Terms and Privacy consent links. No card was entered, Subscribe was not clicked,
  and no charge or live subscription was created.
- Installed the literal public one-liner into a clean temporary home. It resolved
  the official R2 `latest` channel to runtime `0.0.1+aa7a923`, completed scoped
  browser device approval for only the rehearsal project, attached a clean
  metadata-first workspace, and started on port `4795` because the owner's
  existing personal service legitimately owns `4785`.
- The first production write exposed a released-runtime compatibility defect:
  the current Worker required the stronger selected-state/Main compare-and-swap
  predicates that the published runtime's legacy guarded head did not send. The
  journal retained the edit with no data loss. Worker version
  `5bab8479-c12e-4a0f-9705-57539b548d86` now validates the legacy request against
  the current codebase head and upgrades it to the stronger atomic guard before
  execution; attempts to change Main or selected-state security fields are
  rejected. The canonical current client path remains unchanged.
- Replayed the retained journal entry successfully, then wrote a second proof file
  through the direct unproxied watcher path. Final live status: `ok=true`,
  `readiness=ready`, `cloudflare-d1-graph`, cloud revision `2`, two visible cloud
  files, two acknowledged journal entries, zero pending, zero failed,
  `sync=healthy`, and `watch=watching`.
- Repository verification passed after the compatibility fix: full agent, web,
  Worker (`77/77`), configuration, TypeScript, lint, and production Next.js build
  gates are green. Continue monitoring the paid plan's 20,000-row daily allowance
  during the first 30–60 days of real usage before treating it as permanently
  sufficient.

### 2026-07-14 owner service operations console

- Added an owner-only `/admin` control room backed by a typed Worker endpoint,
  not the arbitrary-SQL proxy. Both the Next route and Worker independently
  require the signed-in, verified `HOPIT_OWNER_EMAIL` account.
- The live view polls every 30 seconds and surfaces tenant plan mix, storage and
  daily-write pressure at 50/80/100%, active sync sessions, recent sync/action
  events, billing/webhook state, gross MRR, modeled provider/storage/write costs,
  and the 50% at-cap margin floor for both paid plans.
- Safe service controls can pause/resume a tenant's storage-growing cloud writes,
  revoke a device session, and run Stripe entitlement reconciliation. Pausing
  never blocks reads, exports, local journals, or deletes that free storage;
  billing remains the only source allowed to grant a paid entitlement.
- Added durable `tenant_controls` and `service_admin_events` tables. Every owner
  control requires target confirmation and is recorded in the service audit trail.
- Verification: full `npm run verify` passed (agent 315, web 149, Worker 82,
  config 2, TypeScript, lint, optimized Next build) and desktop 124/124 passed.

### 2026-07-14 comprehensive service control plane

- Expanded `/admin` into six focused views: Overview, Tenants, Billing, Fleet &
  Sync, Infrastructure, and Audit. The Worker now returns repository inventory,
  account growth windows, full safe session/device/pairing metadata, hosted
  action state, Stripe webhook history, keyring/rotation health, invitation
  state, subscription provider ids, and recent sync detail without returning
  credentials, key material, approval codes, or raw action output.
- Added tenant drill-down and redacted snapshot export. Live runtime cards expose
  feature/config presence, deployment commit/region, plan ceilings, and provider
  links while secret values remain server-only.
- Added confirmation-gated, durably audited controls for revoking every tenant
  session, revoking a trusted device plus its linked sessions/pairings, expiring
  pending device setup, canceling a queued hosted action, retrying a failed
  hosted action, and setting or clearing Stripe end-of-period cancellation.
  Stripe subscription ids are resolved server-side from the tenant record, and
  billing reconciliation runs after every renewal change.
- Hardened the control plane after review: renewal changes now reject omitted or
  non-boolean cancellation state; billing reconciliation requires confirmation,
  continues tenant-by-tenant, and returns exact failures; committed mutations
  remain successful when the follow-up dashboard read fails; aggregate totals no
  longer inherit detail-list caps; bounded collections disclose their shown and
  total counts; billing health distinguishes configured, recently verified, and
  stale verification; expired sessions are excluded from the active-device list;
  and hosted-action cancellation uses the existing `cancelled` status vocabulary.
- Verification: full `npm run verify` passed (agent 315, web 156, Worker 87,
  config 2, TypeScript, lint, optimized Next build) and desktop 124/124 passed.

### 2026-07-23 production-readiness hardening

- CI cost controls: the macOS DMG job (10x-billed minutes) now runs only on
  `workflow_dispatch` or `v*` tags, cross-platform packaging is main-push-only,
  and docs-only pushes skip CI. Context: the GitHub Actions spending budget was
  exhausted around 2026-07-12 and every run since was refused before starting;
  the budget itself must be raised in the GitHub billing settings.
- Fixed a shipping defect in packaged artifacts: the packager copied the demo
  fixture to `app/fixtures/` while the bundled CLI resolves it at the release
  root, so `hop init` and `hop demo` failed out of the box on every platform.
  `verifyHostRelease` now runs the full offline demo flow against the built
  artifact so this class of bug fails the build. The artifact manifest's
  recorded fixture path was corrected to match.
- Linux agent parity check (roadmap Phase 1) run on the packaged `linux-x64`
  artifact: init/hydrate/edit/sync/status/review/merge/export/publish/doctor,
  systemd support scripts, XDG state paths, and case-sensitive materialization
  all pass. The only defect found was the fixture-path bug above.
- New `hop restore` command: verify-only by default (manifest schema, per-file
  sha256/bytes integrity, cloud.json/manifest consistency, ndjson parse checks,
  restorable-with-content vs hash-only vs missing categorization), and
  `--workspace <dir> --execute` offline materialization from `cloud.json` with
  non-empty-target refusal, `--force` override, `.private/` restoration, and a
  written restore-report.json. Object-backed bodies (`contentStorage:
  'object-blob'`) are not in a backup: restore reports them with hash/blobKey
  instead of writing placeholders. Proven by `packages/agent/test/restore.test.js`.
- New `hop version` / `--version`: prints the version from the packaged release
  manifest (with build target) or the repo package.json in dev checkouts.
- `scripts/package-hop-dmg.mjs` now lazy-imports `appdmg`, so the DMG and
  release-channel test suites run (and pass) on Linux instead of failing at
  import time; macOS coverage is unchanged.
- Dependency security: `next` moved to 16.2.11 (newest stable; the open Next.js
  advisories, including a middleware-bypass class, have no patched stable 16.x
  release yet - watch for a 16.2.x patch or 16.3.0 stable), `sharp` to 0.35.3
  (libvips CVEs), `@clerk/nextjs` to 7.5.22. A broader `npm update` of the
  remaining within-range minors was attempted and reverted: something in that
  batch breaks the production build during page-data collection
  (`TypeError: e.createContext is not a function`); left for a future bisect.
- Verification on the final tree: lint, typecheck, typecheck:agent green; agent
  suite 328 pass / 0 fail (5 known sandbox-only socket cancellations); web 211,
  worker 87, config 3, desktop 132 all green; production build green;
  `package:hop` verified including the new demo-flow check.

### 2026-07-23 scope simplification: work items, discussions, project boards, and releases removed

- Removed the work-item (issue), discussion, project-board, and product-release
  surfaces from the product: their backend methods and D1 tables are deleted,
  the Worker allowlist is trimmed to match, and the hosted API route and
  dashboard UI for those objects no longer exist.
- Review threads, review decisions, and notifications are kept. The review page
  no longer offers a "File follow-up issue" action.
- The `release` session capability string is kept for released-agent
  compatibility, and the separate `hop` CLI packaging/release-channel
  distribution path is unaffected.
- A redesigned version of these surfaces is deferred to roadmap Phase 4+.

## Known Gaps

- Phase 3 billing plumbing is live behind `HOPIT_BILLING`: Stripe Managed
  Payments hosted Checkout, customer portal, signature-verified/idempotent webhook,
  D1 `subscriptions` + webhook-event ledger, daily reconciliation, the `/pricing`
  upgrade surface, and distinct 30 GB / 100 GB paid quota profiles. Web/worker/agent
  suites are green. The live HopIt Stripe account is activated and the two live
  monthly products now exist at $10 and $15 with Stripe's SaaS business-use preset.
  Managed Payments now reports `Ready to use`, both products are eligible, and the
  hosted Customer Portal is configured for prorated upgrades plus end-of-period
  downgrades and cancellations. An isolated end-to-end staging signup, sync,
  checkout, entitlement lift, cancellation, and downgrade-preservation rehearsal
  passed on 2026-07-13. Production webhook signing, Vercel secrets, D1 schema,
  deployment, public signup, OAuth publishing, public legal routes, and a clean
  stranger signup-to-sync rehearsal are complete as of 2026-07-14. A real paid
  subscription remains intentionally untested because this launch rehearsal was
  required to incur no charge; the live Checkout boundary itself was verified.

- No full HopIt Workspace Root contract yet: the root-level codebase/workspace index, D1 account-visible discovery with scoped-token fallback, automatic account bootstrap, metadata-only attach, dashboard setup/attach/hydrate/dehydrate/open actions, hydration cursor, metadata-only/partial/materialized state, per-file cache state, path-level hydrate/pin/prune primitives, open-time first-working-set hydration, and explicit metadata-first lazy materialization policy exist, but true read-triggered hydration is deferred until a native filesystem provider is chosen.
- The current managed folder path has a safe metadata-first policy and dashboard controls, but metadata-only, path hydration, and open-time hydration are still bounded explicit/intent-driven operations rather than complete native demand hydration. Automatic pruning now exists as a conservative opt-in scheduler; default-on policy and production dogfood evidence remain pending.
- Real account provider code exists and production Clerk DNS/issuer/live-key plus Google OAuth rollout is active; owner sign-in and D1 owner mapping are smoke-tested, and Basic Auth fallback env vars are removed from production.
- Durable membership, role, invitation, hosted member/invite UI, and scoped agent-session token groundwork exist. Active private/team/review change-set reads now enforce an owner/member/viewer/guest matrix, but complete permission coverage is not done yet.
- The full private-repo encryption/key-grant model is documented but not
  implemented. Current client encryption is limited to routed secrets with a
  local key bridge; normal private repo files, private paths/metadata, per-device
  key grants, invite-time wrapping, independent secret grants, revocation, and
  recovery remain.
- D1-backed graph storage and auth-backed user APIs exist for the first collaboration slice, but not every product command has moved to user-scoped auth yet.
- Scoped device SQL now rejects unsupported statement shapes, cross-codebase predicates, mismatched parameters, and capability escapes, and Worker multi-statement writes use D1 batch when available. The raw-SQL proxy remains transitional and should be replaced with typed Worker operations rather than expanded.
- D1 separates file metadata from file bytes for agent sync, records per-file version rows, exposes object-backed revision compare, and has dry-run-by-default retention-aware object GC. Production retention policy and full product write-path coverage are not complete yet.
- Per-file revision-guarded mutation now covers D1 agent journal commits and browser text edits. Browser edits require a writable active change set, preserve Main, retain concurrent different-path changes, and reject stale/object-backed cases; the remaining non-agent product write surface has not moved to the same model yet.
- Graph contract validators exist for the agent/D1 graph path, but product-level validation is not yet comprehensive across every future object type.
- Requester-aware dashboard filtering exists, but the auth-backed collaborator permission model is not enforced across every user-facing write yet.
- A first read-only code-review browser slice exists, now with routeable codebase review/compare/history pages, D1-backed snapshot-anchored inline review threads, durable review decisions, and object-backed revision compare support. The compare API is now wired to real UI (2026-07-12): the dashboard compare page renders live trail-step directory compares and unified per-file diffs, and the desktop Trail expands the same diffs. Richer tree/diff interactions and snapshot-anchored inline comments on those diffs are still pending.
- A first codebase notification feed exists; complete permission coverage is still pending. The issue, discussion, release, and project-board surfaces from the first collaboration slice were removed in the July 2026 scope simplification.
- Cloudflare push/subscription remote-update delivery is deployed and enabled in personal production. The long-standing push skip was diagnosed on 2026-07-10 as a stale content manifest rather than real drift and healed, so the workspace is scan-clean, and a clean-workspace live apply was proven on 2026-07-11 (a second isolated device synced revision 4436 → 4437 and the production service applied it over the hub via trigger `remote-push`, ~8s later). Explicit refresh, per-workspace cursor state, reconnect fallback, and periodic graph-head reconciliation remain the safety layers.
- Service mode syncs local edits and serves status. Local two-service simulation proves device A edits sync through the watcher, while device B pulls them through explicit safe refresh before switching devices.
- No conflict resolution UI yet; fixture conflict detection/status exists.
- `hop import-git` now provides a production-safe literal Git checkout conversion path for snapshot-style repo migration, including `.git/` as owner-private metadata and encrypted routed secrets. Full Git history import, ancestry preservation, and remote publish are still pending.
- Explicit local cache pruning exists through `hop workspace prune`, and conservative scheduled pruning is available behind `--auto-prune` / `HOPIT_AUTO_PRUNE=1`. Default policy/rollout and native provider-backed read-triggered hydration are still pending.
- No offline mode yet.
- A public one-liner installer now exists (`curl -fsSL https://hopit.dev/install | sh`, served from `public/install.sh`) backed by an R2 release channel. The publisher writes unique versioned archives, checksums, and manifests under immutable keys, then updates `latest/manifest.json` last only for a complete target set; the installer ignores legacy moving archive keys. It resolves one version, fails closed without a checksum tool, validates and directly hashes the named archive, smoke-tests the candidate runtime, serializes installers, and atomically activates the launcher. Public unsigned publication has no escape hatch; signing, notarization, native package manager integration, and a tray/menu agent wrapper remain pending.
- `hop setup` now provides a polished four-stage terminal wizard: it opens the system folder picker with permission, renders an explicit existing-content cloud-upload/local-removal safety panel, creates a secure device keyring, opens a signed-in browser approval page with codebase selection or inline first-project creation, decrypts the returned scoped session locally, attaches the workspace, and starts background sync plus macOS start-on-login automatically. The dashboard follows with an explicit cloud-project, local-agent, Workspace Root attach, and first-working-set checklist. `--json`, `--advanced`, `--yes`, `--connect`/`--no-connect`, and explicit flags preserve machine-readable, lower-level, offline, and scripted operation. The public D1 device-code exchange stores only a hash of the secret device code and wraps the session token to the requesting device public key.
- Scoped token rotation is documented and CLI-backed, and the dashboard can track codebase keyring rotation state. Dashboard-guided recovery import, real rekey orchestration, and revocation workflows are still pending.
- No cross-platform watch behavior matrix yet.

## Verification Checklist

Run this before marking agent progress as done:

```bash
npm run agent:test
npm run lint
npm run check:production-config
npm run package:hop
```

For manual smoke testing:

```bash
npm run agent:demo
npm run agent:status
```

Run `npm run agent:serve` in a separate terminal when smoke testing the live web UI against the local status server.

For safe refresh debugging:

```bash
npm run agent:status -- \
  --cloud .hopit-agent/demo/cloud.json \
  --workspace .hopit-agent/demo/workspaces/hopit-core \
  --journal .hopit-agent/demo/journal.ndjson \
  --events .hopit-agent/demo/events.ndjson
```

Do not mark refresh behavior as done unless pending and failed journal states are still blocking refresh.

## Completion Rules

An item can move to `Done` only when all of these are true:

- The implementation exists.
- The behavior is documented.
- A deterministic command or test proves the behavior.
- `.private/` behavior is considered when file visibility is involved.
- Main vs active change-set behavior is considered when state mutation is involved.
- The status/event surface exposes enough evidence for a future UI to explain what happened.

An item should stay `Mostly done` when it works only for same-owner, local-only, fixture-only, or happy-path cases.

An item should stay `Later` if it is outside the current managed-folder MVP path, even if it is technically interesting.

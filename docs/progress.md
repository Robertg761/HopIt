# HopIt Progress Tracker

Last updated: 2026-07-08

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

The solid v1 target is now broader than the current spike: a HopIt Workspace Root, managed-folder/lazy materialization first, production-grade automatic remote-update delivery, object-backed content-addressed storage with per-file revision guards, scoped device/session auth, and GitHub-like code/review/work-item/release surfaces. True native filesystem-provider work remains future research; v1 should prove the managed-folder Workspace Root before going there.

The web app polls `/api/agent/status`. In local mode that route requires the local agent `/status` response and treats `/events` and `/cloud` as best-effort payloads so a slow graph read does not take the dashboard offline; in production it reads the configured D1 cloud dashboard backend. Local dashboard server routes merge `~/.config/hopit/production.env` under the Next.js process env, merge `hop workspace discover` readiness into `/api/codebases`, and the command route can run whitelisted sync, refresh, recover, review, merge, first-run Workspace Root setup, and Workspace Root attach actions with `--profile production` when installed-agent paths are configured. Hosted deployments remain read-only for workspace commands and require dashboard authentication.

Fixture-backed conflict handling is in place for stale selected-state revisions, stale file/base revisions, and stale Main revisions. Conflicts are persisted on the selected active change set, emitted as `change_set.conflict_detected`, and surfaced through status while preserving local edits for review.

Current live deployment:

- Vercel project: `robertg761s-projects/hopit`
- Vercel project id: `prj_hO8U1QmyliQjGODz4R339UkgE86S`
- Vercel org/team id: `team_x1SyEPIryEghBSkkwoXSTIZ2`
- Production URL: `https://hopit.dev`
- Secondary production alias: `https://www.hopit.dev`
- Current Vercel deployment URL: inspect `https://hopit.dev` with `vercel inspect https://hopit.dev` because generated deployment aliases change on every production deploy.
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

Domain-dependent production auth setup is no longer pinned. `hopit.dev` is live, Clerk production DNS/SSL are verified, Vercel has the redacted live Clerk env vars, and Vercel Production now uses `HOPIT_AUTH_PROVIDER=clerk`. Google OAuth is enabled in Clerk production through the Google Cloud project `hopit-auth-prod-rg`; the Google app remains in Testing mode with `robertgordon761@gmail.com` added as the owner test user. Production owner sign-in and D1 owner claim are smoke-tested, and Basic Auth fallback env vars have been removed from Vercel Production.

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

The installed macOS service is owned by LaunchAgent `com.hopit.agent.hopit`; it is verified with `launchctl print` plus `curl http://127.0.0.1:4785/status`. `hop service status` is still pid-file oriented and can report `running: false` for the direct launchd-owned `service run` process even when `/status` is healthy.

Current production state as of 2026-07-03: HopIt uses Cloudflare D1 as the only hosted graph backend. Vercel aliases and Clerk sign-in routing are live. The D1 database `hopit` is created, schema-applied, seeded from the historical export, reachable through `hopit-d1-api.hopit-robert.workers.dev`, configured in Vercel/local env for graph/status/file/codebase/account/action-job/member/invite/work-item/session/key paths, and serving the deployed `hopit.dev` app. Local remote-pull now uses activity-gated safe refresh with a five-minute cooldown so idle services do not burn Cloudflare Worker/D1 requests.

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
- Installed packaged runtime: LaunchAgent `com.hopit.agent.hopit` reports activity-gated remote pull enabled with a 300000 ms cooldown and no fixed interval polling.
- `hop keys status --profile production`: packaged runtime reports the local keyring at `/Users/robert/Library/Application Support/HopIt/Agent/keys/hopit.device.json`, mode `0600`, device key `trusted`, user keyring `active`, and user vault wrap `active`.
- `launchctl print gui/501/com.hopit.agent.hopit` plus `curl http://127.0.0.1:4785/status`: LaunchAgent is running and the loopback status endpoint reports `service=cloudflare-d1-graph`, `cloudExists=true`, and `fileCount=58`.
- `node --test packages/agent/test/d1-backend.test.js`: passes D1 graph sync, collaboration routes, scoped session registration/list/touch/revoke, trusted device key registration, user keyring, and wrapped user-vault key metadata.
- `vercel deploy --prod`: deployed the D1-backed app and aliased it to `https://hopit.dev`.
- `curl -I https://hopit.dev/`: returns `HTTP/2 307` to `/sign-in` for signed-out users, confirming Clerk protects the dashboard.
- Production Clerk sign-in and D1 owner claim were smoke-tested on `https://hopit.dev`; Basic Auth fallback is no longer needed for the owner handoff.
- Google Auth Platform Audience for project `hopit-auth-prod-rg`: shows `1 user (1 test, 0 other) / 100 user cap` and the test-user row `robertgordon761@gmail.com`.

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

## 2026-07-08 WS7c Object-Backed Diff History Log

WS7c from [HopIt Remediation Plan — July 2026](remediation-plan-2026-07.md) implements the owner-approved Option 2 model from [WS7c Object-Backed Diff And History Reconstruction Design](ws7c-object-backed-diff-history-design.md): per-file version rows, snapshot reconstruction by latest version at or before a graph revision, and full content-addressed blobs rather than delta chains.

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

WS6 from [HopIt Remediation Plan — July 2026](remediation-plan-2026-07.md) hardens frontend failure handling, centralizes client API envelope parsing, fixes the command-refresh race, and adds web-focused normalization tests.

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

WS5 from [HopIt Remediation Plan — July 2026](remediation-plan-2026-07.md) hardens the Cloudflare D1 Worker proxy-token path and makes emergency Basic Auth fallback noisy and explicitly acknowledged in production.

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

WS4 from [HopIt Remediation Plan — July 2026](remediation-plan-2026-07.md) splits the monolithic agent CLI into focused modules while keeping `packages/agent/src/cli.js` as the package/bin entrypoint.

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

WS3 from [HopIt Remediation Plan — July 2026](remediation-plan-2026-07.md) splits the monolithic `@hopit/backend-d1` implementation into focused modules without changing the package root public API.

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

WS2 from [HopIt Remediation Plan — July 2026](remediation-plan-2026-07.md) converts the repo into npm workspaces and extracts shared contracts into package boundaries.

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

WS1 from [HopIt Remediation Plan — July 2026](remediation-plan-2026-07.md) removes the retired hosted backend implementation while keeping the historical export migration script.

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

- Editor/tool demand hydration when a local tool asks for a file body that is still metadata-only.
- An automatic pruning policy on top of the explicit dry-run/execute primitive.
- Production-grade push/subscription remote-update delivery beyond the current activity-gated polling/cursor path.
- Broader blocked/conflicted UI detail and cross-device production verification for the full Workspace Root lifecycle.

## Executive Progress

| Area | Status | Summary |
| --- | --- | --- |
| Product concept | Done | The repo has converged on cloud-native managed workspaces, active change sets, explicit Main, and `.private/` owner-only workspace scope. |
| Web product shell | Mostly done | The prototype UI polls live local agent state through `/api/agent/status`, maps files/events/revisions/review/merge/conflict/cache state, can read D1 dashboard state when configured, merges local workspace discovery into codebase cards, shows codebase-level workspace/remote-update readiness in the topology cards, and can run first-run Workspace Root setup/attach, hydrate/dehydrate, and file-level hydrate/pin/free-space actions through the local agent. |
| HopIt Workspace Root | In progress | Production-profile paths, a root-level workspace index, per-path local cache state, D1 account-visible codebase discovery when credentials allow it, scoped-token configured-codebase fallback, automatic verified-owner bootstrap for migrated `local-owner` codebases, local attach/readiness summaries, metadata-only attach, dashboard setup/attach/hydrate/dehydrate actions, `workspace open`, hydration/materialized revision state, metadata-only/dehydrate, single-file and recursive-prefix hydrate, sibling hydrate opt-in, explicit pin/unpin, clean-cache prune, explicit metadata-first lazy materialization policy, and a remote cursor are in place; true read-triggered hydration remains deferred to native filesystem-provider research. |
| Local managed-folder agent | Done for spike | The agent proves hydration, journaling, sync acknowledgement, recovery, watch startup gating, safe refresh, status, and same-owner continuity. |
| Lazy materialization | In progress | `workspace attach`, `workspace open`, `workspace files`, `workspace hydrate-file`, `workspace hydrate-file --with-siblings`, `workspace hydrate-path --recursive`, safe full hydrate through `refresh`, `workspace pin|unpin`, dry-run-by-default `workspace prune`, dashboard file cache controls, and `workspace dehydrate --force` prove metadata-first attach, open-time first-working-set hydration, metadata listing, path-level hydration, explicit full materialization, clean local-body eviction, and metadata-only/partial/materialized state. V1 still needs native provider-backed read-triggered hydration and an automatic pruning policy. |
| Vercel/D1 production baseline | Active dogfood | Vercel hosts the protected dashboard and Clerk sign-in routing is live. The D1 database/env/seeding sequence is complete, `hopit-d1-api` proxies D1 for Vercel, hosted D1 reads can skip schema re-checks with `HOPIT_D1_ASSUME_SCHEMA=1`, hosted status reads are cached/coalesced and the hosted client polls less often to protect the free D1 budget, `hopit.dev` live API smoke checks pass, and the packaged LaunchAgent reports D1 cloud status. Automatic remote-pull is now activity-gated with a five-minute cooldown when enabled. |
| D1 cloud graph | In progress | D1 now has schema, HTTP API backend, agent service integration, hosted status/codebase/file/account/action-job/member/invite/work-item/key-grant routes, automatic verified-owner bootstrap for `local-owner` migrations, account-visible codebase heads with actor access summaries, scoped-token configured-codebase fallback, actions-runner support, scoped D1 proxy session auth, scoped agent sessions, device key/user keyring/wrapped key metadata, project-board operations and UI, durable issue/discussion comments, historical export migration script, and D1 graph/collaboration/session/key round-trip tests. History reconstruction, retention policy, richer release assets, and full product write-path coverage remain to port or complete. |
| Historical hosted graph export | Done | The retired export backup is retained under `/Users/robert/HopIt-Backups/convex/` as a migration/recovery source; the backend implementation was removed by WS1. |
| Object blob storage | Mostly done | The agent has an S3-compatible blob provider boundary, Cloudflare R2 env contract, Backblaze B2-compatible migration path, filesystem-backed tests, metadata-only D1 commits, hash-verified hydrate/refresh/export, client-encrypted secret-object metadata, and dry-run-by-default storage GC. The live `hopit-blobs` R2 bucket exists, scoped local R2 credentials are configured for that bucket only, and read/write/hydrate/delete smoke coverage exists. Personal use keeps R2 free-only with an 8 GB cap and public access disabled; the 1-day auto-delete lifecycle rule was removed on 2026-07-08 so stored blobs persist durably (verified: no object-backed rows existed while the rule was active). Production retention policy and storage tier decisions remain. |
| `.private/` model | Done for spike | `.private/` files are synced/versioned and classified as owner-private; they are not ignored or skipped. Routed `.private/env/` secrets remain local-only by default, and sync only when object storage plus the legacy local key or `hop keys` user-vault bridge are configured so raw secret bytes never go to D1/R2. |
| Privacy/encryption key model | In progress | The end-to-end plan is documented; agent crypto/envelope helpers now cover file envelopes, X25519 device wraps, user-vault unwrap, and encrypted recovery export; `hop keys` can create/status/export local keyrings; file entries carry derived privacy-zone metadata; D1 has key-management tables and first device/keyring/wrapped-key APIs; the dashboard can show redacted trusted-device and wrapped-key grant status; plaintext secret-zone files are rejected. Repo/private/secret zone keys, full private-repo file encryption, invite-time grants, independent secret grants, dashboard approval/recovery, revocation/rekey, and private path metadata remain. |
| Safety journal | Done for spike | Pending, acknowledged, and failed entries are derived from journal/events and exposed through status. |
| Watch loop | Done for spike | Watch startup runs recovery before hydration, blocks unsafe recovery, and syncs later editor writes. Service start waits for the watcher and status server to be ready before reporting success. |
| Fixture cloud graph service boundary | Done | Commands now use a fixture-backed service boundary instead of direct command-level cloud JSON access. |
| Main/change-set/owner/session/visibility contract | Done for fixture | The fixture graph and status surface include these identities and visibility fields. |
| Same-owner two-session continuity | Done for spike | Device/session B can refresh acknowledged shared and `.private/` changes from device/session A. |
| Automatic remote-update delivery | In progress | Remote-update events, explicit safe refresh, per-workspace materialization cursors, opt-in activity-gated `--remote-pull` with a five-minute default cooldown, graph-head cursor checks that avoid unchanged full graph reads, one-shot `hop remote-pull`, WS7a Stage 1 agent-side NDJSON push, and WS7a Stage 2 Cloudflare Durable Object WebSocket hub/D1 notify wiring with local tests exist. Default policy, deployment, and broader production verification remain. |
| Collaborator visibility simulation | Done for fixture | Tests prove private change sets hide non-owner content, team/review-visible change sets expose non-private paths, and `.private/` remains owner-only. |
| Remote-update events | Done for spike | Refresh emits first-class `remote-update` events and status exposes the latest update. |
| Review and merge | Done for fixture | Fixture commands open the selected active change set for review, merge it into Main, emit review/merge events, and expose review/merge state through status. |
| Conflict handling | Done for fixture | Stale selected-state, file/base, and Main revisions become reviewable conflict state. |
| Packaging | Mostly done | The current packager builds macOS/Linux `x64`/`arm64` tarballs with an embedded Node runtime, verifies help plus production-profile status, ships a production env example, and includes user-level launchd/systemd support scripts. |
| Installer/daemon hygiene | In progress | Manual service start, supervised `service run`, env-file install templates, production config checks, scoped-token rotation runbook, backup/export roots, read-only observability endpoints, packaged runtime install, and the current macOS LaunchAgent are documented. `hop service status` still needs direct launchd-owned `service run` awareness. Native signed installers, notarization, and tray UX remain. |
| Git compatibility | In progress | Safe export/publish now creates clean Git repos while omitting `.private/` from publish, but ancestry preservation and remote publishing are still not started. |
| Real accounts/auth | In progress | The repo now has Clerk sign-in routes, middleware, `/api/me`, provider-token forwarding, owner email config, and D1-backed account sync. The production Clerk instance, DNS, SSL, Vercel live env, `HOPIT_AUTH_PROVIDER=clerk`, production Google OAuth, owner sign-in, and D1 owner claim are active for `hopit.dev`; Basic Auth fallback is no longer needed for production owner access. |
| Permissions and invitations | In progress | Durable memberships, invitation tables, requester-aware dashboard filtering, owner claim, member management, invite create/accept/revoke UI, and scoped agent-session token groundwork are in place; complete permission coverage remains. |
| Code browsing/reviews/issues/releases | In progress | The dashboard now has a read-only code-review browser slice, review-linked follow-up issue comments, D1-backed issue/discussion/release/project-board UI, durable issue/discussion comments, project card movement, and an object-backed compare/history API foundation. Web diff UI wiring, snapshot-anchored inline review comments, richer routeable history, and immutable release publishing remain. |
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

The next major phase is a solid v1 workspace, not collaboration alone. The v1 sequence is: HopIt Workspace Root and hydration-state contract, object-backed content-addressed storage with per-file revision guards, privacy/encryption key grants, production-grade automatic remote-update delivery, scoped device/session auth, and GitHub-like web surfaces. The collaboration track is documented in [GitHub-Lite Collaboration Plan](github-lite-collaboration-plan.md), the privacy/security track is documented in [HopIt Privacy And Encryption Plan](privacy-encryption-plan.md), and the sub-plans remain [Auth And Collaboration Plan](auth-collaboration-plan.md), [Code Browsing, Review, Comments, And History Plan](review-code-browser-plan.md), and [HopIt Work Items, Projects, Discussions, And Releases Plan](work-items-releases-plan.md).

Domain-dependent infrastructure is now configured and active: `hopit.dev` routes to Vercel, Clerk production DNS/SSL are verified, Vercel has the redacted `pk_live_`/`sk_live_` values, Vercel Production uses `HOPIT_AUTH_PROVIDER=clerk`, production Google OAuth is configured for the owner test user while the Google app stays in Testing mode, the seeded owner has been claimed by the real Clerk user in D1, and Basic Auth fallback env vars have been removed from Vercel Production. Continue building Workspace Root, storage, remote-update, permission checks, collaboration data, code browsing, review/history, issues, projects, discussions, releases, and scoped agent-session hardening behind Clerk auth.

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

Status: `Next`

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
- The current worktree includes opt-in activity-gated `--remote-pull` support for `watch` and `service start`, plus `hop remote-pull` for a deterministic one-shot safe refresh attempt.
- Remote-pull checks the codebase-level graph head before full graph refresh, so unchanged activity-triggered checks do not repeatedly read all file metadata from the graph backend.
- The production-profile same-Mac dogfood test uses two isolated state/workspace roots against one fixture graph and covers metadata-only dehydrate, single-file hydrate, refresh fallback, one-shot remote-pull apply, unchanged cursor skip before dirty scanning, and dirty-state blocking after a remote move without requiring loopback service access.
- WS7a Stage 1 adds opt-in `--remote-push` / `HOPIT_REMOTE_PUSH=1` agent transport against a compact NDJSON hint stream. The client connects with codebase/state/device cursor context, treats envelopes as hints, calls the same safe remote-refresh decision path as `remote-pull`, reconnects with exponential backoff, and runs a fallback head check after reconnect.
- Status now exposes `remotePush` state and events for `push-connected`, `push-disconnected`, `push-fallback-polling`, `push-skipped`, and `push-applied`, including last event id, pushed revision, applied revision, and current skip/failure reason.
- Fixture tests cover clean apply, pending-journal skip, manifest-drift skip, duplicate idempotence, out-of-order convergence, reconnect fallback catch-up, metadata-only no-body hydration, and same-owner/collaborator `.private/` visibility.

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
- The HTTP status server keeps `/status` lightweight, serves `/cloud` as a graph-only dashboard endpoint, and uses the pid file as the ownership source of truth for `service status`.
- `npm run hop:service:*`, `hop:backup`, `hop:private-export`, `hop:export`, and `hop:publish` wrap production-profile operations.
- `docs/personal-production.md` covers install, login startup, observability, backup/export, and token rotation.
- `scripts/check-production-config.mjs` performs stricter personal-production hygiene checks without printing secrets.

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
- Durable review/comment/merge-history records and a real diff API are still pending.

### 5. Issues, Projects, And Discussions

Status: `In progress`

Definition of done:

- Add durable issue, project, project-item, discussion, and comment records.
- Add list/detail UI with state, assignee, label, and linked-code filters.
- Enforce permission checks for create/edit/close/archive actions.

Current foundation:

- D1 schema now includes issue, project, project item, discussion, comment, and collaboration counter tables.
- Permission-gated list/create/status/comment/project-item functions exist.
- The dashboard can list/create/update issues and discussions, and draft/publish releases. Project-board UI is still pending.

### 6. Releases

Status: `In progress`

Definition of done:

- Add release records tied to Main revisions.
- Add list/detail/create/publish/archive UI.
- Gate release publishing by maintainer/owner permission.
- Leave room for future Git export artifacts and binary artifacts.

Current foundation:

- D1 schema now includes releases and release assets.
- Permission-gated list/create/publish/asset functions exist and validate the target codebase before creating releases.
- The dashboard can draft releases and publish drafts. Immutable publish policy and artifact integration are still pending.

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
- WS7a Stage 2 implements the Cloudflare Durable Object WebSocket fan-out hub, D1-route notify-after-commit wiring, Worker auth-gated WebSocket routing, Wrangler Durable Object config, and agent WebSocket transport selection. It is not deployed yet.
- WS7b implements open-time and intent-driven demand hydration for managed folders: `hop workspace open`, bounded metadata-driven open plans, sibling hydration opt-in, last-open status, missing-key/blocked-path reporting, and collaborator-safe visibility filtering.

Proof command:

```bash
node --test --test-name-pattern "adversarial|crash-left|skewed|racing refresh|storage budget failure" packages/agent/test/agent-cli.test.js
```

WS7c implementation remains intentionally gated on owner approval of the design doc. WS7a Stage 2 remains local-only until the owner runs the documented Cloudflare deployment.

### 2026-07-08 WS7a Stage 1 — Agent Push Delivery

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

### 2026-07-08 WS7a Stage 2 — Cloudflare Push Hub And WebSocket Transport

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

Deferred:

- Owner-side Cloudflare deployment and live same-owner production dogfood verification.
- Default enabling policy; push remains opt-in through `--remote-push` / `HOPIT_REMOTE_PUSH=1`.

### 2026-07-08 WS7b — Open-Time And Intent-Driven Demand Hydration

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
- Editor-specific signals, automatic pruning policy, and production dogfood rollout of open-time hydration remain follow-up work.

## Known Gaps

- No full HopIt Workspace Root contract yet: the root-level codebase/workspace index, D1 account-visible discovery with scoped-token fallback, automatic account bootstrap, metadata-only attach, dashboard setup/attach/hydrate/dehydrate/open actions, hydration cursor, metadata-only/partial/materialized state, per-file cache state, path-level hydrate/pin/prune primitives, open-time first-working-set hydration, and explicit metadata-first lazy materialization policy exist, but true read-triggered hydration is deferred until a native filesystem provider is chosen.
- The current managed folder path has a safe metadata-first policy and dashboard controls, but metadata-only, path hydration, open-time hydration, and cache pruning are still bounded explicit/intent-driven operations rather than a complete native demand-hydration and automatic pruning system.
- Real account provider code exists and production Clerk DNS/issuer/live-key plus Google OAuth rollout is active; owner sign-in and D1 owner mapping are smoke-tested, and Basic Auth fallback env vars are removed from production.
- Durable membership, role, invitation, hosted member/invite UI, and scoped agent-session token groundwork exist, but complete permission coverage is not done yet.
- The full private-repo encryption/key-grant model is documented but not
  implemented. Current client encryption is limited to routed secrets with a
  local key bridge; normal private repo files, private paths/metadata, per-device
  key grants, invite-time wrapping, independent secret grants, revocation, and
  recovery remain.
- D1-backed graph storage and auth-backed user APIs exist for the first collaboration slice, but not every product command has moved to user-scoped auth yet.
- D1 separates file metadata from file bytes for agent sync, records per-file version rows, exposes object-backed revision compare, and has dry-run-by-default retention-aware object GC. Production retention policy and full product write-path coverage are not complete yet.
- Per-file revision-guarded mutation now covers D1 agent journal commits, but the full non-agent product write surface has not moved to the same model yet.
- Graph contract validators exist for the agent/D1 graph path, but product-level validation is not yet comprehensive across every future object type.
- Requester-aware dashboard filtering exists, but the auth-backed collaborator permission model is not enforced across every user-facing write yet.
- A first read-only code-review browser slice exists, now with routeable codebase review/compare/history pages, durable review-linked follow-up issues/comments, D1-backed snapshot-anchored inline review threads, durable review decisions, and object-backed revision compare support. Web UI wiring for the compare API and richer tree/diff interactions are still pending.
- Issue, discussion, release, durable comments, release-asset attachment, project-board UI, routeable work-item detail pages, and first codebase notification feed exist for the first slice; richer linked-object cards and complete permission coverage are still pending.
- Cloudflare push/subscription remote-update delivery is implemented locally through WS7a Stage 2, but it has not been deployed or dogfooded in personal production yet. Explicit refresh, per-workspace cursor state, and opt-in activity-gated remote-pull remain the production fallback layers.
- Service mode syncs local edits and serves status. Local two-service simulation proves device A edits sync through the watcher, while device B pulls them through explicit safe refresh before switching devices.
- No conflict resolution UI yet; fixture conflict detection/status exists.
- `hop import-git` now provides a production-safe literal Git checkout conversion path for snapshot-style repo migration, including `.git/` as owner-private metadata and encrypted routed secrets. Full Git history import, ancestry preservation, and remote publish are still pending.
- Explicit local cache pruning exists through `hop workspace prune`; automatic pruning policy and native provider-backed read-triggered hydration are still pending.
- No offline mode yet.
- No signed production installer, notarization, native package manager integration, or tray/menu agent wrapper yet.
- Start-on-login setup is script/template based and expects the operator to create a correct local env file.
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

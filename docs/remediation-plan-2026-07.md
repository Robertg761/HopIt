# HopIt Remediation Plan — July 2026

This is a delegation-ready execution plan derived from an architecture review on 2026-07-03.
It is written for an AI coding agent (or contractor) with no prior context on this repo.
Execute workstreams **in order** — each one shrinks or de-risks the next. One workstream
per session/branch/PR. Do not combine them.

## How to delegate

Per workstream, give the agent:

1. The **Global context and guardrails** section below (always).
2. The single workstream section.
3. The instruction: "Do not start the next workstream. Stop and report when acceptance
   criteria are met and verification passes."

## Global context and guardrails

**What HopIt is.** A cloud-native code workspace: codebases live in a cloud graph
(Cloudflare D1 metadata + R2 object blobs), a local agent (`hop` CLI) materializes them
into managed folders and syncs edits back, and a Next.js dashboard (Vercel, Clerk auth)
shows status/review/collaboration surfaces. See `README.md` and `docs/agent-architecture.md`.

**Repo map (line counts as of 2026-07-03):**

- `packages/agent/src/cli.js` — 9,294 lines, the entire `hop` CLI (plain JS, ESM, no deps beyond node stdlib + `convex` + shared d1-backend)
- `packages/agent/src/crypto.js` — 471 lines, encryption/key management
- `packages/agent/test/` — `agent-cli.test.js` (3,302 lines, ~85 integration tests), `crypto.test.js`, `d1-backend.test.js`; run with `npm run agent:test` (plain `node --test`)
- `packages/actions-runner/src/runner.js` — 253 lines, hosted-action job runner
- `src/lib/d1-backend.js` — 4,787 lines, D1 data layer shared by web app AND CLI (CLI imports across the package boundary)
- `src/lib/cloud-backend.ts` — 446 lines, backend selector/abstraction (d1 | convex | unavailable)
- `src/lib/collaboration.ts` (943), `src/lib/client/agent-status.ts` (898) — web-side types + normalization
- `convex/` — legacy backend (agent.ts 3,483 lines, collaboration.ts, access.ts, schema.ts). Production Convex deployment is DISABLED (free-plan limits); D1 is production.
- `cloudflare/d1/api-worker.js` (171) + `cloudflare/d1/schema.sql` (457) — D1 HTTP proxy Worker
- `src/app/(app)/...` — dashboard routes; `src/app/api/...` — 13 API route files
- `docs/progress.md` — implementation ledger; update it when a workstream lands

**Hard guardrails — read carefully:**

- This repo backs a LIVE personal production system (`hopit.dev`, production D1 database,
  R2 bucket, a running LaunchAgent `com.hopit.agent.hopit`). NEVER run `hop` commands with
  `--profile production`, never run `npm run hop:*` or `convex:deploy*` scripts, never run
  the D1 migration script without `--dry-run`. All testing goes through `npm run agent:test`
  (fixture/temp-dir based, no cloud access) and `npm run build` / `npm run lint`.
- `.env.local` and `~/.config/hopit/production.env` contain live secrets. Never read them
  into output, never commit them, never copy values into code or docs.
- Do not touch `.hopit-agent/` (runtime data, not source) or `artifacts/`.
- Behavior-preserving refactors must be move-only: no logic changes, no "improvements while
  you're in there." If you find a bug during a refactor, note it in the PR description and
  leave it.
- Work on a branch per workstream. Conventional short commit subjects, matching the existing
  history style (e.g. "Split blob stores out of agent CLI").

**Verification battery (run after every workstream):**

```bash
npm run agent:test          # CLI integration tests — must stay green
npm run lint                # eslint
npm run build               # Next.js production build
npx tsc --noEmit            # typecheck (tsconfig.json)
node packages/agent/src/cli.js help          # CLI still boots
npm run package:hop         # only for workstreams touching the CLI — packaging must still work
```

---

## WS1 — Remove the legacy Convex backend

**Why first:** Convex is a fully duplicated, untested, disabled backend (3,400+ lines in
`convex/agent.ts` alone, plus parallel paths in the web lib and CLI). Every later
workstream gets smaller and safer once it's gone. Recovery is guaranteed by git history
plus the export snapshot at `~/HopIt-Backups/convex/` (do not touch that directory).

**Steps:**

1. Inventory every Convex touchpoint: `grep -rn "convex" src packages scripts convex package.json README.md docs --include="*.{ts,tsx,js,mjs,json,md}" -il` and build a checklist before deleting anything.
2. Delete the `convex/` directory (including `_generated/`).
3. In `src/lib/cloud-backend.ts`: remove the `'convex'` branch from `configuredCloudBackend()` and all convex-dispatch arms. The selector becomes `'d1' | 'unavailable'`. **Deliberate behavior change:** partial/missing D1 config must now yield `'unavailable'` (loud), never a silent fallback.
4. Delete `src/lib/convex-agent.ts` and `src/lib/convex-auth.ts`; remove the Clerk `'convex'` JWT-template call path and any imports of these modules.
5. In `packages/agent/src/cli.js`: remove `ConvexCloudGraphService` and the convex selection branch in the cloud-graph-service factory. Remove convex-specific env handling (`HOPIT_CONVEX_URL`, `HOPIT_AGENT_TOKEN` as convex bootstrap) — grep the test suite first; update or remove tests that exercised the convex path only.
6. Remove the `convex` npm dependency, `convex:dev` / `convex:deploy` / `convex:deploy:prod` scripts, and `components.json`'s convex references if any. Run `npm install` to update the lockfile.
7. Keep `scripts/migrate-convex-export-to-d1.mjs` (it reads an export zip, doesn't need the convex package) — verify it has no `convex` import; if it does, inline what it needs.
8. Sweep `README.md`, `docs/progress.md`, `docs/personal-production.md`, `.env.example`: move Convex from "legacy fallback" to a short "History" note pointing at the snapshot backup and this plan.

**Acceptance criteria:** `grep -rni convex src packages --include="*.{ts,tsx,js}"` returns only the migration script; full verification battery green; `configuredCloudBackend()` has exactly two outcomes; docs updated.

**Size:** ~1 session.

---

## WS2 — npm workspaces + `@hopit/core` shared package

**Why:** The repo is a de-facto monorepo without workspace tooling: the CLI imports
`src/lib/d1-backend.js` across the app boundary, privacy-zone classification is duplicated
(CLI + migration script), and `packages/agent/src/crypto.js` is unavailable to the web app.
The cloud graph shape — the product's core contract — has no formal type.

**Steps:**

1. Convert the root `package.json` to npm workspaces: `"workspaces": ["packages/*"]`. Give `packages/agent` and `packages/actions-runner` their own `package.json` files (`@hopit/agent`, `@hopit/actions-runner`). Keep the root `bin.hop` working or move it into `@hopit/agent` and re-link root scripts.
2. Create `packages/core` (`@hopit/core`), written in TypeScript, built with `tsc` to ESM JS + `.d.ts` in `dist/` (the CLI runs unbundled `node`, so it must consume built JS — no runtime TS). Add a `build` script and a root `prebuild`/`pretest` hook so `npm run agent:test` and `npm run build` build core first.
3. Move into `@hopit/core`, converting to TS as you move (these are the only logic conversions allowed; port their existing tests):
   - Privacy-zone classification (currently duplicated in `cli.js` and `scripts/migrate-convex-export-to-d1.mjs`) — single implementation, zones: repo-content / owner-private / secrets / git-internals.
   - Crypto envelope + key-material helpers from `packages/agent/src/crypto.js` (keep a thin re-export shim at the old path until WS4 removes it).
   - **Graph types:** author `.d.ts`-backed types for the cloud graph, journal entries, change sets, agent status payload, and session/capability shapes. Derive them from `cloudflare/d1/schema.sql`, the demo fixture `packages/agent/fixtures/demo-cloud.json`, and `src/lib/client/agent-status.ts`. This is the highest-value deliverable of the workstream.
4. Move `src/lib/d1-backend.js` to `packages/backend-d1` (`@hopit/backend-d1`), unchanged (splitting it is WS3). Update imports in the web app, CLI, runner, and scripts. Confirm the Next.js build resolves the workspace package (add `transpilePackages` in `next.config.ts` if needed) and that Vercel's build command handles workspaces (it does for npm workspaces by default — verify with `npm run build`).
5. Enable `// @ts-check` on `packages/agent/src/cli.js` is NOT required yet (too noisy pre-split); instead add a `typecheck` script for `packages/core` and wire `@hopit/core` types into the web app where the old ad-hoc shapes lived.
6. Verify `npm run package:hop` (esbuild bundling in `scripts/package-hop.mjs`) still resolves workspace deps into the standalone artifact.

**Acceptance criteria:** verification battery green including `package:hop`; privacy-zone logic exists exactly once; web app compiles against `@hopit/core` graph/status types; no import reaches from `packages/` into `src/`.

**Size:** 1–2 sessions.

---

## WS3 — Split `d1-backend` into modules

**Why:** 4,787 lines, one file, no internal structure; it spans schema, graph I/O, members,
invitations, sessions, keys, audit, and access control.

**Steps:**

1. In `packages/backend-d1/src/`, extract move-only modules along the existing seams, leaf-first, running `npm run agent:test` after each extraction:
   - `client.js` — `query()` / `first()` / HTTP + binding plumbing, retry logic
   - `schema.js` — schema assertion/setup
   - `graph.js` — graph read/write, journal entries, revision guards
   - `access.js` — `readAccessContext`, `filterVisibleGraphForAccess`, role logic
   - `sessions.js` — agent session register/validate/revoke, token hashing
   - `members.js` — members, invitations, suspensions
   - `keys.js` — device keys, keyrings, wrapped keys, key audit events
   - `collaboration.js` — work items, comments, boards, releases, review threads/decisions
   - `index.js` — re-exports the existing public surface unchanged
2. No signature changes, no renamed exports. Callers keep importing the package root.
3. Add JSDoc `@typedef` imports from `@hopit/core` on the module boundaries (params/returns of exported functions) — types only, no behavior.
4. Port/extend `packages/agent/test/d1-backend.test.js` so each module has at least its existing coverage; keep it one test file if that's simplest.

**Acceptance criteria:** no file in the package over ~800 lines; public API byte-compatible (verify by keeping the old file temporarily and diffing `Object.keys` of both export surfaces in a scratch script); verification battery green.

**Size:** 1–2 sessions.

---

## WS4 — Split the agent CLI into modules

**Why:** 9,294 lines in one file is the single biggest drag on iteration speed and the main
barrier to contributors. The integration suite (85 tests) makes this refactor safe *now*.

**Steps:**

1. Target layout under `packages/agent/src/` (extract leaf-first, move-only, `npm run agent:test` after every extraction — this ordering matters):
   1. `blob-stores/` — filesystem + S3-compatible stores (currently ~lines 7408–7756) behind the existing implicit interface
   2. `cloud/d1-graph-service.js` — the cloud graph service adapter (~7877–8288)
   3. `journal.js` — sync journal write/replay/recover
   4. `workspace-index.js` — `workspaces.json` index, per-path cache state, pin/prune
   5. `watch.js` — fs.watch + polling fallback + debounce scheduler + remote-pull cooldown (~2070–2366)
   6. `service.js` — service lifecycle: spawn/pid/status/stop, status HTTP server (~2616–2825)
   7. `commands/` — one file per command family: `import.js` (import/mirror/import-git/import-git-url), `hydrate.js`, `sync.js`, `workspace.js`, `keys.js`, `storage.js`, `status.js`, `export.js` (export/publish/backup), `review.js` (review-open/merge), `service.js`, `demo.js`, `doctor.js`
   8. `options.js` — the hand-rolled option parser, unchanged behavior
   9. `cli.js` — shrinks to: env/profile loading, command table, dispatch, help text
2. Constants (budgets, timeouts, debounce, cooldown) move to a single `constants.js` — same values, one place.
3. Keep `packages/agent/src/cli.js` as the bin entrypoint so `package.json` `bin`, npm scripts, the LaunchAgent plist, and `scripts/package-hop.mjs` need no changes. Verify `npm run package:hop` and run the produced `./bin/hop help`.
4. After the split, enable `// @ts-check` per extracted module with JSDoc types from `@hopit/core`, fixing only annotations (not logic). Add a `typecheck:agent` script using `tsc --checkJs --noEmit` with an allowlist so it can be adopted module-by-module.
5. Do NOT convert the CLI to TypeScript in this workstream (it would add a build step to the dev loop and packaging). Note full TS conversion as a possible follow-up once checkJs coverage is complete.

**Acceptance criteria:** `cli.js` under ~500 lines; no module over ~1,000; all 85 integration tests green without modification (tests import the CLI via its public entrypoints — if any test reaches into internals, update the import path only); `package:hop` artifact boots.

**Size:** 2–3 sessions. Split into multiple PRs at the numbered extraction boundaries if reviewability suffers.

---

## WS5 — Auth hardening (D1 worker + basic-auth fallback)

**Why:** `HOPIT_D1_PROXY_TOKEN` in `cloudflare/d1/api-worker.js` bypasses the entire auth
layer with no rate limiting or logging; the basic-auth fallback is checked first in
`src/lib/request-cloud-actor.ts` across 5+ routes and is silent when enabled.

**Steps:**

1. `cloudflare/d1/api-worker.js`:
   - Use constant-time comparison (`crypto.subtle.timingSafeEqual` or equivalent) for the proxy token check.
   - Add structured logging on every request: auth mode (`proxy` | `session`), codebase id, statement count, rejected-reason on 4xx. No tokens or SQL params in logs.
   - Add an in-worker soft rate limit for failed-auth attempts per IP (simple `Map` counter with time buckets is fine at this scale) returning 429; document that a Cloudflare WAF rate-limiting rule should also be configured (dashboard step — write the exact rule spec in `docs/personal-production.md`, don't attempt it from code).
   - Add a `docs/personal-production.md` runbook section: proxy-token rotation procedure (mint new secret → update Worker env + Vercel env → verify → invalidate old).
2. Basic-auth fallback:
   - In `src/lib/basic-auth-fallback.ts` (or a small shared guard): when `HOPIT_ALLOW_BASIC_AUTH_FALLBACK=1`, log a single prominent server-side warning at first use per process, and emit a warning line from `scripts/check-production-config.mjs` (fail the check when `VERCEL_ENV=production` unless an explicit `HOPIT_ACKNOWLEDGE_BASIC_AUTH_RISK=1` is also set).
   - Add an integration-style unit test for the guard behavior.
3. In `src/lib/cloud-backend.ts` (post-WS1): when required D1 vars are partially set, return `'unavailable'` AND log which variable is missing — misconfiguration should be diagnosable from one log line.

**Acceptance criteria:** worker changes covered by a small test harness (the repo has none for the worker — add `cloudflare/d1/api-worker.test.js` exercising the exported handler with a mocked env/DB binding, runnable under `node --test`); `check:production-config` reflects the new checks; runbook updated; verification battery green.

**Size:** ~1 session.

---

## WS6 — Frontend hardening

**Why:** No error boundaries (a component crash blanks the page); every feature module
hand-rolls fetch + error-envelope parsing; `agent-status.ts` is an 898-line untested
normalization monolith; one fire-and-forget refresh can leave a stale codebase list.

**Steps:**

1. **Error boundaries:** add `src/app/global-error.tsx` and `src/app/(app)/error.tsx` using the existing UI primitives (`Card`, `Button`, `EmptyState`) with a reset button and the humanized error message. Keep styling consistent with the shell.
2. **Shared API client:** create `src/lib/client/api.ts` — a thin `apiFetch<T>(path, init)` that applies JSON headers, parses the standard error envelope, and routes errors through the existing `humanizeApiError`. Migrate the per-feature wrappers (`codebases-api.ts`, `files-api.ts`, work-items/review/members fetch sites) to it. Move-only for behavior; delete the duplicated parsing.
3. **Fix the refresh race:** in `src/components/workspace/workspace-provider.tsx` (~line 199), `await refresh(); void refreshCodebases()` — await both (or `Promise.all`) so command completion can't show a stale codebase list.
4. **Split `agent-status.ts`:** into `src/lib/client/agent-status/` — `normalize.ts` (main mapping), `formatters.ts` (time/duration/case), `mappers.ts` (members/files/events), `defaults.ts` (offline/fallback snapshots), `index.ts` re-exporting the current surface. Move-only.
5. **Unit tests for normalization:** add `vitest` (devDependency, `test:web` script; do not touch `npm test`, which is the agent suite). Cover: `mapAgentStatusResponse` against a captured local-agent payload and a captured hosted-D1 payload (build fixtures from the shapes in `packages/agent/fixtures/demo-cloud.json` and the status route), missing-field fallbacks, and `humanizeApiError` cases.
6. Do NOT migrate to server components, React Query, or any state library — explicitly out of scope; the current provider/polling model is fine at this scale.

**Acceptance criteria:** throwing inside a page renders the boundary, not a blank screen (add a temporary dev-only throw to verify, then remove); zero remaining ad-hoc `fetch` error parsing in feature modules; `test:web` green with meaningful normalization coverage; verification battery green.

**Size:** 1–2 sessions.

---

## WS7 — Core product: sync-engine milestones (design-first)

**Why:** The differentiators — "open the project on another device and keep going,"
never losing work — are the unfinished parts: demand hydration, push-based remote-update
delivery (today: activity-gated polling with a 5-minute cooldown), and object-backed
diff/history reconstruction. Collaboration surfaces (issues/discussions/releases/boards)
are FROZEN until these land: no new features there, bug fixes only.

Each sub-workstream is **design doc first, then implementation after the owner approves
the doc.** Design docs go in `docs/`, follow the style of `docs/agent-architecture.md`,
and must include: options considered, free-tier cost math (D1 daily writes, Worker
requests, R2 ops), failure modes, and a fixture-testable acceptance plan.

**WS7a — Push-based remote-update delivery.** Replace cooldown polling with push.
Evaluate in the design doc: (1) Cloudflare Durable Objects + WebSocket hibernation
(available on the free plan; likely winner — one DO per codebase as a fan-out hub, agent
holds a hibernating socket, D1 writes notify the DO), (2) SSE from a Worker, (3) smarter
head-cursor long-polling as a fallback. Requirements: same-owner devices see acknowledged
changes within seconds; delivery degrades gracefully to the existing poll path; the local
journal-clean gate from `docs/agent-architecture.md` is preserved; idle cost ≈ 0.
Implementation lands behind `HOPIT_REMOTE_PUSH=1` with the poll path as fallback.

**WS7b — Demand hydration.** Without FUSE (explicitly out of scope per README), true
read-triggered hydration isn't available from `fs.watch`. Design doc should evaluate the
practical ladder: hydrate-on-workspace-open (exists) → editor integration signals
(VS Code workspace open / recently-opened tracking) → placeholder-file strategy and its
tool-compatibility risks → macOS File Provider / FSKit research as the documented future
step. Deliverable may legitimately conclude "improve open-time + prefix heuristics now,
defer FS-level triggers" — the doc must say so explicitly with reasons.

**WS7c — Object-backed diff/history reconstruction.** History and compare views currently
lean on graph metadata. Design doc: reconstruct file-level diffs between any two
revisions from R2 content-addressed blobs; define retention/GC interplay with
`hop storage gc`; specify caching so the dashboard compare page doesn't re-fetch blobs
per view; extend the fixture demo so `hop demo` proves a three-revision diff chain.

**WS7d — Cross-device adversarial test suite.** Extend `agent-cli.test.js` with hostile
two-device scenarios: simultaneous edits to the same file, kill -9 mid-journal-write then
recover, clock skew, watch-mode sync during refresh, storage-budget exhaustion mid-sync.
Every scenario must end in either converged state or a surfaced conflict — never silent loss.
This one needs no design doc; it can run in parallel with 7a–7c and will pressure-test them.

**Size:** each sub-workstream is 1 design session + 1–3 implementation sessions.

---

## Suggested sequence

| Order | Workstream | Depends on | Sessions |
|-------|-----------|------------|----------|
| 1 | WS1 Remove Convex | — | 1 |
| 2 | WS2 Workspaces + core pkg | WS1 | 1–2 |
| 3 | WS3 Split d1-backend | WS2 | 1–2 |
| 4 | WS4 Split CLI | WS2 (WS3 helpful) | 2–3 |
| 5 | WS5 Auth hardening | WS1 | 1 |
| 6 | WS6 Frontend hardening | none strictly; after WS1 | 1–2 |
| 7 | WS7d Adversarial tests | any time after WS4 | 1–2 |
| 8 | WS7a Push delivery | design doc first | 1 + 2–3 |
| 9 | WS7b Demand hydration | design doc first | 1 + 1–3 |
| 10 | WS7c Diff/history | design doc first | 1 + 2–3 |

WS5 and WS6 can run in parallel with WS3/WS4 (different files). WS7a–c need owner sign-off
on their design docs before implementation.

After each workstream lands: update `docs/progress.md` (status + proof command) — that
ledger is the project's source of truth for what's done.

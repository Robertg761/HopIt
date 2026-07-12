# Phase 3 — Real Tenants: Multi-Tenant Signup, Isolation, Quotas & Billing

> **Consolidated 2026-07-13 from two parallel design drafts.**

This document is the design-first gate for **Phase 3 of
[docs/product-roadmap.md](product-roadmap.md)** ("Real tenants"). It plans true
multi-tenant signup at `hopit.dev`: per-user isolation and quotas, flat-subscription
billing plumbing, and the security hardening that makes a stranger's sign-up safe.
Following the WS7-era convention, implementation starts only after the owner approves
this doc — no schema change, billing integration, or worker change lands before that
approval, and this doc contains **no implementation**.

**Exit criterion (from the roadmap):** *a stranger can sign up, pay, and sync, and
their data is provably isolated.*

Stages that require an owner-provisioned billing account or a Cloudflare paid plan
are called out explicitly. The doc follows the shape of
[docs/ws7a-push-remote-update-design.md](ws7a-push-remote-update-design.md): options
considered, cost math from
[docs/storage-pricing-research-2026-07.md](storage-pricing-research-2026-07.md),
failure modes, and a fixture-testable acceptance plan. Every claim about current
behavior is grounded in named files and lines, and ends with a single **Decisions
needed from owner** section that lists each choice as a crisp question plus a
recommendation.

## Stage 0 — work already underway (do not re-plan here)

Two workstreams are running in parallel; this doc treats their output as
prerequisites, not new work:

1. **`hst_` middleware wiring.** The Clerk middleware in
   [`src/proxy.ts`](../src/proxy.ts) currently protects all `/api` routes and
   307-redirects unauthenticated requests to `/sign-in`. That blocks the
   agent-session-token (`hst_`) auth path that
   [`src/lib/request-cloud-actor.ts:21-30`](../src/lib/request-cloud-actor.ts)
   already implements — so today that path is dead code for hosted requests
   (confirmed in `docs/progress.md:216`, a live 307 against
   `https://hopit.dev/api/codebase-files`). An agent presenting a `Bearer hst_...`
   token to `/api/*` is redirected to sign-in before the route runs, so
   `cloudActorFromRequest`'s agent-token branch is unreachable from the Next app.
   (Agents still reach D1 through the Cloudflare Worker — see §1 — so this only
   blocks programmatic *dashboard-API* access, which Phase 3 needs for the AI
   story.) Stage-0 makes the `hst_` bearer path load-bearing (a public-but-token-gated
   matcher alongside the existing `isPublicDeviceAuthorizationRoute`). Phase 3
   depends on it but does not redesign it.

2. **Cross-tenant isolation test suite.** A hostile, fixture-backed suite proving
   one tenant's session/token cannot read or mutate another tenant's rows/blobs.
   This is the machine-checkable spine of "provably isolated." Phase 3's acceptance
   plan (§8) extends it rather than inventing a parallel harness. There is no
   `*isolation*` or `*cross-tenant*` test file in the tree yet; the seed is the
   scoped-SQL coverage in
   [`cloudflare/d1/api-worker.test.js`](../cloudflare/d1/api-worker.test.js), the
   adversarial `agent-cli.test.js` patterns (WS7d), and
   `packages/agent/test/access-security.test.js`. See the WS7d hostile suite in
   [docs/remediation-plan-2026-07.md](remediation-plan-2026-07.md).

---

## 1. Current-state audit (read, not assumed)

HopIt is already *shaped* like a multi-tenant system — every table is keyed by a
global `codebase_id`, ownership and membership are modeled, and the worker enforces
a per-session scope. What is missing is everything that turns "one owner with several
codebases" into "many strangers who never trust each other": a real
signup-to-provisioning path, quotas, billing, isolated storage ceilings, and rate
limiting. Several findings below were surprising; file paths are exact.

### 1.1 Already multi-tenant-capable

- **Clerk signup/auth exists and is live.** `hopit.dev` runs a production Clerk
  instance with Google OAuth (`docs/personal-production.md:17-24`, `44-46`).
  `src/proxy.ts:24-38` runs `clerkMiddleware` over everything except a small public
  set (`/sign-in`, `/sign-up`, `/install`, `/install.sh`, and
  `POST /api/device-authorizations`); the actor is derived in
  [`src/lib/request-cloud-actor.ts:32-44`](../src/lib/request-cloud-actor.ts)
  (`auth()` + `currentUser()` → `{ userId, sessionId, primaryEmail, displayName,
  currentAuthEmailVerified }`). `src/lib/auth-config.ts` decides Clerk-vs-basic by
  env (`HOPIT_AUTH_PROVIDER`, presence of `CLERK_SECRET_KEY`). Clerk sign-*up*
  already works — the constraint is what happens *after* signup, not signup itself.
  Whether strangers can register today is a Clerk-dashboard toggle, not code.

- **A signed-in Clerk user becomes an owner by creating a codebase, and that path
  does NOT gate on any owner allowlist.** `codebases.owner_id`
  (`cloudflare/d1/schema.sql:16`) is set on create in
  [`graph.js` `createCodebase`](../packages/backend-d1/src/graph.js#L604) from
  `actor.userId` (`graph.js:612`), which also inserts an `owner`-role row into
  `codebase_members`; `allocateCodebaseId` (`graph.js:17-22`) appends a full UUID so
  *"two accounts can safely choose the same common name"* — codebase ids are already
  global tenant keys. **Any authenticated user can already create and own a codebase.**
  Multi-tenant codebase creation is mechanically live today — the biggest surprise.

- **`codebase_members` + roles.** `codebase_members(codebase_id, user_id, role,
  status, …)` (`schema.sql:115-128`) drives membership; `owner_id` is the tenant
  root; members get `owner|maintainer|member|viewer` (`api-worker.js:116`).
  Invitations (`codebase_invitations`, `schema.sql:130-148`) and the accept flow
  (`members.js:252-312`) let a second real user join a tenant.

- **Requester visibility filtering.** Dashboard reads run through `readVisibleGraph`
  / `readAccessContext` ([`access.js:13-47`](../packages/backend-d1/src/access.js))
  and `listCodebases` filters to `owner_id = ? or (member.user_id = ? and status =
  'active')` (`graph.js:505-510`). A signed-in user only sees their own tenants.

- **Scoped `hst_` sessions per codebase.** `agent_sessions` (`schema.sql:150-169`)
  binds a token hash to exactly one `(user_id, codebase_id, capabilities)`. Minted
  during device approval (`sessions.js:13-77` `registerAgentSession`), the raw token
  is shown once; only the SHA-256 hash is stored (`api-worker.js:278-282`).

- **Encryption keyring is already per-entity.** `user_keyrings` (per user),
  `codebase_keyrings` (per codebase), `wrapped_keys` (per recipient),
  `key_audit_events`. Client-side per-zone encryption exists
  (`packages/backend-d1/src/schema.js`).

- **Device-authorization onboarding incl. create-requested-codebase.**
  `device_authorizations` (`schema.sql:171-194`) plus
  [`device-authorizations.js`](../packages/backend-d1/src/device-authorizations.js)
  implement RFC-8628-style device flow: create (public, `proxy.ts:22`/`30`), approve
  (Clerk-gated, same-origin, and requiring the approver already have access to the
  target `codebaseId` — `src/app/api/device-authorizations/approve/route.ts:27-30`),
  poll. `hop add` (`packages/agent/src/commands/add.js`) requests a *new* codebase
  id/name (`device-authorizations.js:44` `requestedCodebaseId`) and hard-fails if the
  approved codebase differs from the requested one (`add.js:183-196`), so a misrouted
  approval cannot overwrite another workspace. The session token is wrapped to the
  device public key (`device-authorizations.js:142-147`). This is clean and already
  per-user scoped — it needs a billing/quota gate added, not a redesign.

### 1.2 Trust boundaries — two enforcement planes, not equally strong

- **Plane A — the Next.js backend (`@hopit/backend-d1`) reached with the trusted
  proxy token.** The hosted Next API builds its D1 client with **no session token**
  (`cloud-backend.ts:277-279` `createD1Backend({})`), so `d1AuthorizationToken` falls
  back to `HOPIT_D1_API_TOKEN` (`config.js:31-33`, `11`) as the worker bearer. **In
  production that env var is set to the proxy-token value** (`docs/personal-production.md:107`
  — `HOPIT_D1_API_TOKEN=<…-or-hopit-d1-proxy-token>`), which the worker matches
  against its own `env.HOPIT_D1_PROXY_TOKEN` secret (`api-worker.js:73`). On match,
  that token short-circuits *all* scoping: `authorizeRequest` returns
  `{ kind: 'proxy' }` and **skips `assertScopedSessionStatementAllowed`,
  `assertScopedMutationBatch`, and `enforceScopedResultVisibility` entirely**
  (`api-worker.js:73-74`, `89-97`, `180-183`). (The client env var and the worker
  secret carry the same value under different names — `HOPIT_D1_API_TOKEN` vs
  `HOPIT_D1_PROXY_TOKEN`.) Per-user access is then enforced *only in application
  code*: `readAccessContext` / `requireGraphCapability`
  ([`access.js`](../packages/backend-d1/src/access.js)) load `codebase_members` and
  compute a role, and `visibilityContextForGraph` (`helpers/access.js`) fails closed
  to anonymous when only a session id is present. **Tenant isolation on the entire
  dashboard path therefore rests only on application-level `actor.userId` filtering
  in `backend-d1`, not on the worker.** A single missing `where user_id = ?` /
  `codebase_id = ?` in one method is a cross-tenant read. This is the largest
  isolation liability for the "provably isolated" bar. This plane is only as strong
  as every route remembering to pass the real actor and call a capability check.

- **Plane B — the Cloudflare Worker scoped-SQL policy, reached by agents with `hst_`
  tokens.** This is the strong boundary. [`cloudflare/d1/scoped-sql.js`](../cloudflare/d1/scoped-sql.js)
  is a deny-by-default SQL firewall: the session token is bound to exactly one
  `codebase_id`; every statement must be select/insert/update/delete, must carry an
  **exact `codebase_id = ?` equality** predicate matching the session (no `OR`, `IN`,
  `LIKE`, `!=`, `UNION`, or subqueries beyond one whitelisted revision guard —
  `scoped-sql.js:281-283`), uses anonymous params, cannot touch admin tables without
  `admin` capability, and file writes must match byte-for-byte "guarded journal"
  templates. The worker independently re-checks the session's codebase
  (`api-worker.js:84-87`) and re-checks membership/visibility (`readScopedFileAccess`
  `api-worker.js:100-122`, `assertScopedMutationAccess`, `enforceScopedResultVisibility`
  `api-worker.js:180-232`). **Cross-codebase access is structurally impossible on
  Plane B** because the token's `codebase_id` is the scope and every predicate is
  checked against it — but it only applies to the `hst_` path, not the proxy-token
  path.

The net: agent sync (the stranger's daily driver) is well-isolated at the D1 layer.
The dashboard API relies on discipline in route handlers.

### 1.3 R2 blob storage — the client-side-credential isolation gap

- **Blob keys are already codebase-namespaced:**
  `{prefix}/codebases/{codebaseId}/blobs/sha256/{hh}/{hash}` (`blobKeyForHash`,
  [`blob-stores/index.js`](../packages/agent/src/blob-stores/index.js)).
- **But the blob store runs inside the agent**, holding **account-level R2/S3
  credentials** (`HOPIT_R2_ACCESS_KEY_ID` / `HOPIT_R2_SECRET_ACCESS_KEY`), and the
  agent chooses the key path. D1 stores only the `blob_key` reference; the Worker
  never proxies blob bytes. **So today any client holding the shared sync R2
  credentials can read or overwrite *any* codebase's blob prefix — cross-tenant blob
  access.** Shared (non-owner-private) content is stored **plaintext** unless a
  client-encryption zone covers it. For a single trusted operator this is fine (there
  is one client); for strangers, possession of the sync credentials would grant
  cross-tenant blob access. **This is the single biggest isolation gap for strangers
  and must move blob authority behind a per-tenant boundary** (Decision 2d).

### 1.4 Single-tenant control-plane gaps

- **One D1 database + one R2 bucket under the owner's account.** The whole system
  points at a single D1 (`database_id: "5447007f-…"`,
  `cloudflare/d1/wrangler.proxy.jsonc:22-28`) and a single R2 bucket `hopit-blobs`
  (`docs/personal-production.md:27`, `137-144`). Every tenant's rows and blobs share
  **account-wide free-tier ceilings** — 10 GB R2, 5 GB / 100k writes-per-day D1
  (`storage-pricing-research-2026-07.md §2`). One tenant's growth is subtracted from
  everyone's free ceiling.

- **`HOPIT_OWNER_EMAIL` semantics — narrower than the roadmap implies.** The
  single-tenant gate is *not* on the create/own path; it is only the owner-claim
  adoption path. `requireOwnerClaimActor` (`helpers/actors.js:24-34`) throws unless
  the authenticated verified email equals `process.env.HOPIT_OWNER_EMAIL`, and it
  guards only two methods: `bootstrapAccount` and `claimCodebaseOwner`
  (`members.js:22-143`), which exist to **adopt pre-existing `local-owner` codebases**
  (agent/import-created before a browser login) into a real Clerk user.
  `GET /api/codebases` calls `bootstrapAccountForCodebaseList` on *every* request
  (`src/app/api/codebases/route.ts:27`, `164-178`); for a non-owner email it throws,
  is caught, and returns an error summary — **but the same stranger can still create
  and list *their own* codebases.** So the app is "single-tenant" only in the adoption
  path and in operator intent, not in the create/own data path.

- **`'local-owner'` sentinel ownerId.** `createCodebase` falls back to `'local-owner'`
  when there is no `actor.userId`, and `bootstrapAccount` adopts exactly those rows.
  Fine single-user; in multi-tenant a `local-owner` codebase is an unowned/ambiguous
  row.

- **Basic-auth fallback returns an empty actor `{}`.** `cloudActorFromRequest`
  (`src/lib/request-cloud-actor.ts`) resolves, in order: (1) an `hst_` token → agent
  access; (2) a Clerk session; (3) a basic-auth fallback that returns an **empty
  actor `{}`** when `allowBasicFallback` is set — a wildcard that downstream
  visibility code treats specially. Acceptable for a locked-down single operator;
  **it is a tenant bypass in true multi-tenant and must be disabled** (Decision 2e).

- **Quotas are nonexistent.** `createCodebase` (`graph.js:604-691`) performs **no
  per-user codebase-count check, no storage check, no plan check** — it only rejects
  a duplicate id (`graph.js:611`). There is no `subscriptions`, `usage`, `plan`, or
  `quota` table anywhere (schema has 31 tables; `packages/backend-d1/src/schema.js` —
  none meter anything; grep confirms no `quota`/`usage`/`meter`/`stripe`/`subscription`/`billing`
  symbols in `src`, `packages`, `cloudflare`). A signed-in Clerk user can create
  unlimited codebases via `POST /api/codebases` (`src/app/api/codebases/route.ts:45-71`,
  which requires only `auth().userId`, not even a verified email).

- **Billing is nonexistent.** No Stripe/Paddle/Lemon-Squeezy code, no webhook route,
  no `subscriptions` table, no `plan` column anywhere. Clerk plan is Free with paid
  add-ons off (`docs/personal-production.md:476`).

- **The blob budget is a single global env var, not a quota.** The agent-side budget
  lives in [`blob-stores/index.js:80-98`](../packages/agent/src/blob-stores/index.js)
  and reads `HOPIT_BLOB_STORAGE_BUDGET_BYTES` / `HOPIT_BLOB_FREE_ONLY` from *one
  process env* (default `r2DefaultFreeOnlyBudgetBytes = 8_000_000_000`, i.e. 8 GB, vs
  the `r2FreeStorageTierBytes = 10_000_000_000` free ceiling —
  `packages/agent/src/constants.js:93-94`). It is enforced by the *uploading agent*
  (`assertWithinBudget`, `index.js:422-433`) against a bucket-wide prefix scan — it is
  **not per-tenant**, and a tenant running their own agent config can simply raise it.
  It protects the *operator from themselves*, not any one user's fair share. There is
  **no server-side meter** for storage, and **none at all** for D1 writes — which the
  pricing research names as the binding cost constraint.

- **Rate limiting is almost absent.** The only limiter on the worker is an in-memory
  *failed-auth* bucket (`api-worker.js:27-29`, `299-324`): 20 failed auths per IP per
  5 min, per isolate (not durable, not shared across the worker's many isolates).
  There is **no limit on successful authenticated request volume, statement count, or
  write throughput.** Device-auth creation has a 10-per-15-min per-fingerprint cap
  (`device-authorizations.js:16-37`); the runbook documents a Cloudflare dashboard
  rule for failed-auth only (`docs/personal-production.md:232-239`). A single valid
  tenant can exhaust the shared D1 write ceiling for everyone.

- **No tenant/account/subscription entity exists.** "Tenant" today == a user
  (`owner_id`). There is no object above the codebase to hold plan, subscription
  status, or aggregate quota; a user with many codebases has no place to attach one
  subscription.

- **Schema drift to watch when adding Phase-3 tables.** The **live schema is
  `packages/backend-d1/src/schema.js`** (31 `create table` + 2 `alter table`), applied
  at runtime via `ensureSchema`. **`cloudflare/d1/schema.sql` is stale**: it is
  missing `codebase_settings`, `trail_episodes`, and the
  `device_authorizations.requested_codebase_id/_name` columns that `schema.js` adds.
  Phase-3's `subscriptions`/`usage` tables must be added to **`schema.js`** (and
  `schema.sql` re-synced) and owner-applied to the production D1 per the migration
  procedure in `docs/personal-production.md:191-193`.

**Summary:** the *data model* is multi-tenant; the *control plane* (provisioning,
metering, billing, isolation-at-the-worker, isolation-of-blobs, abuse limits) is
single-tenant. Phase 3 is almost entirely control-plane work on top of an
already-tenant-shaped schema.

---

## 2. Design overview and decisions

Introduce one new first-class entity — the **tenant** (a billing account, 1:1 with a
Clerk user in v1) — and hang three things off it: a **subscription**, a **usage
meter**, and an **entitlement** (the plan's limits). Sync and quota enforcement
consult the entitlement; billing webhooks keep the subscription fresh; the meter is
written on the same paths that already journal to D1.

```
Clerk user ──1:1──> tenant ──1:1──> subscription ──> entitlement (plan limits)
                      │
                      ├──1:N──> codebases (owner_id = user_id; tenant_id denormalized)
                      └──1:1──> usage_meter (storage bytes, D1 writes/day, seats)
```

v1 keeps `tenant == user` to avoid an org model this phase (orgs are Phase 4). Code
addresses tenants through a `tenant_id` indirection so a later org tenant is an
additive change, not a rewrite.

### (a) Tenant boundary — where does one tenant's data physically live?

**Options.**

- **A1 — Shared D1 tables keyed by owner (current shape), hardened.** Keep the one
  `hopit` database; every row stays keyed by `codebase_id`/`owner_id`. Close the
  proxy-token hole so isolation is *enforced*, not just *filtered*.
- **A2 — Per-tenant D1 database.** One D1 database per tenant (or per codebase),
  provisioned at signup via the Cloudflare D1 API. Physical isolation; a tenant's
  worst case is their own database.
- **A3 — Hybrid.** Shared control-plane tables (`users`, `subscriptions`,
  `device_authorizations`) in one D1; per-tenant *data* databases for
  `codebases/files/file_versions/…`.

**Weighing.** D1 is **10 GB per database** with 5 GB free
(`storage-pricing-research-2026-07.md §2`). Under A1 all tenants share one 10 GB
database — a single ceiling and a single hot database, but at 31 tables of *metadata*
(blob bytes live in R2) that is thousands of tenants. A2/A3 give each tenant their own
10 GB (effectively unlimited per tenant) but multiply operational surface. A1's
isolation blast radius is "one bad query = cross-tenant read"; correctness rests on
every method carrying the right predicate **and** on finally closing the proxy-token
bypass. A2/A3 make the "provably isolated" proof almost trivial (different
`database_id`), but require dynamic provisioning (create D1 + apply schema at signup),
a `codebase_id → database_id` routing layer, the Cloudflare D1 REST API (Workers
cannot bind DBs dynamically without a deploy), and application-level fan-out for
control-plane joins — a multi-week worker re-architecture.

**Recommendation: A1 (shared tables, hardened) for Phase 3, with A3 as the documented
escape hatch.** At Phase-3 scale (first handful-to-hundreds of paying strangers) a
single 10 GB metadata database is not the constraint. Make A1 *provably* isolated via
the two-front hardening in Decision (d). **Record the A3 split trigger explicitly:
when the shared metadata database approaches ~7 GB (70% of the 10 GB cap) or any
single tenant exceeds ~1 GB of D1 metadata, split data tables to per-tenant
databases.** Until then, A1 is correct and cheap. *(This is surfaced as an
either/or in the Decisions list — both drafts leaned shared/hardened; the dissent is
per-tenant DBs for structural isolation at the cost of the re-architecture above.)*

### (b) Billing provider — one person selling a $7/mo flat sub

The seller is a **solo founder** (`docs/product-roadmap.md:23-24`). The dominant
concern is **not** API ergonomics but **who is the merchant of record (MoR)** — who is
legally responsible for collecting and remitting sales tax/VAT across every
jurisdiction a stranger might sign up from.

**Options.**

| Option | Model | Tax / VAT | Fees | Notes |
|---|---|---|---|---|
| **B1 — Stripe Billing** | You are merchant of record | *You* register, collect, file, remit (Stripe Tax computes only) | ~2.9% + 30¢ (lowest) | Industry default; best API/docs; Customer Portal; SCA handled; test mode + Stripe CLI `trigger` + fixtures |
| **B2 — Paddle (MoR)** | Paddle is reseller/MoR | Paddle handles global registration/collection/remittance; first-line on chargebacks | ~5% + 50¢ | Solid API/webhooks; subscriptions first-class; heavier redirect UX; sandbox |
| **B3 — Lemon Squeezy (MoR)** | LS is MoR | Same tax offload as Paddle | MoR band (~5%) | Developer-friendly, indie-SaaS focused; now Stripe-owned (small roadmap/continuity risk); test mode |
| Roll-your-own | — | — | — | Rejected: PCI + dunning + tax is not our product |

**This is the primary owner decision and the two drafts disagreed** (draft A: MoR;
draft B: Stripe now). It is surfaced as an explicit either/or in §9. The billing
plumbing is deliberately **provider-agnostic**: a `subscriptions` table fed by signed
webhooks, so B1/B2/B3 differ only in the webhook adapter — the choice is reversible.
At $7/mo flat with ~83% gross margin (`storage-pricing-research-2026-07.md §4.b`) the
fee delta between Stripe (~$0.50) and an MoR (~$0.85) is **~$0.35/user/mo**.

**Recommendation: a merchant-of-record provider (Paddle or Lemon Squeezy).** For one
person, ~$0.35/user is cheap insurance against global tax compliance becoming a second
job; between the two, pick on onboarding friction. **Dissenting view (draft B): start
on raw Stripe** — simplest integration, lowest fee, we are low-volume, and since the
plumbing is provider-agnostic, switching to an MoR before broad EU marketing is a cheap
later change. Either way the entitlement the agent enforces against is *our own row*,
refreshed by webhook and a daily reconcile job, so a missed webhook degrades to a
stale-but-safe entitlement, not an outage; the webhook signature is always verified.

Plan shape (both drafts agree): one **Product** with one **recurring Price = $7/mo
flat** (above GitHub Pro $4, below the $10 2 TB consumer plans, per research §4.b),
**30 GB included storage**, overage **$0.05/GB-mo beyond 30 GB** (~3× the ~$0.015 R2
cost, restoring margin on storage-heavy tenants) billed as a metered price that can
ship **dark (reported, not charged)** until enabled.

**Owner actions required (blocking, cannot be built around):**
- Create the billing account (Stripe or MoR), complete business/identity verification
  and payout bank details (a personal/financial action for the owner).
- Create the single `$7/mo` product/price and capture its id.
- Store the API key and webhook signing secret in Vercel + Cloudflare secrets (never
  in repo/docs, matching `docs/personal-production.md:39`).
- Add the public **privacy policy and terms pages** the roadmap already flags
  (`docs/personal-production.md:71`) — MoRs and Google OAuth verification both require
  them.

### (c) Quota model — what is metered, and where is it enforced?

Per the pricing research, **the cost driver is D1 rows written at $1.00/M**
(`storage-pricing-research-2026-07.md §2`, `§4.c`), *not* storage — one active heavy
user's journal writes ($5/mo at 5M rows) can exceed their storage cost and turn the
flat sub margin-negative. Meter three things, in priority order:

1. **D1 rows written per rolling (UTC) day** — the binding cost constraint. Free
   ceiling is 100,000 rows/day **account-wide**; ~7 rows/save after coalescing
   (backed by the already-shipped write-coalescing work — `HOPIT_SYNC_DEBOUNCE_MS`
   collapses same-path bursts ~10×). The daily budget is a backstop for the
   pathological case, not the common path.
2. **Storage bytes (R2 + D1)** — the user-legible number and the natural upgrade
   lever; the plan's headline included-GB figure (30 GB, `§4.b`), overage protection
   beyond it.
3. **Seats / codebase count** — always 1 seat in v1 (tenant == user; metered now so
   Phase 4 orgs inherit the plumbing) plus a cheap codebase-count abuse bound.

Worker requests and Durable Object connections are **observed but not gated** in v1
(research: not the binding constraint; the 10M/mo request bundle is generous).

**Where enforced — server-side, because the agent's env is tenant-controlled (§1.4):**

- **Storage bytes + D1 writes/day — enforced in the Cloudflare Worker (Plane B,
  authoritative).** The Worker already re-reads `readScopedFileAccess` per mutating
  batch; extend that read to also load the tenant's current usage meter + entitlement
  and reject the guarded head update when the write would exceed the hard cap. The
  daily-write meter is incremented **atomically as part of the same batch** (the
  Worker counts the rows it is about to write), so a tenant cannot journal without
  also incrementing their meter. This is the trustworthy point because the agent
  cannot bypass it — the token is bound to the codebase, which resolves to a tenant. A
  per-tenant running counter (a `usage` row, or a Durable Object counter reusing the
  existing `HOPIT_PUSH_HUB` per-codebase DO — `wrangler.proxy.jsonc:8-15`) is the
  natural home; kept as one indexed row per tenant per day to stay cheap (reads ~free,
  §2).
- **Subscription-active / seat / codebase-count gate — enforced in the Next backend
  (Plane A)** at session issuance (`hop add` device approval) and at codebase create:
  refuse to mint a new writing agent session, or create an additional codebase beyond
  the free allowance, without an active entitlement.
- **Agent pre-flight (advisory, fast-fail UX only).** Extend the existing agent budget
  check (`blob-stores/index.js:422-433`) from a single global env var to a
  **server-provided per-tenant budget** fetched at sync start, so the agent refuses to
  upload before wasting a round trip. The worker remains the real gate.

**Behavior at the limit (never data loss, never read lockout)**, matching the roadmap
"soft warn → hard block on writes but never data loss or lockout of reads":

1. **80% of any limit** — dashboard + menu-bar warning; a `usage.warning` event.
   Nothing blocks.
2. **100% storage** — new object-blob writes that would grow storage are rejected at
   the Worker with a typed `quota_exceeded` error; the agent surfaces it and **holds
   the change on local disk** (the existing coalescing-window durability contract —
   the file on disk is untouched, re-attempted after the next scan). Reads, hydration,
   compare, export, and delete/GC (which *reduce* storage) always remain allowed.
3. **100% D1 writes/day** — the Worker returns `quota_exceeded_daily`, the agent backs
   off and retries after the UTC day rolls, edits accumulate on disk. Reads
   unaffected.
4. **Subscription lapsed (past_due beyond grace / canceled)** — the tenant drops to
   the **free entitlement**: writes gated to the free storage cap, but **all reads and
   full data export stay open indefinitely** (git export is the escape hatch). Never
   hold a paying-lapsed tenant's data hostage; **never** an automated hard-delete (a
   prohibited-class action).

Metering data model: a `subscriptions` table (plan, status, provider ids,
current-period bounds) and a `usage`/`usage_meter` table or per-codebase DO counter
(stored bytes, rows-written-today, seats/codebase-count), refreshed on mutation and
reconciled nightly against an R2 prefix scan (the agent already scans a prefix —
`readUsage`, `blob-stores/index.js:435-459`; the meter increment is in the same
guarded batch as the write so it cannot skew).

#### Addendum — quota metering + enforcement, **implemented behind flag** (Stage 2-3, 2026-07-13)

The per-tenant **usage meter and quota enforcement** are now implemented and gated
by `HOPIT_MULTITENANT` (default **off** ⇒ zero metering overhead and byte-for-byte
single-tenant behavior) with the hard-block layer additionally gated by
`HOPIT_ENFORCE_QUOTA` (Stage-3 sub-gate: the master flag meters, this flag blocks).
Of the model options above, the choices made:

- **Metering model — MAINTAINED tally folded into the write batch (chosen over
  computed-on-read).** A new additive table `tenant_usage(tenant_id PK, plan,
  storage_bytes, write_day, rows_written_today, …)` in
  [`packages/backend-d1/src/schema.js`](../packages/backend-d1/src/schema.js) — one
  indexed row per tenant (v1 `tenant_id == owner_id`), so a **single indexed read
  resolves both the plan AND current usage**. The Worker counts the mutating
  statements it is about to run and folds **exactly one** meter upsert into the same
  tenant batch (`cloudflare/d1/quota.js` `buildMeterUpsertStatement`), so a tenant
  cannot journal without also incrementing its meter (they commit/roll back
  together). **Measured added write cost: +1 D1 row written per mutating save batch**
  (the meter row itself, which is *not* counted against the tenant's own budget) — no
  5-counter amplification. The rolling daily counter resets inside the upsert when
  `write_day` rolls to a new UTC day, so no scheduled reset job is needed. Storage is
  an additive tally of guarded file sizes (approximate — a re-save re-adds a path's
  size — and reconciled nightly against a prefix scan; the exact-delta alternative
  would cost a read-before-write on every save). **Codebase count is computed on read**
  at create time (a cold path), never maintained, so the hot path stays at +1 row.
- **Enforcement points (matching Decision c).** Storage bytes + daily D1 writes are
  enforced in the **Cloudflare Worker** (Plane B, un-bypassable): before executing a
  tenant (`hst_` session OR `hsa_` server-actor) mutating batch, the Worker reads the
  tenant's meter + plan and **rejects a cap-crossing write with a typed `429`
  `quota_exceeded_daily` / `quota_exceeded_storage`** (error code `1008`, carrying
  `{code, kind, limit, used, requested, plan}`) BEFORE any statement runs — so no data
  is written and the agent holds the change on local disk. **Reads, exports, hydrate,
  compare, and deletes are never routed through the gate.** The subscription / seat /
  **codebase-count** gate is enforced in the **Next backend** (Plane A) at
  `createCodebase` (`packages/backend-d1/src/graph.js` `assertCodebaseCreationWithinQuota`):
  free = 1 codebase, returning an honest typed `quota_exceeded_codebases`
  ("upgrade to add more") error; seat/subscription are always-allow stubs
  (`packages/backend-d1/src/quota.js` `assertSeatAvailable` / `assertSubscriptionActive`)
  structured for Stage 5 to fill in.
- **Soft-warn → hard-block ladder + status surface.** `computeUsageStatus` reports
  per-line `used/limit/ratio/state` with `state ∈ {ok, warn(≥80%), block(≥100%)}`.
  Two honest read-only surfaces expose it (UI is a later slice): a Worker
  **`GET/POST /usage`** endpoint (authed by the same `hst_`/`hsa_`/proxy principals;
  a caller only ever sees its own tenant meter; **404 with the flag off**) for the
  desktop agent, and a `readTenantUsage` backend method (server-actor may read its
  *own* `tenant_usage` row on Plane A) for the dashboard.
- **Plan resolution.** `tenant_usage.plan` (`free|paid`, default `free` on first
  insert and never overwritten by the meter path — billing owns it) is the single
  indexed lookup; caps derive from that plan via **owner-tunable env knobs** so
  retuning never needs a data migration.
- **Free-tier default → caps** (Decision 4): **2 GB storage, 2,000 D1 rows/day,
  1 codebase; reads/export always open.** Paid: **30 GB, 50,000 rows/day, effectively
  unlimited codebases.** An over-quota free tenant's reads/exports keep working.

**Owner-tunable env knobs** (Worker env for storage/daily-write enforcement; the Next
backend reads the same names from its env for the codebase-count gate + status
display), all with the free/paid defaults above:
`HOPIT_QUOTA_FREE_STORAGE_BYTES` (2_000_000_000), `HOPIT_QUOTA_FREE_DAILY_WRITES`
(2000), `HOPIT_QUOTA_FREE_CODEBASES` (1), `HOPIT_QUOTA_PAID_STORAGE_BYTES`
(30_000_000_000), `HOPIT_QUOTA_PAID_DAILY_WRITES` (50000), `HOPIT_QUOTA_PAID_CODEBASES`
(1_000_000), `HOPIT_QUOTA_WARN_RATIO` (0.8), and the Stage-3 enforcement sub-gate
`HOPIT_ENFORCE_QUOTA` (off). The new `tenant_usage` table is owner-applied to the
production D1 per the migration procedure in `docs/personal-production.md:191-193`.

Proven by tests (`cloudflare/d1/api-worker.test.js` — quota helpers, meter fold,
over-daily/over-storage hard block with nothing written, reads-still-work, free vs
paid, `/usage` surface + flag-off 404; `packages/agent/test/quota-enforcement.test.js`
— end-to-end against a real SQLite Worker: codebase-count gate at create, meter
accumulation + UTC day-roll reset in real SQLite, `readTenantUsage` warn state):
flag-off appends no meter and leaves the batch byte-for-byte; flag-on folds exactly
one meter row; an over-cap write is rejected at the Worker (429) with no data written
while a read of the same codebase still succeeds; the isolation and proxy/`hst_`/`hsa_`
paths are unchanged with the flag on.

### (d) Tenant isolation hardening — the two-front change that makes strangers safe

**Every data access resolves to a `tenant_id`, and every enforcement point checks it.**
The two liabilities from §1.2–1.3 are independent and **both** must close for "provably
isolated":

**Front 1 — D1 dashboard path (retire the proxy super-token).** The hosted dashboard
must call D1 as a **per-request scoped principal**, not the omnipotent proxy token.
Give the Next API a worker auth mode that carries `actor.userId` and is re-checked by
the worker against `codebase_members`/`owner_id` — i.e. extend the scoped-session model
to a "server-actor" token that still passes through `readScopedFileAccess`
(`api-worker.js:100-122`) rather than bypassing it. Add a lint/test that **every**
`/api/*` handler routes through `requireGraphCapability` or an explicit public marker
(close the "discipline-only" gap in §1.2). The proxy super-token survives only for rare
admin/migration jobs, out of the tenant request path.

**Front 2 — R2 blobs (remove account credentials from clients).** Options:

- **(d-i) Per-tenant scoped R2 credentials via a blob-broker Worker (recommended).**
  The agent stops holding account R2 keys; it asks a Worker endpoint (authed by its
  `hst_` token, already codebase-bound) for a short-lived **presigned URL** scoped to
  that codebase's key prefix (`codebases/{codebaseId}/blobs/...`), or the Worker
  proxies the PUT/GET. The Worker is the only holder of R2 credentials and signs only
  within the caller's prefix. Cross-tenant blob access becomes impossible because no
  client ever holds a credential that reaches another prefix. Presign is cheaper than
  proxying bytes (keeps egress on-Cloudflare, research §4.c risk 2).
- **(d-ii) Mandatory client-side encryption of all content**, so even shared content
  in R2 is ciphertext keyed per codebase (`codebase_keyrings`). Defends confidentiality
  if a key leaks, but not integrity/overwrite, and complicates server-side
  compare/summaries.
- **Recommendation: d-i (presigned, per-codebase) as the isolation guarantee, with
  d-ii's encryption retained for owner-private/secret zones as defense in depth.**

Keep every `backend-d1` method's `codebase_id`/`user_id` predicate and both fronts
under the isolation suite as a regression gate. Stripe/MoR customer ids and webhook
payloads live on the tenant row; never place tenant data in URLs; the webhook endpoint
verifies signatures.

#### Addendum — Front 1 mechanism, **implemented behind flag** (Stage 1a, 2026-07-13)

The Front-1 **server-actor** principal is now implemented and gated by
`HOPIT_MULTITENANT` (default **off**, so single-tenant production is byte-for-byte
unchanged until the owner flips it). Mechanism chosen, of the options in this
section:

- **Per-request server-actor credential (chosen).** When the flag is on, the hosted
  dashboard stops using the proxy super-token for authenticated tenant data. The
  `@hopit/backend-d1` client instead mints a short-lived bearer token carrying the
  authenticated Clerk user id, signed with a shared secret
  `HOPIT_D1_SERVER_ACTOR_SECRET` (HMAC-SHA256): `hsa_<base64url(payload)>.<sig>`,
  `payload = {u:userId, iat, exp}` (`packages/backend-d1/src/server-actor-token.js`).
  The Worker re-derives the user id from the signature
  (`cloudflare/d1/api-worker.js` `verifyServerActorToken`) — a forged/absent/expired
  token fails closed.
- **New policy tier BETWEEN `proxy` and `session`.** `authorizeRequest` returns a new
  `{kind:'server-actor'}`. Each statement passes `assertServerActorStatementAllowed`
  (`cloudflare/d1/scoped-sql.js`), a deny-by-default classifier: codebase-scoped
  tables must name a `codebase_id = ?` (no `OR`/`IN`/`!=`/`LIKE`/subquery on
  `codebase_id`); `codebases`/`codebase_members` may instead be **user-anchored**
  (owner_id/user_id predicates that must equal the actor) so a user can list THEIR
  OWN codebases; the `users` table is limited to the actor's own row plus a
  read-only invitation email lookup; every other table is refused. The Worker then
  **dynamically re-checks** that each referenced `codebase_id` is one the actor owns
  or is an active member of (`assertServerActorEntitlement`, a
  `codebases`⋈`codebase_members` lookup) before executing anything.
- **What flips when the flag flips.** Flag **off**: an `hsa_` token is not accepted
  at all (falls through to the auth error), and the client never mints one — proxy +
  `hst_` paths are identical to today. Flag **on**: `cloud-backend.ts` threads the
  authenticated actor into every tenant-data call so the client presents an `hsa_`
  token; a statement touching a codebase the user neither owns nor belongs to is
  rejected at the Worker (not merely filtered in app code). The `hst_` scoped-session
  firewall is untouched. The dashboard runs with `assume-schema` so DDL never rides
  the tenant path.
- **Residual proxy usage (admin/capability-secret only, not user-enumerable tenant
  data).** DDL/migrations, the owner-claim `bootstrapAccount`/`claimCodebaseOwner`
  paths (`HOPIT_OWNER_EMAIL`, off the hot path), the public device-authorization
  create/poll/read flow, invitation **accept-by-token**, and
  `approveDeviceAuthorization` still use the proxy token — each is gated by an
  unguessable secret (token/user-code) rather than by user id, so it is not a
  cross-tenant enumeration surface. Migrating these secret-keyed lookups onto the
  server-actor tier (e.g. by pinning a known `codebase_id`) is a documented Stage-1b
  follow-up.

Proven by tests (`cloudflare/d1/api-worker.test.js` server-actor block;
`packages/agent/test/server-actor-dashboard.test.js` end-to-end against a real
SQLite Worker): flag-off refuses `hsa_`; flag-on rejects a cross-tenant statement
and allows a user reading their own multiple codebases; forged/expired tokens are
refused; proxy and `hst_` behavior is unchanged with the flag on.

#### Addendum — Front 2 mechanism (R2 blob broker), **implemented behind flag** (Stage 1b, 2026-07-13)

The Front-2 **R2 blob broker** is now implemented and gated by `HOPIT_MULTITENANT`
(default **off**, so the direct-S3-credential blob path is byte-for-byte unchanged
until the owner flips it). Mechanism chosen, of the options in §2d Front 2:
**(d-i) per-codebase presigned URLs from a broker Worker (recommended).**

- **Broker endpoint on the existing D1 Worker (not a sibling).** A new
  `POST /blob-presign` route on `cloudflare/d1/api-worker.js` (logic in
  `cloudflare/d1/blob-broker.js`). The Worker already has no R2 binding; the broker
  **holds the R2 S3 credentials as Worker secrets** and mints SigV4 **query-string
  presigned URLs** (WebCrypto HMAC, `UNSIGNED-PAYLOAD`, path-style, short TTL
  default 120 s). Presign — not byte-proxying — keeps R2 egress on-Cloudflare
  (research §4.c risk 2). The route only exists when the flag is on; with the flag
  off it falls through to the Worker's 404, so nothing about single-tenant changes.
- **Same principals as the D1 firewall.** The broker authenticates the caller with
  the SAME auth the query path trusts: an `hst_` scoped session (entitled to exactly
  its bound `codebase_id`), the `hsa_` server-actor (entitlement re-checked via the
  Stage-1a `assertServerActorEntitlement` codebases⋈codebase_members lookup), or the
  admin proxy token (migration/GC tooling; key-scoped but not membership-checked). A
  forged/expired/absent principal fails closed before anything is signed.
- **Prefix-scoping is the isolation invariant.** The broker refuses any key that is
  not the managed blob key of the caller's entitled codebase —
  `assertBrokerKeyForCodebase` requires an exact match of
  `{HOPIT_BLOB_PREFIX}/codebases/{encoded-id}/blobs/sha256/{hh}/{hash}` (mirrors the
  agent's `isManagedBlobKey`; rejects `..`/`//`/`\`). A caller entitled to codebase A
  therefore (a) cannot name codebase B (refused at entitlement) and (b) cannot pass a
  B-key under an A entitlement (refused at the prefix check) — and because the
  signature covers the exact object path + method, a **returned URL cannot be widened**
  to another key or a different verb.
- **Agent gains a `broker` blob-store mode** (`BrokerBlobStore`,
  `packages/agent/src/blob-stores/index.js`), selected by `HOPIT_BLOB_BROKER` (flag
  on). It **never holds account R2 credentials**: for each read/write it asks the
  broker for a presigned URL (authed by its existing `hst_` session token from
  `HOPIT_AGENT_SESSION_TOKEN`) then does a single raw GET/PUT. Flag off keeps the
  existing `r2`/`s3`/`b2` direct providers unchanged.
- **GC / usage-enumeration stay an admin/server-side operation off the tenant client
  path.** They need a bucket-wide LIST that only the account credentials can do, so
  `BrokerBlobStore.readUsage/listBlobs/deleteBlob` throw a typed
  `broker_mode_unsupported` error. Storage-budget enforcement moves server-side
  (Stage 3, `HOPIT_ENFORCE_QUOTA`); GC continues to run as an admin job using the
  direct-credential path (flag off, or a dedicated admin config), never on the tenant
  request path.

**Owner secrets/bindings to set before flipping the flag** (parallel to Stage 1a's
`HOPIT_D1_SERVER_ACTOR_SECRET` note): the Worker needs the R2 S3 signing
credentials as **Wrangler secrets** — `HOPIT_R2_ACCESS_KEY_ID`,
`HOPIT_R2_SECRET_ACCESS_KEY`, `HOPIT_R2_BUCKET`, and either `HOPIT_R2_ACCOUNT_ID`
(endpoint derived as `https://<account>.r2.cloudflarestorage.com`) or an explicit
`HOPIT_R2_ENDPOINT`; optional `HOPIT_R2_REGION` (default `auto`),
`HOPIT_BLOB_BROKER_TTL_SECONDS` (default 120), and **`HOPIT_BLOB_PREFIX` which MUST
equal the agent's `HOPIT_BLOB_PREFIX`** (the two ends compute the same namespace).
The agent gets `HOPIT_BLOB_BROKER=1` plus a broker URL
(`HOPIT_BLOB_BROKER_URL`, or derived from `HOPIT_D1_API_BASE_URL` as
`<base>/blob-presign`) and **must have its account R2 keys removed** so it can only
reach blobs through the broker. These are set as Vercel + Cloudflare secrets, never
in repo/docs (matching `docs/personal-production.md:39`).

Proven by tests (`cloudflare/d1/api-worker.test.js` broker block —
key-scope/presign/entitlement; `packages/agent/test/blob-broker-store.test.js`
end-to-end against a real SQLite Worker broker + a fake R2): flag-off makes the
endpoint 404 and `createObjectBlobStore` returns the direct S3 store unchanged;
flag-on issues an own-codebase URL and round-trips a blob with no account creds on
the client; a codebase-A client cannot presign/read/write a codebase-B blob
(entitlement + prefix both refuse); forged/unscoped/unknown principals are refused
before signing; the `hst_` firewall and proxy path are unchanged with the flag on.

### (e) Signup-to-first-sync onboarding & the no-card experience

Today's flow for the owner is: Clerk sign-in → (owner-only) bootstrap claims migrated
codebases → `hop setup`/`hop add` device authorization → agent syncs. For a *stranger*,
three things are missing between "Clerk user exists" and "workspace provisioned": a
plan/entitlement state, an auto-provisioned first tenant, and the no-card path.

```
hopit.dev → Clerk sign-up (open) → tenant auto-provisioned on first authed request
          → create first codebase (free entitlement) → hop add (device approval) → first sync
          → [billing wall appears here] → checkout → paid entitlement
```

1. **Tenant auto-provision.** On the first authenticated request from a new Clerk user,
   upsert a `users` row (already via `upsertUser`, `graph.js:567-602`) and a `tenant`
   row with the `free` entitlement — **no card, no owner-email gate.** This replaces
   the owner-only `bootstrapAccountForCodebaseList` throw with a *universal* "provision
   this user's own tenant" step. The `HOPIT_OWNER_EMAIL` path is retained only as an
   optional *migration* switch for adopting legacy `local-owner` codebases, behind a
   flag, off the hot path. Upsert is idempotent on `user_id` (race-safe).
2. **Free entitlement / no-card path.** A stranger can sign up, create one codebase,
   `hop add`, and sync **on the free entitlement** up to the free cap — the "aha" that
   earns the subscription, and what satisfies the exit criterion's "sign up … and sync"
   *before* "and pay." The free tier is deliberately small so an abandoned free account
   cannot hoard the shared free ceiling (Decision c cost math). *(Open sub-question in
   §9: whether "free" is a permanent free entitlement or a time-boxed no-card trial —
   the two drafts framed it both ways; the caps are the same either way.)*
3. **Workspace provisioning stays quota-gated.** On codebase create, `createCodebase`
   (`graph.js:604`) now **checks the subscription/quota** first (codebase-count,
   entitlement-active). The device-authorization "create-requested codebase" path
   (`add.js`, `device-authorizations.js:44`) is the primary provisioning entry — note
   the approve route requires the codebase to *already* be visible to the approver
   (`approve/route.ts:27-30`), so the browser approval page must create the tenant
   codebase (via `POST /api/codebases`) *before* approving. That two-step stays, gated
   by quota.
4. **Device authorization → first sync** is unchanged mechanically (the strong part):
   approve mints a scoped `hst_` token wrapped to the device key
   (`device-authorizations.js:135-163`), the agent connects, push/pull sync begins.
5. **Where the billing wall sits: after first sync.** The wall triggers on the *second*
   value ask — a second codebase, a seat/invite (Phase 4), or crossing the free
   storage/write cap. This maximizes activation while capping free cost.
6. **Trial→paid conversion.** Checkout (hosted page) flips the `subscriptions` row to
   `active` on webhook; quota ceilings rise from free/trial to the 30 GB plan.
   **Cancellation** flips to `canceled`/free at period end; the tenant goes read-only
   (never silently deleted — see §7).
7. **Disable the basic-auth fallback and empty-actor path in the multi-tenant runtime**
   (`HOPIT_ALLOW_BASIC_AUTH_FALLBACK` off; ensure `cloudActorFromRequest` never returns
   `{}` when tenancy is on) — §1.4.

### (f) Abuse / rate limiting on the worker

The worker today has only the per-isolate failed-auth bucket (`api-worker.js:299-324`),
not durable. Phase 3 needs three layers:

- **Edge (Cloudflare, owner-configured).** A WAF/rate-limit rule on the `/query` and
  `/events` routes keyed by IP, extending the failed-auth rule the runbook specifies
  (`docs/personal-production.md:232-239`). Blocks crude floods before they reach the
  worker. *(Owner action: dashboard config.)*
- **Per-token successful-request limiting (new, durable).** A rolling per-`hst_` and
  per-tenant request/statement budget, held in the per-codebase Durable Object (the
  `HOPIT_PUSH_HUB` DO already exists per codebase and survives across isolates, unlike
  the in-memory map). This is the layer that stops *one valid tenant* from exhausting
  the shared D1 write ceiling — the noisy-neighbor case the in-memory limiter cannot
  see.
- **Statement-count / batch-size caps.** The worker already counts statements
  (`statementCountForBody`, `api-worker.js:326-329`); add a hard cap per request and
  reject oversized batches, so a single request cannot smuggle thousands of writes.

---

## 3. Staged implementation plan

Ordered so each stage lands independently and the exit criterion decomposes into
testable gates. Everything new sits behind `HOPIT_MULTITENANT` (master flag) plus
per-stage flags, all defaulting **off**, so single-operator production stays
byte-for-byte unchanged until each stage is proven. "Blocked" = needs an owner action
(billing account, Cloudflare paid plan); "Buildable now" = no external dependency.

| Stage | Deliverable | Flag | Gate (testable) | Blocked on |
|---|---|---|---|---|
| **0** (underway + spine) | `hst_` middleware wired; cross-tenant isolation suite; add `tenants`/`entitlements`/`usage_meters` tables (in `schema.js`); auto-provision tenant == user; denormalize `tenant_id` onto codebases; **meter recorded, not enforced** | `HOPIT_MULTITENANT` | A hosted `hst_` request succeeds; a tenant row appears + meter counts rows with enforcement off; suite proves tenant B cannot read/mutate tenant A | Buildable now (new tables owner-applied to prod per `personal-production.md:191-193`) |
| **1 — Isolation hardening** | Front 1: retire proxy super-token from the tenant path; dashboard calls D1 as a per-request scoped/server-actor principal re-checked by the worker + every `/api/*` handler routes through a capability check. Front 2: R2 blob broker/presign — remove account R2 keys from the agent | `HOPIT_BLOB_BROKER` (+ scoped-server-actor) | Isolation suite passes with the dashboard path AND blobs included; a forged/absent `user_id` yields zero cross-tenant rows; a tenant-B client cannot presign/read a tenant-A blob | Buildable now — **this stage is the "provably isolated" gate** |
| **2 — Account & subscription model** | `subscriptions` + `usage` tables (or per-codebase DO counter); universal user upsert on signup (Clerk webhook or first request); replace owner-only bootstrap with universal account-ensure; disable basic-auth empty-actor when tenancy on | `HOPIT_MULTITENANT` | New signup gets a `free`/`trialing` entitlement; `HOPIT_OWNER_EMAIL` no longer required for a stranger to have an account | Buildable now |
| **3 — Quota enforcement** | Storage-byte + daily-write + codebase-count checks in `createCodebase` (pre-flight) and the worker mutation path (authoritative); soft-warn→hard-block ladder; per-tenant budget served to the agent | `HOPIT_ENFORCE_QUOTA` | Over-quota create/sync fails closed with a legible error; at-limit holds on disk, reads open; under-quota unaffected; free cap < paid cap | Buildable now |
| **4 — Rate limiting** | Durable per-token/per-tenant request+write limiter in the codebase DO; statement-count caps; Cloudflare edge rule | (per-stage) | A single token cannot exceed its rolling budget (survives across isolates); batch bomb rejected | Worker code buildable now; edge rule + Workers Paid plan for DO billing = **owner action** |
| **5 — Billing plumbing** | Provider-agnostic checkout link + webhook route (`/api/billing/webhook`) that writes `subscriptions`; entitlement derivation; reconcile cron; trial→active→canceled drives quota + read-only | `HOPIT_BILLING` | Webhook fixture flips subscription state; signature-verified; unsigned/replayed rejected; canceled tenant goes read-only, not deleted | Test-mode/sandbox buildable now; **live: MoR/Stripe account, product/price id, webhook secret (owner)** |
| **6 — Open signup + onboarding UX** | Open Clerk signup; no-card free/trial signup → auto-provisioned first tenant → device authorization → first sync → billing wall → paid, end to end | `HOPIT_OPEN_SIGNUP` | A brand-new Clerk user reaches a synced workspace with no card; hits the wall; pays in test mode; quota rises | Stages 2–5 |

**Exit-criterion decomposition:** Stage 1 = *provably isolated*; Stage 6 (over 2+5) =
*sign up, pay, and sync*. Met when a fresh stranger account runs Stage 6 end to end
**and** the Stage-0/1 isolation suite is green with the dashboard path and blobs
included.

**Cloudflare paid-plan note.** Durable Object *SQLite billing* and DO request overage
are Workers-Paid features (`storage-pricing-research-2026-07.md §2`). Stage 4's DO
limiter and the existing `HOPIT_PUSH_HUB` assume DO availability; if the account is
still on Workers Free, moving to the **$5/mo Workers Paid minimum** is the one infra
owner-action that unblocks durable rate limiting and removes the 100k-request/100k-write
**per-day** free ceilings that a second paying tenant would otherwise threaten.

---

## 4. Cost math (per-tenant marginal cost & paid-transition thresholds)

Reusing `storage-pricing-research-2026-07.md` (all rates verified 2026-07-11;
re-verify before launch).

**Per-tenant marginal cost at the recommended A1 architecture**, moderate user (30 GB
stored, 300k journal writes/mo, 3M reads/mo, 300k Worker requests/mo):

| Line | Qty | Rate | Cost |
|---|---|---|---|
| R2 storage | 30 GB | $0.015/GB | $0.45 |
| R2 ops | 50k A + 500k B | free tier* | ~$0.00–0.40 |
| D1 rows written | 0.3M | $1.00/M | $0.30 |
| D1 rows read | 3M | $0.001/M | ~$0.00 |
| Workers requests | 0.3M | within 10M included | $0.00 |
| Durable Objects | hibernating | ~0 | ~$0.00 |
| **Marginal / user** | | | **≈ $1.00–1.20** |

Plus one **$5/mo Workers Paid account minimum**, amortized to ~$0 past a handful of
tenants. At $7/mo flat that is **~83% gross margin** (`§4.b`). The **D1 rows written
line is the one to watch** — a heavy user (200 GB, 5M writes/mo) costs ~$8.40/mo and
goes margin-negative, mitigated by the storage overage beyond 30 GB and the daily-write
fair-use cap from Decision (c) (`§4.b` sensitivity table: 5M writes/mo = $5 > storage
$3).

**Free-tier protection.** Free cap 2 GB ⇒ at least ~5 concurrent free tenants fit
inside the 10 GB R2 free ceiling before any R2 bill. Per-tenant daily D1-write budget
(proposal: free = **2,000 rows/day** ≈ ~285 saves/day; paid fair-use = **50,000
rows/day** ≈ ~7,000 saves/day) keeps any one tenant from exhausting the shared
account-wide 100k-rows/day ceiling (~14k saves/day across all tenants) and caps the one
cost line that can go negative.

**What tenant count forces the paid transitions** (all ceilings are **account-wide**,
consumed by the *sum* of tenants):

- **R2 storage 10 GB free → paid ($0.015/GB):** holds until the sum of tenant blobs
  exceeds 10 GB. With the owner's 7.2 GB already resident (`§1.3`), the **very first
  additional paying tenant likely crosses it** — but overage is trivial, so this is a
  billing-hygiene transition, not a scaling wall.
- **D1 writes 100k/day free → Workers Paid ($1.00/M):** ~14k saves/day across all
  tenants. A few active tenants reach it; this is the **first real forcing function**
  and the reason Stage 4 assumes Workers Paid.
- **Workers requests 100k/day free → 10M/mo Paid:** same order of magnitude; crossed
  at roughly the same tenant count.
- **D1 storage 10 GB/database:** the **A1→A3 split trigger** — metadata only, so
  thousands of tenants, but a single hard ceiling (Decision a: split at ~7 GB shared or
  ~1 GB/tenant).

**Bottom line:** the marginal tenant costs ~$1/mo against $7 revenue; the binding
constraint that forces the $5/mo Workers Paid plan is **D1 daily writes**, reached at
only a handful of active tenants — budget the Workers Paid transition as a Phase-3
launch cost, not a "later" cost.

---

## 5. Failure modes

- **Tenant data cross-contamination.** *Highest severity.* Two root causes today: the
  proxy super-token bypasses all worker scoping (`api-worker.js:73-74`), so D1
  isolation rests on every `backend-d1` method's predicate; and R2 blobs are written
  client-side with account-level credentials (§1.3), so the shared sync keys reach any
  tenant's blob prefix. *Mitigation:* Stage 1's two fronts (Decision d) — retire the
  proxy token from the tenant path + move R2 behind a per-codebase presign broker; the
  isolation suite is the regression gate; the scoped-SQL policy already forbids
  `OR`/`IN`/`!=` on `codebase_id` (`scoped-sql.js:281-283`).
- **Quota bypass.** A hostile agent can raise `HOPIT_BLOB_STORAGE_BUDGET_BYTES`
  (`blob-stores/index.js:83-87`) or skip the agent pre-flight, since the budget is
  client-side. *Mitigation:* the worker is the authoritative gate (Decision c); the
  agent check is advisory UX only; ceilings re-checked server-side on every mutation.
- **Billing state drift.**
  - *Paid-but-unprovisioned:* webhook confirms payment but the tenant has no
    account/quota row (race, or paid before first login). *Mitigation:* webhook upserts
    user+subscription idempotently (keyed by provider subscription/event id); a
    reconcile cron re-syncs nightly; entitlement stays free (safe) until confirmed.
  - *Canceled-but-active:* subscription canceled/expired but the tenant keeps syncing.
    *Mitigation:* the worker mutation gate checks subscription status; canceled →
    **read-only** (a grace period first), never delete; **all reads/export stay open
    indefinitely**; **never** an automated hard-delete (prohibited-class action).
- **Missed/duplicated webhook.** Entitlement derives from *our* row, updated by webhook
  *and* daily reconcile; webhooks idempotent on event id; a gap degrades to free
  (safe), never an outage or wrongful charge.
- **Meter drift** (crash between D1 write and meter increment). The meter increment is
  *in the same guarded batch* as the write, so it cannot skew; a nightly recompute of
  storage bytes from `files`/`file_blobs` corrects any divergence.
- **Proxy-token blast radius.** The proxy token is omnipotent across *all* tenants and
  skips scoping; if it leaks (logs, env exfiltration) every tenant's data is exposed.
  *Mitigation:* Stage 1 removes it from the request path (rare admin/migration only);
  rotate it (`docs/personal-production.md:180-190`); never log tokens/SQL/params
  (`api-worker.js:344-357` already omits them).
- **Noisy-neighbor exhaustion of shared free tiers.** One tenant's write storm consumes
  the account-wide 100k-writes/day D1 ceiling, degrading sync for *every* tenant — and
  the in-memory failed-auth limiter (`api-worker.js:27-29`) cannot see *successful*
  request volume and is per-isolate. *Mitigation:* Decision (f)'s durable per-tenant DO
  limiter + statement-count caps + shipped write-coalescing; move to Workers Paid so
  the ceiling is monthly-pooled (50M/mo) rather than a hard daily wall.
- **Trial/free abuse.** No-card free/trial is the cheapest attack surface (create
  account, hoard storage, abandon). *Mitigation:* free storage cap well below the paid
  30 GB (Decision c/e); codebase-count soft cap; the existing device-auth
  per-fingerprint rate limit (`device-authorizations.js:16-37`); a circuit breaker can
  pause *new free* signups without touching paying tenants.
- **Blob broker outage.** Agent holds edits on disk (existing durability contract) and
  retries; reads of already-synced blobs can fall back to cached presigned URLs within
  TTL. Egress leak off-Cloudflare (research §4.c risk 2): presign only R2
  (on-Cloudflare, free egress); never presign a non-Cloudflare mirror for reads.
- **`local-owner` legacy rows during migration.** Adoption runs behind the flag, maps
  `local-owner` → operator tenant, and is a one-time job, not a hot path.
- **Basic-auth fallback left on.** An explicit test asserts `cloudActorFromRequest`
  cannot return an empty actor when `HOPIT_MULTITENANT` is on.

---

## 6. Fixture-testable acceptance plan

Extend the Stage-0 isolation suite and the worker tests
(`cloudflare/d1/api-worker.test.js`, `scoped-sql`) and the fixture backend
(`FixtureJsonCloudGraphService`), plus billing **test-mode/sandbox** fixtures — no live
account, no real card, no real R2 for the isolation cases. All gates run against a
local fake worker/D1 fixture before touching production (mirroring WS7a). These cases
contribute to the **adversarial isolation suite being built separately** (WS7d-style;
`agent-cli.test.js` `adversarial|...` patterns, `access-security.test.js`).

**Tenancy + provisioning**
1. First authenticated request for a new Clerk user provisions exactly one tenant with
   the `free` entitlement; a second request is idempotent (no duplicate).
2. A stranger (email ≠ `HOPIT_OWNER_EMAIL`) can create a codebase, own it, and list
   only their own codebases — never another tenant's.

**Isolation (Stage 0/1, adversarial)**
3. Tenant B's `hst_` token cannot `select`/`insert`/`update`/`delete` any row with
   tenant A's `codebase_id` — every attempt rejects at
   `assertScopedSessionStatementAllowed` (`scoped-sql.js`); a malformed predicate
   (`codebase_id != ?`, `OR`, `IN`) is rejected (`scoped-sql.js:278-283`).
4. Tenant B's session cannot read tenant A's `files`/`file_versions`/`file_blobs` —
   `enforceScopedResultVisibility` returns zero rows (`api-worker.js:180-232`).
5. **Dashboard path (Front 1):** a request carrying tenant B's actor cannot list or
   mutate tenant A's codebases even though it reaches the worker — proving the proxy
   super-token no longer grants cross-tenant access.
6. **Blob path (Front 2):** a tenant-B client cannot obtain a presigned URL or proxy
   read/write for a tenant-A blob key; the broker signs only within the caller's
   codebase prefix.
7. A tenant-B request cannot read tenant-A's usage meter or entitlement.

**Quota (no billing account needed)**
8. Creating one codebase over the plan's codebase-count cap fails closed with a legible
   error; under-cap succeeds.
9. A sync that would push stored bytes over the tenant's storage ceiling is rejected by
   the worker even when the agent's local budget env is raised; the file **remains on
   local disk** and re-syncs after a delete frees space.
10. A tenant over its daily-write budget is throttled (`quota_exceeded_daily`); reads,
    compare, hydrate, and export still succeed; the counter resets on UTC day roll;
    write-coalescing keeps a normal editing burst well under the cap.
11. 80% warning emits `usage.warning` and blocks nothing.
12. A lapsed subscription drops the tenant to free limits but leaves **all reads and a
    full export** working — no data deleted.

**Billing (test mode/sandbox + webhook fixtures)**
13. A provider webhook fixture (signed) transitions a subscription
    `trialing/free → active → canceled`; an unsigned/replayed/bad-signature webhook is
    rejected and changes no entitlement; a valid webhook for tenant-A never mutates
    tenant-B.
14. A `canceled` subscription puts the tenant read-only (mutations rejected, reads
    allowed); **no data is deleted**.
15. Paid-but-unprovisioned: a webhook arriving before first login still yields a usable
    account after login (idempotent upsert); a missed webhook is repaired by the
    reconcile cron.

**Rate limiting (Stage 4)**
16. A single `hst_` token exceeding its rolling request/write budget is rejected
    durably (survives across worker isolates via the codebase DO).
17. An oversized statement batch is rejected before execution.

**Onboarding (Stage 6, end-to-end)**
18. A brand-new Clerk user with no card reaches a synced workspace: signup → `free`
    entitlement → create-requested-codebase via device authorization → `hst_` token
    wrapped to the device key → push/pull sync applies a revision (reuse the WS7a
    `push-applied` fixture).
19. That same user then completes checkout in test mode; the webhook flips the
    subscription to `active`; the storage ceiling rises from the free cap to 30 GB; a
    previously-over-free-cap sync now succeeds.

**Production acceptance:** the exit criterion is met when gates 18 + 19 run against a
real stranger account on `hopit.dev` and the isolation gates (3–7, dashboard path and
blobs included) are green in CI.

---

## 7. Decisions needed from owner

Each is a crisp question with a recommendation; the two open **either/or** choices are
marked. These are the questions to bring to the owner before build.

1. **Billing provider — EITHER/OR.** Raw **Stripe Billing** (you are merchant of
   record; lowest fee ~2.9%+30¢; *you* register/collect/remit sales-tax/VAT) **or** a
   **merchant-of-record** (Paddle / Lemon Squeezy; ~5%+50¢, they own global tax
   compliance and first-line chargebacks)?
   *Recommendation:* **a merchant-of-record (Paddle or Lemon Squeezy)** — for a solo
   founder the tax offload is worth the **~$0.35/user/mo** premium (negligible at ~83%
   margin). *Dissenting view:* **start on raw Stripe** — simplest integration, lowest
   fee, low volume; the plumbing is provider-agnostic (a `subscriptions` table fed by
   webhooks), so moving to an MoR before broad EU marketing is a cheap later change.
   (§2b.)

2. **Tenant boundary — EITHER/OR.** **Shared D1 tables keyed by owner, hardened** (A1)
   **or** **per-tenant databases** (A2/A3) for structural isolation?
   *Recommendation:* **A1 (shared, hardened)** for Phase 3 — a single 10 GB *metadata*
   database is thousands of tenants and per-tenant DBs are a multi-week worker
   re-architecture. *Dissenting view:* per-tenant DBs make "provably isolated" trivial
   (different `database_id`). **Split trigger to A3:** when the shared metadata DB nears
   **~7 GB (70% of 10 GB)** or any single tenant exceeds **~1 GB** of D1 metadata, split
   data tables to per-tenant databases. (§2a.)

3. **Plan shape.** Confirm **$7/mo flat, 30 GB included, $0.05/GB-mo overage beyond 30
   GB** (research §4.b)?
   *Recommendation:* **Yes**, and ship overage **reported-but-not-charged** first, flip
   charging on later. (§2b.)

4. **Free tier: caps and permanence.** What are the free caps, and is "free" a
   permanent entitlement or a time-boxed no-card trial? Proposal: **2 GB storage, 2,000
   D1 rows/day (~285 saves), 1 codebase, reads/export always open.**
   *Recommendation:* adopt those caps (keeps ~5 free tenants inside the 10 GB R2 free
   ceiling and bounds D1-write cost); **a permanent small free entitlement** is cleaner
   than a 14-day trial, but either works — the caps are identical. (§2c, §2e.)

5. **Where the billing wall sits.** Before first sync, or after (free sync, wall on the
   second codebase / cap crossing)?
   *Recommendation:* **after first sync** — free sync is the activation "aha"; wall on
   the second value ask. (§2e.)

6. **R2 isolation mechanism.** Per-tenant **presigned URLs from a blob-broker Worker**
   (recommended), full **byte-proxying** through the Worker, or **mandatory client-side
   encryption** as the primary boundary?
   *Recommendation:* **presigned per-codebase URLs** (removes account keys from clients,
   keeps egress free), with client-side encryption retained for owner-private/secret
   zones as defense in depth. (§2d.)

7. **Quota enforcement point.** Confirm **storage + daily-D1 enforced in the Cloudflare
   Worker** (Plane B, un-bypassable) and **subscription/seat/codebase-count gate in the
   Next backend** (Plane A)?
   *Recommendation:* **Yes** — the Worker is the only point the tenant cannot bypass.
   (§2c.)

8. **Retire the D1 proxy super-token from the tenant request path.** Confirm the
   dashboard calls D1 as a per-request scoped/server-actor principal re-checked by the
   worker, with the proxy token reserved for admin/migration only?
   *Recommendation:* **Yes** — this closes the largest dashboard-path isolation
   liability. (§1.2, §2d.)

9. **Tenant == user in v1?** Defer any org/team tenant to Phase 4 while addressing
   everything through a `tenant_id` indirection now?
   *Recommendation:* **Yes** — 1:1 tenant/user this phase; org is additive later.
   (§2.)

10. **Disable basic-auth fallback + empty-actor in the multi-tenant runtime.** Confirm
    `HOPIT_ALLOW_BASIC_AUTH_FALLBACK` is forced off and the empty-actor path is closed
    once `HOPIT_MULTITENANT` is on?
    *Recommendation:* **Yes** — it is a tenant bypass in a real multi-tenant world.
    (§1.4, §2e.)

11. **`hst_` dashboard-API path.** Fix the dead agent-token path in `src/proxy.ts` this
    phase (letting `Bearer hst_` reach route handlers for programmatic/AI access)?
    *Recommendation:* **Yes**, in Stage 0/6 — it becomes load-bearing for the AI story.
    (Stage 0.)

12. **Data-retention policy on lapse/close.** How long are reads/export kept open after
    a subscription lapses or a Clerk account is deleted before GC?
    *Recommendation:* **reads/export open indefinitely on lapse; a 30-day grace then GC
    on account close** — never hold data hostage, never automated hard-delete. (§2c,
    §5.)

13. **Workers Paid plan.** Approve moving to the **$5/mo Workers Paid minimum** to
    unblock the durable DO rate limiter (Stage 4) and remove the 100k/day free ceilings?
    *Recommendation:* **Yes** — budget it as a Phase-3 launch cost; D1 daily writes force
    it at a handful of active tenants. (§3, §4.)

14. **Staging billing.** Approve building and testing entirely against **test
    mode/sandbox + webhook fixtures** (no live account/charges until launch)?
    *Recommendation:* **Yes** — the whole billing stage is provable in CI without a live
    account. (§3, §6.)

---

## 8. Appendix — key file map

| Concern | File(s) |
|---|---|
| Middleware / `hst_` block | `src/proxy.ts`; `src/lib/request-cloud-actor.ts`; `src/lib/auth-config.ts` |
| Worker auth + proxy-token bypass | `cloudflare/d1/api-worker.js:71-98`, `180-232` |
| Scoped-SQL policy (Plane B) | `cloudflare/d1/scoped-sql.js` |
| Dashboard access checks (Plane A) | `packages/backend-d1/src/access.js`; `packages/backend-d1/src/helpers/access.js` |
| Codebase create (no quota) | `packages/backend-d1/src/graph.js:604-691` |
| Tenant listing / visibility | `packages/backend-d1/src/graph.js:498-565`; `packages/backend-d1/src/access.js` |
| Owner-email bootstrap | `packages/backend-d1/src/helpers/actors.js:24-34`; `packages/backend-d1/src/members.js:22-143` |
| Sessions / token mint | `packages/backend-d1/src/sessions.js` |
| Device authorization | `packages/backend-d1/src/device-authorizations.js`; `src/app/api/device-authorizations/approve/route.ts`; `packages/agent/src/commands/add.js` |
| R2 blob store (client-side account creds) | `packages/agent/src/blob-stores/index.js` (`blobKeyForHash`, `assertWithinBudget:422-433`, `readUsage:435-459`); `packages/agent/src/constants.js:93-94` |
| Dashboard D1 client (proxy token) | `src/lib/cloud-backend.ts:277-279`; `src/lib/config.js:31-33`; `src/app/api/codebases/route.ts` |
| Encryption keyrings (per-entity) | `packages/backend-d1/src/schema.js` (`user_keyrings`, `codebase_keyrings`, `wrapped_keys`) |
| Schema (31 tables, no billing/quota; `schema.sql` stale) | `packages/backend-d1/src/schema.js`; `cloudflare/d1/schema.sql` |
| Push hub DO (rate-limit host) | `cloudflare/d1/push-hub.js`; `cloudflare/d1/wrangler.proxy.jsonc:8-15` |
| Isolation test seeds | `cloudflare/d1/api-worker.test.js`; `packages/agent/test/access-security.test.js`; `agent-cli.test.js` (WS7d) |

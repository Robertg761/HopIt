# Storage & Platform Pricing Research — HopIt Billing (Phase 3)

**Date:** 2026-07-11
**Purpose:** Feed the Phase 3 flat-subscription billing design in `docs/product-roadmap.md`.
**Scope:** Object-storage cost math (R2 vs alternatives), Cloudflare platform ceilings that bound per-user cost, competitor/consumer price anchors, and a pricing recommendation.
**All prices are list, USD, verified by web search on the access date shown per source. Do not trust older training data — re-verify before the billing launch.**

---

## TL;DR

1. **The owner's 7.2 GB costs ~$0/month.** R2's free tier is **10 GB of Standard storage** per month, and 7.2 GB fits inside it with room to spare. Even at full paid rates it is only **7.2 × $0.015 = $0.11/mo**. The 800 MB self-imposed budget was far more conservative than the actual free ceiling.
2. **Storage is not the cost driver — D1 writes are.** R2 storage is $0.015/GB-mo with **free egress**, which is the whole moat. The thing that can blow up per-user cost is **D1 rows written at $1.00/million**, because the agent journals every save (write amplification).
3. **The real fixed cost is one $5/mo Workers Paid minimum for the whole account**, amortized across all users. Marginal per-user cost at moderate use is roughly **$1.00–$1.50/mo**.
4. **Defensible flat price: $6–8/mo** with ~25–50 GB included storage and a fair-use cap on journal writes. That sits between GitHub Pro ($4/mo) and a 2 TB consumer plan ($10/mo), and undercuts Bitbucket/GitLab paid tiers massively for solo/small users.

---

## 1. Object-storage cost math

### 1.1 Headline rates (per provider)

| Provider | Storage $/GB-mo | Write ops | Read ops | Egress | Free tier / minimum |
|---|---|---|---|---|---|
| **Cloudflare R2** (Standard) | **$0.015** | Class A $4.50/M | Class B $0.36/M | **$0 (free)** | 10 GB storage, 1M Class A, 10M Class B / mo free |
| **Backblaze B2** (pay-go) | **$0.006** ($6/TB) | Free (since May 2026) | Free (since May 2026) | Free up to 3× stored/mo, then $0.01/GB; **free via Cloudflare CDN** | No hard minimum |
| **AWS S3 Standard** | **$0.023** (first 50 TB) | PUT/POST/LIST $0.005/1k | GET $0.0004/1k | First 100 GB/mo free, then $0.09/GB | New accts: $200 credits/6mo, no perpetual free GB |
| **Wasabi** | **$7.99/TB** ($0.008/GB) | Free | Free | Free within 1:1 storage ratio | **1 TB minimum billing** → $7.99/mo floor; 90-day min storage duration |
| **Hetzner Object Storage** | bundled | Free | Free | 1 TB included, then $1.20/TB | **$5.99/mo base** = 1 TB storage + 1 TB egress (flat floor) |

Notes:
- **R2 rounds billable units up** (e.g. 1.1 GB bills as 2 GB), and the free tier is **account-wide, not per-user**.
- **B2's May-2026 change made all standard API calls free** (except Event Notifications), and egress through Cloudflare's CDN is unlimited-free — so an R2→B2 mirror pattern is essentially storage-only cost.
- **Wasabi and Hetzner are flat-floor products** — they only make sense above ~750 GB–1 TB. For a single small user they are the *most* expensive option despite the low headline $/TB.

### 1.2 Monthly cost for one user — 50k writes + 500k reads + 5 GB egress

Operations held constant: 50,000 writes/mo, 500,000 reads/mo, 5 GB egress/mo. Storage varied.

**Cloudflare R2** — marginal (ignoring the account-wide free tier), then the owner's actual bill (free tier applied):

| Stored | Storage | Write ops (Class A) | Read ops (Class B) | Egress | **Marginal total** | **Owner bill (free tier)** |
|---|---|---|---|---|---|---|
| 1 GB | $0.015 | $0.225 | $0.18 | $0 | **$0.42** | **$0.00** |
| 10 GB | $0.15 | $0.225 | $0.18 | $0 | **$0.56** | **$0.00** |
| 50 GB | $0.75 | $0.225 | $0.18 | $0 | **$1.16** | **$0.60** (40 GB over free) |
| 200 GB | $3.00 | $0.225 | $0.18 | $0 | **$3.41** | **$2.85** (190 GB over free) |

(50k writes and 500k reads are both far inside R2's 1M/10M free-op allowance, so ops are effectively free for the owner; the "marginal" column shows what they'd cost once the account-wide op free tier is exhausted by other users.)

**Backblaze B2** (ops free; egress free via Cloudflare CDN, else 5 GB is within 3× ratio above ~1.7 GB stored):

| Stored | Storage | Ops | Egress | **Total** |
|---|---|---|---|---|
| 1 GB | $0.006 | $0 | ~$0.02 (2 GB over 3× ratio) or $0 via CDN | **~$0.01–0.03** |
| 10 GB | $0.06 | $0 | $0 | **$0.06** |
| 50 GB | $0.30 | $0 | $0 | **$0.30** |
| 200 GB | $1.20 | $0 | $0 | **$1.20** |

**AWS S3 Standard** (egress free under 100 GB/mo in 2026):

| Stored | Storage | PUT (50k) | GET (500k) | Egress | **Total** |
|---|---|---|---|---|---|
| 1 GB | $0.023 | $0.25 | $0.20 | $0 | **$0.47** |
| 10 GB | $0.23 | $0.25 | $0.20 | $0 | **$0.68** |
| 50 GB | $1.15 | $0.25 | $0.20 | $0 | **$1.60** |
| 200 GB | $4.60 | $0.25 | $0.20 | $0 | **$5.05** |

**Wasabi** — 1 TB minimum ⇒ **$7.99/mo flat** at every tier ≤ 1 TB (no op or egress fees). Only competitive above ~1 TB.

**Hetzner** — 1 TB base bundle ⇒ **$5.99/mo flat** at every tier ≤ 1 TB. Only competitive above ~1 TB.

**Ranking for a small single user:** R2 (free) < B2 ($0.01–1.20) < S3 ($0.47–5.05) < Hetzner ($5.99 flat) < Wasabi ($7.99 flat). R2's free tier + free egress makes it the clear default; B2 is the cheapest paid overflow/mirror.

### 1.3 The owner's immediate question: hosting the extra ~7.2 GB

Three projects, ~3.2 GB + 2.2 GB + 1.8 GB = **7.2 GB**, mostly media/binaries.

| Provider | Monthly cost for 7.2 GB | Notes |
|---|---|---|
| **R2 (free tier)** | **$0.00** | 7.2 GB < 10 GB free ceiling |
| R2 (paid rate, if free tier consumed elsewhere) | **$0.11** | 7.2 × $0.015 (rounds to ~$0.12 with unit rounding) |
| Backblaze B2 | **$0.04** | 7.2 × $0.006; ops + CDN egress free |
| AWS S3 Standard | **$0.17** + ops | storage only; add ~$0.45 if 50k/500k ops |
| Wasabi | **$7.99** | 1 TB minimum — do not use |
| Hetzner | **$5.99** | 1 TB base — do not use |

**Answer: hosting all 7.2 GB on R2 is free today** and stays under ~$0.15/mo even at paid rates. There is no cost reason to keep the 800 MB budget; the only reason to cap is to protect the *account-wide* 10 GB free ceiling across all tenants once HopIt has more than one user. Binary/media weight matters for R2 Class A upload ops during initial sync, but 7.2 GB of blobs is a few thousand PUTs — negligible against the 1M/mo free Class A allowance.

---

## 2. Cloudflare platform ceilings that bound per-user cost

One **Workers Paid plan ($5/mo minimum per account)** unlocks the paid tiers of Workers, D1, and Durable Objects together. Below are the free ceilings and overage rates; the question is **which dimension hits a paid threshold first for a heavy user.**

| Service | Free ceiling | Paid included | Overage rate | Notes |
|---|---|---|---|---|
| **Workers requests** | 100,000 / **day** | 10M / mo | **$0.30 / M** | Each save is ≥1 Worker request |
| **Workers CPU** | 10 ms / invocation | 30M CPU-ms / mo | $0.02 / M CPU-ms | Rarely the binding constraint |
| **D1 rows read** | 5M / **day** | 25B / mo | **$0.001 / M** | Cheap; dashboard/presence scans |
| **D1 rows written** | 100,000 / **day** | 50M / mo | **$1.00 / M** | ⚠️ The expensive dimension |
| **D1 storage** | 5 GB total | 5 GB, then $0.75/GB-mo | $0.75 / GB-mo | 10 GB per-database cap |
| **Durable Objects** | (Paid only for SQLite billing) | 1M req/mo, then $0.15/M | duration billed while awake | Hibernation stops duration billing after 10s idle |
| **R2** | 10 GB, 1M Class A, 10M Class B | — | $0.015/GB, $4.50/M A, $0.36/M B | Free egress |

**Which hits first (numbers, not vibes):**

- **On the free plan, the binding constraints are the two 100k/day limits: Workers requests (100k/day) and D1 rows written (100k/day).** They are the same magnitude, but D1 writes are amplified: one save journals *multiple* rows (journal entry + file metadata + change-set head + presence/toe-detection index), so a save typically costs 1 Worker request but **N D1 row-writes**. D1 rows written therefore exhausts first per unit of user activity.
- **On the paid plan, D1 rows written is the cost driver by a wide margin.** At **$1.00/M**, D1 writes are ~3.3× the price of Workers requests ($0.30/M) and **1,000× the price of D1 rows read** ($0.001/M). Reads are effectively free; writes are the meter that matters.
- **Durable Objects with WebSocket Hibernation are cheap for presence/collab** — duration billing stops after 10s idle, and incoming WS messages bill at a 20:1 discount (100 messages = 5 request-equivalents). Not a first-order cost unless objects are kept hot.

**Bottom line:** the first paid threshold a sync-heavy user crosses is **D1 rows written**, driven by per-save journaling. That is the number to engineer against.

---

## 3. Competitor & consumer price anchors

### 3.1 Code hosting

| Product | Price | Storage / bandwidth included | LFS / large-file terms |
|---|---|---|---|
| **GitHub Free** | $0 | Unlimited public+private repos; 10 GB LFS storage + bandwidth | LFS now **metered**: overage bandwidth $0.0875/GB; +50 GB storage & bandwidth = $5/mo |
| **GitHub Pro** | **$4/user/mo** | Same 10 GB LFS included | Metered LFS beyond 10 GB |
| **GitHub Team** | **$4/user/mo** (annual) | 250 GB LFS; 2 GB Packages/org; 3,000 Actions min | Metered overage |
| **GitLab Free** | $0 | Small caps | — |
| **GitLab Premium** | ~$29/user/mo (annual; self-managed $19) | — | Now often "Let's talk" quote |
| **GitLab Ultimate** | ~$99/user/mo | — | Custom pricing |
| **Bitbucket Free** | $0 (≤5 users) | 1 GB storage, 1 GB LFS, 50 CI min | — |
| **Bitbucket Standard** | $3.65/user/mo, **5-seat minimum → $91.25/mo floor** | +storage $10/mo per 100 GB | Punitive for solo users |
| **Bitbucket Premium** | $7.25/user/mo (5-seat min) | — | — |

**What users demonstrably pay for code hosting:** solo/small developers pay **$0–4/mo** (GitHub Free or Pro). Anything above that (GitLab Premium, Bitbucket's 5-seat floor) is priced for teams, not individuals. HopIt's addressable price for a solo user is anchored by GitHub Pro at **$4/mo**.

### 3.2 Consumer raw-GB anchors

| Service | Plan | Price | Implied $/TB-mo |
|---|---|---|---|
| **iCloud+** | 200 GB | $2.99/mo | ~$15/TB |
| **iCloud+** | 2 TB | $9.99/mo | ~$5/TB |
| **Google One** | 200 GB | $2.99/mo | ~$15/TB |
| **Google One** | 2 TB | $9.99/mo | ~$5/TB |
| **Dropbox Plus** | 2 TB | $11.99/mo | ~$6/TB |

**What users demonstrably pay for raw GB:** ~**$3/mo for 200 GB** and ~**$10/mo for 2 TB**. Consumers are anchored to "a few dollars a month for hundreds of GB." HopIt's own R2 cost ($0.015/GB-mo = $15/TB list, but ~$5–6/TB after the free tier and free egress) is *below* what consumers already happily pay Apple/Google/Dropbox — there is comfortable headroom.

---

## 4. Recommendation

### 4.a Cheapest sane path for the owner's 7.2 GB now

**Keep everything on R2; drop the 800 MB cap; do nothing else.** 7.2 GB fits in the 10 GB free tier at $0/mo, and even at paid rates it's ~$0.11/mo. Reserve **Backblaze B2** ($0.006/GB, free CDN egress) as the paid overflow/backup mirror if the account-wide free 10 GB gets consumed by future tenants — B2 is ~2.5× cheaper than R2 on raw storage and, mirrored through Cloudflare, keeps egress free. Do **not** use Wasabi or Hetzner at this scale (flat 1 TB minimums of $5.99–7.99/mo).

### 4.b Defensible flat subscription

**Recommend: $7/mo flat, with 30 GB of included storage and a fair-use journal-write cap.**

Reasoning: sit above GitHub Pro ($4) to reflect the hosting+sync+CI+agent value, and below the 2 TB consumer plans ($10) so raw-GB comparisons feel generous. 30 GB included is 3× GitHub's LFS allowance and covers the owner's 7.2 GB many times over.

**Gross-margin math at $7/mo, moderate user (30 GB stored, 300k journal writes/mo, 3M reads/mo, 300k Worker requests/mo):**

| Cost line | Quantity | Rate | Cost |
|---|---|---|---|
| R2 storage | 30 GB | $0.015/GB | $0.45 |
| R2 ops | 50k A + 500k B | within free op tier* | ~$0.00–0.40 |
| D1 rows written | 0.3M | $1.00/M | $0.30 |
| D1 rows read | 3M | $0.001/M | ~$0.00 |
| Workers requests | 0.3M | within 10M included | $0.00 |
| Durable Objects | hibernating | duration ~0 | ~$0.00 |
| **Marginal total** | | | **≈ $1.00–1.20/user** |

\*R2's 1M/10M op free tier and Workers' 10M-request bundle are **account-wide**, so the more users share the account, the closer marginal op cost trends to the raw rate. Budget ~$0.40 ops headroom per user to be safe.

Plus a **fixed $5/mo Workers Paid minimum per account**, amortized to near-zero once there are more than a handful of users.

**Gross margin at $7/mo ≈ ($7 − $1.20) / $7 ≈ 83%.** Even doubling the marginal cost estimate leaves ~65% margin.

**Sensitivity — heavy user (200 GB stored, 5M journal writes/mo):**

| Cost line | Quantity | Rate | Cost |
|---|---|---|---|
| R2 storage | 200 GB | $0.015/GB | $3.00 |
| R2 ops | heavy | | ~$0.40 |
| **D1 rows written** | **5M** | **$1.00/M** | **$5.00** |
| **Marginal total** | | | **≈ $8.40/user** |

At $7/mo this user is **gross-margin negative**, and note **D1 writes ($5.00) exceed storage ($3.00)** as the cost — confirming §2's finding. Mitigate with (i) an **overage on storage beyond the 30 GB included** (e.g. $0.05/GB-mo, ~3× cost, so 200 GB adds ~$8.50 in overage and restores margin), and (ii) a **journal-write fair-use cap** or, better, **write coalescing** (see §4.c).

### 4.c Structural risks

1. **D1 write amplification is the margin killer.** The agent journals every save, and one save fans out into multiple row-writes (journal + metadata + change-set head + toe-detection index). At $1.00/M rows written, a very active user or a shared-account team can generate the single largest per-user cost line — larger than storage. **Mitigation: batch/coalesce journal writes** (debounce many rapid saves into one row-write; append to a compact log rather than updating multiple indexed rows per save). This is both a cost fix and architecturally cleaner. Watch for toe-detection fan-out becoming N² across watchers.
2. **Egress is free on R2 — but only on R2.** The entire cost model depends on staying on Cloudflare (Workers/r2.dev/S3 API egress is free). Any path that serves blobs off-Cloudflare, or a B2 mirror that egresses *not* through the Cloudflare CDN, reintroduces per-GB egress ($0.01/GB B2, $0.09/GB S3). Keep all blob delivery on-Cloudflare.
3. **Account-wide free tiers hide true marginal cost.** R2's 10 GB / 1M / 10M and Workers' 10M requests are per-*account*, not per-user. Early margins look infinite because one user consumes shared free allowance; model marginal cost at the **raw rates** (as in §4.b) for capacity planning, not at the free-tier-inclusive owner bill.
4. **Unbounded storage users.** A single 200 GB user costs ~$3/mo in R2 storage alone. Without an included-GB cap + overage, storage-heavy users erode margin quietly. The 30 GB-included + overage structure in §4.b contains this.
5. **Wasabi's 90-day minimum storage duration and both Wasabi/Hetzner 1 TB floors** make them traps for a churny, small-object workload — avoid unless HopIt aggregates well past 1 TB and wants a flat-rate backend.

---

## Implementation notes — journal write coalescing (2026-07-12)

Shipped the §4.c mitigation "batch/coalesce journal writes." Two changes in the
local agent's watch/sync pipeline; no durability change, no worker/dashboard/schema
change. Row counts below are counted from the D1 statement paths
(`packages/backend-d1/src/graph.js` `commitJournalEntry` / `commitJournalEntryChunk`,
plus one `agent_events` insert per emitted event in `packages/agent/src/io.js`) and
corroborated by fixture-backed tests in `packages/agent/test/sync-coalescing.test.js`
(observed cloud revisions, `sync.complete`, and `cloud.acknowledged` counts).

**Measured D1 write amplification, end to end (rows *written*).** Reads
(readGraph, push-notify head/changed-file lookups) are excluded — writes are the
$1.00/M meter.

*One save of one file* — `codebases` head update + `files` upsert + `file_versions`
insert = **3 graph rows**, in one guarded batch (one HTTP round trip). Plus one
`agent_events` row per emitted event — `sync.started`, `write.journaled`,
`cloud.acknowledged`, `sync.complete` = **4 event rows**. **Total 7 rows / save**
(4 event inserts are 4 separate round trips). Single-file cost is unchanged by
this work — coalescing changes how *many* saves become a commit, not the per-commit
cost.

*Burst of N=10 saves of the same path within seconds* (spaced wider than the old
250 ms micro-debounce, i.e. a normal human editing cadence):

| | cloud revisions | D1 rows written |
|---|---|---|
| **Before** (250 ms debounce, no coalescing) | 10 | 10 × 7 = **70** |
| **After** (2000 ms window, 5000 ms cap) | 1–2 | **7–14** |

A same-path burst that settles inside the 5 s cap collapses to **one** revision =
**7 rows** — a **10×** cut (test: `same-path save burst coalesces into one cloud
revision with the final content` asserts exactly one revision bump, one
`sync.complete`, one journal entry carrying the *final* content). A burst that runs
longer than the cap flushes at most every 5 s, so a continuously-typed minute is a
handful of revisions, not one per save. `HOPIT_SYNC_DEBOUNCE_MS=0` restores the
old 70-row / 10-revision behavior exactly.

*Burst of M=10 saves to distinct paths coalesced into one sync* — the second
change batches a multi-file commit into a single guarded round trip:

| | head-row writes | graph rows | event rows | round trips |
|---|---|---|---|---|
| **Before** (per-file commit loop) | 10 | 3×10 = 30 | 22 | 10 |
| **After** (one batched commit) | **1** | 2×10+1 = 21 | 13 | **1** |

~35% fewer rows and 10× fewer round trips for a 10-file coalesced sync; the win is
the collapse of N `codebases` head-row writes into one (test: `distinct-path save
burst still commits every file in one coalesced sync` asserts all files land, one
`sync.bulk_commit`, one `sync.complete`).

**What changed vs. what was already adequate.**
- *Already adequate:* the watch scheduler already coalesced sub-250 ms filesystem
  event storms into one sync pass, and the bulk-commit path already batched large
  backlogs (>40 entries) into one round trip per 40-entry chunk with a guarded
  compare-and-swap. Reads already fetch only codebase head metadata before a full
  graph read.
- *(a) Save coalescing:* `createWatchSyncScheduler` now uses an env-tunable quiet
  window (default 2000 ms) with a hard delay cap (default 5000 ms from the first
  unsynced change) so rapid same-path saves collapse into one journaled write
  carrying the final content, while a never-idle editor still flushes within the
  cap. Flushes immediately once saves stop (after the quiet window).
- *(b) Multi-file batching:* lowered `bulkJournalCommitThreshold` from 20 to 1 so
  any 2+ entry commit (sync or recovery) uses the existing guarded batch — one
  `codebases` head-row write and one HTTP round trip instead of one per file.
  Single-file commits stay on the direct path (identical row count, no bulk
  summary event). The batch shape (exactly one guarded head + one guarded
  file/version op per path) already satisfies the worker's scoped-session
  statement policy (`assertScopedMutationBatch`), so no worker change was needed.

**Durability is unchanged.** Nothing is journaled or sent to the cloud during the
coalescing window — the edit lives only on disk until flush. A crash mid-window
therefore loses at most the window's uncommitted keystrokes *from the cloud*; the
file on disk is untouched and is journaled + committed by the next scan on restart
(recovery runs first, then the sync pass picks up the on-disk change). Proven by
`a crash mid-window loses nothing on disk: the edit is journaled on the next scan`.

**Env knobs** (also `--sync-debounce-ms` / `--sync-max-delay-ms`; forwarded across
service restart):
- `HOPIT_SYNC_DEBOUNCE_MS` — coalescing quiet window in ms. Default `2000`. `0`
  disables coalescing and the delay cap (legacy 250 ms micro-debounce).
- `HOPIT_SYNC_MAX_DELAY_MS` — hard cap on how long the first unsynced change is
  held. Default `5000`; clamped to be ≥ the debounce window.

**Test/suite counts after this work:** agent `267` (was 262; +5 in
`sync-coalescing.test.js`), worker `23`, web `47`, `typecheck:agent` clean.

---

## Sources (accessed 2026-07-11)

- Cloudflare R2 Pricing — https://developers.cloudflare.com/r2/pricing/
- Cloudflare D1 Pricing — https://developers.cloudflare.com/d1/platform/pricing/
- Cloudflare Workers Pricing — https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare Durable Objects Pricing — https://developers.cloudflare.com/durable-objects/platform/pricing/
- Backblaze B2 Pricing — https://www.backblaze.com/cloud-storage/pricing
- Backblaze B2 Transaction Pricing — https://www.backblaze.com/cloud-storage/transaction-pricing
- AWS S3 Pricing — https://aws.amazon.com/s3/pricing/
- Wasabi Pricing — https://wasabi.com/pricing and https://docs.wasabi.com/docs/may-2026-wasabi-pricing
- Hetzner Object Storage — https://www.hetzner.com/storage/object-storage/
- GitHub Pricing — https://github.com/pricing
- GitHub Git LFS Billing — https://docs.github.com/billing/managing-billing-for-git-large-file-storage/about-billing-for-git-large-file-storage
- GitLab Pricing — https://about.gitlab.com/pricing/
- Bitbucket Pricing — https://www.atlassian.com/software/bitbucket/pricing
- iCloud+ / Google One / Dropbox consumer pricing — https://bestcloudstorageguide.com/blog/icloud-pricing-2026-pricing-guide-2026 ; https://www.spliiit.com/en/blog/dropbox-vs-google-one-vs-icloud-comparatif

*Secondary/aggregator cross-checks (used only to corroborate primary pages): leanopstech.com, mecanik.dev, costbench.com, checkthat.ai. Where an aggregator and an official page disagreed, the official page's number was used.*

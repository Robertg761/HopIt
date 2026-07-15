# Trail Summaries: Implementation Notes (2026-07-12)

Engine/CLI slice of Phase 2 "Trail summaries" (`docs/product-roadmap.md`). This
records the choices resolved while building it. Desktop/dashboard surfacing is a
later slice; this slice is engine + CLI only.

## What shipped

1. **Episode clustering**: `packages/backend-d1/src/episodes.js` (`clusterEpisodes`).
   Pure, deterministic, no I/O. Consumes the file-version rows the WS7c history
   layer already records (path, device, timestamp per graph revision) and groups
   them into episodes. Exported from `@hopit/backend-d1`.
2. **Storage**: additive D1 tables `trail_episodes` and `codebase_settings`
   (`packages/backend-d1/src/schema.js`), plus backend methods in
   `episodes-store.js`. Equivalent methods on the local/dev fixture backend
   (`FixtureJsonCloudGraphService`) store the same data under top-level
   `trailEpisodes` / `codebaseSettings` keys in the cloud JSON.
3. **Summarizer provider interface**: `packages/agent/src/summaries/`. Thin,
   provider-agnostic. Adapters: `openai` (default), `gemini` (fallback), `stub`
   (deterministic, used in all tests). The prompt/response contract and the
   metadata-vs-diff privacy boundary live in `payload.js`, not the adapters.
4. **Opt-in config**: per-codebase, persisted in `codebase_settings`.
   Managed by `hop trail summaries on|off [--mode metadata|diff]`. Default OFF.
5. **CLI**: `hop trail` command group: `episodes`, `summarize`, `summaries`.
6. **Nightly backup tie-in**: `hop backup` now writes `trail-episodes.json` and
   references episode counts + the latest label in `manifest.json`.

## Resolved choices

### Clustering
- A **step** is one graph revision (a save; may touch many files). Steps are
  ordered by `(timestamp, revision)`.
- Steps join the same episode while they share a **device** and the gap to the
  previous step is **≤ threshold**. Default threshold **30 min**, tunable via
  `--gap-minutes` / `--gap-ms` (`HOPIT_*` not needed: it's a per-invocation
  flag). A gap exactly at the threshold stays in the same episode; one second
  over splits.
- Episode shape: `{ episodeId, fromRevision, toRevision, deviceName, startedAt,
  endedAt, stepCount, changedPathCount, samplePaths }`.
- `episodeId = ep_<fromRevision>_<toRevision>`: deterministic and stable
  because episodes never overlap, so a `(from,to)` pair is unique per codebase.
- `samplePaths` is the sorted distinct path list capped at 5;
  `changedPathCount` reports the full distinct count.

### Storage / config home
- Opt-in lives in a **`codebase_settings` D1 row**, not the local workspace
  index: the setting is per-codebase (not per-device), travels with the
  codebase, and is queryable server-side for the eventual dashboard. Absence of
  a row means **disabled**: off is the honest default with no migration.
- `trail_summaries_mode` (`metadata` | `diff`) is the separate diff opt-in.
- `trail_episodes` stores `step_count`, `changed_path_count`, `sample_paths_json`
  beyond the spec's columns so the dashboard and backup manifest can render an
  episode without re-reading full history. All additions are new
  `create table if not exists` statements (not `alter`), so they apply cleanly
  to pre-existing databases; `ensureSchema` already tolerates re-runs.

### Model decision (owner, 2026-07-12)
- **Default: OpenAI `gpt-5.4-mini`** via `/v1/chat/completions`.
- **Fallback: Google `gemini-2.5-flash-lite`** via `:generateContent`
  (`x-goog-api-key` header). Both endpoints/model ids verified 2026-07-12.
- Model ids and endpoints are **config, not constants**: see
  `summaries/config.js` `PROVIDER_DEFAULTS`. Everything is overridable by env
  (`HOPIT_SUMMARY_PROVIDER` / `HOPIT_SUMMARY_MODEL` / `HOPIT_SUMMARY_API_KEY` /
  `HOPIT_SUMMARY_BASE_URL` / …) or CLI flag (`--summary-provider`, etc.). The
  "local model later" roadmap option is just another adapter.

### Privacy enforcement (the load-bearing rules)
- **Off by default; impossible when off.** `summarizeEpisodes` checks the opt-in
  first and returns before the provider is constructed or called. Proven by a
  test that passes a provider whose `label()` throws and asserts it is never hit.
- **Metadata-only default.** The metadata payload contains **only** device,
  revisions, timestamps, `stepCount`, `changedPathCount`, `samplePaths`. There
  is no code path that can place file contents into a metadata payload: diff
  text is a separate argument dropped unless `mode === 'diff'`. Enforced at the
  single `buildEpisodePayload` boundary and asserted on the `--dry-run` output.
- **Full-diff is a second explicit switch.** `hop trail summaries on` sets
  `metadata`; diff requires `--mode diff`. `summarize` refuses diff unless the
  persisted mode is `diff`.
- **Bounded diff.** Diff text is assembled from the WS7c compare engine over an
  episode's sample paths and hard-capped at `HOPIT_SUMMARY_DIFF_MAX_CHARS`
  (default 8000), bounded again in the payload layer.

### Worker scoped-session policy (post-launch fix, 2026-07-12)
- The deployed worker's scoped-session statement policy
  (`cloudflare/d1/scoped-sql.js`) initially did not recognize the new tables, so
  `hop trail episodes` through a scoped session failed with "must be constrained
  to its codebase". Both tables are now in `codebaseScopedTables`; every
  statement the store issues binds `codebase_id` (reads in WHERE, upserts as a
  bound column with `codebase_id` in the conflict target), and cross-codebase or
  unscoped shapes stay rejected.
- Capabilities: **reads on both tables need `read`**; **`trail_episodes` writes
  need `write`** (derived work data, like `agent_events`); **`codebase_settings`
  writes need `admin`**: flipping summarization on or switching to diff mode is
  a codebase-wide privacy-posture change, treated like the policy's other
  codebase-level mutations. Consequence: `hop trail summaries on|off` through a
  scoped session requires an admin-capable session (or the owner D1 API token);
  the default `read,write,sync,watch` session can list and summarize but not
  flip the opt-in.

### Reliability
- Transient errors retried via the existing `cloud-retry.js`
  (`withCloudFetchRetry`); 4xx (auth/validation) fail fast, 429/5xx retry.
- Hard per-request timeout via `AbortController` (`HOPIT_SUMMARY_TIMEOUT_MS`,
  default 15s).
- Per-run episode cap (`HOPIT_SUMMARY_MAX_EPISODES`, default 50); `--limit`
  bounds a single run further.

## Payload examples

Metadata mode (the default: exactly what `--dry-run` prints):

```json
{
  "mode": "metadata",
  "device": "Laptop",
  "fromRevision": 1,
  "toRevision": 3,
  "startedAt": "2026-07-12T09:00:00.000Z",
  "endedAt": "2026-07-12T09:20:00.000Z",
  "stepCount": 3,
  "changedPathCount": 4,
  "samplePaths": ["src/auth/login.js", "src/auth/session.js"]
}
```

Diff mode (opt-in) adds one bounded `diff` string:

```json
{
  "mode": "diff",
  "device": "Laptop",
  "fromRevision": 1,
  "toRevision": 3,
  "stepCount": 3,
  "changedPathCount": 4,
  "samplePaths": ["src/auth/login.js"],
  "diff": "--- src/auth/login.js\n-old line\n+new line"
}
```

## CLI

```
hop trail episodes [--limit N] [--gap-minutes 30]     # cluster + list, no model calls
hop trail summarize [--limit N] [--dry-run]           # label unlabeled episodes (opt-in only)
hop trail summaries on|off [--mode metadata|diff]     # manage the per-codebase opt-in
```

`--json` (or `HOPIT_JSON=1`) emits machine output; human output is the default.

## Follow-ups (out of scope for this slice)
- Desktop/dashboard surfacing of labeled episodes as the browse/rollback unit.
- Backup **restore** path could re-key restore points by nearest episode label
  (the label data is now in the manifest; the shell restore script is
  machine-local, not in this repo).
- Batch-API submission (the research doc's recommended async default, 50% off)
  is a provider-capability extension of the same adapter interface.

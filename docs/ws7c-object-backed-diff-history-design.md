# WS7c Object-Backed Diff And History Reconstruction Design

This document completes the design-first WS7c gate from [HopIt Remediation Plan July 2026](remediation-plan-2026-07.md). Implementation should start only after owner approval. The goal is to make review, compare, history, export, and publish reconstruct real file contents from content-addressed object blobs instead of leaning on metadata-only approximations.

## Goal

HopIt should be able to compute file-level diffs between any two graph revisions that are still inside retention. The compare view should show added, modified, deleted, renamed-later, binary, symlink, directory, private, and encrypted-file states from the same graph and blob contract the agent uses for hydration.

## Current State

The graph stores file metadata, revisions, hashes, and object-backed content references. The agent can sync to object blobs, hydrate by hash, and run storage garbage collection. Review and compare surfaces exist, but history reconstruction is not yet a first-class object-backed contract.

## Revision Model

Every file mutation should create enough durable metadata to answer:

- which selected state or Main state changed
- file path and kind
- old file revision and new file revision
- content hash and blob reference for both sides when applicable
- privacy zone and visibility scope
- actor/session/device
- created timestamp and monotonic graph event id

Reconstruction should start from a known snapshot revision and replay file mutations forward, or read a compact file-state table keyed by revision when available. The implementation can begin with "current graph plus event chain" in the fixture path, then optimize D1 queries later.

## Options Considered

### Option 1: Store full snapshots per graph revision

Each graph revision has a complete file tree snapshot. Diffs read two snapshots and compare entries.

This is simple and reliable but writes too much metadata for frequent saves. It also makes D1 write pressure grow with repo size, not with changed files.

### Option 2: Store per-file version rows and reconstruct snapshots

Each file mutation writes a version row containing path, revision, kind, hash, blob reference, scope, privacy zone, and delete marker. A snapshot at revision N is reconstructed by choosing the latest version per path at or before N, filtered by selected state and requester visibility.

This is the recommended model. It keeps writes proportional to changes and maps cleanly to D1 indexes.

### Option 3: Store patches/deltas between blobs

Persist textual patches or binary deltas. Diffs reconstruct from delta chains.

This saves object storage in some cases but creates complex failure modes: patch chain corruption, binary handling, encrypted bytes, and expensive random access. Content-addressed full blobs are simpler and match existing hydration.

## Recommended Design

Use object-backed per-file versions:

1. On each acknowledged write, record a file version row with revision, path, kind, hash, size, scope, privacy zone, content storage, blob provider, blob key/hash, encoding, target, actor, and selected state id.
2. On delete, record a tombstone version.
3. Keep object blobs content-addressed by hash and shared across revisions.
4. Build `compareRevisions(leftRevision, rightRevision, requester)` in the D1 backend package.
5. The function reconstructs left and right file maps, applies visibility filtering, and returns a diff summary plus per-file entries.
6. Text diffs fetch only the two object blobs needed for the selected file. Directory-level compare should not fetch file bodies.
7. Cache fetched compare blobs server-side per request and client-side per view so switching files does not re-fetch the same content.
8. Respect encryption: if the server cannot decrypt a private/secret blob, return metadata and a `requiresLocalKey` state. Local-agent compare can decrypt when key material is available.
9. Extend `hop demo` so it creates a three-revision chain and prints a deterministic diff proof.

## Retention And Garbage Collection

`hop storage gc` must not delete blobs still referenced by any retained file version, Main snapshot, active change set, review state, export, or publish record.

Retention rules:

- Main history: keep indefinitely until a user-level retention policy exists.
- Active change sets: keep all referenced blobs while the change set is open or unmerged.
- Merged change sets: keep at least until the Main retention window covers the merge.
- Deleted files: keep tombstone metadata and old blob references while revisions that can diff against them are retained.
- Orphaned blobs: eligible for GC only when no retained file version references the blob key/hash.

GC acceptance must include a dry-run mode that reports retained-reference counts and orphan counts before delete.

## Free-Tier Cost Math

Cloudflare pricing checked on 2026-07-03:

- D1 Free includes 5 million rows read per day, 100,000 rows written per day, and 5 GB total storage.
- R2 Standard free tier includes 10 GB-month storage, 1 million Class A operations per month, 10 million Class B operations per month, and free internet egress.
- R2 Class A operations include `PutObject`; Class B operations are the lower-cost read side.

References:

- <https://developers.cloudflare.com/d1/platform/pricing/>
- <https://developers.cloudflare.com/r2/pricing/>

Personal dogfood estimate:

- 200 file saves/day.
- D1 writes: one file-version row plus indexes and event rows. Budget at 4 written rows/save = 800 rows/day, under 1 percent of D1 Free writes.
- R2 writes: one object write/save = about 6,000 Class A ops/month, below 1 percent of R2 Free Class A.
- Compare use: 20 compare views/day, 10 files inspected/view = 200 file body pairs/day, up to 400 R2 Class B ops/day, about 12,000/month, near 0.12 percent of R2 Free Class B.
- Storage: 200 saves/day * 20 KB average changed file = 120 MB/month before dedupe and GC.

Small-team estimate:

- 2,000 saves/day at 50 KB average changed file = 3 GB/month before dedupe and GC.
- D1 writes: 8,000 rows/day at 4 rows/save, 8 percent of Free writes.
- R2 Class A: 60,000 writes/month, 6 percent of Free Class A.
- Compare use: 100 views/day * 20 inspected files * two blobs = 4,000 Class B/day, 120,000/month, 1.2 percent of Free Class B.

Cost guardrails:

- Directory compare fetches metadata only.
- Fetch blob bodies lazily when a file diff row is opened.
- Cache blob reads during a compare session.
- Use content hashes to avoid duplicate object writes.
- Keep D1 queries indexed by codebase, selected state, path, and revision.

## Failure Modes

- Missing blob referenced by retained metadata: compare row is `missing_blob`, status is degraded, and GC must not proceed until repaired.
- Hash mismatch: compare fails closed for that file and records integrity failure.
- Encrypted blob without local key: return metadata-only diff with `requiresLocalKey`.
- Visibility change between revisions: requester sees only paths visible at the requested revision under the effective visibility policy.
- Very large binary file: return binary changed metadata without fetching bodies unless explicitly requested.
- Rename detection absent: initial implementation reports delete plus add; later rename detection can be hash-based.
- Partial retention window: compare returns `revision_expired` rather than silently comparing against current state.
- Concurrent writes: revision ids, not timestamps, determine ordering.

## Fixture-Testable Acceptance Plan

1. `hop demo` creates three revisions: initial, README edit, new source file plus private note edit.
2. A compare command or backend helper returns added, modified, deleted, and unchanged counts between revision 1 and revision 3.
3. Text body fetch returns a deterministic README diff from object blobs.
4. Directory-level compare does not read object bodies.
5. Binary file changes return binary metadata without text diff.
6. Same-owner requester can diff `.private/` paths; collaborator requester cannot see private path names.
7. GC dry-run keeps blobs referenced by any retained file version.
8. A deliberately missing blob produces `missing_blob` and does not crash the whole compare.

Product acceptance:

- Review and compare pages can request revision diffs from D1/R2-backed history.
- Export and publish can reconstruct the selected merged revision from retained object-backed versions.
- Storage GC is retention-aware and cannot delete live history.

## Implementation Notes Addendum (2026-07-12)

This addendum records the concrete choices made where the design above left an
option open, following the rule "pick the simplest option consistent with the
doc's stated constraints." It reflects the implementation as landed, not new
design. Where the doc offered a spectrum, the narrowest choice that satisfies the
free-tier cost math and failure-mode contract was taken.

### Reconstruction model

- **Chose Option 2 (per-file version rows)**, as recommended. Persisted as a D1
  `file_versions` table (`packages/backend-d1/src/schema.js`) and, in the fixture
  path, as a `fileVersions` array on the graph JSON. Both carry the same shape:
  `version_id`, `graph_revision`, `path`, `operation`, `old_file_json`,
  `new_file_json`, `blob_provider/blob_key/blob_hash`, `scope`, `privacy_zone`,
  `zone_id`, `actor`, `created_at`.
- **Snapshot-by-replay**, not stored snapshots. `compareVersionRows`
  (`packages/backend-d1/src/history.js`) folds versions ordered by
  `(graph_revision, version_id, path)` up to each requested revision. This keeps
  writes proportional to changed files (the doc's D1-write-pressure constraint).
- **Ordering is by revision id, never timestamp** (per the concurrent-writes
  failure mode). `version_id` breaks ties within a revision.
- Indexes match the doc's "codebase, selected state, path, revision" guidance:
  `(codebase_id, graph_revision, path)`, `(codebase_id, path, graph_revision)`,
  and `(codebase_id, blob_key)` for GC reachability lookups.

### API surface

- The reconstruction lives in the agent/backend layer the doc names, exposed as
  `compareRevisions(left, right, requester)` on both `D1CloudGraphService`
  (production, R2 blobs) and `FixtureJsonCloudGraphService` (tests/demo,
  filesystem blobs), plus `listFileVersions` and
  `retainedBlobKeysForFileVersions`.
- CLI surface is `hop compare --from <rev> --to <rev> [--path <file>]`. Directory
  compare (no `--path`) returns metadata only and fetches zero blob bodies; a
  `--path` opens exactly one file's two blob bodies. This is the doc's
  cost-guardrail ("fetch bodies lazily when a file diff row is opened").

### Caching

- **Server/request-scoped cache only in this slice.** `createCompareBlobReader`
  holds a per-invocation `Map` keyed by `blobKey || blobHash || hash`, and
  surfaces `bodyFetches` / `blobCacheHits` on the compare result so a caller can
  prove no duplicate fetch occurred. This is the simplest thing that satisfies
  "switching files does not re-fetch the same content" within one compare
  request.
- **Client-side per-view cache is deferred to the dashboard/Trail consumer.** The
  design doc lists both a server-per-request and a client-per-view cache. The
  dashboard compare page (`src/components/features/review/compare-view.tsx`) is
  still a status-snapshot shell ("full line-by-line diffing is on the roadmap")
  and is intentionally out of this slice per the Phase 2 roadmap note that the
  Trail view consumes this reconstruction later. The client cache belongs with
  that consumer and is recorded here as an explicit deferral, not an omission of
  the backend contract.

### Retention and GC

- `hop storage gc` computes the retained set as the union of (a) blobs reachable
  from the current graph and (b) blobs referenced by any retained file-version
  row (`retainedBlobKeysForFileVersions`). Anything else is an orphan candidate.
- **Dry-run is the default**; deletion requires `--execute`. An optional
  retention window (`storageRetentionMsFromOptions`) further protects
  recently-written orphans. Output reports listed/reachable/orphaned/deleted
  counts and a bounded orphan sample, satisfying the doc's dry-run-with-counts
  requirement.
- **Fails honest, never fabricates.** A diff whose referenced blob has been GC'd
  (or is otherwise absent) yields per-file `state: "missing_blob"` and increments
  `summary.missingBlob`; the rest of the compare still returns. A fetched body
  whose hash does not match its recorded hash yields `integrity_failure` and
  fails closed for that file only. Neither path invents content.

### Failure-mode choices

- **Text diff** uses deterministic common-prefix / common-suffix line trimming
  rather than a full Myers diff. It is cheap and stable for the acceptance proof;
  a richer diff can replace `textDiffSummary` without touching the contract.
- **Rename detection is absent** (delete + add), matching the doc's initial-cut
  note; hash-based rename detection is a later addition over the same rows.
- **Encrypted files** return `requiresLocalKey` metadata-only when
  `clientEncryption` is present; **binary files** (base64 encoding) return
  `binary_changed` / `binary_unchanged` metadata with no body fetch.
- **Out-of-window revisions** return `revision_expired` rather than silently
  comparing against current state.

### Demo proof

`hop demo` builds the three-revision chain (initial → README edit → new source
file plus private-note edit) and prints a deterministic
`{ action: "demo.compare", revisions: [1,2,3], summary, readmeDiff }` block. The
README diff is reconstructed from stored blobs, and the private-note edit
confirms owner-visible `.private/` reconstruction.

### Tests

Fixture-backed coverage lives in `packages/agent/test/d1-backend.test.js`
("D1 backend records file versions and compares retained revisions": owner vs
collaborator visibility, `missing_blob`, integrity rejection) and
`packages/agent/test/agent-cli.test.js` ("demo creates object-backed revision
chain and compare reads README blobs lazily", "compare reports binary metadata
and missing object blobs without crashing", "storage gc dry-runs and deletes only
orphaned managed filesystem blobs with execute").

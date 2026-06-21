# Code Browsing, Review, Comments, And History Plan

Last updated: 2026-06-21

## Purpose

The next major HopIt phase should make a codebase reviewable in the browser without turning HopIt into a GitHub clone. The target is GitHub-lite collaboration built on HopIt's own model:

- Main is the accepted state.
- Active change sets are live cloud-backed work states.
- Review opens an active change set for team inspection.
- Merge advances Main explicitly.
- `.private/` files remain owner-only and never enter shared review, publish, or public history.

This plan covers the product UX, API contracts, storage shape, and incremental implementation order for:

- code browsing
- file history
- change-set diffs
- reviews
- inline and overview comments
- merge history

## Current Foundation

Already available in this repo:

- The local agent can materialize and sync a selected active change set.
- Main and selected active change-set identities exist in the fixture graph.
- Review and merge commands exist for the selected active change set.
- Conflict state is persisted on the selected active change set.
- `/api/agent/status` can read local agent `status`, `events`, and `cloud` endpoints, or a Convex dashboard query when configured.
- The web UI maps visible file metadata, capped shared-file content previews, review state, merge state, conflict state, remote-update state, and recent events.
- The dashboard has a read-only `CodeReviewSection` that lists visible shared files, renders a capped content preview, and groups review readiness/history signals.
- Convex can persist the current graph, files, and agent events.

Not yet available:

- A durable snapshot index.
- Durable merge records.
- A true tree API separate from the status payload.
- A diff API that compares Main, snapshots, and active change sets.
- Review comment storage.
- Review decisions or requested-change state.
- File history import from Git ancestry.
- Permission-aware browser routes beyond the local prototype status path.

## Product Principles

### Keep HopIt Terms

The UI should say codebase, Main, active change set, review, merge, and history. Avoid branch/fork/worktree language unless the user is explicitly importing, exporting, or publishing Git.

### Browse Without Editing

Browser code views are read-only in this phase. Editing still happens through the managed workspace folder and local tools. The browser helps users inspect, discuss, approve, and understand code.

### Treat Review As A Visibility Boundary

Opening review should make the non-private active change-set content visible to permitted reviewers. It should not make `.private/` content visible, and it should not advance Main.

### Diff Against A Named Base

Every diff must name both sides:

- base: usually Main revision or a specific snapshot
- head: usually active change-set revision or review snapshot

The UI should never say a file changed unless the API knows the base and head that were compared.

### Comments Belong To Stable Anchors

Inline comments should anchor to:

- codebase id
- change-set id or merged history item id
- file path
- side: base or head
- base revision and head revision
- line number plus a compact content fingerprint

Line numbers alone are not enough because active change sets can continue syncing while a review is open.

## Target UX

### Codebase Browser

Primary route:

```text
/codebases/:codebaseId/tree/:ref?path=src/app/page.tsx
```

Refs:

- `main`
- `main@<revision>`
- `cs:<changeSetId>`
- `snapshot:<snapshotId>`
- `merge:<mergeId>`

Core layout:

- Left tree with directories and files.
- Center read-only file viewer with line numbers.
- Right metadata panel with path, size, revision, scope, latest change, review status, and history links.
- Breadcrumb for path navigation.
- Ref selector for Main, active change set, review snapshot, or historical snapshot.
- Scope badge for shared vs owner-private.

Behavior:

- Shared files are viewable by users with codebase read permission.
- Active change-set files are viewable according to effective change-set visibility.
- `.private/` files are visible only to the owner and never appear in reviewer views.
- Binary or unsupported files show metadata and download/export affordances later; the first version can show metadata only.

### Diff Browser

Primary route:

```text
/codebases/:codebaseId/compare?base=main@12&head=cs:cs_hopit_local@18
```

Review route:

```text
/codebases/:codebaseId/reviews/:reviewId/files
```

Core layout:

- File list grouped by added, modified, deleted, renamed, conflicted.
- Main diff pane with unified and split modes.
- Review status rail showing open comments, resolved comments, approvals, requested changes, conflicts, and merge eligibility.
- Sticky file header with base/head revisions.

Diff states:

- added
- modified
- deleted
- renamed
- mode changed, later
- conflicted
- hidden because private
- hidden because permission denied
- too large, later

First algorithm:

- Compare file paths in base and head snapshots.
- Treat path present only in head as added.
- Treat path present only in base as deleted.
- Treat path present in both with different hash or revision as modified.
- Rename detection can wait until durable blob history exists.

### Review Overview

Primary route:

```text
/codebases/:codebaseId/reviews/:reviewId
```

Core sections:

- Summary: title, author, state, base, head, visibility, conflict state.
- Changed files: counts and per-file status.
- Conversation: overview comments and system events.
- Checks: sync freshness, conflicts, pending writes, hidden private paths, merge readiness.
- Actions: comment, approve, request changes, merge, close review.

Review states:

- draft, optional later
- open
- changes-requested
- approved
- merged
- closed
- conflicted

The current fixture only has `not-open`, `open`, and `merged`. The API can expose those now and extend later.

### Inline Comments

Comment surfaces:

- Overview comment on the review.
- Inline file comment on a diff line.
- Inline file comment on a tree line, later promoted to a review thread if the user starts a review from browsing.

Thread states:

- open
- resolved
- outdated

Comment capabilities:

- Add comment.
- Reply.
- Resolve/unresolve.
- Mark outdated automatically when the anchored content no longer exists at the head revision.

### History

Primary routes:

```text
/codebases/:codebaseId/history
/codebases/:codebaseId/history/:snapshotId
/codebases/:codebaseId/files/:path/history
```

History should show HopIt-native events before it tries to mirror Git:

- active change-set creation
- sync acknowledgements
- review opened
- comment added/resolved
- change requested
- approval added
- merge completed
- export/publish completed

Git import can enrich history with commit ancestry later, but the durable HopIt history should not depend on Git being present.

## API Plan

### Read APIs

Use app routes as the initial facade, backed by the local agent in development and Convex/cloud services in hosted mode.

```text
GET /api/codebases/:codebaseId/tree?ref=main&path=src
GET /api/codebases/:codebaseId/files?ref=main&path=src/app/page.tsx
GET /api/codebases/:codebaseId/compare?base=main@12&head=cs:abc@18
GET /api/codebases/:codebaseId/reviews
GET /api/codebases/:codebaseId/reviews/:reviewId
GET /api/codebases/:codebaseId/reviews/:reviewId/files
GET /api/codebases/:codebaseId/reviews/:reviewId/comments
GET /api/codebases/:codebaseId/history
GET /api/codebases/:codebaseId/files/:encodedPath/history
```

Read response shape examples:

```ts
type TreeResponse = {
  codebaseId: string
  ref: RefDescriptor
  path: string
  entries: TreeEntry[]
}

type FileResponse = {
  codebaseId: string
  ref: RefDescriptor
  path: string
  scope: 'shared' | 'owner-private'
  revision: number
  hash: string
  size: number
  content: string | null
  renderMode: 'text' | 'binary' | 'too-large'
}

type CompareResponse = {
  codebaseId: string
  base: RefDescriptor
  head: RefDescriptor
  summary: DiffSummary
  files: DiffFile[]
}
```

### Mutation APIs

Keep mutations separate from code browsing. These should require explicit permission checks and idempotency keys.

```text
POST /api/codebases/:codebaseId/reviews
POST /api/codebases/:codebaseId/reviews/:reviewId/comments
POST /api/codebases/:codebaseId/reviews/:reviewId/comments/:commentId/replies
POST /api/codebases/:codebaseId/reviews/:reviewId/comments/:commentId/resolve
POST /api/codebases/:codebaseId/reviews/:reviewId/approve
POST /api/codebases/:codebaseId/reviews/:reviewId/request-changes
POST /api/codebases/:codebaseId/reviews/:reviewId/merge
POST /api/codebases/:codebaseId/reviews/:reviewId/close
```

Mutation rules:

- Review creation snapshots the base and head revisions.
- Merge requires the reviewed head to still be mergeable into current Main or to enter conflict state.
- Comments must validate path visibility.
- Review comments cannot target `.private/` paths unless the review is owner-only, and owner-only reviews should not become team-visible.
- Merging must write a merge record and advance Main in one transaction.

### Agent/Status Bridge

The current `/api/agent/status` route can continue powering the dashboard status panel. The code browser should move to explicit tree/file/compare routes once those routes exist.

Near-term bridge:

- Use `/api/agent/status` for a read-only dashboard preview of visible files.
- Do not add review comment mutations to `/api/agent/command`.
- Do not overload the local status payload as the long-term browser API.

## Storage Plan

The production model should split metadata from blobs.

### Core Tables Or Collections

```text
codebases
snapshots
snapshotFiles
blobs
activeChangeSets
reviews
reviewFiles
reviewThreads
reviewComments
reviewDecisions
mergeRecords
historyEvents
```

### Snapshots

Snapshots are immutable references to a file graph at a point in time.

Required fields:

- id
- codebaseId
- sourceType: main, active-change-set, review, merge, import
- sourceId
- revision
- createdAt
- createdBy
- fileCount
- hiddenFileCount
- baseSnapshotId, optional

### Snapshot Files

Required fields:

- snapshotId
- path
- blobId
- hash
- size
- scope
- fileRevision
- updatedAt

### Reviews

Required fields:

- id
- codebaseId
- changeSetId
- authorId
- state
- baseSnapshotId
- headSnapshotId
- baseMainRevision
- headChangeSetRevision
- visibility
- conflictState
- openedAt
- updatedAt
- mergedAt, optional
- closedAt, optional

### Comments

Required fields:

- id
- reviewId
- threadId
- authorId
- body
- createdAt
- updatedAt
- resolvedAt, optional
- path, optional for overview comments
- side, optional
- line, optional
- baseSnapshotId
- headSnapshotId
- anchorFingerprint, optional

### Merge Records

Required fields:

- id
- codebaseId
- reviewId
- changeSetId
- mergedBy
- previousMainRevision
- resultingMainRevision
- baseSnapshotId
- headSnapshotId
- mergedSnapshotId
- createdAt

## Permission Rules

### Codebase Read

Can read Main, public/shared metadata, and permitted history.

### Change-Set Read

Can read active change-set content only when:

- requester is the owner, or
- effective visibility is team-visible and requester has codebase membership, or
- effective visibility is review-visible and requester has review access.

### Private Path Read

`.private/` is owner-only regardless of change-set visibility. Private paths should be counted in owner views but hidden in reviewer views.

### Comment Write

Requester must have review access and target a visible path. Inline comments on hidden/private paths should fail with a permission error.

### Merge

Requester must have merge permission, review must be mergeable, no unresolved required-change state can remain, and Main must still match the review base unless the merge engine explicitly handles the divergence.

## Implementation Phases

### Phase 1: Read-Only Browser Scaffold

Goal: make code review visible without adding write-risk.

Tasks:

- Add a dashboard code-review panel fed by current `AgentStatusSnapshot.files`.
- Show candidate shared files, review state, merge state, conflict state, and recent history events.
- Hide or metadata-only render owner-private content in review surfaces.
- Document the full UX/API plan in this file.

Proof:

```bash
npm run lint
```

### Phase 2: Explicit Tree And File APIs

Goal: stop relying on the generic status payload for browsing.

Tasks:

- Add local fixture functions that can read a visible tree by ref and path.
- Add `GET /api/codebases/:codebaseId/tree`.
- Add `GET /api/codebases/:codebaseId/files`.
- Map Convex dashboard graph reads into the same shape.
- Add tests for owner, collaborator/private, collaborator/review-visible, and `.private/` visibility.

Proof:

```bash
npm run agent:test
npm run lint
```

### Phase 3: Snapshot Index And Compare API

Goal: make diffs honest and stable.

Tasks:

- Add snapshot records for Main and selected active change-set states.
- Capture a review head snapshot when review opens.
- Add compare service for base/head snapshots.
- Add `GET /api/codebases/:codebaseId/compare`.
- Render changed file list and simple text diffs.

Proof:

```bash
npm run agent:test
npm run lint
```

### Phase 4: Review Records And Comments

Goal: make review collaboration durable.

Tasks:

- Add review records separate from selected-state metadata.
- Add overview comments and inline comments.
- Add resolve/unresolve state.
- Anchor comments to base/head snapshot ids and line fingerprints.
- Add permission tests for private paths and invisible change sets.

Proof:

```bash
npm run agent:test
npm run lint
```

### Phase 5: Merge Records And History

Goal: make accepted work auditable.

Tasks:

- Add merge records.
- Add codebase history feed.
- Add file history feed.
- Add review-to-merge event timeline.
- Keep Git publish/export history as optional externalization, not the source of truth.

Proof:

```bash
npm run agent:test
npm run lint
npm run package:hop
```

### Phase 6: Git History Import And Publish Alignment

Goal: connect Git compatibility to HopIt history without making Git the product model.

Tasks:

- Import Git commits as historical snapshots.
- Preserve commit ancestry where possible.
- Allow historical snapshot export.
- Publish merged HopIt history to remote Git only when requested.
- Verify `.private/` is never exported or published.

Proof:

```bash
npm run agent:test
npm run lint
npm run package:hop
```

## First Patch Boundary

Safe first patch:

- docs only, plus a read-only dashboard section.
- no auth schema changes.
- no Convex schema changes.
- no write endpoints.
- no comment persistence.
- no real diff claims unless base/head comparison exists.

The first UI should be treated as a planning and orientation surface. It can show visible file metadata, review state, and recent history signals using the current status contract, but true code browsing should graduate to explicit tree/file APIs in Phase 2.

## Open Questions

- Should an opened review freeze a head snapshot immediately, or keep showing live active change-set updates with an explicit "new changes since review opened" marker?
- Should approvals be invalidated by any new head revision, or only by files touched after approval?
- Should review-visible change sets be visible to all codebase members or only explicitly added reviewers?
- Should comments on tree views create draft review threads or standalone file notes?
- How much syntax highlighting should V1 include before a dedicated code viewer package is worth adding?

# HopIt Progress Tracker

Last updated: 2026-06-21

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

HopIt has a working local managed-folder agent spike plus a deployed personal production baseline. The agent can seed a cloud graph, hydrate a normal folder, capture local writes, journal them durably, acknowledge them into the selected active change set, recover unacknowledged writes after restart, safely refresh a second same-owner workspace, export/publish a clean Git escape hatch, and expose local status/event/journal/cloud state.

The web app polls `/api/agent/status`. In local mode that route reads the local agent status server's status/events/cloud endpoints; in production it reads the Convex `agent.dashboard` query. The local command route can run whitelisted sync, refresh, recover, review, and merge actions against the local agent, while hosted Convex-backed deployments remain read-only for workspace commands and require dashboard authentication.

Fixture-backed conflict handling is in place for stale selected-state revisions, stale file/base revisions, and stale Main revisions. Conflicts are persisted on the selected active change set, emitted as `change_set.conflict_detected`, and surfaced through status while preserving local edits for review.

Current live deployment:

- Vercel project: `robertg761s-projects/hopit`
- Production URL: `https://hopit-ten.vercel.app`
- Convex project: `robertgordon761/hopit`
- Production Convex URL: `https://sincere-jaguar-17.convex.cloud`
- Seeded codebase id: `hopit`
- Seeded graph size: 58 source files
- Production workspace: `/Users/robert/HopIt Workspaces/hopit`

Current proof commands:

```bash
npm run agent:test
npm run lint
npm run check:production-config
npm run package:hop
```

Current verified result:

- `npm run agent:test`: 31 passing tests.
- `npm run lint`: passes.
- `npm run check:production-config`: passes when `.env.local` is loaded.
- `npm run package:hop`: builds the current macOS artifact and verifies `hop help` plus production-profile `hop status`.

## Executive Progress

| Area | Status | Summary |
| --- | --- | --- |
| Product concept | Done | The repo has converged on cloud-native managed workspaces, active change sets, explicit Main, and `.private/` owner-only workspace scope. |
| Web product shell | Mostly done | The prototype UI polls live local agent state through `/api/agent/status`, maps files/events/revisions/review/merge/conflict state, and can read Convex dashboard state when configured. |
| Local managed-folder agent | Done for spike | The agent proves hydration, journaling, sync acknowledgement, recovery, watch startup gating, safe refresh, status, and same-owner continuity. |
| Vercel/Convex production baseline | Done for personal dogfood | Vercel hosts the protected dashboard, Convex stores the seeded production graph, and the hosted API reads the graph successfully. |
| Convex cloud graph | Mostly done | Convex functions persist graph, files, and agent events, require an agent token by default, validate graph contracts, and expose a dashboard query, but blob storage and durable user permissions are still thin. |
| `.private/` model | Done for spike | `.private/` files are synced/versioned and classified as owner-private; they are not ignored or skipped. |
| Safety journal | Done for spike | Pending, acknowledged, and failed entries are derived from journal/events and exposed through status. |
| Watch loop | Done for spike | Watch startup runs recovery before hydration, blocks unsafe recovery, and syncs later editor writes. |
| Fixture cloud graph service boundary | Done | Commands now use a fixture-backed service boundary instead of direct command-level cloud JSON access. |
| Main/change-set/owner/session/visibility contract | Done for fixture | The fixture graph and status surface include these identities and visibility fields. |
| Same-owner two-session continuity | Done for spike | Device/session B can refresh acknowledged shared and `.private/` changes from device/session A. |
| Collaborator visibility simulation | Done for fixture | Tests prove private change sets hide non-owner content, team/review-visible change sets expose non-private paths, and `.private/` remains owner-only. |
| Remote-update events | Done for spike | Refresh emits first-class `remote-update` events and status exposes the latest update. |
| Review and merge | Done for fixture | Fixture commands open the selected active change set for review, merge it into Main, emit review/merge events, and expose review/merge state through status. |
| Conflict handling | Done for fixture | Stale selected-state, file/base, and Main revisions become reviewable conflict state. |
| Packaging | Mostly done | The current packager builds macOS/Linux `x64`/`arm64` tarballs with an embedded Node runtime, verifies help plus production-profile status, and now fails explicitly on unsupported Windows hosts. |
| Git compatibility | In progress | Safe export/publish now creates clean Git repos while omitting `.private/` from publish, but ancestry preservation and remote publishing are still not started. |
| Real accounts/auth | In progress | The repo now has Clerk sign-in routes, middleware, Convex auth config, `/api/me`, and provider-token forwarding; production still needs real Clerk env vars before Basic Auth can be retired. |
| Permissions and invitations | In progress | Durable memberships, invitation tables, requester-aware dashboard filtering, owner claim, member management, and invite create/accept/revoke UI are in place; scoped agent-session tokens and complete permission coverage remain. |
| Code browsing/reviews/issues/releases | In progress | The dashboard now has a read-only code-review browser slice plus issue/discussion/release UI backed by Convex; real diffs, review comments, routeable history, project-board UI, and immutable release publishing remain. |
| Native mount/FUSE/RAM-only cache | Later | Explicitly not part of the current MVP path. |

## Milestone Tracker

### Milestone 1: Product Shell

Status: `Mostly done`

Goal: Build the logged-in product surface around codebases, files, active change sets, connected devices, sync state, collaborators, visibility, and recent activity, while removing GitHub-social concepts from the first prototype.

Completed:

- Product direction is documented in [MVP Plan](mvp-plan.md).
- Core concepts are named: codebase, Main, active change set, managed workspace folder, HopIt agent, local cache, safety journal, workspace snapshot, workspace visibility, change-set visibility, and cloud file graph.
- The app surface exists under `src/app` and `src/components/hopit`.
- The app surface consumes `/api/agent/status` through `useAgentStatus`, maps live local status/events/cloud data into the dashboard, and falls back to offline state when the agent is unavailable.
- The status API can read either the local status server or the Convex dashboard query, depending on environment configuration.
- The command API exposes whitelisted local sync, refresh, recover, review, and merge actions for the prototype UI.
- GitHub-social concepts are documented as non-goals for v1.
- `.private/` is documented as owner-visible, snapshotted, synced, and versioned.
- Change-set visibility resolution order is documented: per-change-set override, codebase override, global user default, product default.

Current evidence:

- `npm run lint` passes.
- The product plan and README consistently describe the same product model.
- The app has local-agent and Convex status adapters in `src/lib/agent-status.ts`, `src/lib/convex-agent.ts`, and `/api/agent/status`.

Remaining:

- Add richer UI affordances for uncertain, degraded, retrying, remote-update, review, merge, and conflict detail.
- Keep the UI mapper aligned as the local status server and Convex dashboard shape evolve.
- Add production authentication and permission-aware command handling before exposing commands outside the local prototype.

Risks:

- The UI can drift if its mapper lags behind the local status server or Convex dashboard contract.
- Visibility UI should not imply `.private/` is an ignore mechanism.

Next product-shell step:

- Harden the live UI/Convex status contract and use it to drive the Git compatibility import/export/publish flow.

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
- Commands can target Convex with `--convex-url` and `--agent-token`, and the web app can read the Convex dashboard query for hosted status.
- The service exposes graph initialization, graph reads, graph writes, optional graph reads, existence checks, and journal-entry application.
- The local persistence file is still JSON, but command code no longer treats that JSON file as the product API.
- Convex functions persist codebase graph metadata, files, and agent events for the current cloud-backed prototype.
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

- Collaborator filtering is fixture-only and not backed by real authentication or durable permissions.
- The fixture graph is still flattened around one selected active change set, so private collaborator reads show an empty file set rather than falling back to a separate Main snapshot.

Next two-session step:

- Use the review/merge skeleton as the boundary for conflict handling while preserving the same remote-update and visibility evidence.

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
- Decide the long-term private backup UX for explicit owner-private export.

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
| `cache.evicted` | Not started | Needed for safe cache pruning work. |
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
| file `content` | Done | Inline in fixture JSON for now. |
| file `hash` | Done | Computed from content. |
| file `size` | Done | Computed from content. |
| file `scope` | Done | Derived from path; `.private/` becomes owner-private. |
| file `revision` | Done | Updated on acknowledged write. |
| content-addressed blob refs | Not started | Needed for production-style storage. |
| snapshot indexes | Not started | Needed for review/merge/export. |
| merge records | Not started | Needed for review/merge. |

## Immediate Next Queue

The next major phase is tracked in [GitHub-Lite Collaboration Plan](github-lite-collaboration-plan.md). The detailed sub-plans are [Auth And Collaboration Plan](auth-collaboration-plan.md), [Code Browsing, Review, Comments, And History Plan](review-code-browser-plan.md), and [HopIt Work Items, Projects, Discussions, And Releases Plan](work-items-releases-plan.md). Git compatibility remains important, but the immediate product gap is now collaboration: accounts, permissions, code browsing, reviews, issues, projects, discussions, and releases.

### 1. Real Accounts And Auth

Status: `In progress`

Definition of done:

- Hosted dashboard uses real user sign-in instead of product-level Basic Auth.
- Convex user-facing queries and mutations resolve the requester to a durable user id.
- Local agent service tokens remain separate from human user identity.
- Docs cover provider setup, production env vars, local dev, and recovery.

Current foundation:

- Convex schema now includes `users` and `authIdentities`.
- Convex exposes `viewer` and `upsertViewer`.
- The Next app includes Clerk provider wrapping, sign-in/sign-up pages, protected middleware, `/api/me`, and server-side Clerk-to-Convex token forwarding.
- The hosted dashboard still needs the real Clerk environment variables before the production deployment can move off Basic Auth.

### 2. Multi-User Permissions And Invitations

Status: `In progress`

Definition of done:

- Add durable users, memberships, roles, and invitations.
- Enforce server-side role checks for codebase reads, review/merge actions, member management, and future issue/release writes.
- Add invite creation, acceptance, expiry, and revocation.
- Preserve `.private/` owner-only semantics independently from role-based codebase access.

Current foundation:

- Convex schema now includes `codebaseMembers`, `codebaseInvitations`, and `agentSessions`.
- `saveGraph` seeds owner/collaborator membership rows from the graph during the bootstrap phase.
- Owner claim, member list, suspend/remove, and invitation create/accept/revoke mutations exist, including duplicate pending-invite checks and verified-email acceptance.
- The dashboard can filter visible graph files by requester role, with token-only reads still treated as the current owner bridge for personal dogfooding.
- The dashboard has member/invite UI for owner claim, member list, pending invites, invite creation, invite acceptance, revocation, suspension, and removal.

### 3. Web Code Browser

Status: `In progress`

Definition of done:

- Browse folders and files from the Convex-backed graph.
- Show visible file contents, revision, size, hash, scope, and path metadata.
- Hide owner-private paths from non-owner requesters.
- Add routeable file selection and safe large-file fallbacks.

Current foundation:

- The status mapper now carries capped content previews for shared visible files.
- The dashboard renders a read-only `CodeReviewSection` with file selection, metadata, content preview, review readiness, and history signals.
- Routeable file browsing, search, syntax highlighting, and dedicated file-read queries are still pending.

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

- Convex schema now includes issue, project, project item, discussion, comment, and collaboration counter tables.
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

- Convex schema now includes releases and release assets.
- Permission-gated list/create/publish/asset functions exist and validate the target codebase before creating releases.
- The dashboard can draft releases and publish drafts. Immutable publish policy and artifact integration are still pending.

### Later: Deeper Git Replacement Work

Status: `Later`

Definition of done:

- Import Git history into the cloud file graph.
- Preserve ancestry and historical snapshots.
- Add remote Git publish and rollback.
- Eventually design immutable/content-addressed history, clone/fetch/push equivalents, tags, releases, and offline-first sync.

## Known Gaps

- Real account provider code exists, but production Clerk keys/issuer/owner email are not configured yet.
- Durable membership, role, invitation, and hosted member/invite UI exist, but scoped agent-session tokens and complete permission coverage are not done yet.
- Convex-backed graph storage and auth-backed user APIs exist for the first collaboration slice, but not every product command has moved to user-scoped auth yet.
- No production database/object-blob split yet; Convex stores prototype graph metadata, file content, and events.
- No content-addressed blob backend yet.
- No schema validator yet.
- Requester-aware dashboard filtering exists, but the auth-backed collaborator permission model is not enforced across every user-facing write yet.
- A first read-only code-review browser slice exists, but dedicated routeable code browsing, diff view, inline review comments, durable review records, and history UI are still pending.
- Issue, discussion, and release product UI exists for the first slice; project-board UI, comment/detail pages, and richer filters are still pending.
- No push-style live remote-update delivery yet; remote-update is currently emitted by explicit refresh.
- No conflict resolution UI yet; fixture conflict detection/status exists.
- No Git history import, ancestry preservation, or remote publish yet.
- No local cache pruning yet.
- No offline mode yet.
- No signed production installer or tray/menu agent wrapper yet.
- No cross-platform watch behavior matrix yet.

## Verification Checklist

Run this before marking agent progress as done:

```bash
npm run agent:test
npm run lint
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

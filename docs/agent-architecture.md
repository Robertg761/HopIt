# Local Agent Architecture

HopIt's local agent materializes a cloud codebase into a managed workspace folder while keeping the cloud file graph as the source of truth. The v1 architecture should optimize for OS and editor compatibility: a normal local folder, an agent-owned local cache, a safety journal, a status API, and an event log. A true OS filesystem mount is future optional research, not the default product path.

## Core Pieces

### Cloud File Graph

The cloud file graph is the durable model for a codebase:

- directory and file paths
- file revisions and metadata
- content hashes and blob references
- workspace revision number
- device/session sync state

The spike stores this in `.hopit-agent/cloud.json`. A production service should split metadata into a database and content into blob storage, but expose the same graph-shaped API to the agent.

HopIt v1 does not have an ignore-file model. The graph should store visibility metadata for `.private/` paths: those files are snapshotted, synced, and versioned, but visible only to the owner. Files outside `.private/` are shared with the codebase's collaborators according to workspace permissions.

### Workspace Adapter

The workspace adapter is the boundary between normal local tools and HopIt state.

V1 managed-folder adapter:

- materializes files into a managed workspace folder, such as `.hopit-agent/workspaces/<codebase>`
- lets editors, terminals, language servers, and test runners use normal OS file APIs
- scans the folder for edits
- translates file creates, writes, and deletes into journal entries
- marks `.private/` paths as owner-visible without skipping sync or versioning
- preserves a "no clone to manage" product model

Future optional mount research:

- serves reads directly from the cloud graph or a volatile cache
- intercepts writes at the filesystem boundary
- records each unacknowledged mutation before reporting success to local tools
- keeps the same agent-facing read, write, journal, status, and event contracts

Native filesystem experiments should stay outside the v1 implementation path unless the managed-folder product has already proven the core workflow.

### Local Cache

The cache is an agent-owned working set, not a durable local source of truth. In v1, materialized disk files are intentional: they maximize compatibility with the OS, editors, file watchers, language servers, and command-line tools.

Responsibilities:

- materialize file content when the workspace opens, when files change remotely, or when policy requests hydration
- keep files available for editors, language servers, and test runners through normal disk paths
- prune clean cached content when policy allows
- never evict writes that are still awaiting cloud acknowledgement

RAM-only caching can be revisited later for specialized workflows, but it is not the v1 default.

### Safety Journal

The safety journal is the local durable record for writes that the cloud has not acknowledged yet. It protects the user's latest edits from process crashes, device sleep, and network loss.

Each journal entry should include:

- stable write id
- operation type: create, write, delete, move later
- cloud path
- visibility, including whether the path is under `.private/`
- content hash and byte size when content exists
- base revision or known cloud revision
- created timestamp
- pending, acknowledged, or failed status

The spike writes this as NDJSON at `.hopit-agent/journal.ndjson`.

### Restart Recovery And Watch Loop

Restart recovery and the background watch loop are explicit agent contracts, not demo-only behavior. The current spike exposes recovery through `npm run agent:recover`, and `npm run agent:watch` runs recovery before hydrating the workspace.

Restart recovery expectations:

- agent startup reads the safety journal before accepting new workspace writes
- pending journal entries are replayed against the cloud file graph in creation order
- acknowledged entries stay queryable for diagnostics but no longer count as pending work
- failed entries remain durable, visible in status, and retried only when the failure is retryable
- `.private/` scope is preserved during replay exactly as it was recorded in the journal
- the agent never prunes or overwrites local content for an unacknowledged journal entry

Watch-loop expectations:

- `npm run agent:watch` runs recovery, hydrates the managed folder only when recovery is safe, starts watching for local changes, journals writes, and runs bounded sync attempts
- file create, write, and delete detection should be idempotent across repeated scans
- rapid editor saves should coalesce into stable journaled writes without losing the latest content
- the loop should keep running after transient cloud or filesystem errors and surface the degraded state through status and events
- the loop should treat the cloud file graph as the source of truth while preserving pending local edits until acknowledgement or conflict review

Recovery should be safe before it is clever. If the agent is unsure whether the cloud accepted a write, it should keep the journal entry pending and expose that uncertainty through status instead of silently discarding local state.

### Status API

The agent should expose a small local status API for the product UI, tray/menu UI, and diagnostics.

Suggested fields:

- codebase id and display name
- workspace path
- cloud revision currently visible locally
- last acknowledged revision
- pending journal entry count
- last cloud acknowledgement time
- connectivity state
- cache mode and approximate memory/disk use
- adapter type: managed folder, with optional research adapters later
- recent error summary

This can start as a local HTTP endpoint or CLI command. The current spike exposes the HTTP status surface with `npm run agent:status`; a direct CLI status command can use the same agent-state reader. The important part is that status reads from agent state instead of guessing from files on disk.

### Event Log

The event log is an append-only operational trace for development, debugging, and UI updates. It is not the source of truth for file content.

Important event types:

- `workspace.ready`
- `watch.started`
- `file.hydrated`
- `write.journaled`
- `cloud.acknowledged`
- `sync.complete`
- `sync.failed`
- `cache.evicted`
- `connection.changed`

The spike writes events to `.hopit-agent/events.ndjson`. A production agent can stream the same events over the status API while retaining a short local diagnostic log.

## Editor Read/Write Flow

```text
Editor or tool
  -> Workspace adapter
  -> Local cache
  -> Cloud file graph / blob API
  -> Safety journal for writes
  -> Cloud acknowledgement
  -> Status API and event log
```

Read path:

1. An editor, language server, or command-line tool reads a path in the HopIt workspace.
2. The OS reads a normal disk file in the managed workspace folder.
3. The agent keeps that file aligned with the cloud graph revision it has made visible locally.
4. On workspace open or remote change, the agent asks the cloud file graph for metadata and hydrates blob content into the local cache.
5. The agent emits `file.hydrated` or a remote-update event when local content changes.

Write path:

1. An editor saves a file into the managed workspace folder.
2. The agent computes the content hash and creates a durable safety journal entry before treating the write as locally accepted.
3. The local cache records the visible content and pending write state.
4. The agent streams the mutation to the cloud file graph service.
5. The cloud validates the base revision, stores new content if needed, advances the file/workspace revision, and returns an acknowledgement.
6. The agent marks the journal entry acknowledged, updates local revision state, and emits `cloud.acknowledged`.
7. The status API reports a clean workspace when no pending journal entries remain.

If the cloud cannot acknowledge immediately, the journal entry remains pending and the status API should make that visible.

## Next Milestones

### 1. Lock The Managed-Folder Contracts

- Keep the current deterministic demo working.
- Treat cloud graph shape, journal entries, event names, and status fields as explicit contracts.
- Align docs and examples with the actual spike commands: `npm run agent:demo`, `npm run agent:watch`, `npm run agent:sync`, and `npm run agent:status`.
- Keep `.private/` as owner-private workspace scope, not an ignored or skipped path.

### 2. Stabilize Restart Recovery

- Persist pending writes durably before cloud acknowledgement.
- Keep `npm run agent:recover` replaying pending journal entries in order before reporting a clean workspace.
- Keep `npm run agent:watch` blocked when recovery cannot safely replay unacknowledged journal entries.
- Keep acknowledged, pending, failed, and uncertain entries visible through status.
- Preserve owner-private `.private/` scope during replay.
- Expand focused recovery fixtures that simulate process exit after journal append and before cloud acknowledgement.

### 3. Harden The Watch Loop

- Make `npm run agent:watch` the primary continuous-agent proof path.
- Debounce repeated editor saves without dropping the final content.
- Keep the watch loop alive across transient sync failures.
- Emit status and event-log evidence for started, degraded, recovered, sync-complete, and sync-failed states.
- Keep clean cloud content, pending local edits, and failed writes distinguishable in status.

### 4. Add Cloud-Service Boundaries

- Replace the local cloud JSON file with a service-shaped interface.
- Keep a local fixture implementation for tests and demos.
- Model acknowledgements, validation failures, connectivity loss, and retry timing.
- Preserve the same editor read/write flow from the managed-folder spike.

### 5. Prove Two-Device Continuity

- Run two agent sessions against the same cloud file graph.
- Show that a write acknowledged from one session becomes visible to another.
- Emit event-log entries for remote updates and cache invalidation.
- Surface pending and acknowledged state through the status API.

### 6. Tighten Managed-Folder Behavior

- Handle creates, writes, deletes, renames, and `.private/` visibility paths consistently.
- Make local cache pruning explicit and conservative.
- Preserve normal editor and terminal compatibility as the primary v1 constraint.

### 7. Tighten Conflict Handling

- Detect writes based on stale cloud revisions.
- Surface conflicts as reviewable workspace states through status and events.
- Keep clean acknowledged content evictable while preserving unacknowledged local edits.

## Future Optional Research

A true OS filesystem mount, macFUSE backend, or RAM-only working set may become useful after the managed-folder product is proven. If that work resumes, it should keep the same cloud graph, safety journal, status API, event log, and acknowledgement contracts so the product model does not change.

# HopIt MVP Plan

Last updated: 2026-07-01

## Goal

Build the smallest useful version of a cloud-native managed workspace for codebases. The MVP should prove that a developer can choose a HopIt Workspace Root on a device, see cloud codebases as normal local project folders, edit with normal tools, and have those changes become cloud-backed active change-set state automatically.

The product promise is:

> It feels local. It lives in the cloud.

HopIt should start as a managed-folder Workspace Root for codebases, not as social Git hosting or a true OS filesystem mount. A normal folder cannot fully behave like a native ghost filesystem without an OS filesystem provider, so v1 should use the practical path first: cloud metadata, conservative lazy materialization, safe local cache, automatic remote update delivery, and visible blocked/conflict states.

The v1 sharing model has two layers. Path visibility is controlled by `.private/`: files under `.private/` are snapshotted, synced, and versioned like any other workspace file, but they are visible only to the owner. Change-set visibility controls whether in-progress work outside `.private/` is private, visible to the team, or opened for review.

Change-set visibility should be configurable as a global user default, a per-codebase override, and a per-change-set override. The effective rule is: per-change-set override, then codebase override, then global user default, then product default. The product default should be conservative: private until shared or opened for review.

The long-term privacy model adds a third layer: encryption grants. Private and
shared-private repos need client-side encrypted file bytes, device trust, repo
keys, owner-private keys, secret-group keys, and invite-time key wrapping so
only intended users/devices can decrypt the right zones. The detailed
implementation plan is [HopIt Privacy And Encryption Plan](privacy-encryption-plan.md).

## Current Personal Production Baseline

The current real-use setup is a private dogfood baseline, not the final public product:

- Hosted dashboard: Vercel project `robertg761s-projects/hopit`, project id `prj_hO8U1QmyliQjGODz4R339UkgE86S`, at `https://hopit.dev`.
- Domain and product auth: Porkbun-owned `hopit.dev` points at Vercel; Clerk production DNS, SSL, live Vercel env, legacy Convex issuer, `HOPIT_AUTH_PROVIDER=clerk`, production Google OAuth, owner sign-in, and D1 owner claim are active. Basic Auth fallback is no longer needed for normal production access.
- Cloud graph: Cloudflare D1 database `hopit`, fronted for Vercel by the `hopit-d1-api` Worker. Legacy Convex project `robertgordon761/hopit` remains disabled and retained as an export/fallback source.
- Object storage: Cloudflare R2 bucket `hopit-blobs`, private public-access-disabled bucket, free-only app budget enabled, 1-day lifecycle rule for current no-charge dogfooding.
- Local device: packaged `hop-darwin-arm64` runtime installed under `/Users/robert/Library/Application Support/HopIt/Runtime`, supervised by LaunchAgent `com.hopit.agent.hopit`.
- Local workspace root: `/Users/robert/HopIt Workspaces`, with current codebase folder `/Users/robert/HopIt Workspaces/hopit`.
- Config source of truth: `.env.local` for this checkout and `/Users/robert/.config/hopit/production.env` for the installed agent. Both contain secrets and must not be committed.

Temporary choices:

- Clerk guards the hosted deployment; Basic Auth fallback should stay unset in production unless deliberately re-enabled for emergency recovery.
- R2 is the first low-cost object storage provider and keeps the storage contract S3-compatible for a later Backblaze B2 or larger production-storage migration.
- `.private/env/` remains local-only unless object storage and a local decrypt-capable key source are configured; when configured through either `HOPIT_CLIENT_ENCRYPTION_KEY` or `hop keys` user-vault bridging, routed secrets sync only as client-encrypted object blobs.
- The current full-repo literal mirror path can copy `.git/`, binary files, symlinks, empty directories, and generated files, but a full cloud upload of the current repository should not be treated as complete or safe by default.
- Full private-repo encryption is not complete yet. The current encrypted file
  support is routed-secret-only, but local device keyrings, encrypted recovery
  export, trusted-device public-key registration, and first wrapped-key APIs now
  exist. The next security milestone is repo/privacy-zone keys, per-file private
  encryption, invite-time grants, independent secret sharing, and complete
  revocation/rekey support.

The operational source of truth is [Personal Production Runbook](personal-production.md). The implementation ledger is [Progress Tracker](progress.md).

## First-Version Experience

1. A user creates or imports a codebase into HopIt.
2. HopIt stores Main, active change sets, file metadata, content-addressed blobs, collaborators, visibility settings, and snapshots in the cloud.
3. The user installs or runs the HopIt agent on a device.
4. The user chooses a HopIt Workspace Root, and the agent shows cloud codebases there as managed local project folders.
5. Directory and file metadata are visible before every file body is downloaded; file content is materialized when the workspace opens, when policy prefetches it, or when local tools need it.
6. Edits are captured by the agent, written into a small safety journal, and streamed to the user's active change set in the cloud.
7. Once the cloud acknowledges the write into the active change set, the local cache can keep or prune clean content according to policy.
8. Another device owned by the same user opens the same active change set and receives the current cloud state automatically when its local journal is clean, without a manual sync ritual.
9. Collaborators see in-progress work according to the active change set's effective visibility.
10. The user can check service health, rotate a scoped device token, create a restorable agent-state backup, create an owner-private Git export, request review, merge the change set into Main, import from Git, export a publishable snapshot, or publish a clean Git commit when ready.

## Core Concepts

### Codebase

The main object users interact with. A codebase contains Main state, active change sets, content-addressed blobs, workspace snapshots, collaborators, permissions, connected devices, visibility preferences, and sync state.

### HopIt Workspace Root

The local root chosen by the user, such as `~/HopIt Workspaces`. V1 should make cloud codebases appear under this root without asking the user to clone each project manually. The first implementation should use managed folders and agent-owned cache metadata. Native filesystem providers, macFUSE, or RAM-only mounts can be researched later if managed folders cannot meet the product experience.

### Main

The accepted shared state of a codebase. Main advances through an explicit merge/review action, not merely because an editor saved a file.

### Active Change Set

A cloud-backed working state created automatically when a user starts editing. It behaves like an automatic branch internally, but V1 should present it as a change set or draft rather than a user-managed Git branch. Live sync writes into the active change set so the user's devices can continue instantly without publishing directly to Main.

### Managed Workspace Folder

A normal local folder under the HopIt Workspace Root, materialized and watched by the HopIt agent. Editors, terminals, language servers, and test runners should treat it like any other folder, while HopIt treats it as an agent-owned view of cloud state with no clone to manage.

### HopIt Agent

A local process that creates and watches the managed workspace folder, manages local cache policy, records unsynced writes in a safety journal, and streams changes to HopIt.

### Local Cache

The agent-owned local working set. Files are materialized on disk for OS and editor compatibility, with metadata that lets HopIt distinguish clean cached content from unacknowledged user edits.

### Safety Journal

A small durable local record of writes that have not been acknowledged by the cloud. The safety journal protects recent edits from process crashes, network drops, and device sleep.

### Workspace Snapshot

An addressable cloud state for Main or an active change set at a point in time. A snapshot can include file revisions, in-progress workspace changes, device metadata, conflict markers, visibility metadata, review state, and publish metadata.

### Workspace Visibility

HopIt does not treat ignore files as a product sharing control. The reserved `.private/` directory is the v1 owner-only workspace area, and it still participates in snapshots, sync, and versioning. Files outside `.private/` can be shared, reviewed, and merged according to the active change set's visibility and codebase permissions.

Temporary safety exception: `.private/env/` is local-only unless client-side encrypted secret sync is configured. Env files routed there should remain usable by the local owner, and their raw bytes must not be uploaded to Convex, R2, B2, or another cloud provider.

### Privacy Zones And Key Grants

Path visibility decides what should be shown to a user. Encryption grants decide
what a user/device can actually decrypt. Private repos need these to be separate
contracts:

- normal repo content uses a repo content key
- `.private/**` uses an owner-private key
- `.private/env/**` and other secret bundles use separate secret-group keys
- `.git/**` and converted Git internals are owner-private by default
- public snapshots exclude private zones and can be published separately

Adding a collaborator should grant the normal repo content key only. Sharing
secrets or owner-private content requires a separate explicit grant. Revoking
access removes permissions immediately and rotates keys for future writes when
strong revocation is needed.

### Change-Set Visibility

The visibility state for in-progress work outside `.private/`. V1 should support at least private, team-visible, and review-visible states. Settings are resolved in this order: per-change-set override, codebase override, global user default, product default. `.private/` remains owner-only regardless of the change-set setting.

### Cloud File Graph

The durable representation of directories, files, blobs, revisions, visibility metadata, Main state, active change sets, and snapshot metadata. Git can be imported from and exported to this graph, and a snapshot or merged state can be published as a Git commit, but the graph is optimized for live sync, device handoff, review, merge, and on-demand hydration. V1 needs content-addressed blob storage and per-file revision guards so concurrent devices do not rely on whole-graph overwrites.

Before HopIt syncs secrets or claims private-repo security, the cloud file graph
needs client-side encrypted entries and wrapped key material. The intended
user/device set should control the decryption keys, with cloud services storing
only ciphertext, encrypted metadata, and wrapped key material. The security
target is that private content and secret values remain unreadable to Convex,
object storage, Vercel, and unapproved devices.

## Workspace Modes

### Managed Folder Mode

The v1 default. The agent creates managed project folders under the HopIt Workspace Root, materializes metadata and content according to policy, watches local edits, journals writes before cloud acknowledgement, and keeps the currently selected cloud state as the source of truth. For day-to-day editing, that state is usually the user's active change set; for browsing accepted project state, it can be Main.

### Safe Cache Mode

The same managed folder model with explicit pruning and recovery rules. HopIt owns the cache and can prune clean content, while unsynced writes stay protected by the safety journal.

### Lazy Materialization Mode

The first production-grade refinement of managed folder mode. HopIt may list project structure and metadata before every file body is present locally, then hydrate content on workspace open, explicit prefetch, remote update, or local tool demand. Until a native filesystem provider exists, demand hydration must be conservative: do not present a file as safely editable unless the agent can protect writes with the journal and cache metadata.

### Offline Mode

Optional later mode for travel or unreliable networks. The agent keeps enough local state to continue working and reconciles with cloud state when connectivity returns.

### Native Mount Research

Optional future research. A true OS filesystem mount, macFUSE backend, or RAM-only working set may become useful later for large repos or specialized workflows, but it is not the v1 default or next main milestone.

## Installer And Operations Baseline

The v1 agent should be installable and observable before HopIt depends on it
for valuable work. The first production-shaped baseline is intentionally simple:

- A standalone `hop` tarball with an embedded Node runtime.
- A local env file outside the repo for Convex URLs, bootstrap token, scoped device token, workspace root, backup root, export root, and remote-pull settings.
- Manual `hop service start/status/stop/restart` commands for debugging.
- A foreground `hop service run` mode for user-level supervisors.
- macOS LaunchAgent and Linux systemd user-service templates for start on login.
- Read-only `/status`, `/events`, `/journal`, and `/cloud` endpoints bound to loopback.
- A restorable agent-state backup path plus an explicit owner-private Git export path that can include `.private/`.
- A publishable export/publish path that omits `.private/`.
- Scoped device-token rotation that does not require deleting the local workspace.

Native signed installers, notarization, package-manager distribution, tray/menu
UI, and dashboard-guided credential recovery are later production polish, not
the current v1 proof gate.

## Current Architecture

- Web app: Next.js product shell on Vercel for codebases, files, live sync state, active change sets, connected devices, recent activity, collaborators, review/merge state, and snapshots.
- API: Next.js routes for hosted/local status and whitelisted local commands. Hosted deployments read D1 status and refuse local workspace commands.
- D1 backend: production graph service for codebase metadata, file metadata, object-blob references, agent events, dashboard reads, memberships, invitations, first work items/releases, scoped sessions, and trusted-device/key metadata. Legacy Convex backend remains as disabled fallback/migration code.
- Object storage: S3-compatible file-byte layer. Cloudflare R2 is the first personal-use provider with free-only budget guards enabled; Backblaze B2 can use the same adapter later by switching provider/env configuration when HopIt is ready for broader release.
- Local agent: managed-folder process with service/session token support, workspace-root index, hydration cursor, local cache, safety journal, retry queue, service wrapper, and `.private/` visibility handling.
- Installer/daemon: standalone package with embedded runtime, production env example, user-level launchd/systemd support scripts, manual service controls, supervised `service run`, backup/export runbook, token-rotation runbook, and stricter production config checks.
- Storage today: D1 separates graph/file metadata from file bytes. The agent can upload regular file bytes to S3-compatible object storage, store only `contentStorage`, provider, key, hash, and size metadata in D1 or the legacy Convex fallback, and hydrate/refresh/export by downloading and verifying the object hash. Routed secrets can be client-encrypted with the legacy local key or the `hop keys` user-vault bridge. Durable history reconstruction, full private-repo encryption, repo/zone key use, private metadata, and all product write paths still need to move onto the same model.
- Realtime today: polling through `/api/agent/status`, `remote-update` events emitted by explicit safe refresh, a per-workspace materialization cursor, and opt-in activity-gated `--remote-pull` with a five-minute default cooldown for personal dogfooding. Solid v1 still needs production-grade automatic remote-update delivery for file changes, collaborator presence, sync status, visibility changes, review events, merge events, and device handoff.
- Git interoperability: import/export/publish stays as snapshot interoperability, not the everyday sync model.

The local agent contract is detailed in [Local Agent Architecture](agent-architecture.md). That document is the implementation guide for the cloud file graph, managed-folder adapter, local cache, safety journal, status API, event log, two-device simulation, and editor read/write acknowledgement flow.

For a detailed done/in-progress/next view with proof commands, milestone status, contract tracking, and known gaps, see [Progress Tracker](progress.md).

## MVP Milestones

### Milestone 1: Product Shell

- Build the logged-in dashboard around codebases, files, active change sets, connected devices, sync state, collaborators, visibility, and recent activity.
- Remove GitHub-social concepts from the first prototype surface.
- Document the codebase, Main, active change set, managed workspace folder, `.private/` visibility model, change-set visibility model, agent, cache, journal, and snapshot model.

### Milestone 2: Agent Managed-Folder Spike

- Create a local agent that can materialize a tiny cloud-backed file tree into a normal managed folder.
- Hydrate or refresh file content from the cloud file graph.
- Capture writes and print deterministic write events.
- Prove that a normal editor can open and save files in the managed folder.

Current spike:

- `packages/agent` implements a managed-folder version of this lifecycle.
- `npm run agent:demo` seeds a local cloud graph, hydrates a workspace, simulates an editor save, journals the write, and acknowledges the cloud revision. The current spike treats that graph as a stand-in for one selected active change set.
- `npm run agent:recover` replays unacknowledged journal entries into the cloud graph.
- `npm run agent:watch` is the continuous managed-folder proof path: it runs recovery before hydration, blocks safely when recovery cannot replay, and coalesces watch-triggered sync attempts.
- `npm run agent:refresh` is the safe cloud-to-workspace path: it refuses pending or failed local journal state, then mirrors the cloud file graph into the managed folder when the journal is clean.
- `npm run agent:sync` runs one explicit scan/journal/acknowledgement pass.
- `npm run agent:status` prints read-only local agent state once, while `npm run agent:serve` starts the HTTP status server for status, event, journal, and cloud inspection.
- The agent now reaches the fixture-backed cloud graph through a service-shaped boundary, while preserving the same managed-folder, `.private/`, refresh, and journal contracts.
- The fixture graph now names Main, the selected active change set, owner identity, session identity, and effective change-set visibility. Acknowledged writes advance the selected active change set, while Main stays stable until the explicit merge command runs.
- Requester-aware fixture reads now prove collaborator visibility rules: private change sets hide active work from collaborators, team-visible and review-visible change sets expose non-private paths, and `.private/` remains owner-only.
- Minimal review/merge fixture commands open the selected active change set for review, merge it into Main, emit `change_set.review_opened` and `change_set.merged`, and surface review/merge state through status. Main stays stable until the explicit merge command runs.
- Fixture conflict handling detects stale selected-state revisions, stale file/base revisions, and stale Main revisions, emits `change_set.conflict_detected`, and surfaces conflict state while preserving local edits for review.
- The Next.js product shell now polls `/api/agent/status`, maps live local status/events/cloud data into the dashboard, and can read the Cloudflare D1 dashboard data when the D1 backend env is configured. Legacy Convex dashboard reads remain available while the old backend is being retired.
- `/api/agent/command` exposes whitelisted local actions for sync, refresh, recover, review, merge, first-run Workspace Root setup, and Workspace Root attach. Local dashboard server routes merge `~/.config/hopit/production.env` under the Next.js process env, and command execution uses `--profile production` when installed-agent paths are configured, so D1 credentials and Workspace Root paths stay aligned. Hosted D1-backed deployments can read status but still require the local agent for workspace commands.
- `hop workspace` persists a root-level index keyed by codebase and concrete workspace path; D1 account-visible discovery now merges cloud codebase heads with local attach/readiness state when credentials allow it, scoped device tokens fall back to the configured codebase, dashboard-driven first-run setup/metadata-only attach can bind a cloud codebase into the Workspace Root through the local agent, and hydrate, refresh, and sync update the materialized revision cursor that status and remote-pull use.
- `hop device` / `hop session` exposes local session status. Scoped session registration, listing, touch, and revocation now work on D1 and the legacy Convex fallback; the D1 proxy can accept scoped session tokens for codebase-scoped reads/writes, while installer/setup UX and complete product write-path coverage remain to harden.

Current next work:

1. Finish the HopIt Workspace Root product contract: automatic account bootstrap, richer hydrate onboarding, richer per-file cache metadata, and automatic lazy materialization policy on top of the current D1 account-visible discovery, dashboard-driven setup/metadata-only attach, and single-file hydrate primitives.
2. Broaden object-backed content-addressed storage and per-file revision guards beyond the agent sync path into full history, large files, product write flows, retention, and garbage collection.
3. Implement the privacy/encryption framework: device trust, user vault keys,
   repo/private/secret zone keys, encrypted blobs, key grants, invite-time key
   wrapping, revocation, recovery, and path-metadata privacy.
4. Promote the opt-in activity-gated remote-pull proof into production-grade automatic remote-update delivery so same-owner devices refresh safely without a manual command when the local journal is clean.
5. Harden scoped device/session auth coverage, membership, invitation, and permission work behind Clerk auth now that owner handoff is proven and production uses Clerk/D1 without Basic Auth.
6. Deepen the hosted code browser, diff/review/comment/history surface, issue/detail and discussion thread flows, releases, and project boards beyond the first dashboard slices.

### Milestone 3: Recovery And Watch Loop

- Treat the safety journal as the durable recovery boundary for writes awaiting cloud acknowledgement.
- Stabilize replay of pending journal entries after restarting the agent, preserving `.private/` owner-private scope.
- Keep watch startup blocked before hydration when recovery cannot safely replay unacknowledged entries.
- Keep failed and uncertain entries durable and visible through the status surface.
- Coalesce repeated editor saves into stable sync work without losing final file contents.
- Make the watch loop resilient to transient filesystem and cloud errors after startup.
- Emit `sync.failed` and `sync.complete` evidence so the web app can show live clean, pending, failed, degraded, and recovered sync states.

### Milestone 4: Cloud Service Boundary

- Replace the local cloud JSON file with a service-shaped file graph API.
- Model Main, active change sets, owner identity, change-set visibility, and merge targets.
- Store blobs content-addressably.
- Store file graph metadata and revisions.
- Add per-file mutation APIs with base revision checks and conflict responses.
- Reconstruct a Main or active change-set snapshot from metadata and blobs.

### Milestone 4.5: Privacy, Encryption, And Key Grants

- Replace the current routed-secret bridge with trusted device keys, user vault
  keys, repo content keys, owner-private keys, secret-group keys, and wrapped
  key grants. First device/user-vault/wrapped-key foundations exist; repo and
  zone keys remain.
- Encrypt all private/shared-private repo file bytes before object upload.
- Keep `.private/`, `.private/env/`, secrets, and Git internals in separate
  privacy zones with separate sharing rules.
- Grant repo access during invitation acceptance by wrapping repo keys to the
  recipient's trusted devices, while leaving secrets unshared by default.
- Add recovery, device approval, revocation, rotation, and audit events.
- Move private repo metadata toward encrypted paths and keyed path ids before
  marketing HopIt as fully zero-knowledge.

### Milestone 5: Two-Session Continuity

- Open the same codebase and active change set from a second device or second agent session owned by the same user.
- Show that an acknowledged write from one session becomes visible to the other without merging to Main.
- Use the same-owner simulation as the first proof: device/session A syncs a non-private file and a `.private/` owner-private file into the same active change set, then device/session B runs the safe refresh flow and sees both.
- Keep collaborator simulations passing: private change sets remain hidden, team-visible and review-visible change sets expose non-private paths, and `.private/` stays owner-only in every mode.
- Preserve pending local edits until acknowledgement or conflict review.
- Keep status and event-log evidence for remote updates.
- Move from explicit refresh-only continuity to automatic remote-update delivery when the receiving device has a clean local journal.

### Milestone 6: Review And Merge

- Let a user open an active change set for review.
- Merge a reviewed change set into Main.
- Keep Main stable until merge.
- In the current agent graph contract, `npm run agent:review` opens the selected active change set for review and emits `change_set.review_opened`; fixture tests provide deterministic proof coverage.
- In the current agent graph contract, `npm run agent:merge` merges the selected active change set into Main and emits `change_set.merged`; fixture tests provide deterministic proof coverage.
- Surface review and merge state through the local agent status contract.
- Surface conflicts as reviewable change-set states instead of terminal-only chores.
- Preserve visibility settings in review and merge history.

### Milestone 7: Git Compatibility

- Import an existing Git repository into the cloud file graph.
- Export a workspace snapshot to a Git commit. The current agent can export the selected graph state to a clean Git repo.
- Publish Main or a selected merged snapshot as Git history when the user chooses to publish. The current agent can publish the reviewed and merged selected active change set to a clean Git repo.
- Preserve commit ancestry where possible.
- Never leak `.private/` owner-only content during publish.
- Keep Git out of the everyday continuity model; no user-managed Git-style branch, fork, or worktree product surfaces in v1. Automatic active change sets are a HopIt product concept, not Git branch management.

### Milestone 8: GitHub-Lite Collaboration

- Add real accounts/auth and map every user-facing request to a durable HopIt user.
- Add codebase memberships, roles, invitations, and server-side permission checks.
- Build a hosted web code browser for Cloudflare D1-backed file graphs.
- Add diff, review, inline comment, and merge-history records around active change sets and Main.
- Add issues, projects, discussions, and releases as first-class codebase collaboration objects.
- Keep local-agent service tokens separate from human user auth.
- Keep `.private/` owner-only regardless of codebase role until a future explicit sharing model changes that.

The detailed implementation sequence lives in [GitHub-Lite Collaboration Plan](github-lite-collaboration-plan.md).

### Milestone 9: Workspace Root And Automatic Device Handoff

- Create a durable workspace-root configuration and setup flow. The root index, account-visible discovery, and dashboard first-run setup/metadata-only attach action exist; automatic account bootstrap remains.
- Represent codebase folders, hydration state, local cache state, and remote event cursors explicitly. Codebase/workspace entries, materialized revision cursors, metadata-only state, and partial single-file hydration exist; richer per-file cache policy remains.
- Materialize content lazily and safely, with no silent overwrite of pending local edits.
- Run an automatic remote-update loop that refreshes clean workspaces and blocks/conflicts dirty ones.
- Expose the same state in the dashboard, tray/menu UI, and `hop status`.

## Solid V1 Exit Criteria

- A new device can install HopIt, point at the same account/service, choose a Workspace Root, and see the user's cloud codebases.
- Opening a codebase materializes enough content for normal editor, terminal, language-server, and test-runner workflows.
- Local writes are journaled, acknowledged into an active change set, and visible on the web dashboard.
- Another same-owner device receives acknowledged changes automatically when safe, or gets an explicit blocked/conflict state.
- Convex/storage writes use file-level revisions and content-addressed blobs instead of replacing the whole graph as the concurrency boundary.
- Device/session tokens are scoped, revocable, and separate from human dashboard auth.
- A new device can run HopIt at login, expose loopback-only health endpoints, rotate a scoped token, and produce restorable agent-state backups, owner-private Git exports, and publishable exports without relying on the source checkout.
- The web app supports routeable code browsing, diffs, review comments, history, issues, discussions, projects, releases, members, invitations, and permission-aware writes.
- Git import/export/publish remains available as interoperability without becoming the everyday workspace model.

## Deliberate Non-Goals For V1

- Replacing every Git workflow on day one.
- User-managed Git-style branches, forks, worktrees, wiki pages, stars, public social discovery, trending pages, and marketplace features.
- Full browser IDE implementation.
- Enterprise admin, compliance, or audit-log features.
- Perfect merge conflict automation.
- True OS filesystem mount, macFUSE, RAM-only workspace mode, or large-repo virtual filesystem optimization as the first implementation. These remain valid future research after the managed-folder Workspace Root is proven.

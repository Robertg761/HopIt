# HopIt Work Items, Projects, Discussions, And Releases Plan

Last updated: 2026-06-23

## Purpose

This is the work-tracking and release sub-plan under the solid v1 dogfood track: GitHub-lite issues, projects, discussions, and releases around codebases, active change sets, Main, snapshots, and release history.

The goal is not to turn HopIt into a social Git host. HopIt should keep its current product center:

- managed cloud workspaces
- explicit Main
- active change sets
- `.private/` owner-only workspace scope
- review/merge as the boundary for accepted state
- Git import/export/publish as compatibility, not the everyday workflow

The collaboration layer should add the missing project-management objects developers expect around that core: issues, project boards, discussions, and releases.

Current live setup note: first issue, discussion, release, and member/invite slices exist behind the Clerk-protected Vercel deployment at `https://hopit.dev`. Basic Auth fallback remains enabled until sign-in/OAuth and owner-mapping smoke tests are complete. Project boards, richer release artifacts, durable review linkage, notifications, and complete permission coverage remain future work. Operational setup details, active accounts, and config locations are centralized in [Personal Production Runbook](personal-production.md).

## Product Principles

1. Collaboration is codebase-scoped by default. Issues, projects, discussions, and releases belong to a HopIt codebase before they belong to a public social network.
2. Active change sets stay the work-in-progress boundary. Issues can link to active change sets, but an issue is not a branch.
3. Releases point at accepted state. A published release should target Main, a merged snapshot, or a Git-published ref, not unreviewed local work.
4. `.private/` never leaks. Release notes, issue links, discussion links, generated summaries, exports, and publish flows must not expose owner-private paths or content.
5. The first version should be useful without notifications, reactions, mentions, public discovery, or marketplace-style surfaces.
6. The backend contract should be small and explicit before UI is built around it.

## Shared Object Contract

Every collaboration object should carry:

- `codebaseId`
- per-codebase `number`
- lifecycle `status`
- creator/updater identity strings, using durable HopIt user ids when product auth is active and a local/system actor only for personal dogfood fallbacks
- `createdAt` and `updatedAt`
- optional links to active change sets, snapshots, release targets, or other collaboration objects

Per-codebase numbers should come from server-side counters so a user can refer to `#12` without leaking database ids.

Initial statuses:

| Object | Statuses |
| --- | --- |
| Issue | `open`, `closed` |
| Project | `active`, `archived` |
| Discussion | `open`, `answered`, `locked`, `closed` |
| Release | `draft`, `published`, `archived` |

## Issues

Issues are the lightweight work-item object for bugs, tasks, cleanup, and follow-up work.

### Data Model

Issue fields:

- title
- optional body
- status
- optional priority: `low`, `medium`, `high`
- labels
- assignee ids
- optional linked active change set id
- optional linked release id
- comments

### Workflows

1. Create an issue from a codebase, active change set, discussion, failed sync/conflict event, or release checklist.
2. Assign labels and owners.
3. Link one or more active change sets once implementation starts.
4. Close the issue manually or from a merge/release action.
5. Keep issue comments as durable collaboration history, separate from the agent operational event log.

### Acceptance Criteria

- Issues can be created, listed by codebase, filtered by status, commented on, and closed/reopened.
- Issue numbers are stable within a codebase.
- Linked change-set ids are treated as references; closing an issue does not merge or publish code.
- Issue content does not expose hidden `.private/` path details from conflict or sync summaries.

## Projects

Projects are codebase-scoped planning boards. They should be enough to organize issues, discussions, releases, and plain notes without pulling HopIt into a full product-management suite.

### Data Model

Project fields:

- name
- optional description
- status
- ordered columns
- project items

Project item fields:

- project id
- column id
- position
- item target:
  - issue
  - discussion
  - release
  - note

### Workflows

1. Create a project with default columns: Todo, In progress, Done.
2. Add issues, discussions, releases, or notes to a column.
3. Move/reorder project items.
4. Archive a project without deleting the linked objects.
5. Later, drive project automation from issue status, review-opened, merged, and release-published events.

### Acceptance Criteria

- Projects can be created, listed by codebase, archived, and populated with typed items.
- Project items cannot link to objects from another codebase.
- Columns are project-owned; deleting or renaming columns needs a migration rule before UI work.

## Discussions

Discussions are durable async conversation threads for design questions, ideas, Q&A, and announcements that are too broad or speculative to be issues.

### Data Model

Discussion fields:

- title
- body
- category: `general`, `ideas`, `q-and-a`, `announcements`
- status
- labels
- linked issue ids
- optional linked active change set id
- comments

### Workflows

1. Start a discussion from a codebase or active change set.
2. Link follow-up issues once the conversation produces work.
3. Mark a Q&A discussion as answered.
4. Lock announcements or resolved threads.
5. Convert/link discussion outcomes to issues or release notes later.

### Acceptance Criteria

- Discussions can be created, listed by codebase/status, commented on, locked, closed, and marked answered.
- Locked discussions reject new comments.
- Linked issues must belong to the same codebase.

## Releases

Releases package accepted HopIt state for human consumption. A release is the product-facing record around Main/snapshot/Git publishing, changelogs, and artifacts.

### Data Model

Release fields:

- version
- title
- notes
- status
- target:
  - `main`
  - `snapshot`
  - `change-set`
  - `git`
- optional target revision
- optional provenance metadata
- assets

Release asset fields:

- release id
- name
- kind: `artifact`, `source-archive`, `note`
- optional URL
- optional size
- optional checksum

### Workflows

1. Draft a release against Main or a merged snapshot.
2. Generate or manually write release notes from closed issues, merged change sets, discussions, and publish metadata.
3. Attach artifacts or source archives.
4. Publish the release after the target state is accepted.
5. Later, connect `hop publish` and remote Git publish to release creation.

### Acceptance Criteria

- Releases can be drafted, listed by codebase/status, published, and given assets.
- Version names are unique within a codebase.
- Published releases point at accepted state and must not include `.private/` content or hidden path names.
- Draft releases can exist before artifact generation; publishing is the durable boundary.

## Backend Implementation Phases

### Phase 1: Metadata Foundation

Status: backend foundation landed.

Scope:

- Added Convex tables for issues, issue comments, projects, project items, discussions, discussion comments, releases, release assets, and collaboration counters.
- Added permission-gated Convex functions for basic create/list/status/comment/asset operations.
- Added codebase existence validation before creating issues, projects, discussions, and releases.
- Added first hosted UI and API routes for issue, discussion, and release list/create/update flows.
- Project-board UI, comment detail pages, and release artifact workflows remain future work.

Proof:

- Convex code generation succeeds.
- TypeScript/ESLint passes.

### Phase 2: Agent And Event Integration

Scope:

- Add collaboration events such as `issue.created`, `issue.closed`, `project.item_moved`, `discussion.created`, `release.published`.
- Allow conflict and sync failure summaries to create issue drafts without exposing `.private/` details.
- Link issue closure to merge/release events only after explicit user action.
- Keep the operational agent event log separate from durable collaboration comments.

Proof:

- Agent tests cover issue creation from a conflict summary and verify hidden scope counts remain aggregated.

### Phase 3: Release Contract

Scope:

- Add merge records/history if not already complete.
- Add snapshot ids suitable for release targets.
- Connect Git export/publish outputs to release assets.
- Add release-note source selection from issues, discussions, and merged change sets.

Proof:

- A release can target a merged snapshot and attach a source archive without `.private/`.
- Release version uniqueness is enforced per codebase.

### Phase 4: Product UI

Scope:

- Add codebase-level tabs or navigation for Issues, Projects, Discussions, and Releases.
- Keep the first UI dense and work-focused, not social-network styled.
- Add issue/detail pages, discussion threads, project board movement, and release draft/publish views.
- Show links from active change sets to related issues/releases.

Proof:

- Browser verification covers create/list/comment/status flows.
- UI does not show hidden `.private/` paths to collaborators.

### Phase 5: Permissions And Notifications

Scope:

- Replace token-gated prototype functions with production identity checks.
- Enforce owner/member/guest capabilities for each object type.
- Add notification events only after object workflows are stable.
- Add mentions only if the collaboration model needs them.

Proof:

- Permission tests cover owner, collaborator, and guest reads/writes.
- Notification tests prove no event leaks hidden path names.

## Current Boundary

The first backend/UI slice has landed. The remaining boundary is deliberately
smaller than a full GitHub replacement:

- keep this plan as the roadmap source for deeper issue/project/discussion/release work
- keep the existing Convex schema/functions aligned with codebase permissions
- expand UI from list/create/update flows into detail/comment/project/release workflows
- avoid notifications, reactions, templates, markdown automation, and GitHub import/export until the core workflows are stable
- avoid changing the agent command contract unless an issue/release workflow truly needs agent events or publish artifacts

## Risks And Open Decisions

- Production Clerk infrastructure is active, but Basic Auth fallback remains enabled until sign-in/OAuth and owner mapping are smoke-tested.
- Per-codebase counters need to remain mutation-owned to avoid duplicate public numbers.
- Project item ordering needs a real reorder strategy before a UI board depends on it.
- Release targets need durable snapshot and merge-record ids before releases become authoritative.
- Generated summaries must be privacy-aware; hidden `.private/` details should stay aggregated.
- Git compatibility work can pull the product toward branch/repo hosting language unless the UI keeps Main, active change sets, and releases as HopIt-native concepts.

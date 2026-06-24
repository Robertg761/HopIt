# GitHub-Lite Collaboration Plan

Last updated: 2026-06-24

This is the collaboration sub-plan under the solid v1 dogfood track. HopIt is moving toward a production-shaped Workspace Root first, while also turning the deployed personal dogfood system into a private GitHub-lite collaboration surface. The current foundation is a Vercel-hosted dashboard, a Convex production graph, a production-profile local agent, a seeded `hopit` codebase, and a managed workspace hydrated outside the source checkout.

This plan covers the collaboration goals that sit beside Workspace Root, storage, scoped device auth, and automatic device-handoff work before deeper Git-replacement internals resume.

Private collaboration also depends on the encryption/key-grant model in
[HopIt Privacy And Encryption Plan](privacy-encryption-plan.md). This document
tracks the GitHub-like product layer; the privacy plan tracks which users and
devices can decrypt private repo content, `.private/`, and secrets.

## Current Baseline

- Production app: `https://hopit.dev`
- Secondary production alias: `https://www.hopit.dev`
- Vercel project: `robertg761s-projects/hopit`, project id `prj_hO8U1QmyliQjGODz4R339UkgE86S`, org/team id `team_x1SyEPIryEghBSkkwoXSTIZ2`
- Production Convex graph: `https://sincere-jaguar-17.convex.cloud`
- Convex project: `robertgordon761/hopit`
- Object storage: private Cloudflare R2 bucket `hopit-blobs`, currently free-only/lifecycle-limited for personal dogfooding
- Current codebase id: `hopit`
- Current production graph contents: 58 source files
- Current workspace: `/Users/robert/HopIt Workspaces/hopit`
- Current local service: LaunchAgent `com.hopit.agent.hopit` running the packaged `hop-darwin-arm64` runtime
- Current config locations: `.env.local` for this checkout and `/Users/robert/.config/hopit/production.env` for the installed local agent
- Hosted dashboard: Clerk production auth and Google OAuth are active for `hopit.dev`; Basic Auth fallback remains enabled until owner sign-in and owner mapping are complete; read-only for workspace commands
- Local agent: can import, hydrate, sync, refresh, recover, open review, merge, export, publish, validate, and report status
- Git compatibility: export/publish exists as a local escape hatch; history import, ancestry preservation, and remote publish are still future work

The current setup details live in [Personal Production Runbook](personal-production.md). This document is the implementation plan for the missing GitHub-like product layer, not the operational source of truth.

## Current Implementation Slice

The first collaboration slice is now started in the repo:

- Convex has user, auth identity, codebase member, invitation, and agent-session tables.
- Convex exposes authenticated viewer/upsert entrypoints plus owner-claim, member list/manage, and invitation create/accept/revoke mutations.
- The dashboard query can filter graph files by requester role and `.private/` ownership.
- The status mapper carries capped shared-file content previews.
- The dashboard includes a read-only code-review browser section.
- The dashboard includes member/invite management plus first issue, discussion, and release workflows.
- Convex has initial permission-gated tables/functions for issues, projects, discussions, releases, release assets, and per-codebase counters.
- Convex has scoped agent-session token registration/list/touch/revoke plus token authorization for graph reads, per-file agent writes, and event sync.
- Secret-only client encryption exists for routed `.private/env/` object blobs,
  but full private-repo encryption, invite-time key grants, independent secret
  sharing, path encryption, and revocation/rekey flows are still pending.

This is still a foundation layer, but it is no longer only backend scaffolding. The repo has Clerk-backed sign-in routes, auth middleware, Convex auth config, member/invite UI, work-item UI, owner email config, scoped agent-session token groundwork, and a Convex JWT template. Clerk production DNS, SSL, live Vercel env, Convex issuer, `HOPIT_AUTH_PROVIDER=clerk`, and production Google OAuth are active for `hopit.dev`; retiring Basic Auth fallback is intentionally deferred until owner sign-in and owner mapping are verified. Real diffs, inline review comments, routeable history, project-board UI, immutable release publishing, and complete permission coverage remain pending.

## Phase Principle

Build identity and collaboration as first-class product contracts, not as dashboard-only decoration. Every object below must eventually be permission checked server-side and tied to durable codebase, change-set, Main, and user identities.

For private repos, permission checks must be paired with encryption grants.
Membership can make a user eligible to read something, but only wrapped keys
should make that content decryptable on a trusted device.

Until the owner handoff is proven, keep Basic Auth fallback available and continue product work behind Clerk: permissions, role checks, code browsing, reviews, issues, discussions, releases, and local-agent/service-token hardening.

## Goal 1: Real Accounts And Auth

### Product Outcome

Users sign in as real HopIt users. The hosted dashboard no longer depends on shared Basic Auth as the product identity layer. Every server read/write can resolve the requester to a durable user id.

Current status: code support, production Clerk infrastructure, and production Google OAuth are active, but Basic Auth fallback remains enabled until owner sign-in and owner mapping are smoke-tested.

### Implementation Plan

1. Use Clerk as the first auth provider and document the production setup for Vercel plus Convex.
2. Add user identity tables and a server-side identity resolver.
3. Keep `HOPIT_AGENT_TOKEN` as the local-agent service credential, separate from human user auth.
4. Replace dashboard Basic Auth with Clerk sign-in once the provider is configured.
5. Add an authenticated `/api/me` or Convex query for current user/session metadata.
6. Migrate the seeded owner from `local-owner` to a real user id when the first account is connected.

### Definition Of Done

- Hosted dashboard requires provider sign-in.
- Convex can resolve the authenticated user for user-facing queries/mutations.
- Local agent writes remain service-authenticated and scoped to a codebase/member.
- Basic Auth is retained only as an emergency deployment guard or removed entirely.
- Docs explain env vars, provider dashboard setup, local development, production rollout, and recovery.

## Goal 2: Multi-User Permissions And Invitations

### Product Outcome

Codebases have owners and members. Invitations can bring a user into a codebase with a role. Access checks govern graph reads, comments, reviews, issues, releases, and future write commands.

### Implementation Plan

1. Add durable `users`, `codebaseMembers`, and `invitations` records.
2. Define roles: `owner`, `maintainer`, `member`, `viewer`.
3. Define capability checks for read, write, review, merge, manage members, manage settings, and release.
4. Add invitation lifecycle: created, accepted, expired, revoked.
5. Add membership UI: members list, owner claim, pending invites, invite creation, invite acceptance, revoke, suspend, and remove actions.
6. Thread requester identity through Convex dashboard reads and local-agent command authorization.
7. Preserve `.private/` owner-only semantics independently from member roles.

### Definition Of Done

- Every codebase has at least one owner membership.
- A signed-in user can only see codebases they own or belong to.
- Invited users can accept an invite and become members.
- Role checks are enforced server-side, not only hidden in UI.
- `.private/` remains owner-only even for maintainers/developers unless a future explicit sharing model changes that.

## Goal 2.5: Private Repo Encryption And Secret Grants

### Product Outcome

A private or shared-private HopIt repo can be uploaded completely, including
files that Git would ignore, while only intended users/devices can decrypt the
right content. Normal collaborator access grants normal repo files only.
`.private/`, `.private/env/`, and secret groups stay owner-private unless the
owner explicitly shares them.

Current status: routed secrets can sync as encrypted object blobs with the
legacy local key or the new `hop keys` user-vault bridge. Trusted device
keyrings, recovery export, and first wrapped-key APIs exist. Full repo-wide
private encryption, repo/zone keys, invite-time grants, independent secret
grants, and revoke/rotate flows are not implemented yet.

### Implementation Plan

1. Add privacy zones for repo content, owner-private content, secrets, Git
   internals, and public snapshots.
2. Add trusted device public keys, user vault keys, codebase keyrings, and
   wrapped key grants. First local/Convex foundations exist; repo/zone key use
   and product sharing flows remain.
3. Extend the object-blob pipeline so all private repo file bytes are encrypted
   locally before upload.
4. Make invitation acceptance grant the normal repo content key only, and only
   after a recipient trusted device is available.
5. Add explicit secret-group grants for `.private/env/**` and other configured
   secret prefixes.
6. Add revoke, rotate, recovery, and audit events for devices, members, repo
   keys, private-zone keys, and secret keys.
7. Move private repo metadata toward encrypted path manifests and keyed path ids.

### Definition Of Done

- Private repo normal files are ciphertext in object storage.
- Invited members can decrypt only granted repo zones.
- `.private/` and secrets remain unavailable to collaborators by default.
- Secret sharing is separate, explicit, audited, and revocable for future
  updates.
- New devices cannot decrypt existing private content until approved or
  recovered.
- Public export/publish cannot include private zones.

## Goal 3: Web Code Browsing

### Product Outcome

The hosted dashboard can browse the Convex-backed codebase graph: folders, files, file contents, metadata, revisions, and scope.

### Implementation Plan

1. Extend the status mapper to carry safe file content for visible files.
2. Add a read-only code browser component with file tree, search/filter, metadata, and content preview.
3. Add a routeable file selection model so a link can point to a codebase path.
4. Add server-side file read queries that enforce membership and `.private/` visibility.
5. Add syntax highlighting and large-file fallbacks after the basic browser exists.
6. Add path-level breadcrumbs and copy-link actions.

### Definition Of Done

- A signed-in member can browse visible files in the hosted dashboard.
- Owner-private paths remain hidden from non-owner requesters.
- Large or binary files do not crash the browser.
- File content, revision, size, hash, scope, and path are visible where appropriate.

## Goal 4: Diffs, Reviews, Comments, And History

### Product Outcome

HopIt shows what changed, lets users review active change sets, comment on files/lines, resolve discussions, and inspect accepted Main history.

### Implementation Plan

1. Add change-set and merge-history records separate from the flattened selected-state metadata.
2. Compute file diffs between Main and the selected active change set.
3. Add review records with states: draft, open, approved, changes requested, merged, closed.
4. Add inline comments anchored to path, side, line, selected-state revision, and optional range.
5. Add review timeline events from agent events plus durable review/comment records.
6. Add merge records that capture actor, previous Main revision, resulting Main revision, changed paths, and review id.
7. Move hosted review/merge actions behind authenticated, permission-checked server mutations.

### Definition Of Done

- Users can open a review from the web UI.
- Users can inspect a diff for the selected active change set.
- Users can comment on file lines and resolve review threads.
- Maintainers can merge only when permissions and review state allow it.
- Main history shows merge records and changed files.

## Goal 5: Issues, Projects, And Discussions

### Product Outcome

HopIt supports planning and asynchronous collaboration around codebases without leaving the product.

### Implementation Plan

1. Add issue records with title, body, author, assignee, labels, state, priority, and linked paths/change sets.
2. Add project records with views and project items that can reference issues, reviews, discussions, and releases.
3. Add discussion records with categories, comments, resolution/answer state, and optional linked files.
4. Add list/detail UI for issues, projects, and discussions.
5. Add permission checks for create, edit, close, pin, label, and delete/archive actions.
6. Add search/filter by state, assignee, label, project, and linked code path.

### Definition Of Done

- Members can create, edit, close, and comment on issues.
- Members can create discussions and reply in threads.
- Projects can group issues/reviews/discussions into basic planning views.
- All records are tied to codebase membership and audit metadata.

## Goal 6: Releases

### Product Outcome

HopIt can name accepted Main states as releases and attach notes/artifacts later.

### Implementation Plan

1. Add release records tied to `codebaseId`, Main revision, tag/name, notes, author, and creation time.
2. Start with metadata-only releases, then add artifacts once export/publish artifacts are durable.
3. Add release UI: list, detail, create draft, publish, archive.
4. Gate release publishing behind maintainer/owner permission.
5. Link releases to Git publish/export results when the Git compatibility layer grows remote publishing.

### Definition Of Done

- Maintainers can create a release from a Main revision.
- Releases show title, notes, revision, author, status, and timestamps.
- Published releases are immutable except for notes/status edits unless a later policy says otherwise.
- Release records can later attach Git exports or binary artifacts without schema churn.

## Execution Order

1. Accounts/auth and identity resolver.
2. Memberships, roles, invitations, and permission helpers.
3. Read-only code browser on permission-checked file reads.
4. Durable change sets, diffs, review records, and comments.
5. Issues, discussions, and projects.
6. Releases tied to Main revisions.
7. Deeper Git replacement work: immutable history, content-addressed blobs, clone/fetch/push equivalents, rollback, tags, and offline-first sync.

## Verification Strategy

- Unit tests for permission helpers and schema validators.
- Convex function tests or CLI smoke checks for seeded data and query/mutation behavior.
- Browser smoke for auth redirect, code browsing, invite acceptance, review open/comment/merge, issue creation, and release creation.
- Production smoke on `https://hopit.dev` after each deployment.
- Explicit negative tests for non-member reads, viewer write attempts, expired invites, `.private/` access, and merge without permission.

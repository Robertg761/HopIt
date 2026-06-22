# Auth And Collaboration Plan

This plan is the identity and permissions sub-plan under the solid v1 dogfood track. It covers real accounts, authenticated access, durable codebase membership, and invitation flows. Code browsing, diffs, comments, issues, projects, discussions, and releases build on this access layer as it becomes enforced server-side.

## Goals

- Every user-facing read and write has an authenticated actor.
- A HopIt user is a product identity that can be linked to one or more auth-provider identities.
- A codebase has durable membership rows with explicit roles instead of only a graph-local `collaborators` array.
- Invitations are email-bound, expiring, revocable, and accepted by an authenticated account.
- The server filters codebase state before returning it; the UI is never the permission boundary.
- `.private/` remains owner-only regardless of codebase membership or active change-set visibility.
- The current agent token remains a bootstrap/admin bridge while scoped device/session tokens cover normal installed-device operation.

## Data Model

### Users And Identities

`users` is the HopIt-owned account record. It stores `userId`, email/display metadata, and the user's global default change-set visibility.

`authIdentities` links provider identities to HopIt users. The first implementation can map a Convex auth `tokenIdentifier` to a single user, while leaving room for later account linking.

`/api/me` is the hosted account bridge. When Clerk auth and Convex are configured, it derives the Convex JWT from the server-side Clerk session, upserts the HopIt user through `agent.upsertViewer`, and returns a sanitized account summary. It does not accept caller-supplied bearer tokens for product account sync.

### Codebase Access

`codebaseMembers` is the durable access source for a codebase. Roles should start small:

| Role | Intended capability |
| --- | --- |
| `owner` | Full access, settings, invites, member management, review, merge, release |
| `maintainer` | Read/write, review, merge, invite collaborators |
| `member` | Read/write visible codebase content and participate in review |
| `viewer` | Read visible codebase content only |

The legacy graph `ownerId` and `collaborators[]` fields are still useful during migration and agent fixture imports, but production permission checks should prefer `codebaseMembers`.

### Invitations

`codebaseInvitations` stores pending, accepted, revoked, and expired invitations. Invitations should be keyed by an opaque token hash, not a raw token. Acceptance requires an authenticated user whose normalized primary email matches the invitation email.

Invitation creation is also server-guarded against duplicate active membership by normalized email. Expiry values must parse as future timestamps; invalid or past expiry values are rejected at creation, and legacy invalid pending expiries are treated as expired on read.

### Agent Sessions

`agentSessions` tracks user-owned devices or local agents. The table stores hashed session tokens, token prefixes, capabilities, expiry, status, revocation metadata, user id, and optional codebase scope. `HOPIT_AGENT_TOKEN` remains the bootstrap/admin credential, while normal installed devices can use `HOPIT_AGENT_SESSION_TOKEN` for graph reads, per-file mutations, and agent event appends.

Session tokens are generated once with an `hst_` prefix, stored only as hashes plus a display prefix, and scoped to a single user/codebase pair. Re-registering an existing session id is only allowed for that same user and codebase; cross-user or cross-codebase reuse is rejected. Session expiry values must be valid future timestamps.

## Permission Rules

1. Owners can see all codebase files, including `.private/`.
2. Non-owners can never see `.private/` paths or their names.
3. Guests see nothing unless a future public-link feature explicitly grants access.
4. Members and maintainers can see Main.
5. Members and maintainers can see active change-set files only when effective visibility is `team-visible` or `review-visible`.
6. Viewers can read visible state but cannot write, invite, review, merge, or publish.
7. Maintainers and owners can create invitations.
8. Only owners can downgrade, suspend, or remove other owners.

## Implementation Sequence

1. Land the identity/access schema and read-side helpers.
2. Seed `codebaseMembers` from graph `ownerId` and `collaborators[]` whenever the current agent saves a graph.
3. Add authenticated account upsert from Convex auth and expose a small `viewer` query.
4. Add invitation create/accept/revoke mutations and write tests around email match, expiry, revocation, and duplicate acceptance.
5. Make dashboard and graph reads requester-aware, returning visible file counts plus hidden scope counts without leaking hidden paths.
6. Move write operations from deployment-wide agent-token authorization to scoped actor authorization: authenticated user for browser commands, scoped agent session token for local agent writes. Agent graph reads, per-file mutations, and event appends now support scoped session tokens; complete browser command/write coverage remains.
7. Add audit events for membership and invitation changes.
8. Replace the graph-local collaborator list as the source of truth once migration has backfilled memberships.

## Current Patch Boundary

Status: backend plus first hosted UI/API slice landed.

- Added Convex tables for users, auth identities, codebase members, invitations, and agent sessions.
- Added scoped agent-session registration, listing, touch, revocation, token hashing, capability checks, and CLI `hop device` commands.
- Added Convex helpers for authenticated viewer upsert, owner claim, member list/manage, invitation create/accept/revoke, and requester-aware dashboard filtering.
- Added pending-invite duplicate checks, server-generated invite tokens, token hashing, verified-email invite acceptance, and revocation audit fields.
- Added Clerk provider wiring, sign-in/sign-up pages, auth middleware, `/api/me`, and Clerk-to-Convex token forwarding through the hosted API routes.
- Added hosted member/invite UI for owner claim, member list, invite creation, invite acceptance, revocation, suspension, and removal.
- Preserved service-token bootstrap/admin behavior while adding session-token authorization for `getGraph`, per-file mutation sync, and event append paths.
- Hardened hosted API token handling so collaboration routes derive Convex auth from the active Clerk server session instead of trusting arbitrary request bearer tokens.
- Added `/api/me` Convex account sync, active-member invite rejection, future-only invite/session expiries, session id reuse checks, and `hst_` session-token format validation.

## Domain-Deferred Rollout

The provider-auth code remains valuable, but production Clerk rollout is pinned until HopIt has an owned domain. Current personal production should keep `HOPIT_AUTH_PROVIDER=basic`, `HOPIT_ALLOW_BASIC_AUTH_FALLBACK=1`, and the Vercel-generated deployment URL.

Continue building domain-independent pieces:

- Permission helpers and server-side role checks.
- Membership and invitation lifecycle behavior.
- Requester-aware dashboard filtering.
- Complete permission coverage for every browser and agent write path.

Do not treat these as current blockers:

- Clerk production instance completion.
- `pk_live_`/`sk_live_` Vercel environment rollout.
- Production OAuth callback verification on an owned domain.
- Retiring Basic Auth from the live deployment.

## Risks And Blockers

- The production deployment has Clerk/Convex wiring in code, but production Clerk rollout is intentionally deferred until an owned HopIt domain exists. Basic Auth remains the current personal production guard.
- The current agent can read graphs through scoped session tokens, but bootstrap/admin graph replacement still uses the shared service token. Retiring the shared token requires installer/setup flow, rotation UX, and complete write-path coverage.
- Existing fixture identities such as `user_demo_owner` are not real auth subjects. Migration must map or claim those owners before production use.
- Invitation emails are matched against HopIt `users.primaryEmail`, so duplicate-member rejection only works for accounts that have already signed in or otherwise been upserted.

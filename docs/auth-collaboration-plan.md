# Auth And Collaboration Plan

This plan scopes the next major HopIt phase around real accounts, authenticated access, durable codebase membership, and invitation flows. It deliberately covers identity and permissions only; code browsing, diffs, comments, issues, projects, discussions, and releases should build on this access layer after it is enforced server-side.

## Goals

- Every user-facing read and write has an authenticated actor.
- A HopIt user is a product identity that can be linked to one or more auth-provider identities.
- A codebase has durable membership rows with explicit roles instead of only a graph-local `collaborators` array.
- Invitations are email-bound, expiring, revocable, and accepted by an authenticated account.
- The server filters codebase state before returning it; the UI is never the permission boundary.
- `.private/` remains owner-only regardless of codebase membership or active change-set visibility.
- The current agent token remains a bootstrap/admin bridge only until user-scoped device tokens are introduced.

## Data Model

### Users And Identities

`users` is the HopIt-owned account record. It stores `userId`, email/display metadata, and the user's global default change-set visibility.

`authIdentities` links provider identities to HopIt users. The first implementation can map a Convex auth `tokenIdentifier` to a single user, while leaving room for later account linking.

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

### Agent Sessions

`agentSessions` tracks user-owned devices or local agents. A later patch should replace the single deployment-wide `HOPIT_AGENT_TOKEN` with user/device-scoped tokens bound to an agent session and codebase membership.

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
6. Move write operations from deployment-wide agent-token authorization to scoped actor authorization: authenticated user for browser commands, scoped agent session token for local agent writes.
7. Add audit events for membership and invitation changes.
8. Replace the graph-local collaborator list as the source of truth once migration has backfilled memberships.

## Current Patch Boundary

Status: backend plus first hosted UI/API slice landed.

- Added Convex tables for users, auth identities, codebase members, invitations, and agent sessions.
- Added Convex helpers for authenticated viewer upsert, owner claim, member list/manage, invitation create/accept/revoke, and requester-aware dashboard filtering.
- Added pending-invite duplicate checks, server-generated invite tokens, token hashing, verified-email invite acceptance, and revocation audit fields.
- Added Clerk provider wiring, sign-in/sign-up pages, auth middleware, `/api/me`, and Clerk-to-Convex token forwarding through the hosted API routes.
- Added hosted member/invite UI for owner claim, member list, invite creation, invite acceptance, revocation, suspension, and removal.
- Preserved existing `getGraph`, `saveGraph`, and `appendEvent` token behavior for the local agent.

## Risks And Blockers

- The production deployment still needs real Clerk environment variables and the Convex auth issuer before Basic Auth can be retired.
- The current agent reads full graphs through `getGraph`; scoped agent sessions are required before the shared token can be retired.
- Existing fixture identities such as `user_demo_owner` are not real auth subjects. Migration must map or claim those owners before production use.

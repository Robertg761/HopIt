-- Batch device authorization: one row per project requested/approved under a
-- single authorization, so `hop add --all` connects N projects in ONE browser
-- round trip instead of N. Not idempotent beyond `if not exists` (matches this
-- repo's existing migrations): apply once, by hand. Never applied automatically.
--
-- APPLY THIS BEFORE DEPLOYING THE APP CODE. The table is additive and unused by
-- the currently-deployed build, so applying it early is safe; deploying the app
-- first is NOT, because createDeviceAuthorization inserts here and both the
-- browser approval page and the CLI go through that path -- device authorization
-- would fail outright until the table existed.
--
-- The scalar codebase columns on device_authorizations stay populated from the
-- FIRST entry, so agents and browser tabs running pre-batch code keep working
-- through the rollout. Authorizations created before this table existed simply
-- have no rows here, and the read paths synthesize a single entry from those
-- scalars (see deviceAuthorizationCodebases in
-- packages/backend-d1/src/device-authorizations.js), which is what lets an
-- authorization already in flight during the deploy still complete.
--
-- Deliberately NOT added to `codebaseScopedTables` in cloudflare/d1/scoped-sql.js:
-- device authorization runs through the web app's server credential, not a scoped
-- `hst_` session, exactly like device_authorizations and device_keys.
create table if not exists device_authorization_codebases (
  authorization_id text not null,
  position integer not null,
  requested_codebase_id text not null,
  requested_codebase_name text,
  codebase_id text,
  session_id text,
  wrapped_session_token_json text,
  state text not null,
  primary key (authorization_id, requested_codebase_id)
);

create index if not exists idx_device_authorization_codebases_authorization on device_authorization_codebases(authorization_id, position);

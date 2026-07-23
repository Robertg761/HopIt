create table if not exists users (
  user_id text primary key,
  primary_email text,
  display_name text,
  avatar_url text,
  email_verified integer not null default 0,
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_users_primary_email on users(primary_email);

create table if not exists codebases (
  codebase_id text primary key,
  name text not null,
  owner_id text not null,
  schema_version integer not null,
  revision integer not null,
  main_json text not null,
  selected_state_json text not null,
  owner_json text not null,
  collaborators_json text not null,
  session_json text not null,
  visibility_json text not null,
  file_count integer not null default 0,
  private_file_count integer not null default 0,
  member_count integer not null default 1,
  updated_at text not null
);

create table if not exists files (
  codebase_id text not null,
  path text not null,
  kind text not null default 'file',
  content text not null default '',
  encoding text not null default 'utf8',
  target text,
  blob_hash text,
  blob_provider text,
  blob_key text,
  blob_size integer,
  client_encryption_json text,
  encryption_json text,
  privacy_zone text,
  zone_id text,
  content_storage text not null default 'inline',
  hash text,
  size integer,
  scope text not null,
  revision integer not null,
  updated_at text not null,
  primary key (codebase_id, path),
  foreign key (codebase_id) references codebases(codebase_id) on delete cascade
);

create index if not exists idx_files_codebase on files(codebase_id);

create table if not exists file_versions (
  version_id integer primary key autoincrement,
  codebase_id text not null,
  selected_state_type text,
  selected_state_id text,
  main_state_id text,
  graph_revision integer not null,
  path text not null,
  operation text not null,
  kind text not null default 'file',
  old_revision integer,
  new_revision integer,
  old_file_json text,
  new_file_json text,
  scope text not null,
  privacy_zone text,
  zone_id text,
  content_storage text not null default 'inline',
  blob_provider text,
  blob_key text,
  blob_hash text,
  encoding text not null default 'utf8',
  target text,
  size integer,
  actor_user_id text,
  session_id text,
  device_name text,
  created_at text not null,
  foreign key (codebase_id) references codebases(codebase_id) on delete cascade
);

create index if not exists idx_file_versions_codebase_revision_path on file_versions(codebase_id, graph_revision, path);
create index if not exists idx_file_versions_codebase_path_revision on file_versions(codebase_id, path, graph_revision);
create index if not exists idx_file_versions_codebase_blob_key on file_versions(codebase_id, blob_key);

create table if not exists file_blobs (
  codebase_id text not null,
  hash text not null,
  content text not null,
  encoding text not null default 'utf8',
  size integer not null,
  created_at text not null,
  primary key (codebase_id, hash)
);

create table if not exists agent_events (
  id integer primary key autoincrement,
  codebase_id text not null,
  event text not null,
  detail_json text not null,
  at text not null,
  source text
);

create index if not exists idx_agent_events_codebase_at on agent_events(codebase_id, at);
create index if not exists idx_agent_events_codebase_event_at on agent_events(codebase_id, event, at);

create table if not exists codebase_members (
  codebase_id text not null,
  user_id text not null,
  role text not null,
  status text not null,
  source text,
  invited_by_user_id text,
  joined_at text,
  created_at text not null,
  updated_at text not null,
  primary key (codebase_id, user_id)
);

create index if not exists idx_codebase_members_user on codebase_members(user_id);

create table if not exists codebase_invitations (
  invitation_id text primary key,
  codebase_id text not null,
  normalized_email text not null,
  role text not null,
  token_hash text not null,
  status text not null,
  invited_by_user_id text not null,
  accepted_by_user_id text,
  revoked_by_user_id text,
  expires_at text,
  accepted_at text,
  revoked_at text,
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_codebase_invitations_codebase on codebase_invitations(codebase_id);
create index if not exists idx_codebase_invitations_token on codebase_invitations(token_hash);

create table if not exists agent_sessions (
  session_id text primary key,
  user_id text not null,
  codebase_id text not null,
  device_name text,
  token_hash text,
  token_prefix text,
  capabilities_json text not null default '[]',
  expires_at text,
  status text not null,
  created_at text not null,
  last_seen_at text not null,
  updated_at text not null,
  revoked_by_user_id text,
  revoked_at text
);

create index if not exists idx_agent_sessions_token_hash on agent_sessions(token_hash);
create index if not exists idx_agent_sessions_user on agent_sessions(user_id);
create index if not exists idx_agent_sessions_codebase on agent_sessions(codebase_id);

create table if not exists device_authorizations (
  authorization_id text primary key,
  device_code_hash text not null unique,
  user_code text not null unique,
  request_fingerprint text,
  device_id text not null,
  device_name text,
  platform text,
  device_key_json text not null,
  status text not null,
  user_id text,
  codebase_id text,
  session_id text,
  wrapped_session_token_json text,
  created_at text not null,
  expires_at text not null,
  approved_at text,
  consumed_at text,
  updated_at text not null
);

create index if not exists idx_device_authorizations_device_code on device_authorizations(device_code_hash);
create index if not exists idx_device_authorizations_user_code on device_authorizations(user_code);
create index if not exists idx_device_authorizations_fingerprint_created on device_authorizations(request_fingerprint, created_at);

create table if not exists device_keys (
  device_id text primary key,
  user_id text not null,
  display_name text,
  platform text,
  encryption_public_key text not null,
  encryption_public_key_algorithm text not null,
  encryption_public_key_encoding text not null,
  signing_public_key text,
  signing_public_key_algorithm text,
  signing_public_key_encoding text,
  status text not null,
  created_at text not null,
  trusted_at text,
  revoked_at text,
  last_seen_at text
);

create index if not exists idx_device_keys_user on device_keys(user_id);
create index if not exists idx_device_keys_user_status on device_keys(user_id, status);

create table if not exists user_keyrings (
  user_id text primary key,
  vault_key_id text not null,
  current_version integer not null,
  status text not null,
  recovery_configured integer not null default 0,
  created_at text not null,
  updated_at text not null
);

create table if not exists codebase_keyrings (
  codebase_id text primary key,
  repo_content_key_id text not null,
  owner_private_key_id text not null,
  git_internals_key_id text not null,
  default_secret_key_id text not null,
  rotation_state text,
  created_at text not null,
  updated_at text not null
);

create table if not exists wrapped_keys (
  wrap_id text primary key,
  wrapped_key_id text not null,
  wrapped_key_type text not null,
  key_version integer not null,
  recipient_type text not null,
  recipient_id text not null,
  codebase_id text,
  zone_id text,
  wrapping_key_id text,
  wrapping_public_key_id text,
  algorithm text not null,
  ciphertext text not null,
  created_by_user_id text,
  created_by_device_id text,
  created_at text not null,
  expires_at text,
  revoked_at text,
  status text not null
);

create index if not exists idx_wrapped_keys_wrapped_key on wrapped_keys(wrapped_key_id);
create index if not exists idx_wrapped_keys_recipient on wrapped_keys(recipient_type, recipient_id);
create index if not exists idx_wrapped_keys_codebase on wrapped_keys(codebase_id);
create index if not exists idx_wrapped_keys_zone on wrapped_keys(zone_id);

create table if not exists key_audit_events (
  event_id text primary key,
  codebase_id text,
  actor_user_id text,
  actor_device_id text,
  event_type text not null,
  target_user_id text,
  target_device_id text,
  zone_id text,
  key_id text,
  wrap_id text,
  created_at text not null
);

create index if not exists idx_key_audit_events_codebase on key_audit_events(codebase_id, created_at);
create index if not exists idx_key_audit_events_actor on key_audit_events(actor_user_id, created_at);

create table if not exists action_jobs (
  job_id text primary key,
  codebase_id text not null,
  kind text not null,
  command text not null,
  args_json text not null default '[]',
  status text not null,
  requested_by_user_id text not null,
  runner_id text,
  exit_code integer,
  stdout text,
  stderr text,
  summary text,
  created_at text not null,
  updated_at text not null,
  claimed_at text,
  started_at text,
  finished_at text
);

create index if not exists idx_action_jobs_status_created on action_jobs(status, created_at);
create index if not exists idx_action_jobs_codebase_created on action_jobs(codebase_id, created_at);

create table if not exists review_threads (
  thread_id text primary key,
  codebase_id text not null,
  change_set_id text not null,
  file_path text not null,
  line_number integer,
  base_revision text,
  head_revision text,
  line_fingerprint text,
  status text not null,
  created_by text not null,
  updated_by text,
  created_at text not null,
  updated_at text not null,
  resolved_at text
);

create index if not exists idx_review_threads_codebase_change_set on review_threads(codebase_id, change_set_id, updated_at);
create index if not exists idx_review_threads_codebase_path on review_threads(codebase_id, file_path);

create table if not exists review_thread_comments (
  comment_id text primary key,
  codebase_id text not null,
  thread_id text not null,
  body text not null,
  created_by text not null,
  updated_by text,
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_review_thread_comments_thread on review_thread_comments(thread_id);
create index if not exists idx_review_thread_comments_codebase on review_thread_comments(codebase_id);

create table if not exists review_decisions (
  decision_id text primary key,
  codebase_id text not null,
  change_set_id text not null,
  decision text not null,
  summary text,
  created_by text not null,
  created_at text not null
);

create index if not exists idx_review_decisions_codebase_change_set on review_decisions(codebase_id, change_set_id, created_at);

create table if not exists notifications (
  notification_id text primary key,
  codebase_id text not null,
  recipient_user_id text,
  kind text not null,
  title text not null,
  body text not null,
  href text,
  read_at text,
  created_at text not null
);

create index if not exists idx_notifications_codebase_created on notifications(codebase_id, created_at);
create index if not exists idx_notifications_recipient_created on notifications(recipient_user_id, created_at);

-- Phase 3 multi-tenant usage and billing. These are additive tables so the
-- migration is safe to apply before the feature flags are enabled.
create table if not exists tenant_usage (
  tenant_id text primary key,
  plan text not null default 'free',
  storage_bytes integer not null default 0,
  write_day text,
  rows_written_today integer not null default 0,
  created_at text not null,
  updated_at text not null
);

create table if not exists subscriptions (
  tenant_id text primary key,
  provider text not null,
  provider_customer_id text,
  provider_subscription_id text unique,
  plan_key text not null,
  status text not null,
  entitlement_active integer not null default 0,
  cancel_at_period_end integer not null default 0,
  current_period_end text,
  last_event_id text not null,
  last_event_created_at text not null,
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_subscriptions_provider_customer
  on subscriptions(provider, provider_customer_id);

create table if not exists billing_webhook_events (
  event_id text primary key,
  provider text not null,
  event_created_at text not null,
  received_at text not null
);

create index if not exists idx_billing_webhook_events_received
  on billing_webhook_events(received_at);

-- Narrow owner-only service controls. Paid entitlements remain billing-owned;
-- these controls only pause tenant writes or revoke compromised sessions.
create table if not exists tenant_controls (
  tenant_id text primary key,
  writes_paused integer not null default 0,
  reason text,
  updated_by_user_id text not null,
  created_at text not null,
  updated_at text not null
);

create table if not exists service_admin_events (
  event_id text primary key,
  actor_user_id text not null,
  action text not null,
  target_type text not null,
  target_id text not null,
  detail_json text not null default '{}',
  created_at text not null
);

create index if not exists idx_service_admin_events_created
  on service_admin_events(created_at);

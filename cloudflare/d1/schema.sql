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

create table if not exists collaboration_counters (
  codebase_id text not null,
  scope text not null,
  next_number integer not null,
  updated_at text not null,
  primary key (codebase_id, scope)
);

create table if not exists issues (
  issue_id text primary key,
  codebase_id text not null,
  number integer not null,
  title text not null,
  body text,
  status text not null,
  priority text,
  labels_json text not null default '[]',
  assignee_ids_json text not null default '[]',
  linked_change_set_id text,
  linked_release_id text,
  created_by text not null,
  updated_by text,
  created_at text not null,
  updated_at text not null,
  closed_at text
);

create index if not exists idx_issues_codebase_created on issues(codebase_id, created_at);
create index if not exists idx_issues_codebase_status on issues(codebase_id, status);
create unique index if not exists idx_issues_codebase_number on issues(codebase_id, number);

create table if not exists issue_comments (
  comment_id text primary key,
  codebase_id text not null,
  issue_id text not null,
  body text not null,
  created_by text not null,
  updated_by text,
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_issue_comments_issue on issue_comments(issue_id);
create index if not exists idx_issue_comments_codebase on issue_comments(codebase_id);

create table if not exists projects (
  project_id text primary key,
  codebase_id text not null,
  number integer not null,
  name text not null,
  description text,
  status text not null,
  columns_json text not null default '[]',
  created_by text not null,
  updated_by text,
  created_at text not null,
  updated_at text not null,
  archived_at text
);

create index if not exists idx_projects_codebase_created on projects(codebase_id, created_at);
create index if not exists idx_projects_codebase_status on projects(codebase_id, status);
create unique index if not exists idx_projects_codebase_number on projects(codebase_id, number);

create table if not exists project_items (
  project_item_id text primary key,
  codebase_id text not null,
  project_id text not null,
  item_json text not null,
  column_id text not null,
  position real not null,
  created_by text not null,
  updated_by text,
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_project_items_project on project_items(project_id);
create index if not exists idx_project_items_codebase on project_items(codebase_id);

create table if not exists discussions (
  discussion_id text primary key,
  codebase_id text not null,
  number integer not null,
  title text not null,
  body text not null,
  category text not null,
  status text not null,
  labels_json text not null default '[]',
  linked_issue_ids_json text not null default '[]',
  linked_change_set_id text,
  created_by text not null,
  updated_by text,
  created_at text not null,
  updated_at text not null,
  closed_at text
);

create index if not exists idx_discussions_codebase_created on discussions(codebase_id, created_at);
create index if not exists idx_discussions_codebase_status on discussions(codebase_id, status);
create unique index if not exists idx_discussions_codebase_number on discussions(codebase_id, number);

create table if not exists discussion_comments (
  comment_id text primary key,
  codebase_id text not null,
  discussion_id text not null,
  body text not null,
  created_by text not null,
  updated_by text,
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_discussion_comments_discussion on discussion_comments(discussion_id);
create index if not exists idx_discussion_comments_codebase on discussion_comments(codebase_id);

create table if not exists releases (
  release_id text primary key,
  codebase_id text not null,
  number integer not null,
  version text not null,
  title text not null,
  notes text not null,
  status text not null,
  target_json text not null,
  provenance_json text,
  created_by text not null,
  updated_by text,
  created_at text not null,
  updated_at text not null,
  published_at text
);

create index if not exists idx_releases_codebase_created on releases(codebase_id, created_at);
create index if not exists idx_releases_codebase_status on releases(codebase_id, status);
create unique index if not exists idx_releases_codebase_version on releases(codebase_id, version);
create unique index if not exists idx_releases_codebase_number on releases(codebase_id, number);

create table if not exists release_assets (
  asset_id text primary key,
  codebase_id text not null,
  release_id text not null,
  name text not null,
  kind text not null,
  url text,
  size integer,
  checksum text,
  created_by text not null,
  created_at text not null
);

create index if not exists idx_release_assets_release on release_assets(release_id);
create index if not exists idx_release_assets_codebase on release_assets(codebase_id);

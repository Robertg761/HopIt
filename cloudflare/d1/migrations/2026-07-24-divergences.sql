-- GR-A2: same-owner multi-device divergence persistence (decisions §1).
-- Written by the reconnect protocol when a path was touched by two devices
-- with differing content. Nothing is ever silently dropped: `local_entry_json`
-- holds the offline device's full file payload so it stays retrievable even
-- though it is never written to `files` while the divergence is open. The
-- cloud side needs no separate copy here -- it is the codebase's current (or,
-- after resolution, historical) `files`/`file_versions` row. One row per
-- divergence; a path can accumulate multiple resolved rows over time, but at
-- most one `state = 'open'` row per (codebase_id, path).
create table if not exists divergences (
  divergence_id text primary key,
  codebase_id text not null,
  path text not null,
  scope text,
  state text not null default 'open',
  reason text,
  base_revision integer,
  cloud_revision integer,
  local_hash text,
  cloud_hash text,
  local_device text,
  cloud_device text,
  local_side text,
  cloud_side text,
  local_entry_json text,
  opened_at text not null,
  resolved_at text,
  resolved_keep text,
  resolved_revision integer,
  created_at text not null,
  updated_at text not null,
  foreign key (codebase_id) references codebases(codebase_id) on delete cascade
);

create index if not exists idx_divergences_codebase_state on divergences(codebase_id, state);
create index if not exists idx_divergences_codebase_path_state on divergences(codebase_id, path, state);

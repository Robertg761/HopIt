-- GR-B4: releases (decisions doc §9). A lightweight, named pin of a Main
-- revision -- "mark this state as a release" without any git tag in the
-- product. Not idempotent on purpose (matches this repo's existing
-- migrations): apply once, by hand. Never applied automatically.
--
-- Duplicate names per codebase are rejected in application code
-- (`createRelease` in packages/backend-d1/src/releases-store.js), not a SQL
-- unique constraint -- same reasoning as the proposals table's open-proposal
-- constraint: the GR-S1 drift-test parser only understands plain `create
-- index` statements, not partial/unique index syntax.
--
-- GR-E3 (later, not implemented by this migration) reads this table to emit
-- a git tag on the mirror when one is configured: `name` is the tag name
-- candidate, `pinned_revision` is what to build the tree from.
create table if not exists releases (
  release_id text primary key,
  codebase_id text not null,
  name text not null,
  notes text,
  pinned_revision integer not null,
  created_by_user_id text not null,
  created_at text not null,
  foreign key (codebase_id) references codebases(codebase_id) on delete cascade
);

create index if not exists idx_releases_codebase_name on releases(codebase_id, name);
create index if not exists idx_releases_codebase_created on releases(codebase_id, created_at);

-- GR-C1: per-codebase derived-path overrides (decisions §6).
-- Not applied automatically; the owner runs this by hand against production D1.
--
-- `codebase_settings` already exists live (trail-summarization opt-in). This
-- adds one additive column for the derived-path add/remove overrides. Safe to
-- re-run is NOT guaranteed for `alter table add column` on D1/SQLite (it
-- errors if the column already exists), so this should only be applied once.
alter table codebase_settings
  add column derived_path_overrides text not null default '{}';

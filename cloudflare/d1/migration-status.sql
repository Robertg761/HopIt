-- Read-only migration status report for a HopIt D1 database.
--
-- Answers "which of cloudflare/d1/migrations/*.sql are already applied?"
-- without writing anything. Run it against production before applying any
-- migration by hand -- most of those files are `alter table ... add column`,
-- which is NOT idempotent on SQLite/D1 and errors if the column is already
-- there, so applying blind is how you get a half-failed batch.
--
--   npx wrangler d1 execute <DB_NAME> --remote --file cloudflare/d1/migration-status.sql
--
-- Every row comes back with applied = 1 (nothing to do) or applied = 0 (the
-- migration still needs to be applied). A migration that adds several columns
-- reports one row per column, because a partially-applied ALTER batch is a
-- real state: an earlier run can fail halfway and leave some columns present.
--
-- Why this is needed at all: production sets HOPIT_D1_ASSUME_SCHEMA=1, so
-- `ensureSchema()` (packages/backend-d1/src/schema-methods.js) returns
-- immediately and never self-heals the schema. Nothing applies these files
-- automatically. Separately, the newer `codebase_settings` columns exist only
-- inside that table's inline `create table if not exists`, which is a no-op
-- against an already-existing table -- so for a live database these migrations
-- are the only way those columns ever appear.
with expected(migration, object_name, column_name) as (
  values
    -- `create table if not exists` migrations. These are checked by a
    -- distinctive *column*, never by table name alone: `if not exists` keys
    -- off the name, so an unrelated table that happens to share the name
    -- silently swallows the migration and leaves the real one uncreated.
    -- That is not hypothetical -- the production database already had a
    -- `releases` table belonging to a different feature entirely (version /
    -- number / status / published_at), which a name-only check reported as
    -- "applied" while `hop release` would have failed on the missing
    -- `pinned_revision` column.
    ('2026-07-14-service-admin',        'tenant_controls',      'writes_paused'),
    ('2026-07-14-service-admin',        'service_admin_events', 'action'),
    ('2026-07-24-divergences',          'divergences',          'local_entry_json'),
    ('2026-07-24-proposals',            'proposals',            'pinned_revision'),
    ('2026-07-24-releases',             'releases',             'pinned_revision'),

    -- alter table add column: the non-idempotent ones. These are the rows
    -- that actually decide whether it is safe to run a file.
    ('2026-07-23-derived-path-overrides', 'codebase_settings', 'derived_path_overrides'),
    ('2026-07-23-large-file-threshold',   'codebase_settings', 'large_file_threshold_bytes'),
    ('2026-07-23-secret-scanning-setting','codebase_settings', 'secret_scanning_enabled'),
    ('2026-07-24-mirror-remote-config',   'codebase_settings', 'mirror_remote_url'),
    ('2026-07-24-mirror-remote-config',   'codebase_settings', 'mirror_branch'),
    ('2026-07-24-mirror-remote-config',   'codebase_settings', 'mirror_deploy_key_ciphertext'),
    ('2026-07-24-mirror-remote-config',   'codebase_settings', 'mirror_deploy_key_metadata'),
    ('2026-07-24-action-jobs-proposal-link', 'action_jobs',      'proposal_id'),
    ('2026-07-24-proposals',              'review_decisions',   'decision_revision'),
    ('2026-07-24-proposals',              'review_decisions',   'proposal_id')
)
select
  expected.migration,
  expected.object_name,
  coalesce(expected.column_name, '(table)') as checks,
  case
    when not exists (
      select 1 from sqlite_master
      where type = 'table' and name = expected.object_name
    ) then 0
    when expected.column_name is null then 1
    when exists (
      select 1 from pragma_table_info(expected.object_name)
      where name = expected.column_name
    ) then 1
    else 0
  end as applied
from expected
order by expected.migration, expected.object_name, checks;

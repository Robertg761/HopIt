-- GR-D1: per-project secret-scanning setting (decisions doc §7).
-- Warn-only outbound secret scanning defaults ON; codebase_settings already
-- exists in production (self-healing `create table if not exists` in
-- packages/backend-d1/src/schema.js), so this adds the new column via ALTER.
-- Not idempotent on purpose (matches this repo's one existing migration):
-- the owner applies this once, by hand.
alter table codebase_settings add column secret_scanning_enabled integer not null default 1;

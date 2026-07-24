-- GR-E2: mirror automation on merge (decisions doc §8).
-- Adds the mirror destination (remote/branch) and an optional client-
-- encrypted deploy key to codebase_settings, which already exists in
-- production (self-healing `create table if not exists` in
-- packages/backend-d1/src/schema.js). Not idempotent on purpose (matches
-- this repo's existing migrations): the owner applies this once, by hand.
--
-- `mirror_deploy_key_ciphertext`/`mirror_deploy_key_metadata` must never
-- carry plaintext key material -- only the AES-256-GCM envelope produced by
-- the agent's local `@hopit/core/crypto` `encryptClientPayload`, the same
-- rule already applied to `.private/env/`.
alter table codebase_settings add column mirror_remote_url text;
alter table codebase_settings add column mirror_branch text;
alter table codebase_settings add column mirror_deploy_key_ciphertext text;
alter table codebase_settings add column mirror_deploy_key_metadata text;

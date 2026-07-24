-- GR-B5: CI on propose (actions-runner hardening). Ties an `action_jobs`
-- row back to the proposal it gates, so the merge queue can find "the CI
-- job for this proposal" (kind = 'ci') without a separate join table.
-- Additive column: existing rows get NULL, meaning "not a proposal-gating
-- job" (hosted lint/test/build requests, and GR-E2 mirror-push jobs, never
-- carry a proposal_id). Not idempotent on purpose (matches this repo's
-- existing migrations): apply once, by hand. Never applied automatically.
alter table action_jobs add column proposal_id text;

create index if not exists idx_action_jobs_proposal on action_jobs(proposal_id, created_at);

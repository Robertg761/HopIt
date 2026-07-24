-- GR-B1: proposal data model (decisions doc §2-4). DRAFT migration for the
-- design in docs/proposal-data-model-design.md. Not applied automatically;
-- the owner runs this by hand against production D1. GR-B2 is blocked on
-- owner sign-off of the design before it ships propose/merge-queue code
-- against this schema.
--
-- `decision_revision` / `proposal_id` are additive columns on the existing
-- `review_decisions` table (safe: existing rows get NULL, meaning "reviewed
-- before proposals existed" / "not yet re-associated"). Not idempotent on
-- purpose (matches this repo's existing migrations): apply once, by hand.
alter table review_decisions add column decision_revision integer;
alter table review_decisions add column proposal_id text;

create index if not exists idx_review_decisions_codebase_change_set on review_decisions(codebase_id, change_set_id, created_at);

-- The first-class proposal row. See docs/proposal-data-model-design.md for
-- the full state machine, the traceability table against decisions §2-4, and
-- why there is no separate merge-queue table (ordering + serialization reuse
-- `queued_at` plus the codebase's existing `revision` compare-and-swap).
create table if not exists proposals (
  proposal_id text primary key,
  codebase_id text not null,
  change_set_id text not null,
  title text,
  state text not null default 'proposed',
  pinned_revision integer not null,
  pinned_at text not null,
  base_revision integer not null,
  created_by_user_id text not null,
  created_at text not null,
  updated_at text not null,
  queued_at text,
  merged_at text,
  merged_revision integer,
  merged_by_user_id text,
  stale_at text,
  stale_reason text,
  foreign key (codebase_id) references codebases(codebase_id) on delete cascade
);

create index if not exists idx_proposals_codebase_change_set on proposals(codebase_id, change_set_id, updated_at);
create index if not exists idx_proposals_codebase_state_queued on proposals(codebase_id, state, queued_at);

-- Additive owner operations state. Safe to re-run.
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

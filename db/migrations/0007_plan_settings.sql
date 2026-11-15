-- Plan names, prices and feature lists managed in the platform admin. Drafts until an owner publishes them;
-- the website, sign-up and the control centre read the published values. System-only (no tenant access).
create table bai_plan_settings (
  plan_id text primary key check (plan_id in ('starter','growth','professional','premium')),
  draft jsonb,
  published jsonb,
  draft_changed boolean not null default false,
  updated_by uuid references bai_platform_admins(id) on delete set null,
  updated_at timestamptz not null default now(),
  published_at timestamptz
);

create table bai_plan_settings_history (
  id bigserial primary key,
  plan_id text not null,
  value jsonb,
  action text not null check (action in ('save','publish')),
  admin_id uuid references bai_platform_admins(id) on delete set null,
  occurred_at timestamptz not null default now()
);
create trigger bai_plan_settings_history_append_only before update or delete on bai_plan_settings_history
  for each row execute function bai_forbid_mutation();

alter table bai_plan_settings enable row level security;
alter table bai_plan_settings_history enable row level security;

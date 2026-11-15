-- The platform's own agents (they work for CONARO Business AI itself, not for a customer's business):
-- their runs and the proposals they put in the owner's approval queue. System-only (no tenant access).
create table bai_platform_agent_runs (
  id bigserial primary key,
  agent_id text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text not null default 'running' check (outcome in ('running','succeeded','failed')),
  summary jsonb not null default '{}'::jsonb,
  simulated boolean not null default false,
  triggered_by text not null
);
create index bai_platform_agent_runs_recent on bai_platform_agent_runs (agent_id, id desc);

create table bai_platform_proposals (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null,
  kind text not null check (kind in ('task','site.copy','plans.draft','outreach.draft')),
  title text not null check (length(title) <= 200),
  rationale text not null check (length(rationale) <= 4000),
  evidence jsonb not null default '[]'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','applied','expired')),
  outcome text,
  decided_by uuid references bai_platform_admins(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
-- One open proposal per subject: agents re-running daily do not pile up duplicates.
create unique index bai_platform_proposals_open on bai_platform_proposals (dedupe_key) where status = 'pending';

alter table bai_platform_agent_runs enable row level security;
alter table bai_platform_proposals enable row level security;

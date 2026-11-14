-- CONARO Business AI: multi-tenant AI workforce for businesses on the marketplace.
--
-- Tenant isolation is enforced by the database, not by application filters:
--   * Every tenant table carries tenant_id, defaulted from the transaction
--     setting bai.tenant_id (set by withTenant() in src/business-ai/tenancy.ts).
--   * Tenant code runs as the role bai_tenant (SET LOCAL ROLE), which has
--     no BYPASSRLS. Policies allow only rows of the current tenant; with no
--     tenant set, nothing is visible and nothing can be written.
--   * The application's own role (table owner) is used only by system code:
--     tenant creation, sign-in, and listing tenants for the worker.
--   * History tables are append-only (bai_forbid_mutation below).
--   * Every object is prefixed bai_, so this schema can share a database with the
--     CONARO operating system without touching it.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'bai_tenant') then
    create role bai_tenant nologin nobypassrls;
  end if;
exception when duplicate_object or unique_violation then
  null; -- roles are cluster-wide: another database's migration created it at the same moment
end $$;

-- The connecting role must be a member to SET ROLE (not needed for superusers).
do $$ begin
  execute format('grant bai_tenant to %I', current_user);
exception when others then
  raise notice 'grant bai_tenant to % skipped: %', current_user, sqlerrm;
end $$;

create or replace function bai_forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception '% on % is not allowed: history is append-only', tg_op, tg_table_name;
end $$;

create or replace function bai_current_tenant() returns uuid
  language sql stable as $$ select nullif(current_setting('bai.tenant_id', true), '')::uuid $$;

-- ---------------------------------------------------------------- tenants
create table bai_tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text not null,
  industry text not null,
  status text not null default 'onboarding' check (status in ('onboarding','active','suspended','cancelled')),
  paused boolean not null default false,
  paused_at timestamptz,
  paused_reason text,
  time_zone text not null default 'America/Moncton',
  marketplace_provider_ref text,
  created_at timestamptz not null default now()
);

-- Identities of people who use Business AI (business owners and their staff).
-- System-only: no policy for bai_tenant.
create table bai_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email)),
  display_name text not null,
  password_hash text not null,
  status text not null default 'active' check (status in ('active','disabled')),
  created_at timestamptz not null default now()
);
create table bai_sessions (
  token_hash text primary key,
  user_id uuid not null references bai_users(id) on delete cascade,
  tenant_id uuid not null references bai_tenants(id) on delete cascade,
  csrf_token text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table bai_login_attempts (
  id bigserial primary key,
  email text not null,
  ip text not null,
  success boolean not null,
  attempted_at timestamptz not null default now()
);
create index bai_login_attempts_recent on bai_login_attempts (attempted_at);

create table bai_memberships (
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  user_id uuid not null references bai_users(id) on delete cascade,
  role text not null check (role in ('owner','manager','staff','accountant','viewer')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create table bai_counters (
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  kind text not null,
  value integer not null default 0,
  primary key (tenant_id, kind)
);

-- ---------------------------------------------------------------- profile and configuration
create table bai_profiles (
  tenant_id uuid primary key default bai_current_tenant() references bai_tenants(id) on delete cascade,
  version integer not null default 0,
  data jsonb not null default '{}'::jsonb,
  intelligence jsonb not null default '{}'::jsonb,
  completeness integer not null default 0 check (completeness between 0 and 100),
  updated_at timestamptz not null default now(),
  updated_by text not null
);
create table bai_profile_versions (
  id bigserial primary key,
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  version integer not null,
  data jsonb not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, version)
);
create trigger bai_profile_versions_append_only before update or delete on bai_profile_versions
  for each row execute function bai_forbid_mutation();

create table bai_settings (
  tenant_id uuid primary key default bai_current_tenant() references bai_tenants(id) on delete cascade,
  policy jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text not null
);

create table bai_agents (
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  agent_id text not null,
  enabled boolean not null default false,
  autonomy text not null default 'approval' check (autonomy in ('draft_only','approval','rules','autonomous')),
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, agent_id)
);

create table bai_agent_memory (
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  agent_id text not null,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, agent_id, key)
);

create table bai_services (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  name text not null,
  category text not null,
  description text not null default '',
  pricing_unit text not null check (pricing_unit in ('fixed','hourly','per_unit')),
  unit_label text,
  price_cents integer check (price_cents >= 0),
  min_charge_cents integer not null default 0 check (min_charge_cents >= 0),
  travel_fee_cents integer not null default 0 check (travel_fee_cents >= 0),
  duration_minutes integer check (duration_minutes > 0),
  required_skill text,
  taxable boolean not null default true,
  seasonal_months integer[] not null default '{}',
  limitations text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table bai_employees (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  name text not null,
  email text,
  skills text[] not null default '{}',
  -- {"1": ["08:00","17:00"], ...} ISO weekday (1 = Monday) -> working window, local time
  availability jsonb not null default '{}'::jsonb,
  location_consent boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- customers and consent
create table bai_customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  name text not null,
  email text check (email is null or email = lower(email)),
  phone text,
  area text,
  language text not null default 'en-CA' check (language in ('en-CA','fr-CA')),
  preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now()
);
create index bai_customers_email on bai_customers (tenant_id, email);

create table bai_consents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  customer_id uuid references bai_customers(id) on delete set null,
  email text not null check (email = lower(email)),
  basis text not null check (basis in ('express','implied_existing_business_relationship','implied_inquiry','none')),
  source text not null,
  evidence jsonb not null default '{}'::jsonb,
  obtained_at timestamptz not null,
  expires_at timestamptz,
  withdrawn_at timestamptz,
  created_at timestamptz not null default now()
);
create table bai_suppressions (
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  email text not null check (email = lower(email)),
  reason text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, email)
);
create trigger bai_suppressions_no_delete before delete on bai_suppressions
  for each row execute function bai_forbid_mutation();

-- ---------------------------------------------------------------- revenue: leads, quotes, campaigns
create table bai_campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('seasonal','service','referral','repeat','reactivation','education','capacity','social','seo','email')),
  channel text not null,
  status text not null default 'draft' check (status in ('draft','pending_approval','scheduled','active','completed','cancelled')),
  budget_cents integer not null default 0 check (budget_cents >= 0),
  starts_on date,
  ends_on date,
  content jsonb not null default '{}'::jsonb,
  tracking_code text not null,
  dedupe_key text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, tracking_code),
  unique (tenant_id, dedupe_key)
);

create table bai_leads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  ref text not null,
  customer_id uuid not null references bai_customers(id),
  service_id uuid references bai_services(id),
  channel text not null,
  description text not null,
  area text,
  desired_date date,
  quantity numeric,
  status text not null default 'new' check (status in ('new','qualified','unqualified','quoted','won','lost')),
  score integer check (score between 0 and 100),
  qualification jsonb not null default '{}'::jsonb,
  estimated_value_cents integer,
  lost_reason text,
  campaign_id uuid references bai_campaigns(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, ref)
);

create table bai_quotes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  ref text not null,
  lead_id uuid references bai_leads(id),
  customer_id uuid not null references bai_customers(id),
  lines jsonb not null,
  subtotal_cents integer not null,
  discount_cents integer not null default 0,
  tax_cents integer not null,
  tax_rate_bp integer not null,
  total_cents integer not null,
  status text not null default 'draft' check (status in ('draft','pending_approval','sent','accepted','declined','expired')),
  valid_until date,
  assumptions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  decided_at timestamptz,
  unique (tenant_id, ref)
);

-- ---------------------------------------------------------------- operations
create table bai_bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  ref text not null,
  customer_id uuid not null references bai_customers(id),
  service_id uuid not null references bai_services(id),
  quote_id uuid references bai_quotes(id),
  lead_id uuid references bai_leads(id),
  employee_id uuid references bai_employees(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  status text not null default 'requested' check (status in ('requested','confirmed','completed','cancelled','no_show')),
  recurrence text check (recurrence in ('weekly','biweekly','monthly')),
  area text,
  reminder_sent_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  unique (tenant_id, ref)
);
create index bai_bookings_time on bai_bookings (tenant_id, starts_at);

create table bai_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  ref text not null,
  booking_id uuid not null references bai_bookings(id),
  status text not null default 'scheduled' check (status in ('scheduled','in_progress','completed','cancelled')),
  checklist jsonb not null default '[]'::jsonb,
  notes text not null default '',
  outcome text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, ref),
  unique (tenant_id, booking_id)
);

create table bai_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  ref text not null,
  job_id uuid references bai_jobs(id),
  customer_id uuid not null references bai_customers(id),
  lines jsonb not null,
  subtotal_cents integer not null,
  tax_cents integer not null,
  tax_rate_bp integer not null,
  total_cents integer not null,
  paid_cents integer not null default 0,
  status text not null default 'draft' check (status in ('draft','issued','partially_paid','paid','void')),
  due_on date,
  issued_at timestamptz,
  last_reminder_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, ref),
  unique (tenant_id, job_id)
);

create table bai_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  invoice_id uuid references bai_invoices(id),
  amount_cents integer not null check (amount_cents > 0),
  method text not null,
  received_on date not null,
  source text not null check (source in ('manual','import','integration')),
  external_ref text,
  recorded_by text not null,
  created_at timestamptz not null default now()
);
create trigger bai_payments_append_only before update or delete on bai_payments
  for each row execute function bai_forbid_mutation();

create table bai_feedback (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  customer_id uuid references bai_customers(id),
  job_id uuid references bai_jobs(id),
  rating integer not null check (rating between 1 and 5),
  comment text not null default '',
  source text not null,
  response_draft text,
  created_at timestamptz not null default now()
);

create table bai_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  customer_id uuid references bai_customers(id),
  lead_id uuid references bai_leads(id),
  direction text not null check (direction in ('inbound','outbound')),
  channel text not null,
  body text not null,
  simulated boolean not null default false,
  action_id uuid,
  created_at timestamptz not null default now()
);
create trigger bai_messages_append_only before update or delete on bai_messages
  for each row execute function bai_forbid_mutation();

-- ---------------------------------------------------------------- finance
create table bai_transactions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  occurred_on date not null,
  description text not null,
  amount_cents integer not null check (amount_cents > 0),
  direction text not null check (direction in ('income','expense')),
  category text,
  category_source text check (category_source in ('import','owner','rule_confirmed')),
  suggested_category text,
  suggestion_reason text,
  tax_cents integer,
  status text not null default 'unreviewed' check (status in ('unreviewed','confirmed')),
  flags text[] not null default '{}',
  source text not null,
  external_ref text,
  import_hash text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, import_hash)
);
create table bai_transaction_events (
  id bigserial primary key,
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  transaction_id uuid not null references bai_transactions(id),
  actor text not null,
  change jsonb not null,
  created_at timestamptz not null default now()
);
create trigger bai_transaction_events_append_only before update or delete on bai_transaction_events
  for each row execute function bai_forbid_mutation();

-- ---------------------------------------------------------------- orchestration
create table bai_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text not null,
  status text not null default 'pending' check (status in ('pending','processed','ignored')),
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (tenant_id, dedupe_key)
);
create index bai_events_pending on bai_events (tenant_id, created_at) where status = 'pending';

create table bai_workflow_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  workflow text not null,
  event_id uuid references bai_events(id),
  status text not null default 'running' check (status in ('running','retry_scheduled','succeeded','failed','paused')),
  context jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  error text,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (tenant_id, dedupe_key)
);
create table bai_workflow_steps (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  run_id uuid not null references bai_workflow_runs(id) on delete cascade,
  step_key text not null,
  agent_id text not null,
  status text not null check (status in ('succeeded','skipped','failed')),
  output jsonb not null default '{}'::jsonb,
  error text,
  attempts integer not null default 1,
  finished_at timestamptz not null default now(),
  unique (run_id, step_key)
);
create table bai_agent_messages (
  id bigserial primary key,
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  run_id uuid references bai_workflow_runs(id) on delete cascade,
  from_agent text not null,
  to_agent text not null,
  kind text not null,
  body jsonb not null,
  created_at timestamptz not null default now()
);
create trigger bai_agent_messages_append_only before update or delete on bai_agent_messages
  for each row execute function bai_forbid_mutation();

create table bai_approvals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  ref text not null,
  action_type text not null,
  level integer not null check (level in (1,2,3)),
  title text not null,
  summary text not null default '',
  payload jsonb not null,
  idempotency_key text not null,
  requested_by_agent text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','expired','executed')),
  decided_by uuid references bai_users(id),
  decided_at timestamptz,
  note text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, ref)
);
create unique index bai_approvals_one_open on bai_approvals (tenant_id, idempotency_key) where status in ('pending','approved','executed');
create table bai_approval_events (
  id bigserial primary key,
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  approval_id uuid not null references bai_approvals(id),
  event text not null,
  actor text not null,
  note text,
  created_at timestamptz not null default now()
);
create trigger bai_approval_events_append_only before update or delete on bai_approval_events
  for each row execute function bai_forbid_mutation();

create table bai_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  agent_id text not null,
  action_type text not null,
  level integer not null check (level in (1,2,3)),
  title text not null,
  payload jsonb not null,
  idempotency_key text not null,
  status text not null check (status in ('done','simulated','approval_pending','approved_for_person','blocked','rejected')),
  reason text,
  result jsonb not null default '{}'::jsonb,
  run_id uuid references bai_workflow_runs(id) on delete set null,
  approval_id uuid references bai_approvals(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);
create index bai_actions_recent on bai_actions (tenant_id, created_at);

create table bai_recommendations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  agent_id text not null,
  kind text not null check (kind in ('recommendation','opportunity','issue')),
  title text not null,
  rationale text not null,
  assumptions jsonb not null default '[]'::jsonb,
  data_basis jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open','accepted','dismissed','done')),
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, dedupe_key)
);

create table bai_reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  kind text not null check (kind in ('daily_summary','weekly','monthly','value_report','revenue_review')),
  period text not null,
  body jsonb not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, kind, period)
);

create table bai_admin_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  title text not null,
  kind text not null check (kind in ('task','deadline','reminder')),
  due_on date,
  source_agent text not null,
  status text not null default 'open' check (status in ('open','done','dismissed')),
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, dedupe_key)
);

create table bai_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  name text not null,
  kind text not null,
  content_text text not null,
  size_bytes integer not null check (size_bytes <= 1048576),
  sha256 text not null,
  uploaded_by text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- subscription, usage, integrations
create table bai_subscriptions (
  tenant_id uuid primary key default bai_current_tenant() references bai_tenants(id) on delete cascade,
  plan text not null,
  status text not null default 'trial' check (status in ('trial','active','past_due','cancelled')),
  addons text[] not null default '{}',
  billing_status text not null default 'not_connected',
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table bai_subscription_events (
  id bigserial primary key,
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  event text not null,
  detail jsonb not null default '{}'::jsonb,
  actor text not null,
  created_at timestamptz not null default now()
);
create trigger bai_subscription_events_append_only before update or delete on bai_subscription_events
  for each row execute function bai_forbid_mutation();

create table bai_usage (
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  period text not null,
  metric text not null,
  quantity integer not null default 0,
  primary key (tenant_id, period, metric)
);

create table bai_ai_usage (
  id bigserial primary key,
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  agent_id text not null,
  purpose text not null,
  provider text not null,
  model text not null,
  outcome text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  latency_ms integer not null default 0,
  created_at timestamptz not null default now()
);

create table bai_integrations (
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  provider text not null,
  status text not null default 'not_connected' check (status in ('not_connected','authorised_untested','operational','error','revoked')),
  detail text not null default '',
  checked_at timestamptz,
  primary key (tenant_id, provider)
);

-- ---------------------------------------------------------------- audit (hash chain per tenant)
create table bai_audit (
  id bigserial primary key,
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  occurred_at timestamptz not null,
  actor text not null,
  action text not null,
  subject_type text not null,
  subject_id text,
  detail jsonb not null default '{}'::jsonb,
  prev_hash text not null,
  hash text not null
);
create index bai_audit_tenant on bai_audit (tenant_id, id);
create trigger bai_audit_append_only before update or delete on bai_audit
  for each row execute function bai_forbid_mutation();

-- ---------------------------------------------------------------- RLS and grants
alter table bai_tenants enable row level security;
create policy bai_tenant_self on bai_tenants to bai_tenant
  using (id = bai_current_tenant()) with check (id = bai_current_tenant());
grant select, update on bai_tenants to bai_tenant;

alter table bai_users enable row level security;
alter table bai_sessions enable row level security;
alter table bai_login_attempts enable row level security;
-- Members may see the names of colleagues in their own tenant only.
create policy bai_users_colleagues on bai_users for select to bai_tenant
  using (exists (select 1 from bai_memberships m where m.user_id = bai_users.id and m.tenant_id = bai_current_tenant()));
grant select (id, email, display_name, status) on bai_users to bai_tenant;

do $$
declare
  t text;
  append_only text[] := array['bai_profile_versions','bai_payments','bai_messages','bai_transaction_events',
    'bai_agent_messages','bai_approval_events','bai_subscription_events','bai_audit'];
  tenant_tables text[] := array['bai_memberships','bai_counters','bai_profiles','bai_profile_versions','bai_settings',
    'bai_agents','bai_agent_memory','bai_services','bai_employees','bai_customers','bai_consents','bai_suppressions',
    'bai_campaigns','bai_leads','bai_quotes','bai_bookings','bai_jobs','bai_invoices','bai_payments','bai_feedback',
    'bai_messages','bai_transactions','bai_transaction_events','bai_events','bai_workflow_runs','bai_workflow_steps',
    'bai_agent_messages','bai_approvals','bai_approval_events','bai_actions','bai_recommendations','bai_reports',
    'bai_admin_tasks','bai_documents','bai_subscriptions','bai_subscription_events','bai_usage','bai_ai_usage',
    'bai_integrations','bai_audit'];
begin
  foreach t in array tenant_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I to bai_tenant using (tenant_id = bai_current_tenant()) with check (tenant_id = bai_current_tenant())',
      t || '_isolation', t);
    if t = any(append_only) then
      execute format('grant select, insert on %I to bai_tenant', t);
    else
      execute format('grant select, insert, update, delete on %I to bai_tenant', t);
    end if;
  end loop;
end $$;

grant usage on sequence bai_profile_versions_id_seq, bai_transaction_events_id_seq, bai_agent_messages_id_seq,
  bai_approval_events_id_seq, bai_subscription_events_id_seq, bai_ai_usage_id_seq, bai_audit_id_seq to bai_tenant;

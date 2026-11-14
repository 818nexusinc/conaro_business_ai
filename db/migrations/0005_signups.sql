-- Self-serve sign-ups from the landing page. System-only (RLS on, no policy): read by CONARO staff.
-- Keeps the proof of consent CASL needs for any later product email to the business owner
-- (express consent only when the box was ticked; the exact wording shown is stored with it).
create table bai_signups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references bai_tenants(id) on delete set null,
  business_name text not null,
  owner_email text not null check (owner_email = lower(owner_email)),
  plan text not null,
  industry text not null,
  marketing_consent boolean not null default false,
  consent_wording text,
  ip_hash text not null,
  created_at timestamptz not null default now()
);
create index bai_signups_recent on bai_signups (ip_hash, created_at);
alter table bai_signups enable row level security;

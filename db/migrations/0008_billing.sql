-- Stripe billing: which Stripe customer and subscription belong to which business, and every webhook event
-- received (processed once). System-only tables (RLS on, no tenant policy).
create table bai_billing_accounts (
  tenant_id uuid primary key references bai_tenants(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_status text,
  plan text,
  livemode boolean not null default false,
  updated_at timestamptz not null default now()
);
create unique index bai_billing_accounts_customer on bai_billing_accounts (stripe_customer_id) where stripe_customer_id is not null;

create table bai_billing_events (
  event_id text primary key,
  type text not null,
  livemode boolean not null,
  tenant_id uuid references bai_tenants(id) on delete set null,
  outcome text not null,
  received_at timestamptz not null default now()
);

alter table bai_billing_accounts enable row level security;
alter table bai_billing_events enable row level security;

-- Interoperation with the CONARO marketplace and the CONARO operating system (BOS).
-- Both use the signed link protocol (src/interop/protocol.ts, identical to the BOS and marketplace copies).

-- One-time codes already used (replay protection). System-only.
create table bai_link_nonces (
  nonce text primary key,
  seen_at timestamptz not null default now()
);
-- Every signed exchange, both directions, without bodies. System-only.
create table bai_link_exchanges (
  id bigserial primary key,
  direction text not null check (direction in ('inbound','outbound')),
  peer text not null check (peer in ('marketplace','bos')),
  endpoint text not null,
  ok boolean not null,
  detail text not null default '',
  at timestamptz not null default now()
);
alter table bai_link_nonces enable row level security;
alter table bai_link_exchanges enable row level security;

-- Per business: where the marketplace feed was read up to.
create table bai_sync_state (
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  source text not null,
  cursor text,
  last_ok_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, source)
);
-- Which local record came from which marketplace record (never imported twice).
create table bai_external_refs (
  tenant_id uuid not null default bai_current_tenant() references bai_tenants(id) on delete cascade,
  source text not null,
  kind text not null,
  external_id text not null,
  local_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, source, kind, external_id)
);

do $$
declare t text;
begin
  foreach t in array array['bai_sync_state','bai_external_refs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I to bai_tenant using (tenant_id = bai_current_tenant()) with check (tenant_id = bai_current_tenant())', t || '_isolation', t);
    execute format('grant select, insert, update on %I to bai_tenant', t);
  end loop;
end $$;

-- A workspace is linked to at most one marketplace provider.
create unique index bai_tenants_marketplace_ref on bai_tenants (marketplace_provider_ref) where marketplace_provider_ref is not null;

-- Where a booking came from. Marketplace bookings are paid, quoted and reviewed on the marketplace,
-- so Business AI never invoices them, never sends its own quote and never asks for a review.
alter table bai_bookings add column source text not null default 'direct' check (source in ('direct','conaro-marketplace'));

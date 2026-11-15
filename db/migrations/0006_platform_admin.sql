-- Platform administration of CONARO Business AI itself (not of a customer's business): CONARO staff accounts,
-- the editable website content (drafts, published values and their history) and uploaded images.
-- All tables are system-only: RLS on and no policy, so a business workspace (role bai_tenant) can never read them.

create table bai_platform_admins (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email)),
  display_name text not null,
  password_hash text not null,
  role text not null check (role in ('owner','editor','viewer')),
  status text not null default 'active' check (status in ('active','disabled')),
  created_at timestamptz not null default now()
);

create table bai_admin_sessions (
  token_hash text primary key,
  admin_id uuid not null references bai_platform_admins(id) on delete cascade,
  csrf_token text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Every admin action, append-only.
create table bai_admin_audit (
  id bigserial primary key,
  admin_id uuid references bai_platform_admins(id) on delete set null,
  actor text not null,
  action text not null,
  subject text,
  detail jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create trigger bai_admin_audit_append_only before update or delete on bai_admin_audit
  for each row execute function bai_forbid_mutation();

-- Website text and settings, per key and language ('*' for language-neutral values such as the section layout).
-- The page shows published_value; the editor shows draft_value. Null means "the built-in default".
create table bai_site_content (
  key text not null check (key ~ '^[a-z0-9][a-z0-9._-]{0,119}$'),
  lang text not null check (lang in ('en','fr','*')),
  draft_value text check (length(draft_value) <= 20000),
  published_value text check (length(published_value) <= 20000),
  draft_changed boolean not null default false,
  updated_by uuid references bai_platform_admins(id) on delete set null,
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  primary key (key, lang)
);

create table bai_site_content_history (
  id bigserial primary key,
  key text not null,
  lang text not null,
  value text,
  action text not null check (action in ('save','publish','discard','restore')),
  admin_id uuid references bai_platform_admins(id) on delete set null,
  occurred_at timestamptz not null default now()
);
create index bai_site_content_history_key on bai_site_content_history (key, lang, id desc);
create trigger bai_site_content_history_append_only before update or delete on bai_site_content_history
  for each row execute function bai_forbid_mutation();

-- Images uploaded in the editor (stored here because the hosted app has no writable disk).
create table bai_site_media (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  mime text not null check (mime in ('image/jpeg','image/png','image/webp')),
  bytes bytea not null check (octet_length(bytes) <= 3145728),
  sha256 text not null,
  uploaded_by uuid references bai_platform_admins(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table bai_platform_admins enable row level security;
alter table bai_admin_sessions enable row level security;
alter table bai_admin_audit enable row level security;
alter table bai_site_content enable row level security;
alter table bai_site_content_history enable row level security;
alter table bai_site_media enable row level security;

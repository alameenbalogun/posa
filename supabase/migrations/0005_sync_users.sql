-- Keep the offline staff directory in the cloud as a tenant-scoped resource.
-- Supabase Auth authenticates the workspace owner; this table carries the
-- local staff profiles and their salted PIN verifiers to every authorised POS
-- terminal so staff can sign in offline on any terminal in the business.

create table if not exists public.users (
  id                    text primary key,
  business_id           uuid not null references public.businesses(id) on delete cascade,
  branch_id             text,
  full_name             text not null,
  email                 text,
  phone                 text,
  credential_hash       text,
  offline_verifier      text,
  pin_hash              text,
  role                  text not null check (role in ('owner','manager','cashier','inventory','accountant','admin')),
  branch_ids            text[] not null default '{}',
  granted               text[] not null default '{}',
  revoked               text[] not null default '{}',
  status                text not null default 'active' check (status in ('active','suspended','invited')),
  authorization_version integer not null default 1,
  last_login_at         timestamptz,
  created_at             timestamptz not null default now(),
  revision              bigint not null default 0,
  updated_at            timestamptz not null default now(),
  updated_by            text,
  deleted_at            timestamptz
);

create index if not exists idx_users_business on public.users (business_id, status);
alter table public.users enable row level security;

drop policy if exists users_tenant_read on public.users;
create policy users_tenant_read on public.users
  for select using (public.is_member(business_id));
drop policy if exists users_tenant_insert on public.users;
create policy users_tenant_insert on public.users
  for insert with check (public.can_administer(business_id));
drop policy if exists users_tenant_update on public.users;
create policy users_tenant_update on public.users
  for update using (public.can_administer(business_id))
  with check (public.can_administer(business_id));
drop policy if exists users_tenant_delete on public.users;
create policy users_tenant_delete on public.users
  for delete using (public.can_administer(business_id));

drop trigger if exists trg_users_change_log on public.users;
create trigger trg_users_change_log
  after insert or update or delete on public.users
  for each row execute function public.log_change();
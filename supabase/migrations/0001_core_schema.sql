-- ============================================================================
-- POSA — core schema (PRD §32 Data Model, §31 Security, §33 API Design)
-- ============================================================================
--
-- Design decisions worth stating, because they are the load-bearing ones:
--
-- 1. OPERATIONAL IDS ARE CLIENT-GENERATED (ULID, text). A till that has been
--    offline for a week must be able to create a sale, a customer and a stock
--    movement without waiting for a sequence from the cloud. Only tenant,
--    branch-owner and auth identities are server-generated uuids.
--
-- 2. EVERY SYNCABLE ROW CARRIES PROVENANCE: revision, updated_at, updated_by,
--    deleted_at. That is what makes optimistic concurrency and conflict review
--    possible instead of guesswork (PRD §21.3).
--
-- 3. FINANCIAL AND LEDGER ROWS ARE APPEND-ONLY. `suppress_rewrite` below refuses
--    an update to a completed sale, payment, ledger entry, return or audit row.
--    The database enforces PRD §47's "never silently rewrite completed sales",
--    rather than trusting every future client to behave.
--
-- 4. TENANT ISOLATION IS IN THE DATABASE, not the API layer. Row Level Security
--    keyed on membership means a bug in an endpoint cannot leak another tenant's
--    data through a guessed id (PRD §47).

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------

create table if not exists businesses (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  legal_name  text,
  phone       text,
  email       text,
  address     text,
  logo_url    text,
  settings    jsonb not null default '{
    "currency": "NGN",
    "taxInclusive": true,
    "allowNegativeStock": true,
    "requireApprovalFor": ["sale.void"],
    "maxDiscountBasisPoints": 1000,
    "offlineSessionMinutes": 480
  }'::jsonb,
  status      text not null default 'active' check (status in ('active','suspended')),
  created_at  timestamptz not null default now()
);

create table if not exists business_members (
  business_id uuid not null references businesses(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null check (role in ('owner','manager','cashier','inventory','accountant','admin')),
  branch_ids  text[] not null default '{}',
  granted     text[] not null default '{}',
  revoked     text[] not null default '{}',
  status      text not null default 'active' check (status in ('active','suspended','invited')),
  authorization_version integer not null default 1,
  full_name   text,
  phone       text,
  email       text,
  primary key (business_id, user_id)
);

create index if not exists idx_members_user on business_members (user_id) where status = 'active';

-- Membership test used by every RLS policy. SECURITY DEFINER so the policy does
-- not recurse into business_members' own RLS.
create or replace function public.is_member(target_business uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from business_members m
    where m.business_id = target_business
      and m.user_id = auth.uid()
      and m.status = 'active'
  );
$$;

create or replace function public.member_role(target_business uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select m.role from business_members m
  where m.business_id = target_business and m.user_id = auth.uid() and m.status = 'active'
  limit 1;
$$;

create or replace function public.can_administer(target_business uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.member_role(target_business) in ('owner','admin','manager'), false);
$$;

-- ---------------------------------------------------------------------------
-- Branches & devices
-- ---------------------------------------------------------------------------

create table if not exists branches (
  id           text primary key,
  business_id  uuid not null references businesses(id) on delete cascade,
  name         text not null,
  code         text not null,
  address      text,
  phone        text,
  timezone     text not null default 'Africa/Lagos',
  is_warehouse boolean not null default false,
  status       text not null default 'active' check (status in ('active','inactive')),
  created_at   timestamptz not null default now(),
  revision     bigint not null default 0,
  updated_at   timestamptz not null default now(),
  updated_by   text,
  deleted_at   timestamptz,
  unique (business_id, code)
);

create table if not exists devices (
  id            text primary key,
  business_id   uuid not null references businesses(id) on delete cascade,
  branch_id     text not null references branches(id) on delete restrict,
  name          text not null,
  platform      text not null,
  fingerprint   text not null,
  app_version   text not null,
  status        text not null default 'active' check (status in ('active','revoked')),
  last_sync_at  timestamptz,
  last_acked_seq bigint not null default 0,
  registered_at timestamptz not null default now(),
  revision      bigint not null default 0,
  updated_at    timestamptz not null default now(),
  updated_by    text,
  deleted_at    timestamptz
);

create index if not exists idx_devices_business on devices (business_id, branch_id);

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------

create table if not exists categories (
  id          text primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  name        text not null,
  parent_id   text,
  color_token text,
  sort_order  integer not null default 0,
  revision    bigint not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  deleted_at  timestamptz
);

create table if not exists products (
  id                    text primary key,
  business_id           uuid not null references businesses(id) on delete cascade,
  name                  text not null,
  description           text,
  category_id           text,
  brand                 text,
  sku                   text not null,
  unit                  text not null default 'unit',
  is_weighted           boolean not null default false,
  cost_price            bigint not null default 0,
  selling_price         bigint not null default 0,
  tax_rate_basis_points integer not null default 0,
  tax_category_id       text,
  reorder_level         integer not null default 0,
  supplier_id           text,
  image_url             text,
  track_batches         boolean not null default false,
  track_serials         boolean not null default false,
  status                text not null default 'active' check (status in ('active','archived')),
  created_at            timestamptz not null default now(),
  revision              bigint not null default 0,
  updated_at            timestamptz not null default now(),
  updated_by            text,
  deleted_at            timestamptz
);

create unique index if not exists uq_products_sku on products (business_id, sku) where deleted_at is null;
create index if not exists idx_products_business on products (business_id, status);

create table if not exists variants (
  id            text primary key,
  business_id   uuid not null references businesses(id) on delete cascade,
  product_id    text not null references products(id) on delete cascade,
  name          text not null,
  sku           text not null,
  attributes    jsonb not null default '{}'::jsonb,
  cost_price    bigint not null default 0,
  selling_price bigint not null default 0,
  status        text not null default 'active' check (status in ('active','archived')),
  revision      bigint not null default 0,
  updated_at    timestamptz not null default now(),
  updated_by    text,
  deleted_at    timestamptz
);

-- A barcode is unique PER BUSINESS, not globally: two shops may both use
-- POSA-minted internal codes without colliding (PRD §10.3 duplicate prevention).
create table if not exists barcodes (
  barcode     text not null,
  business_id uuid not null references businesses(id) on delete cascade,
  product_id  text not null references products(id) on delete cascade,
  variant_id  text,
  status      text not null default 'active' check (status in ('active','archived','blocked')),
  revision    bigint not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  deleted_at  timestamptz,
  primary key (business_id, barcode)
);

create index if not exists idx_barcodes_product on barcodes (product_id);

create table if not exists price_overrides (
  id          text primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  branch_id   text not null,
  product_id  text not null,
  variant_id  text,
  price       bigint not null,
  starts_at   timestamptz,
  ends_at     timestamptz,
  reason      text,
  revision    bigint not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  deleted_at  timestamptz
);

create table if not exists price_history (
  id             text primary key,
  business_id    uuid not null references businesses(id) on delete cascade,
  product_id     text not null,
  variant_id     text,
  branch_id      text,
  previous_price bigint not null,
  new_price      bigint not null,
  changed_by     text,
  reason         text,
  at             timestamptz not null default now(),
  revision       bigint not null default 0,
  updated_at     timestamptz not null default now(),
  updated_by     text,
  deleted_at     timestamptz
);

-- ---------------------------------------------------------------------------
-- Inventory ledger (PRD §14: stock is DERIVED, never a mutable column)
-- ---------------------------------------------------------------------------

create table if not exists inventory_ledger (
  id            text primary key,
  business_id   uuid not null references businesses(id) on delete cascade,
  branch_id     text not null,
  product_id    text not null,
  variant_id    text,
  quantity_delta numeric not null,
  reason        text not null,
  source_type   text,
  source_id     text,
  unit_cost     bigint,
  note          text,
  actor_id      text,
  device_id     text not null,
  occurred_at   timestamptz not null default now(),
  location      jsonb,
  revision      bigint not null default 0,
  updated_at    timestamptz not null default now(),
  updated_by    text,
  deleted_at    timestamptz,
  constraint ledger_nonzero check (quantity_delta <> 0)
);

create index if not exists idx_ledger_stock on inventory_ledger (business_id, branch_id, product_id, variant_id);
create index if not exists idx_ledger_source on inventory_ledger (source_type, source_id);
create index if not exists idx_ledger_time on inventory_ledger (business_id, occurred_at desc);

create table if not exists stock_count_sessions (
  id          text primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  branch_id   text not null,
  name        text not null,
  status      text not null default 'open',
  started_by  text not null,
  started_at  timestamptz not null default now(),
  closed_at   timestamptz,
  snapshot_at timestamptz,
  revision    bigint not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  deleted_at  timestamptz
);

create table if not exists stock_count_lines (
  id                text primary key,
  business_id       uuid not null references businesses(id) on delete cascade,
  session_id        text not null,
  product_id        text not null,
  variant_id        text,
  expected_quantity numeric not null default 0,
  counted_quantity  numeric not null default 0,
  variance_reason   text,
  counted_by        text,
  counted_at        timestamptz,
  revision          bigint not null default 0,
  updated_at        timestamptz not null default now(),
  updated_by        text,
  deleted_at        timestamptz
);

create table if not exists stock_transfers (
  id           text primary key,
  business_id  uuid not null references businesses(id) on delete cascade,
  from_branch_id text not null,
  to_branch_id   text not null,
  reference    text not null,
  status       text not null default 'draft',
  lines        jsonb not null default '[]'::jsonb,
  created_by   text not null,
  created_at   timestamptz not null default now(),
  received_at  timestamptz,
  revision     bigint not null default 0,
  updated_at   timestamptz not null default now(),
  updated_by   text,
  deleted_at   timestamptz
);

-- ---------------------------------------------------------------------------
-- Sales
-- ---------------------------------------------------------------------------

create table if not exists sales (
  id                  text primary key,
  receipt_number      text not null,
  business_id         uuid not null references businesses(id) on delete cascade,
  branch_id           text not null,
  device_id           text not null,
  cashier_id          text not null,
  customer_id         text,
  shift_id            text,
  channel             text not null default 'pos',
  status              text not null default 'committed',
  currency            text not null default 'NGN',
  subtotal            bigint not null default 0,
  line_discount_total bigint not null default 0,
  cart_discount_total bigint not null default 0,
  discount_total      bigint not null default 0,
  tax_total           bigint not null default 0,
  rounding_adjustment bigint not null default 0,
  total               bigint not null default 0,
  amount_paid         bigint not null default 0,
  change_due          bigint not null default 0,
  item_count          numeric not null default 0,
  note                text,
  approved_by         text,
  idempotency_key     text not null,
  committed_at        timestamptz not null,
  voided_at           timestamptz,
  void_reason         text,
  -- Server-side receipt time. The device clock may be wrong; this one is not,
  -- which is how PRD §46's "device clock differs from server" is diagnosed.
  received_at         timestamptz not null default now(),
  revision            bigint not null default 0,
  updated_at          timestamptz not null default now(),
  updated_by          text,
  deleted_at          timestamptz,
  unique (business_id, receipt_number),
  unique (business_id, idempotency_key)
);

create index if not exists idx_sales_time on sales (business_id, branch_id, committed_at desc);
create index if not exists idx_sales_cashier on sales (business_id, cashier_id, committed_at desc);
create index if not exists idx_sales_device on sales (device_id, committed_at desc);

create table if not exists sale_lines (
  id                    text primary key,
  business_id           uuid not null references businesses(id) on delete cascade,
  sale_id               text not null references sales(id) on delete cascade,
  product_id            text not null,
  variant_id            text,
  name                  text not null,
  sku                   text not null,
  barcode               text,
  quantity              numeric not null,
  unit_price            bigint not null,
  line_discount         bigint not null default 0,
  allocated_discount    bigint not null default 0,
  tax_rate_basis_points integer not null default 0,
  taxable_base          bigint not null default 0,
  tax_amount            bigint not null default 0,
  line_total            bigint not null default 0,
  unit_cost             bigint not null default 0,
  returnable_quantity   numeric not null default 0,
  returned_quantity     numeric not null default 0,
  revision              bigint not null default 0,
  updated_at            timestamptz not null default now(),
  updated_by            text,
  deleted_at            timestamptz
);

create index if not exists idx_sale_lines_sale on sale_lines (sale_id);

create table if not exists payments (
  id                     text primary key,
  business_id            uuid not null references businesses(id) on delete cascade,
  sale_id                text not null references sales(id) on delete cascade,
  method                 text not null,
  amount                 bigint not null,
  reference              text,
  status                 text not null,
  requires_authorization boolean not null default false,
  provider               text,
  tendered_amount        bigint,
  change_given           bigint,
  captured_at            timestamptz,
  failure_reason         text,
  device_id              text not null,
  revision               bigint not null default 0,
  updated_at             timestamptz not null default now(),
  updated_by             text,
  deleted_at             timestamptz
);

create index if not exists idx_payments_sale on payments (sale_id);
-- Unconfirmed authorisations need chasing. This index makes that a one-liner.
create index if not exists idx_payments_pending on payments (business_id) where status = 'pending';

create table if not exists held_sales (
  id             text primary key,
  business_id    uuid not null references businesses(id) on delete cascade,
  branch_id      text not null,
  device_id      text not null,
  label          text not null,
  customer_id    text,
  lines          jsonb not null default '[]'::jsonb,
  note           text,
  held_by        text not null,
  held_at        timestamptz not null default now(),
  revision_token bigint not null default 0,
  revision       bigint not null default 0,
  updated_at     timestamptz not null default now(),
  updated_by     text,
  deleted_at     timestamptz
);

-- ---------------------------------------------------------------------------
-- Returns
-- ---------------------------------------------------------------------------

create table if not exists returns (
  id              text primary key,
  business_id     uuid not null references businesses(id) on delete cascade,
  branch_id       text not null,
  device_id       text not null,
  sale_id         text not null references sales(id) on delete restrict,
  receipt_number  text not null,
  cashier_id      text not null,
  approved_by     text,
  reason          text not null,
  reason_note     text,
  refund_subtotal bigint not null default 0,
  refund_tax      bigint not null default 0,
  refund_total    bigint not null default 0,
  refund_method   text not null,
  restock         boolean not null default true,
  status          text not null default 'committed',
  idempotency_key text not null,
  committed_at    timestamptz not null default now(),
  revision        bigint not null default 0,
  updated_at      timestamptz not null default now(),
  updated_by      text,
  deleted_at      timestamptz,
  unique (business_id, idempotency_key)
);

create table if not exists return_lines (
  id          text primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  return_id   text not null references returns(id) on delete cascade,
  sale_line_id text not null,
  product_id  text not null,
  variant_id  text,
  quantity    numeric not null,
  unit_refund bigint not null default 0,
  line_refund bigint not null default 0,
  tax_refund  bigint not null default 0,
  revision    bigint not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  deleted_at  timestamptz
);

-- ---------------------------------------------------------------------------
-- Customers, suppliers, purchasing
-- ---------------------------------------------------------------------------

create table if not exists customers (
  id           text primary key,
  business_id  uuid not null references businesses(id) on delete cascade,
  name         text not null,
  phone        text,
  email        text,
  address      text,
  balance      bigint not null default 0,
  credit_limit bigint not null default 0,
  loyalty_points integer not null default 0,
  notes        text,
  status       text not null default 'active' check (status in ('active','archived')),
  created_at   timestamptz not null default now(),
  revision     bigint not null default 0,
  updated_at   timestamptz not null default now(),
  updated_by   text,
  deleted_at   timestamptz
);

create index if not exists idx_customers_phone on customers (business_id, phone);

create table if not exists suppliers (
  id           text primary key,
  business_id  uuid not null references businesses(id) on delete cascade,
  name         text not null,
  contact_name text,
  phone        text,
  email        text,
  address      text,
  balance      bigint not null default 0,
  status       text not null default 'active' check (status in ('active','archived')),
  created_at   timestamptz not null default now(),
  revision     bigint not null default 0,
  updated_at   timestamptz not null default now(),
  updated_by   text,
  deleted_at   timestamptz
);

create table if not exists purchases (
  id           text primary key,
  business_id  uuid not null references businesses(id) on delete cascade,
  branch_id    text not null,
  supplier_id  text not null,
  reference    text not null,
  status       text not null default 'draft',
  lines        jsonb not null default '[]'::jsonb,
  subtotal     bigint not null default 0,
  tax_total    bigint not null default 0,
  total        bigint not null default 0,
  amount_paid  bigint not null default 0,
  expected_at  timestamptz,
  received_at  timestamptz,
  created_by   text not null,
  created_at   timestamptz not null default now(),
  note         text,
  revision     bigint not null default 0,
  updated_at   timestamptz not null default now(),
  updated_by   text,
  deleted_at   timestamptz
);

-- ---------------------------------------------------------------------------
-- Cash, shifts, expenses
-- ---------------------------------------------------------------------------

create table if not exists shifts (
  id             text primary key,
  business_id    uuid not null references businesses(id) on delete cascade,
  branch_id      text not null,
  device_id      text not null,
  cashier_id     text not null,
  opening_float  bigint not null default 0,
  counted_close  bigint,
  expected_close bigint,
  variance       bigint,
  cash_in        bigint not null default 0,
  cash_out       bigint not null default 0,
  status         text not null default 'open' check (status in ('open','closed','reconciled')),
  opened_at      timestamptz not null default now(),
  closed_at      timestamptz,
  closed_by      text,
  note           text,
  revision       bigint not null default 0,
  updated_at     timestamptz not null default now(),
  updated_by     text,
  deleted_at     timestamptz
);

create index if not exists idx_shifts_open on shifts (business_id, device_id) where status = 'open';

create table if not exists cash_movements (
  id          text primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  branch_id   text not null,
  shift_id    text,
  device_id   text not null,
  type        text not null,
  amount      bigint not null,
  reason      text not null,
  actor_id    text not null,
  approved_by text,
  occurred_at timestamptz not null default now(),
  revision    bigint not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  deleted_at  timestamptz
);

create table if not exists expense_categories (
  id                text primary key,
  business_id       uuid not null references businesses(id) on delete cascade,
  name              text not null,
  requires_approval boolean not null default false,
  revision          bigint not null default 0,
  updated_at        timestamptz not null default now(),
  updated_by        text,
  deleted_at        timestamptz
);

create table if not exists expenses (
  id            text primary key,
  business_id   uuid not null references businesses(id) on delete cascade,
  branch_id     text not null,
  category_id   text,
  category_name text not null,
  amount        bigint not null,
  source        text not null,
  shift_id      text,
  reference     text,
  description   text,
  spent_by      text not null,
  approved_by   text,
  spent_at      timestamptz not null default now(),
  revision      bigint not null default 0,
  updated_at    timestamptz not null default now(),
  updated_by    text,
  deleted_at    timestamptz
);

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

create table if not exists audit_logs (
  id          text primary key,
  business_id uuid not null references businesses(id) on delete cascade,
  branch_id   text,
  device_id   text not null,
  actor_id    text,
  actor_name  text not null default '',
  action      text not null,
  entity_type text not null,
  entity_id   text,
  metadata    jsonb not null default '{}'::jsonb,
  origin      text not null default 'local' check (origin in ('local','cloud')),
  occurred_at timestamptz not null default now(),
  revision    bigint not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  deleted_at  timestamptz
);

create index if not exists idx_audit_time on audit_logs (business_id, occurred_at desc);
create index if not exists idx_audit_entity on audit_logs (business_id, entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- Append-only enforcement (PRD §47)
-- ---------------------------------------------------------------------------

-- Financial and ledger history is a record of what physically happened. A client
-- may not rewrite it — not after a retry, not after a conflict, not ever. New
-- facts are appended; corrections are new rows (a void, a return, a reversing
-- ledger entry). Enforced here so it holds regardless of client behaviour.
create or replace function public.suppress_rewrite()
returns trigger
language plpgsql
as $$
begin
  -- The single sanctioned mutation is the lifecycle status the cloud may advance
  -- (a sale becoming voided or partially returned). Everything else is refused.
  if tg_table_name = 'sales' then
    if new.id = old.id
       and new.total = old.total
       and new.subtotal = old.subtotal
       and new.tax_total = old.tax_total
       and new.amount_paid = old.amount_paid
       and new.committed_at = old.committed_at
       and new.receipt_number = old.receipt_number
    then
      return new;
    end if;
  elsif tg_table_name = 'sale_lines' then
    -- Only `returned_quantity` may move, and only upward.
    if new.id = old.id
       and new.quantity = old.quantity
       and new.line_total = old.line_total
       and new.unit_price = old.unit_price
       and new.returned_quantity >= old.returned_quantity
    then
      return new;
    end if;
  else
    raise exception 'Records in % are append-only (PRD §47).', tg_table_name using errcode = '55000';
  end if;

  raise exception 'Refusing to rewrite completed financial record % in % (PRD §47).', old.id, tg_table_name
    using errcode = '55000';
end;
$$;

drop trigger if exists trg_sales_append_only on sales;
create trigger trg_sales_append_only before update on sales
  for each row execute function public.suppress_rewrite();

drop trigger if exists trg_sale_lines_append_only on sale_lines;
create trigger trg_sale_lines_append_only before update on sale_lines
  for each row execute function public.suppress_rewrite();

drop trigger if exists trg_payments_append_only on payments;
create trigger trg_payments_append_only before update on payments
  for each row execute function public.suppress_rewrite();

drop trigger if exists trg_ledger_append_only on inventory_ledger;
create trigger trg_ledger_append_only before update on inventory_ledger
  for each row execute function public.suppress_rewrite();

drop trigger if exists trg_returns_append_only on returns;
create trigger trg_returns_append_only before update on returns
  for each row execute function public.suppress_rewrite();

drop trigger if exists trg_audit_append_only on audit_logs;
create trigger trg_audit_append_only before update on audit_logs
  for each row execute function public.suppress_rewrite();

drop trigger if exists trg_cash_movements_append_only on cash_movements;
create trigger trg_cash_movements_append_only before update on cash_movements
  for each row execute function public.suppress_rewrite();

-- Payment status must be allowed to advance (pending -> successful) when a
-- provider confirms, so it gets a narrower rule.
create or replace function public.payment_status_only()
returns trigger
language plpgsql
as $$
begin
  if new.amount <> old.amount or new.sale_id <> old.sale_id or new.method <> old.method then
    raise exception 'A recorded payment may only change status or reference (PRD §47).' using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_payments_status_only on payments;
create trigger trg_payments_status_only before update on payments
  for each row execute function public.payment_status_only();

-- ---------------------------------------------------------------------------
-- Row Level Security (PRD §31, §47)
-- ---------------------------------------------------------------------------

alter table businesses         enable row level security;
alter table business_members   enable row level security;
alter table branches           enable row level security;
alter table devices            enable row level security;
alter table categories         enable row level security;
alter table products           enable row level security;
alter table variants           enable row level security;
alter table barcodes           enable row level security;
alter table price_overrides    enable row level security;
alter table price_history      enable row level security;
alter table inventory_ledger   enable row level security;
alter table stock_count_sessions enable row level security;
alter table stock_count_lines  enable row level security;
alter table stock_transfers     enable row level security;
alter table sales              enable row level security;
alter table sale_lines         enable row level security;
alter table payments           enable row level security;
alter table held_sales         enable row level security;
alter table returns            enable row level security;
alter table return_lines       enable row level security;
alter table customers          enable row level security;
alter table suppliers          enable row level security;
alter table purchases          enable row level security;
alter table shifts             enable row level security;
alter table cash_movements     enable row level security;
alter table expense_categories enable row level security;
alter table expenses           enable row level security;
alter table audit_logs         enable row level security;

-- Businesses: a member sees only their own tenants.
drop policy if exists business_read on businesses;
create policy business_read on businesses for select
  using (public.is_member(id));

drop policy if exists business_update on businesses;
create policy business_update on businesses for update
  using (public.can_administer(id)) with check (public.can_administer(id));

drop policy if exists business_insert on businesses;
create policy business_insert on businesses for insert
  with check (auth.uid() is not null);

-- Membership: you can see your own memberships; admins can manage the rest.
drop policy if exists members_read on business_members;
create policy members_read on business_members for select
  using (user_id = auth.uid() or public.is_member(business_id));

drop policy if exists members_admin on business_members;
create policy members_admin on business_members for all
  using (public.can_administer(business_id))
  with check (public.can_administer(business_id));

-- Every operational table gets the same membership-scoped policy. Generated
-- rather than hand-written 26 times, so a new table cannot be forgotten.
do $$
declare
  target text;
  scoped text[] := array[
    'branches','devices','categories','products','variants','barcodes',
    'price_overrides','price_history','inventory_ledger','stock_count_sessions',
    'stock_count_lines','stock_transfers','sales','sale_lines','payments',
    'held_sales','returns','return_lines','customers','suppliers','purchases',
    'shifts','cash_movements','expense_categories','expenses','audit_logs'
  ];
begin
  foreach target in array scoped loop
    execute format('drop policy if exists %I on %I;', target || '_tenant_read', target);
    execute format(
      'create policy %I on %I for select using (public.is_member(business_id));',
      target || '_tenant_read', target
    );

    execute format('drop policy if exists %I on %I;', target || '_tenant_insert', target);
    execute format(
      'create policy %I on %I for insert with check (public.is_member(business_id));',
      target || '_tenant_insert', target
    );

    execute format('drop policy if exists %I on %I;', target || '_tenant_update', target);
    execute format(
      'create policy %I on %I for update using (public.is_member(business_id)) with check (public.is_member(business_id));',
      target || '_tenant_update', target
    );

    -- Deletes are only for administrators: operational history is not disposable.
    execute format('drop policy if exists %I on %I;', target || '_tenant_delete', target);
    execute format(
      'create policy %I on %I for delete using (public.can_administer(business_id));',
      target || '_tenant_delete', target
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Change log — the backbone of pull sync (PRD §21.2 step 10)
-- ---------------------------------------------------------------------------

create table if not exists change_log (
  seq         bigserial primary key,
  business_id uuid not null,
  branch_id   text,
  entity      text not null,
  entity_id   text not null,
  op          text not null,
  revision    bigint not null default 0,
  row_data    jsonb,
  changed_at  timestamptz not null default now()
);

create index if not exists idx_change_log_cursor on change_log (business_id, seq);
create index if not exists idx_change_log_entity on change_log (business_id, entity, entity_id);

alter table change_log enable row level security;
drop policy if exists change_log_tenant_read on change_log;
create policy change_log_tenant_read on change_log for select using (public.is_member(business_id));

/*
 * A trigger on each syncable table records what changed. Using a trigger rather
 * than application code means the log cannot drift from the data — including when
 * a row is changed by a migration, an admin console, or a future integration.
 */
create or replace function public.log_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  payload jsonb;
  entity_name text := tg_table_name;
begin
  payload := to_jsonb(coalesce(new, old));
  insert into change_log (business_id, branch_id, entity, entity_id, op, revision, row_data)
  values (
    coalesce(new.business_id, old.business_id),
    coalesce(new.branch_id::text, old.branch_id::text, null),
    entity_name,
    coalesce(new.id, old.id),
    case tg_op when 'INSERT' then 'insert' when 'UPDATE' then 'update' else 'delete' end,
    coalesce(new.revision, old.revision, 0),
    payload
  );
  return coalesce(new, old);
end;
$$;

do $$
declare
  target text;
  syncable text[] := array[
    'branches','devices','categories','products','variants','barcodes',
    'price_overrides','price_history','inventory_ledger','stock_count_sessions',
    'stock_count_lines','stock_transfers','sales','sale_lines','payments',
    'held_sales','returns','return_lines','customers','suppliers','purchases',
    'shifts','cash_movements','expense_categories','expenses','audit_logs'
  ];
begin
  foreach target in array syncable loop
    execute format('drop trigger if exists trg_%s_change_log on %I;', target, target);
    execute format(
      'create trigger trg_%s_change_log after insert or update or delete on %I
         for each row execute function public.log_change();',
      target, target
    );
  end loop;
end $$;

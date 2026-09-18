-- ============================================================================
-- POSA — sync engine server side (PRD §21, §33)
-- ============================================================================
--
-- THE IDEMPOTENCY CONTRACT (PRD §33: "Sync endpoints must be idempotent. The
-- server should safely accept a retried event without creating duplicate sales,
-- payments or stock movements.")
--
-- `sync_push` takes a batch of events, each carrying the ULID the DEVICE
-- generated before it ever touched the network. An event that has already been
-- applied is answered `duplicate` and the row is left untouched. So a terminal
-- that retries the same batch ten times across a flaky link produces exactly one
-- sale — which is the acceptance criterion in PRD §45 framed as a database
-- guarantee rather than a hope.
--
-- Three further guarantees:
--
--   * DEPENDENCY GATING. An event whose parent has not been applied is answered
--     `dependency_missing` and left in the queue, so a `sale_line` can never
--     arrive before its `sale`.
--
--   * APPEND-ONLY ENFORCEMENT. Financial and ledger entities are insert-only
--     through this API. A retry of an already-applied ledger entry is a
--     `duplicate`, never an update that would double-count stock.
--
--   * OPTIMISTIC CONCURRENCY. Mutable metadata carries the `baseRevision` the
--     device last saw. If the server has moved on, we do not guess: the event is
--     answered `conflict` and both versions are parked in `sync_conflicts` for a
--     human (PRD §21.3, §46).

-- ---------------------------------------------------------------------------
-- Idempotency ledger
-- ---------------------------------------------------------------------------

create table if not exists applied_events (
  event_id    text primary key,
  business_id uuid not null,
  device_id   text not null,
  entity      text not null,
  entity_id   text not null,
  revision    bigint,
  applied_at  timestamptz not null default now()
);

create index if not exists idx_applied_device on applied_events (device_id, applied_at desc);

alter table applied_events enable row level security;
drop policy if exists applied_events_read on applied_events;
create policy applied_events_read on applied_events for select using (public.is_member(business_id));

-- ---------------------------------------------------------------------------
-- Conflicts awaiting a human decision (PRD §21.3, §34 "Sync center")
-- ---------------------------------------------------------------------------

create table if not exists sync_conflicts (
  id              text primary key,
  business_id     uuid not null references businesses(id) on delete cascade,
  device_id       text not null,
  entity          text not null,
  entity_id       text not null,
  local_payload   jsonb not null,
  local_revision  bigint not null default 0,
  server_payload  jsonb,
  server_revision bigint not null default 0,
  strategy        text not null default 'manual_review',
  status          text not null default 'open' check (status in ('open','resolved_local','resolved_server','resolved_merged')),
  resolved_by     uuid,
  resolved_at     timestamptz,
  note            text,
  detected_at     timestamptz not null default now()
);

create index if not exists idx_conflicts_open on sync_conflicts (business_id, status, detected_at desc);

alter table sync_conflicts enable row level security;
drop policy if exists conflicts_read on sync_conflicts;
create policy conflicts_read on sync_conflicts for select using (public.is_member(business_id));
drop policy if exists conflicts_write on sync_conflicts;
create policy conflicts_write on sync_conflicts for all
  using (public.can_administer(business_id)) with check (public.can_administer(business_id));

-- ---------------------------------------------------------------------------
-- Entity → table map. A whitelist, not a guess: an unknown entity is rejected
-- rather than interpolated into dynamic SQL (PRD §47 "least-privilege API").
-- ---------------------------------------------------------------------------

create or replace function public.entity_table(p_entity text)
returns text
language sql
immutable
as $$
  select case p_entity
    when 'branch'               then 'branches'
    when 'user'                 then 'users'
    when 'device'               then 'devices'
    when 'category'             then 'categories'
    when 'product'              then 'products'
    when 'variant'              then 'variants'
    when 'barcode'              then 'barcodes'
    when 'price_override'       then 'price_overrides'
    when 'price_history'        then 'price_history'
    when 'inventory_ledger'     then 'inventory_ledger'
    when 'stock_count_session'  then 'stock_count_sessions'
    when 'stock_count_line'     then 'stock_count_lines'
    when 'stock_transfer'       then 'stock_transfers'
    when 'sale'                 then 'sales'
    when 'sale_line'            then 'sale_lines'
    when 'payment'              then 'payments'
    when 'held_sale'            then 'held_sales'
    when 'return'               then 'returns'
    when 'return_line'          then 'return_lines'
    when 'customer'             then 'customers'
    when 'supplier'             then 'suppliers'
    when 'purchase'             then 'purchases'
    when 'shift'                then 'shifts'
    when 'cash_movement'        then 'cash_movements'
    when 'expense_category'     then 'expense_categories'
    when 'expense'              then 'expenses'
    when 'audit_log'            then 'audit_logs'
    else null
  end;
$$;

-- Entities that may only ever be inserted. A replayed event is a duplicate, and
-- an attempted mutation is refused outright.
create or replace function public.is_append_only(p_entity text)
returns boolean
language sql
immutable
as $$
  select p_entity in (
    'inventory_ledger','payment','return','return_line',
    'cash_movement','audit_log','price_history'
  );
$$;

-- Entities whose only sanctioned mutation is a lifecycle/status field.
create or replace function public.is_status_mutable(p_entity text)
returns boolean
language sql
immutable
as $$
  select p_entity in ('sale','sale_line');
$$;

-- ---------------------------------------------------------------------------
-- Payload normalisation
-- ---------------------------------------------------------------------------

/*
 * The client speaks the domain's camelCase; Postgres speaks snake_case. Rather
 * than maintain a hand-written field map per entity (which WILL drift), we do
 * the rename generically and then drop any key that is not a real column. That
 * also safely discards client-only fields such as `barcodes` and `effectivePrice`.
 */
create or replace function public.prepare_row(p_table text, p_payload jsonb)
returns jsonb
language sql
stable
as $$
  select coalesce(
    jsonb_object_agg(
      lower(regexp_replace(e.key, '([a-z0-9])([A-Z])', '\1_\2', 'g')),
      e.value
    ),
    '{}'::jsonb
  )
  from jsonb_each(p_payload) e
  where lower(regexp_replace(e.key, '([a-z0-9])([A-Z])', '\1_\2', 'g')) in (
    select c.column_name
    from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = p_table
  )
  and lower(regexp_replace(e.key, '([a-z0-9])([A-Z])', '\1_\2', 'g')) not in ('revision');
$$;

-- ---------------------------------------------------------------------------
-- Push
-- ---------------------------------------------------------------------------

create or replace function public.sync_push(
  p_device   text,
  p_business uuid,
  p_sequence bigint,
  p_client_time timestamptz,
  p_events   jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event        jsonb;
  v_event_id     text;
  v_entity       text;
  v_entity_id    text;
  v_op           text;
  v_table        text;
  v_base         bigint;
  v_payload      jsonb;
  v_row          jsonb;
  v_server       jsonb;
  v_existing_rev bigint;
  v_exists       boolean;
  v_result       jsonb;
  v_results      jsonb := '[]'::jsonb;
  v_dep          text;
  v_dep_missing  boolean;
  v_cursor       bigint;
  v_device_ok    boolean;
  v_branch       text;
  v_now          timestamptz := now();
begin
  -- ---- Authentication & authorisation -----------------------------------
  if auth.uid() is null then
    return jsonb_build_object('serverTime', v_now, 'cursor', '0',
                              'reauthRequired', true, 'results', '[]'::jsonb);
  end if;

  if not public.is_member(p_business) then
    -- Same answer for "not yours" and "does not exist": never confirm a tenant's
    -- existence to a non-member (PRD §47 "never expose another tenant's data").
    raise exception 'Not a member of this business.' using errcode = '42501';
  end if;

  select d.status = 'active', d.branch_id
    into v_device_ok, v_branch
  from devices d
  where d.id = p_device and d.business_id = p_business;

  if v_device_ok is not true then
    -- A revoked terminal may still be holding valid receipts. It stops syncing
    -- and must re-register; it does not lose its local data (PRD §46).
    return jsonb_build_object(
      'serverTime', v_now,
      'cursor', coalesce((select max(seq)::text from change_log where business_id = p_business), '0'),
      'reauthRequired', true,
      'results', jsonb_build_array(jsonb_build_object(
        'eventId', 'device', 'status', 'rejected', 'code', 'device_revoked',
        'message', 'This terminal has been revoked and must be re-registered.'))
    );
  end if;

  -- ---- Apply each event -------------------------------------------------
  for v_event in select * from jsonb_array_elements(p_events) loop
    v_event_id  := v_event->>'id';
    v_entity    := v_event->>'entity';
    v_entity_id := v_event->>'entityId';
    v_op        := coalesce(v_event->>'op', 'insert');
    v_base      := coalesce((v_event->>'baseRevision')::bigint, 0);
    v_payload   := coalesce(v_event->'payload', '{}'::jsonb);
    v_table     := public.entity_table(v_entity);

    -- Tenant safety: an event may only carry the business it was authenticated for.
    if (v_payload->>'businessId') is not null and (v_payload->>'businessId') <> p_business::text then
      v_results := v_results || jsonb_build_object(
        'eventId', v_event_id, 'status', 'rejected',
        'code', 'tenant_mismatch', 'message', 'Event business does not match the authenticated tenant.');
      continue;
    end if;

    if v_table is null then
      v_results := v_results || jsonb_build_object(
        'eventId', v_event_id, 'status', 'rejected',
        'code', 'validation_failed', 'message', format('Unknown entity "%s".', coalesce(v_entity, 'null')));
      continue;
    end if;

    -- Idempotency: this is the line that makes retries safe.
    if exists (select 1 from applied_events a where a.event_id = v_event_id) then
      select a.revision into v_existing_rev from applied_events a where a.event_id = v_event_id;
      v_results := v_results || jsonb_build_object(
        'eventId', v_event_id, 'status', 'duplicate', 'revision', coalesce(v_existing_rev, 0));
      continue;
    end if;

    -- Dependency gating: a child may not land before its parent.
    v_dep_missing := false;
    if jsonb_typeof(v_event->'dependsOn') = 'array' then
      for v_dep in select jsonb_array_elements_text(v_event->'dependsOn') loop
        if not exists (select 1 from applied_events a where a.event_id = v_dep) then
          v_dep_missing := true;
          exit;
        end if;
      end loop;
    end if;

    if v_dep_missing then
      v_results := v_results || jsonb_build_object(
        'eventId', v_event_id, 'status', 'rejected',
        'code', 'dependency_missing', 'message', 'A parent event has not been applied yet.');
      continue;
    end if;

    v_row := public.prepare_row(v_table, v_payload);
    v_row := jsonb_set(v_row, '{id}', to_jsonb(v_entity_id), true);
    v_row := jsonb_set(v_row, '{business_id}', to_jsonb(p_business::text), true);
    v_row := jsonb_set(v_row, '{updated_by}', to_jsonb(p_device), true);
    if not (v_row ? 'updated_at') then
      v_row := jsonb_set(v_row, '{updated_at}', to_jsonb(v_now), true);
    end if;

    execute format('select exists (select 1 from %I where id = $1)', v_table)
      into v_exists using v_entity_id;

    -- ---- Append-only entities: insert once, never mutate -----------------
    if public.is_append_only(v_entity) then
      if v_exists then
        -- A replayed ledger entry or payment. Answer duplicate; do NOT touch the
        -- row, or a double retry would double-count stock or cash.
        execute format('select revision from %I where id = $1', v_table) into v_existing_rev using v_entity_id;
        insert into applied_events (event_id, business_id, device_id, entity, entity_id, revision)
        values (v_event_id, p_business, p_device, v_entity, v_entity_id, v_existing_rev)
        on conflict (event_id) do nothing;
        v_results := v_results || jsonb_build_object(
          'eventId', v_event_id, 'status', 'duplicate', 'revision', coalesce(v_existing_rev, 0));
        continue;
      end if;

      execute format(
        'insert into %I select * from jsonb_populate_record(null::%I, $1)',
        v_table, v_table) using v_row;

      execute format('select revision from %I where id = $1', v_table) into v_existing_rev using v_entity_id;
      insert into applied_events (event_id, business_id, device_id, entity, entity_id, revision)
      values (v_event_id, p_business, p_device, v_entity, v_entity_id, v_existing_rev);

      v_results := v_results || jsonb_build_object(
        'eventId', v_event_id, 'status', 'applied', 'revision', coalesce(v_existing_rev, 0));
      continue;
    end if;

    -- ---- Status-mutable entities (sales, sale lines) ---------------------
    if public.is_status_mutable(v_entity) then
      if not v_exists then
        execute format(
          'insert into %I select * from jsonb_populate_record(null::%I, $1)',
          v_table, v_table) using v_row;
        execute format('select revision from %I where id = $1', v_table) into v_existing_rev using v_entity_id;
        insert into applied_events (event_id, business_id, device_id, entity, entity_id, revision)
        values (v_event_id, p_business, p_device, v_entity, v_entity_id, v_existing_rev);
        v_results := v_results || jsonb_build_object(
          'eventId', v_event_id, 'status', 'applied', 'revision', coalesce(v_existing_rev, 0));
        continue;
      end if;

      execute format('select revision from %I where id = $1', v_table) into v_existing_rev using v_entity_id;

      -- The append-only trigger decides what may actually change. We only need
      -- to decide whether it is safe to try.
      if v_base > 0 and v_existing_rev > v_base then
        execute format('select to_jsonb(t) from %I t where t.id = $1', v_table)
          into v_server using v_entity_id;
        insert into sync_conflicts (id, business_id, device_id, entity, entity_id,
                                    local_payload, local_revision, server_payload, server_revision, strategy)
        values (gen_random_uuid()::text, p_business, p_device, v_entity, v_entity_id,
                v_payload, v_base, v_server, v_existing_rev, 'manual_review');
        insert into applied_events (event_id, business_id, device_id, entity, entity_id, revision)
        values (v_event_id, p_business, p_device, v_entity, v_entity_id, v_existing_rev);
        v_results := v_results || jsonb_build_object(
          'eventId', v_event_id, 'status', 'conflict', 'code', 'stale_revision',
          'message', 'The cloud copy changed while this terminal was offline.',
          'revision', v_existing_rev, 'serverRecord', v_server);
        continue;
      end if;

      begin
        execute format(
          'update %I t set %s from jsonb_populate_record(null::%I, $1) s where t.id = s.id',
          v_table,
          (select string_agg(format('%1$I = s.%1$I', c.column_name), ', ')
             from information_schema.columns c
            where c.table_schema = 'public' and c.table_name = v_table
              and c.column_name not in ('id','revision','business_id')),
          v_table) using v_row;
      exception when others then
        insert into applied_events (event_id, business_id, device_id, entity, entity_id, revision)
        values (v_event_id, p_business, p_device, v_entity, v_entity_id, null);
        v_results := v_results || jsonb_build_object(
          'eventId', v_event_id, 'status', 'rejected', 'code', 'immutable_record',
          'message', sqlerrm);
        continue;
      end;

      execute format('select revision from %I where id = $1', v_table) into v_existing_rev using v_entity_id;
      insert into applied_events (event_id, business_id, device_id, entity, entity_id, revision)
      values (v_event_id, p_business, p_device, v_entity, v_entity_id, v_existing_rev);
      v_results := v_results || jsonb_build_object(
        'eventId', v_event_id, 'status', 'applied', 'revision', coalesce(v_existing_rev, 0));
      continue;
    end if;

    -- ---- Freely mutable metadata (products, customers, ...) --------------
    if v_exists then
      execute format('select revision from %I where id = $1', v_table)
        into v_existing_rev using v_entity_id;

      if v_base > 0 and v_existing_rev > v_base then
        execute format('select to_jsonb(t) from %I t where t.id = $1', v_table)
          into v_server using v_entity_id;
        insert into sync_conflicts (id, business_id, device_id, entity, entity_id,
                                    local_payload, local_revision, server_payload, server_revision, strategy)
        values (gen_random_uuid()::text, p_business, p_device, v_entity, v_entity_id,
                v_payload, v_base, v_server, v_existing_rev,
                case
                  when v_entity in ('product','variant','purchase','shift','expense','stock_count_session')
                    then 'optimistic'
                  when v_entity in ('customer','supplier','held_sale','category','expense_category')
                    then 'last_write_wins'
                  else 'manual_review'
                end);
        insert into applied_events (event_id, business_id, device_id, entity, entity_id, revision)
        values (v_event_id, p_business, p_device, v_entity, v_entity_id, v_existing_rev);
        v_results := v_results || jsonb_build_object(
          'eventId', v_event_id, 'status', 'conflict', 'code', 'stale_revision',
          'message', 'Both the terminal and the cloud changed this record.',
          'revision', v_existing_rev, 'serverRecord', v_server);
        continue;
      end if;

      execute format(
        'update %I t set %s from jsonb_populate_record(null::%I, $1) s where t.id = s.id',
        v_table,
        (select string_agg(format('%1$I = s.%1$I', c.column_name), ', ')
           from information_schema.columns c
          where c.table_schema = 'public' and c.table_name = v_table
            and c.column_name not in ('id','revision','business_id')),
        v_table) using v_row;
    else
      execute format(
        'insert into %I select * from jsonb_populate_record(null::%I, $1)',
        v_table, v_table) using v_row;
    end if;

    -- Server owns the revision counter: monotonically increasing per row.
    execute format('update %I set revision = coalesce(revision, 0) + 1 where id = $1', v_table)
      using v_entity_id;
    execute format('select revision from %I where id = $1', v_table)
      into v_existing_rev using v_entity_id;

    insert into applied_events (event_id, business_id, device_id, entity, entity_id, revision)
    values (v_event_id, p_business, p_device, v_entity, v_entity_id, v_existing_rev)
    on conflict (event_id) do nothing;

    v_results := v_results || jsonb_build_object(
      'eventId', v_event_id, 'status', 'applied', 'revision', coalesce(v_existing_rev, 0));
  end loop;

  -- Record the acknowledgement watermark so the admin view can spot a terminal
  -- that has stopped sending (PRD §23 "manager can view device sync status").
  update devices d
     set last_sync_at = v_now,
         last_acked_seq = greatest(coalesce(d.last_acked_seq, 0), coalesce(p_sequence, 0))
   where d.id = p_device;

  select coalesce(max(seq), 0) into v_cursor from change_log where business_id = p_business;

  return jsonb_build_object(
    'serverTime', v_now,
    'cursor', v_cursor::text,
    'reauthRequired', false,
    'results', v_results
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Pull
-- ---------------------------------------------------------------------------

create or replace function public.sync_pull(
  p_device   text,
  p_business uuid,
  p_branch   text,
  p_cursor   bigint,
  p_limit    integer default 500,
  p_entities text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changes   jsonb := '[]'::jsonb;
  v_new_cursor bigint;
  v_more      boolean;
begin
  if auth.uid() is null or not public.is_member(p_business) then
    raise exception 'Not a member of this business.' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(row_to_json(c)::jsonb order by c.seq), '[]'::jsonb),
         coalesce(max(c.seq), p_cursor)
    into v_changes, v_new_cursor
  from (
    select cl.seq, cl.entity, cl.entity_id, cl.op, cl.revision, cl.row_data
    from change_log cl
    where cl.business_id = p_business
      and cl.seq > coalesce(p_cursor, 0)
      -- Branch scoping: a till only receives its own branch's operational data
      -- plus business-wide master data (products, customers), which has no branch.
      and (p_branch is null or cl.branch_id is null or cl.branch_id = p_branch)
      and (p_entities is null or cl.entity = any (p_entities))
    order by cl.seq
    limit coalesce(p_limit, 500)
  ) c;

  select exists (
    select 1 from change_log cl
    where cl.business_id = p_business
      and cl.seq > v_new_cursor
      and (p_branch is null or cl.branch_id is null or cl.branch_id = p_branch)
      and (p_entities is null or cl.entity = any (p_entities))
      limit 1
  ) into v_more;

  update devices d set last_sync_at = now() where d.id = p_device;

  return jsonb_build_object(
    'cursor', v_new_cursor::text,
    'serverTime', now(),
    'hasMore', v_more,
    'changes', v_changes
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Conflict resolution (PRD §21.3: "Expose sync conflicts in an administrative screen")
-- ---------------------------------------------------------------------------

create or replace function public.resolve_sync_conflict(
  p_conflict_id text,
  p_resolution  text,
  p_note        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conflict sync_conflicts;
  v_table    text;
begin
  select * into v_conflict from sync_conflicts where id = p_conflict_id for update;

  if v_conflict.id is null then
    raise exception 'Conflict not found.' using errcode = 'P0002';
  end if;

  if not public.can_administer(v_conflict.business_id) then
    raise exception 'Only an administrator may resolve sync conflicts.' using errcode = '42501';
  end if;

  if p_resolution = 'local' then
    v_table := public.entity_table(v_conflict.entity);
    if v_table is null then
      raise exception 'Unknown entity.' using errcode = '22023';
    end if;
    -- Apply the terminal's version, then bump the revision so any further stale
    -- writer is correctly detected as conflicting.
    execute format(
      'update %I t set %s from jsonb_populate_record(null::%I, $1) s where t.id = s.id',
      v_table,
      (select string_agg(format('%1$I = s.%1$I', c.column_name), ', ')
         from information_schema.columns c
        where c.table_schema = 'public' and c.table_name = v_table
          and c.column_name not in ('id','revision','business_id')),
      v_table) using public.prepare_row(v_table, v_conflict.local_payload);

    execute format('update %I set revision = coalesce(revision, 0) + 1 where id = $1', v_table)
      using v_conflict.entity_id;
  end if;

  update sync_conflicts
     set status = case p_resolution
                    when 'local'  then 'resolved_local'
                    when 'server' then 'resolved_server'
                    else 'resolved_merged'
                  end,
         resolved_by = auth.uid(),
         resolved_at = now(),
         note = p_note
   where id = p_conflict_id;

  return jsonb_build_object('ok', true, 'resolution', p_resolution);
end;
$$;

-- ---------------------------------------------------------------------------
-- Reporting helpers the dashboard can call without pulling the whole ledger
-- ---------------------------------------------------------------------------

create or replace function public.stock_levels(p_business uuid, p_branch text default null)
returns table (branch_id text, product_id text, variant_id text, quantity numeric)
language sql
stable
security definer
set search_path = public
as $$
  select l.branch_id, l.product_id, l.variant_id, sum(l.quantity_delta) as quantity
  from inventory_ledger l
  where l.business_id = p_business
    and public.is_member(p_business)
    and (p_branch is null or l.branch_id = p_branch)
  group by l.branch_id, l.product_id, l.variant_id;
$$;

create or replace function public.sales_summary(
  p_business uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_branch text default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'transactionCount', count(*),
    'grossSales', coalesce(sum(s.total), 0),
    'taxTotal', coalesce(sum(s.tax_total), 0),
    'discountTotal', coalesce(sum(s.discount_total), 0),
    'itemCount', coalesce(sum(s.item_count), 0),
    'averageOrderValue', coalesce(round(avg(s.total)), 0)
  )
  from sales s
  where s.business_id = p_business
    and public.is_member(p_business)
    and s.status <> 'voided'
    and s.committed_at >= p_from
    and s.committed_at < p_to
    and (p_branch is null or s.branch_id = p_branch);
$$;

-- ---------------------------------------------------------------------------
-- Onboarding helper: create a business + owner membership atomically
-- ---------------------------------------------------------------------------

create or replace function public.create_business(
  p_name text,
  p_branch_name text,
  p_branch_code text,
  p_currency text default 'NGN',
  p_tax_inclusive boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_id uuid;
  v_branch_id   text;
begin
  if auth.uid() is null then
    raise exception 'Sign in required.' using errcode = '42501';
  end if;

  insert into businesses (name, settings)
  values (
    p_name,
    jsonb_build_object(
      'currency', p_currency,
      'taxInclusive', p_tax_inclusive,
      'allowNegativeStock', true,
      'requireApprovalFor', jsonb_build_array('sale.void'),
      'maxDiscountBasisPoints', 1000,
      'offlineSessionMinutes', 480
    )
  )
  returning id into v_business_id;

  insert into business_members (business_id, user_id, role, branch_ids, authorization_version)
  values (v_business_id, auth.uid(), 'owner', '{}', 1);

  v_branch_id := 'br_' || encode(gen_random_bytes(12), 'hex');
  insert into branches (id, business_id, name, code)
  values (v_branch_id, v_business_id, p_branch_name, upper(p_branch_code));

  update business_members
     set branch_ids = array[v_branch_id]
   where business_id = v_business_id and user_id = auth.uid();

  return jsonb_build_object('businessId', v_business_id, 'branchId', v_branch_id);
end;
$$;

grant execute on function public.sync_push(text, uuid, bigint, timestamptz, jsonb) to authenticated;
grant execute on function public.sync_pull(text, uuid, text, bigint, integer, text[]) to authenticated;
grant execute on function public.resolve_sync_conflict(text, text, text) to authenticated;
grant execute on function public.create_business(text, text, text, text, boolean) to authenticated;
grant execute on function public.stock_levels(uuid, text) to authenticated;
grant execute on function public.sales_summary(uuid, timestamptz, timestamptz, text) to authenticated;

-- Barcodes use (business_id, barcode) as their key, not a generic id column.
-- Keep them out of the generic sync_push SQL and process them through this
-- idempotent RPC instead.

create or replace function public.sync_barcode_push(
  p_device text,
  p_business uuid,
  p_events jsonb
)
returns jsonb
language plpgsql
security definer 
set search_path = public
as $$
declare
  e jsonb;
  event_id text;
  code text;
  existing_revision bigint;
  results jsonb := '[]'::jsonb;
begin
  if auth.uid() is null or not public.is_member(p_business) then
    return jsonb_build_object('serverTime', now(), 'cursor', '0', 'reauthRequired', true, 'results', '[]'::jsonb);
  end if;
  if not exists (select 1 from devices where id = p_device and business_id = p_business and status = 'active') then
    return jsonb_build_object('serverTime', now(), 'cursor', '0', 'reauthRequired', true, 'results', '[]'::jsonb);
  end if;

  for e in select * from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) loop
    event_id := e->>'id';
    code := upper(coalesce(e->'payload'->>'barcode', e->>'entityId'));
    if exists (select 1 from applied_events a where a.event_id = sync_barcode_push.event_id) then
      results := results || jsonb_build_object('eventId', event_id, 'status', 'duplicate', 'revision', 0);
      continue;
    end if;
    if e->>'op' = 'delete' then
      delete from barcodes where business_id = p_business and barcode = code;
      insert into applied_events(event_id, business_id, device_id, entity, entity_id, revision)
      values (event_id, p_business, p_device, 'barcode', code, null);
    else
      insert into barcodes(barcode, business_id, product_id, variant_id, status, revision, updated_at, updated_by, deleted_at)
      values (
        code, p_business, e->'payload'->>'productId', e->'payload'->>'variantId',
        coalesce(e->'payload'->>'status', 'active'), 1, now(), p_device, null
      )
      on conflict (business_id, barcode) do update set
        product_id = excluded.product_id,
        variant_id = excluded.variant_id,
        status = excluded.status,
        revision = barcodes.revision + 1,
        updated_at = now(),
        updated_by = p_device,
        deleted_at = null;
      select revision into existing_revision from barcodes where business_id = p_business and barcode = code;
      insert into applied_events(event_id, business_id, device_id, entity, entity_id, revision)
      values (event_id, p_business, p_device, 'barcode', code, existing_revision);
    end if;
    results := results || jsonb_build_object('eventId', event_id, 'status', 'applied', 'revision', coalesce(existing_revision, 0));
  end loop;

  return jsonb_build_object(
    'serverTime', now(),
    'cursor', coalesce((select max(seq)::text from change_log where business_id = p_business), '0'),
    'reauthRequired', false,
    'results', results
  );
end;
$$;

grant execute on function public.sync_barcode_push(text, uuid, jsonb) to authenticated;
-- Migration 0003 used gen_random_bytes(), which is not available in every
-- Supabase project's exposed search path. Replace the function body with the
-- pgcrypto function that is guaranteed by migration 0001.

create or replace function public.ensure_business_link(
  p_local_business_id text,
  p_business jsonb,
  p_branch jsonb,
  p_device jsonb,
  p_owner jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cloud_business uuid;
  v_branch_id text;
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Sign in required.' using errcode = '42501';
  end if;

  select cloud_business_id into v_cloud_business
  from public.cloud_business_links
  where local_business_id = p_local_business_id and owner_user_id = v_user;

  if v_cloud_business is null then
    v_cloud_business := gen_random_uuid();
    insert into public.businesses (id, name, legal_name, phone, email, address, settings)
    values (v_cloud_business, coalesce(p_business->>'name', 'POSA business'),
      p_business->>'legal_name', p_business->>'phone', p_business->>'email',
      p_business->>'address', coalesce(p_business->'settings', '{}'::jsonb));
    insert into public.cloud_business_links (local_business_id, cloud_business_id, owner_user_id)
    values (p_local_business_id, v_cloud_business, v_user);
  end if;

  insert into public.business_members (business_id, user_id, role, branch_ids, granted, revoked, full_name, phone, email)
  values (v_cloud_business, v_user, coalesce(p_owner->>'role', 'owner'),
    coalesce(array(select jsonb_array_elements_text(p_owner->'branch_ids')), '{}'),
    '{}', '{}', p_owner->>'full_name', p_owner->>'phone', p_owner->>'email')
  on conflict (business_id, user_id) do update set
    role = excluded.role, full_name = excluded.full_name, phone = excluded.phone,
    email = excluded.email, status = 'active';

  v_branch_id := coalesce(p_branch->>'id', 'branch_' || replace(gen_random_uuid()::text, '-', ''));
  insert into public.branches (id, business_id, name, code, address, phone, timezone, is_warehouse)
  values (v_branch_id, v_cloud_business, coalesce(p_branch->>'name', 'Main Shop'),
    upper(coalesce(p_branch->>'code', 'MAIN')), p_branch->>'address', p_branch->>'phone',
    coalesce(p_branch->>'timezone', 'Africa/Lagos'), coalesce((p_branch->>'is_warehouse')::boolean, false))
  on conflict (id) do update set name = excluded.name, code = excluded.code,
    address = excluded.address, phone = excluded.phone, timezone = excluded.timezone;

  update public.business_members set branch_ids = array[v_branch_id]
  where business_id = v_cloud_business and user_id = v_user;

  insert into public.devices (id, business_id, branch_id, name, platform, fingerprint, app_version)
  values (p_device->>'id', v_cloud_business, v_branch_id,
    coalesce(p_device->>'name', 'Front Counter'), coalesce(p_device->>'platform', 'web'),
    coalesce(p_device->>'fingerprint', p_device->>'id'), coalesce(p_device->>'app_version', '1.0.0'))
  on conflict (id) do update set business_id = excluded.business_id, branch_id = excluded.branch_id,
    name = excluded.name, platform = excluded.platform, fingerprint = excluded.fingerprint,
    app_version = excluded.app_version, status = 'active';

  return jsonb_build_object('cloudBusinessId', v_cloud_business::text, 'userId', v_user::text, 'branchId', v_branch_id);
end;
$$;

grant execute on function public.ensure_business_link(text, jsonb, jsonb, jsonb, jsonb) to authenticated;
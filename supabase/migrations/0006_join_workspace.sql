-- Let a newly installed terminal join a business that the authenticated user
-- already belongs to. The terminal receives no secrets; its own device row is
-- registered under the existing tenant and normal sync_pull hydrates the data.

create or replace function public.join_business_workspace(
  p_device jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business businesses;
  v_branch branches;
  v_device_id text := p_device->>'id';
begin
  if auth.uid() is null then
    raise exception 'Sign in required.' using errcode = '42501';
  end if;

  select b.* into v_business
  from businesses b
  join business_members m on m.business_id = b.id
  where m.user_id = auth.uid() and m.status = 'active' and b.status = 'active'
  order by b.created_at
  limit 1;

  if v_business.id is null then
    raise exception 'This account is not a member of a POSA business.' using errcode = '42501';
  end if;

  select br.* into v_branch
  from branches br
  join business_members m on m.business_id = br.business_id
  where br.business_id = v_business.id
    and m.user_id = auth.uid()
    and br.status = 'active'
    and (cardinality(m.branch_ids) = 0 or br.id = any(m.branch_ids))
  order by br.created_at
  limit 1;

  if v_branch.id is null then
    raise exception 'This account has no active branch access.' using errcode = '42501';
  end if;

  if v_device_id is null or length(trim(v_device_id)) = 0 then
    raise exception 'A terminal id is required.' using errcode = '22023';
  end if;

  insert into devices (id, business_id, branch_id, name, platform, fingerprint, app_version, status)
  values (
    v_device_id,
    v_business.id,
    v_branch.id,
    coalesce(nullif(p_device->>'name', ''), 'New terminal'),
    coalesce(nullif(p_device->>'platform', ''), 'web'),
    coalesce(nullif(p_device->>'fingerprint', ''), v_device_id),
    coalesce(nullif(p_device->>'app_version', ''), '1.0.0'),
    'active'
  )
  on conflict (id) do update set
    business_id = excluded.business_id,
    branch_id = excluded.branch_id,
    name = excluded.name,
    platform = excluded.platform,
    fingerprint = excluded.fingerprint,
    app_version = excluded.app_version,
    status = 'active';

  return jsonb_build_object(
    'cloudBusinessId', v_business.id::text,
    'cloudUserId', auth.uid()::text,
    'business', to_jsonb(v_business),
    'branch', to_jsonb(v_branch)
  );
end;
$$;

grant execute on function public.join_business_workspace(jsonb) to authenticated;
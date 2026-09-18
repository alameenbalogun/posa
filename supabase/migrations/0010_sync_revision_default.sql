-- jsonb_populate_record() does not apply table defaults when a column is
-- absent from the JSON object. The generic sync normalizer intentionally
-- removes client revision values, so append-only rows such as audit_logs were
-- being inserted with NULL revision and rejected by their NOT NULL constraint.
-- Seed revision zero explicitly; sync_push remains the only owner of the
-- authoritative server revision.

create or replace function public.prepare_row(p_table text, p_payload jsonb)
returns jsonb
language sql
stable
as $$
  select jsonb_set(
    coalesce(
      jsonb_object_agg(
        lower(regexp_replace(e.key, '([a-z0-9])([A-Z])', '\1_\2', 'g')),
        e.value
      ),
      '{}'::jsonb
    ),
    '{revision}',
    '0'::jsonb,
    true
  )
  from jsonb_each(p_payload) e
  where lower(regexp_replace(e.key, '([a-z0-9])([A-Z])', '\1_\2', 'g')) in (
    select c.column_name
    from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = p_table
  )
  and lower(regexp_replace(e.key, '([a-z0-9])([A-Z])', '\1_\2', 'g')) not in ('revision');
$$;
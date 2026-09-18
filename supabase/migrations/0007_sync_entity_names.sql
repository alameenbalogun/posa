-- Keep change_log names aligned with the client sync protocol. Older versions
-- used tg_table_name directly ("products", "users", "barcodes"), while the
-- protocol uses singular entity names ("product", "user", "barcode").

update public.change_log
set entity = case entity
  when 'businesses' then 'business'
  when 'branches' then 'branch'
  when 'users' then 'user'
  when 'devices' then 'device'
  when 'categories' then 'category'
  when 'products' then 'product'
  when 'variants' then 'variant'
  when 'barcodes' then 'barcode'
  when 'price_overrides' then 'price_override'
  when 'price_history' then 'price_history'
  when 'inventory_ledger' then 'inventory_ledger'
  when 'stock_count_sessions' then 'stock_count_session'
  when 'stock_count_lines' then 'stock_count_line'
  when 'stock_transfers' then 'stock_transfer'
  when 'sales' then 'sale'
  when 'sale_lines' then 'sale_line'
  when 'payments' then 'payment'
  when 'held_sales' then 'held_sale'
  when 'returns' then 'return'
  when 'return_lines' then 'return_line'
  when 'customers' then 'customer'
  when 'suppliers' then 'supplier'
  when 'purchases' then 'purchase'
  when 'shifts' then 'shift'
  when 'cash_movements' then 'cash_movement'
  when 'expense_categories' then 'expense_category'
  when 'expenses' then 'expense'
  when 'audit_logs' then 'audit_log'
  else entity
end
where entity in (
  'businesses','branches','users','devices','categories','products','variants',
  'barcodes','price_overrides','price_history','inventory_ledger',
  'stock_count_sessions','stock_count_lines','stock_transfers','sales',
  'sale_lines','payments','held_sales','returns','return_lines','customers',
  'suppliers','purchases','shifts','cash_movements','expense_categories',
  'expenses','audit_logs'
);

update public.change_log
set entity_id = row_data->>'barcode'
where entity = 'barcode' and (entity_id is null or entity_id = '');

create or replace function public.log_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  payload jsonb := to_jsonb(coalesce(new, old));
  entity_name text := case tg_table_name
    when 'businesses' then 'business'
    when 'branches' then 'branch'
    when 'users' then 'user'
    when 'devices' then 'device'
    when 'categories' then 'category'
    when 'products' then 'product'
    when 'variants' then 'variant'
    when 'barcodes' then 'barcode'
    when 'price_overrides' then 'price_override'
    when 'price_history' then 'price_history'
    when 'stock_count_sessions' then 'stock_count_session'
    when 'stock_count_lines' then 'stock_count_line'
    when 'stock_transfers' then 'stock_transfer'
    when 'sales' then 'sale'
    when 'sale_lines' then 'sale_line'
    when 'payments' then 'payment'
    when 'held_sales' then 'held_sale'
    when 'returns' then 'return'
    when 'return_lines' then 'return_line'
    when 'customers' then 'customer'
    when 'suppliers' then 'supplier'
    when 'purchases' then 'purchase'
    when 'shifts' then 'shift'
    when 'cash_movements' then 'cash_movement'
    when 'expense_categories' then 'expense_category'
    when 'expenses' then 'expense'
    when 'audit_logs' then 'audit_log'
    else tg_table_name
  end;
  business_id uuid := coalesce(
    nullif(payload->>'business_id', '')::uuid,
    case when tg_table_name = 'businesses' then nullif(payload->>'id', '')::uuid end
  );
begin
  insert into change_log (business_id, branch_id, entity, entity_id, op, revision, row_data)
  values (
    business_id,
    payload->>'branch_id',
    entity_name,
    coalesce(payload->>'id', payload->>'barcode'),
    case tg_op when 'INSERT' then 'insert' when 'UPDATE' then 'update' else 'delete' end,
    coalesce(nullif(payload->>'revision', '')::bigint, 0),
    payload
  );
  return coalesce(new, old);
end;
$$;
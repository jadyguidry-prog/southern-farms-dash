-- Enable RLS on the Square tables to match every other table in this database.
--
-- These tables hold live revenue data. Without RLS the anon key could read them
-- directly, bypassing the app's auth gate. Every other table in this schema is
-- already protected, so this closes an inconsistency rather than adding a new
-- policy model.
--
-- Access model matches the existing tables: any authenticated staff user can
-- read and write. There is no per-user ownership in this app — it is a single
-- business with a shared set of books.
--
-- Additive and idempotent: safe to re-run.

do $$
declare
  t text;
  square_tables text[] := array[
    'square_orders',
    'square_order_line_items',
    'square_payments',
    'square_refunds',
    'square_catalog_objects',
    'square_team_members',
    'square_locations',
    'square_sync_state',
    'square_csv_imports',
    'sales_daily',
    'sales_by_category',
    'sales_by_employee',
    'sales_source_rules'
  ];
begin
  foreach t in array square_tables loop
    -- Skip anything not present, so this runs cleanly on partial schemas.
    if not exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
    ) then
      continue;
    end if;

    execute format('alter table public.%I enable row level security', t);

    -- Drop-then-create keeps the migration idempotent without needing
    -- "create policy if not exists" (which Postgres does not support).
    execute format('drop policy if exists %I on public.%I', t || '_rw', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (true) with check (true)',
      t || '_rw', t
    );
  end loop;
end $$;

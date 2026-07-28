-- Enable RLS on the Square tables to match every other table in this database.
--
-- These tables hold live revenue data. Without RLS the anon key could read them
-- directly, bypassing the app's auth gate. Every other table in this schema is
-- already protected, so this closes an inconsistency rather than adding a new
-- policy model.
--
-- Access model is copied verbatim from the existing tables (verified against
-- pg_policies for sales_monthly / sales_by_product / business_settings): RLS
-- enabled, with four separate permissive policies named <table>_select /
-- _insert / _update / _delete, each scoped to the `authenticated` role with a
-- `true` predicate. There is no per-user ownership in this app -- it is a
-- single business with one shared set of books.
--
-- Additive and idempotent: safe to re-run. Nothing is dropped or modified
-- except the policies this script itself owns.

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
    'sales_by_employee'
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

    -- Drop-then-create keeps this idempotent: Postgres has no
    -- "create policy if not exists".
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      t || '_select', t
    );

    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (true)',
      t || '_insert', t
    );

    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (true) with check (true)',
      t || '_update', t
    );

    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (true)',
      t || '_delete', t
    );

    -- Remove the earlier single-policy form, if a prior run of this script
    -- created it, so the final state matches the project convention exactly.
    execute format('drop policy if exists %I on public.%I', t || '_rw', t);
  end loop;
end $$;

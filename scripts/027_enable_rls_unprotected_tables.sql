-- These four tables were created with row level security OFF, so the public
-- anon key (shipped to every browser) could read and write them without a login.
-- Bring them in line with every other farm table: authenticated users only.
-- The Plaid/Square crons use the service-role client, which bypasses RLS.

do $$
declare
  t text;
begin
  foreach t in array array[
    'obligation_payments',
    'obligation_payment_audit',
    'sales_source_rules',
    'growth_risk_modes'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (true)', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (true) with check (true)', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (true)', t || '_delete', t);
  end loop;
end $$;

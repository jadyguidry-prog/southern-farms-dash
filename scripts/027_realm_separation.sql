-- 027: Separate FARM users from PERSONAL-finance users inside one Supabase project.
--
-- Before this migration every farm table was readable by ANY authenticated user
-- (`TO authenticated USING (true)`), and four tables had RLS switched off entirely,
-- so they were readable with the public anon key. Adding personal sign-ups on top
-- of that would have handed every personal user the farm's books.
--
-- Design:
--   * Every auth user carries `app_metadata.realm` = 'farm' | 'personal'.
--     app_metadata is NOT user-writable (supabase.auth.updateUser cannot touch it),
--     so a user cannot promote themselves.
--   * A BEFORE INSERT trigger assigns it. Sign-ups that request 'personal' get
--     'personal'; everything else gets 'farm', so the existing farm sign-up and the
--     admin-created verification user keep working unchanged. Requesting 'personal'
--     can only ever DOWNGRADE access, which is why it is safe to honour a
--     user-supplied hint.
--   * current_realm() reads auth.users, not the JWT, so it is authoritative and
--     fails closed: a stale token or an unknown value is never treated as 'farm'.
--   * Farm tables get an ADDITIVE restrictive policy. Restrictive policies are ANDed
--     with the existing permissive ones, so no existing policy is altered.
--
-- New farm tables MUST also get a `farm_realm_only` restrictive policy, or personal
-- users will be able to read them.

create or replace function public.current_realm()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.raw_app_meta_data ->> 'realm'
  from auth.users u
  where u.id = auth.uid()
$$;

revoke all on function public.current_realm() from public;
grant execute on function public.current_realm() to authenticated;

create or replace function public.assign_user_realm()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.raw_app_meta_data := coalesce(new.raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object(
      'realm',
      case
        when new.raw_user_meta_data ->> 'requested_realm' = 'personal' then 'personal'
        else 'farm'
      end
    );
  return new;
end;
$$;

drop trigger if exists assign_user_realm on auth.users;
create trigger assign_user_realm
  before insert on auth.users
  for each row execute function public.assign_user_realm();

-- Every user that exists today is a farm user.
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"realm":"farm"}'::jsonb
where coalesce(raw_app_meta_data ->> 'realm', '') = '';

-- Tables that previously had RLS OFF: enable it with the same "any signed-in farm
-- user" access the rest of the farm schema has. Service-role (cron) access is
-- unaffected because the service role bypasses RLS.
do $$
declare t text;
begin
  foreach t in array array['obligation_payments', 'obligation_payment_audit', 'sales_source_rules', 'growth_risk_modes']
  loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_rw') then
      execute format('create policy %I on public.%I for all to authenticated using (true) with check (true)', t || '_rw', t);
    end if;
  end loop;
end $$;

-- Restrictive farm-only gate on every existing public table.
do $$
declare t text;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'public' and tablename not like 'personal\_%'
  loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'farm_realm_only') then
      execute format(
        'create policy farm_realm_only on public.%I as restrictive for all to authenticated
           using ((select public.current_realm()) = ''farm'')
           with check ((select public.current_realm()) = ''farm'')',
        t
      );
    end if;
  end loop;
end $$;

-- Farm document storage. Written so it only constrains this one bucket.
drop policy if exists transaction_documents_farm_realm_only on storage.objects;
create policy transaction_documents_farm_realm_only on storage.objects
  as restrictive for all to authenticated
  using (bucket_id <> 'transaction-documents' or (select public.current_realm()) = 'farm')
  with check (bucket_id <> 'transaction-documents' or (select public.current_realm()) = 'farm');

-- 028: Personal finance (budgeting) tables.
--
-- Every row belongs to one personal user. Policies require BOTH ownership and the
-- 'personal' realm, so a farm user can never read these even by guessing ids.
-- Plaid writes go through the service role (server-only); the browser session can
-- only read its own rows and edit the few columns granted below.

create table if not exists public.personal_plaid_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id text not null unique,
  institution_id text,
  institution_name text,
  access_token_encrypted text,
  cursor text,
  status text not null default 'active'
    check (status in ('active', 'reauth_required', 'error')),
  last_error text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.personal_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id text not null references public.personal_plaid_items(item_id) on delete cascade,
  plaid_account_id text not null unique,
  name text not null,
  official_name text,
  mask text,
  type text,
  subtype text,
  current_balance numeric(14, 2),
  available_balance numeric(14, 2),
  credit_limit numeric(14, 2),
  iso_currency_code text,
  is_hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.personal_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plaid_account_id text not null references public.personal_accounts(plaid_account_id) on delete cascade,
  plaid_transaction_id text not null unique,
  transaction_date date not null,
  authorized_date date,
  name text not null,
  merchant_name text,
  signed_amount numeric(14, 2) not null,
  iso_currency_code text,
  plaid_category text,
  plaid_category_detailed text,
  category_override text check (category_override is null or category_override ~ '^[A-Z_]+$'),
  pending boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.personal_transactions.signed_amount is
  'Positive = money IN, negative = money OUT. Plaid''s own amount is the opposite sign; it is flipped once in lib/personal-finance.ts.';

create index if not exists personal_transactions_user_date_idx
  on public.personal_transactions (user_id, transaction_date desc);

create table if not exists public.personal_budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  category text not null check (category ~ '^[A-Z_]+$'),
  monthly_limit numeric(12, 2) not null check (monthly_limit > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, category)
);

do $$
declare t text;
begin
  foreach t in array array['personal_plaid_items', 'personal_accounts', 'personal_transactions', 'personal_budgets']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('drop trigger if exists touch_updated_at on public.%I', t);
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- Items: readable WITHOUT the token or cursor columns. Writes are service-role only.
grant select (id, item_id, institution_name, status, last_error, last_synced_at, created_at)
  on public.personal_plaid_items to authenticated;
create policy personal_items_select_own on public.personal_plaid_items
  for select to authenticated
  using (user_id = (select auth.uid()) and (select public.current_realm()) = 'personal');

-- Accounts: read own, toggle visibility only.
grant select on public.personal_accounts to authenticated;
grant update (is_hidden) on public.personal_accounts to authenticated;
create policy personal_accounts_select_own on public.personal_accounts
  for select to authenticated
  using (user_id = (select auth.uid()) and (select public.current_realm()) = 'personal');
create policy personal_accounts_update_own on public.personal_accounts
  for update to authenticated
  using (user_id = (select auth.uid()) and (select public.current_realm()) = 'personal')
  with check (user_id = (select auth.uid()) and (select public.current_realm()) = 'personal');

-- Transactions: read own, re-categorise only. Amounts come from the bank and are
-- not editable from the browser.
grant select on public.personal_transactions to authenticated;
grant update (category_override) on public.personal_transactions to authenticated;
create policy personal_transactions_select_own on public.personal_transactions
  for select to authenticated
  using (user_id = (select auth.uid()) and (select public.current_realm()) = 'personal');
create policy personal_transactions_update_own on public.personal_transactions
  for update to authenticated
  using (user_id = (select auth.uid()) and (select public.current_realm()) = 'personal')
  with check (user_id = (select auth.uid()) and (select public.current_realm()) = 'personal');

-- Budgets: full CRUD on own rows.
grant select, insert, delete on public.personal_budgets to authenticated;
grant update (monthly_limit) on public.personal_budgets to authenticated;
create policy personal_budgets_all_own on public.personal_budgets
  for all to authenticated
  using (user_id = (select auth.uid()) and (select public.current_realm()) = 'personal')
  with check (user_id = (select auth.uid()) and (select public.current_realm()) = 'personal');

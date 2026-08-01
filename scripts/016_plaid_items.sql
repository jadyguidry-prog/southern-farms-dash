-- Plaid bank/card connections.
--
-- Additive and idempotent: creates three new tables and touches nothing that
-- already exists. Safe to re-run.
--
-- Model:
--   plaid_items      one row per institution LOGIN (an "Item" in Plaid's terms).
--                    Holds the encrypted access_token and the sync cursor.
--   plaid_accounts   the individual accounts inside an Item, each mapped to the
--                    `account_name` string already used by financial_transactions.
--   plaid_sync_state one row per Item, mirroring square_sync_state so the
--                    Settings screen can report real status and real errors.
--
-- Why the account mapping table exists: financial_transactions has no
-- account_id column -- accounts are joined by the free-text `account_name`
-- label. Plaid supplies its own account ids and names ("Plaid Checking"), which
-- would NOT match the existing "South Lafourche Bank Checking ending 2268".
-- Without an explicit mapping, synced rows would land under a second,
-- near-identical account and silently split every per-account report.

create table if not exists public.plaid_items (
  id uuid primary key default gen_random_uuid(),
  item_id text not null unique,
  institution_id text,
  institution_name text,
  -- AES-256-GCM ciphertext, never the raw token. See lib/plaid-crypto.ts.
  access_token_encrypted text not null,
  -- Cursor for /transactions/sync. Null means "never synced".
  cursor text,
  status text not null default 'active',
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.plaid_accounts (
  id uuid primary key default gen_random_uuid(),
  item_id text not null references public.plaid_items (item_id) on delete cascade,
  account_id text not null unique,
  -- What Plaid calls it.
  plaid_name text,
  mask text,
  type text,
  subtype text,
  -- What THIS app calls it. Must match financial_transactions.account_name
  -- exactly or reporting splits in two. Null until the owner maps it.
  account_name text,
  -- Plaid amounts are positive for money OUT; this app stores negative for
  -- money out. 'card' flips the sign, 'bank' does not -- the same two
  -- conventions lib/transactions.ts already models for CSV files.
  amount_convention text not null default 'bank',
  -- Do not import anything dated on or before this. Prevents double-counting
  -- against history already loaded from CSV, which cannot dedupe against Plaid
  -- rows because they carry different ids and descriptions.
  import_from_date date,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.plaid_sync_state (
  id uuid primary key default gen_random_uuid(),
  item_id text not null unique references public.plaid_items (item_id) on delete cascade,
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  status text,
  records_synced integer default 0,
  added_count integer default 0,
  modified_count integer default 0,
  removed_count integer default 0,
  skipped_before_cutover integer default 0,
  updated_at timestamptz not null default now()
);

create index if not exists plaid_accounts_item_idx on public.plaid_accounts (item_id);
create index if not exists plaid_accounts_name_idx on public.plaid_accounts (account_name);

-- Match the RLS shape used by every other table in this schema: enabled, with
-- four permissive policies scoped to `authenticated`. Single business, one
-- shared set of books, so the predicate is `true` rather than per-user.
--
-- The access token lives behind this. `authenticated` can read the row, so the
-- token is additionally encrypted at the application layer -- RLS alone would
-- expose it to any signed-in session.
do $$
declare
  t text;
  plaid_tables text[] := array[
    'plaid_items',
    'plaid_accounts',
    'plaid_sync_state'
  ];
begin
  foreach t in array plaid_tables loop
    execute format('alter table public.%I enable row level security', t);

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
  end loop;
end $$;

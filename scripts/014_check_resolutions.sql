-- CHECK resolution overlay: identify who was paid, without editing the import.
--
-- Why this table exists
-- --------------------
-- 201 bank lines read only `CHECK` or `CHECK # 1317` — $292,487.68 with no
-- payee recorded anywhere in the export. That is nearly 2x all categorized COGS,
-- so gross profit cannot be trusted until these are attributed.
--
-- The critical design decision is that this is an OVERLAY, not an edit. The
-- existing `categorizeTransactions` action writes `expense_category` directly on
-- `financial_transactions`; doing that here would destroy the only faithful copy
-- of what the bank actually sent. Instead every resolution lives in its own row
-- keyed by transaction, and reporting layers it on top at read time. The
-- imported `description` and `expense_category` are never written by this
-- module, so the raw ledger stays byte-identical to the statement and cash-out
-- totals continue to reconcile.
--
-- Additive and idempotent: creates two new tables plus indexes and policies.
-- Nothing existing is renamed, altered, or dropped. Safe to re-run.

create table if not exists public.check_resolutions (
  id uuid primary key default gen_random_uuid(),

  -- The bank line being explained. Cascade on delete because a resolution has
  -- no meaning without the transaction it describes.
  financial_transaction_id uuid not null
    references public.financial_transactions (id) on delete cascade,

  -- Recovered from the description ("CHECK # 1317" -> 1317). Text, not integer:
  -- leading zeros are meaningful on a printed check, and 5 of the 201 lines are
  -- a bare `CHECK` with no number at all.
  check_number text,

  -- What the owner determined. `resolved_payee` is free text because the payee
  -- may not exist in `vendors` yet; `resolved_vendor_id` links it when it does,
  -- so a resolution is useful immediately without forcing vendor creation first.
  resolved_payee text,
  resolved_vendor_id uuid references public.vendors (id),
  resolved_category text,

  memo text,
  business_purpose text,

  -- pending -> approved | rejected, and approved -> undone via Undo.
  -- Only 'approved' rows are read by reporting.
  review_status text not null default 'pending',

  -- high | medium | low. Stored rather than recomputed so the confidence shown
  -- at approval time is the confidence recorded forever, even after later
  -- resolutions would change what the suggester infers today.
  confidence text,

  -- How the resolution was arrived at (manual, amount_cluster, vendor_match,
  -- prior_check, check_sequence) so a suspicious batch can be traced later.
  resolution_source text,

  reviewed_by text,
  reviewed_at timestamptz,

  -- Groups every row written by one approval so a cluster of 18 checks is
  -- undone as the single action the owner actually took.
  bulk_action_id uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one APPROVED resolution per transaction. Partial unique index rather
-- than a plain one: rejected and undone rows are kept as history and would
-- otherwise collide. This is what makes the overlay unambiguous at read time —
-- a transaction can never have two competing live answers.
create unique index if not exists check_resolutions_one_approved_per_txn
  on public.check_resolutions (financial_transaction_id)
  where review_status = 'approved';

-- Reporting joins the overlay by transaction; the screen filters by status.
create index if not exists check_resolutions_txn_idx
  on public.check_resolutions (financial_transaction_id);

create index if not exists check_resolutions_status_idx
  on public.check_resolutions (review_status, reviewed_at desc);

-- Undo looks up every row from one approval.
create index if not exists check_resolutions_bulk_idx
  on public.check_resolutions (bulk_action_id);

-- Suggestions look up prior approved answers by payee and by amount cluster.
create index if not exists check_resolutions_payee_idx
  on public.check_resolutions (resolved_payee)
  where review_status = 'approved';


-- Audit trail for the overlay.
--
-- Kept separate from `transaction_audit_log` because that table records a single
-- changed column per row (field / previous_value / new_value), which cannot
-- express "these seven overlay fields moved together". Storing whole-overlay
-- JSONB snapshots means Undo restores the exact prior reporting state rather
-- than replaying field-by-field guesses.
create table if not exists public.check_resolution_audit (
  id uuid primary key default gen_random_uuid(),

  -- The action ID the owner sees and undoes. Not unique here: one approval of a
  -- cluster writes one audit row per affected transaction.
  bulk_action_id uuid not null,

  financial_transaction_id uuid
    references public.financial_transactions (id) on delete cascade,

  -- approve | reject | undo
  action text not null,

  -- Full before/after overlay snapshots. `previous_overlay` is null on a first
  -- resolution, which is itself meaningful: it says the row had no overlay, so
  -- Undo must remove it rather than restore something.
  previous_overlay jsonb,
  new_overlay jsonb,

  actor_email text,
  reason text,

  created_at timestamptz not null default now(),

  -- Set when this entry has been rolled back, so an action cannot be undone
  -- twice and double-restore a stale state.
  reverted_at timestamptz
);

create index if not exists check_resolution_audit_bulk_idx
  on public.check_resolution_audit (bulk_action_id);

-- "Recent changes" reads the newest entries that are still in effect.
create index if not exists check_resolution_audit_active_idx
  on public.check_resolution_audit (created_at desc)
  where reverted_at is null;

-- Access model copied verbatim from 012_square_rls.sql / 013_square_shifts.sql:
-- RLS on, four permissive policies scoped to `authenticated` with a `true`
-- predicate. One business, one shared set of books, no per-user ownership.
alter table public.check_resolutions enable row level security;

drop policy if exists check_resolutions_select on public.check_resolutions;
create policy check_resolutions_select on public.check_resolutions
  for select to authenticated using (true);

drop policy if exists check_resolutions_insert on public.check_resolutions;
create policy check_resolutions_insert on public.check_resolutions
  for insert to authenticated with check (true);

drop policy if exists check_resolutions_update on public.check_resolutions;
create policy check_resolutions_update on public.check_resolutions
  for update to authenticated using (true) with check (true);

drop policy if exists check_resolutions_delete on public.check_resolutions;
create policy check_resolutions_delete on public.check_resolutions
  for delete to authenticated using (true);

alter table public.check_resolution_audit enable row level security;

drop policy if exists check_resolution_audit_select on public.check_resolution_audit;
create policy check_resolution_audit_select on public.check_resolution_audit
  for select to authenticated using (true);

drop policy if exists check_resolution_audit_insert on public.check_resolution_audit;
create policy check_resolution_audit_insert on public.check_resolution_audit
  for insert to authenticated with check (true);

drop policy if exists check_resolution_audit_update on public.check_resolution_audit;
create policy check_resolution_audit_update on public.check_resolution_audit
  for update to authenticated using (true) with check (true);

drop policy if exists check_resolution_audit_delete on public.check_resolution_audit;
create policy check_resolution_audit_delete on public.check_resolution_audit
  for delete to authenticated using (true);

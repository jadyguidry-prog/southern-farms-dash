-- Bill Payments overlay: track WHEN a bill was actually paid, and whether the
-- money has really left the bank yet.
--
-- Why this table exists
-- --------------------
-- `cash_obligations` says what is owed and when. It cannot say "a check for this
-- went out on the 3rd and hasn't cashed yet". That gap matters because bank
-- balances still include money already promised: write a $2,811 rent check and
-- the balance keeps showing $18,846 until it clears. Spendable cash is LOWER
-- than every balance on screen, and nothing in the app knew it.
--
-- Design decisions
-- ----------------
-- OVERLAY, not an edit — same rule as 014_check_resolutions.sql. Recording a
-- payment NEVER mutates the `cash_obligations` row. The one exception is a
-- deliberate, audited roll-forward of `next_due_date` for recurring bills, done
-- from the action layer, because marking a monthly bill "Paid" would drop it out
-- of the cash forecast entirely.
--
-- Float is driven by STATUS, not by payment method. ACH is inserted already
-- 'cleared'; only 'outstanding' reduces spendable cash. Deriving it from
-- `payment_method` instead would silently break the day another floating method
-- (mailed money order) is added.
--
-- A void is a status change, never a delete: an audit row preserves that a check
-- was written and then voided (lost in the mail, reissued).
--
-- Additive and idempotent: creates two new tables plus indexes and policies.
-- Nothing existing is renamed, altered, or dropped. Safe to re-run.
--
-- NOTE: these tables were originally created directly against the database while
-- the module was being built. This file back-fills them into version control so
-- the schema is reproducible from the repo alone; it is written to match the live
-- schema exactly and is safe to run against a database that already has them.

create table if not exists public.obligation_payments (
  id uuid primary key default gen_random_uuid(),

  -- The scheduled bill being paid. Cascade on delete: a payment against a
  -- deleted obligation has nothing left to describe.
  --
  -- Nullable as of 018 to support one-off checks to payees that were never set
  -- up as recurring obligations. See that migration for the paired constraint
  -- that keeps every row identifiable.
  obligation_id uuid not null
    references public.cash_obligations (id) on delete cascade,

  amount numeric not null check (amount > 0),
  payment_date date not null,

  -- Constrained rather than free text so the float logic can rely on it.
  payment_method text not null check (payment_method in ('check', 'ach')),

  -- Text, not integer: leading zeros are meaningful on a printed check. Required
  -- by the action layer for checks (it is the only reliable way to match the
  -- payment to the bank later), optional here so ACH rows can leave it null.
  check_number text,

  bank_account_id uuid references public.bank_accounts (id),

  -- outstanding -> cleared, or -> void. 'outstanding' is the only status that
  -- reduces spendable cash.
  status text not null default 'outstanding'
    check (status in ('outstanding', 'cleared', 'void')),

  cleared_date date,

  -- The bank row that proves this cleared. Stamped only on explicit owner
  -- confirmation of a suggested match — Plaid data never silently resolves a
  -- payment.
  cleared_transaction_id uuid references public.financial_transactions (id),

  -- Reserved for Phase 2 invoice/receipt capture.
  invoice_document_id uuid,

  memo text,

  created_at timestamptz not null default now(),
  created_by text
);

-- One bank transaction can clear at most ONE payment. Without this, two
-- same-amount checks could both be confirmed against a single withdrawal and
-- quietly understate outstanding cash by a full check. Partial index because
-- the column is null for every not-yet-cleared row.
create unique index if not exists obligation_payments_cleared_txn_key
  on public.obligation_payments (cleared_transaction_id)
  where cleared_transaction_id is not null;

-- Payment history for one bill.
create index if not exists obligation_payments_obligation_idx
  on public.obligation_payments (obligation_id);

-- The outstanding-check sweep filters on status on every dashboard load.
create index if not exists obligation_payments_status_idx
  on public.obligation_payments (status);


-- Audit trail. Every state change is recorded so a void is explainable and a
-- clear can be traced back to the evidence that justified it.
create table if not exists public.obligation_payment_audit (
  id uuid primary key default gen_random_uuid(),

  payment_id uuid not null
    references public.obligation_payments (id) on delete cascade,

  action text not null
    check (action in ('created', 'cleared', 'uncleared', 'voided')),

  -- Whole-snapshot JSONB rather than one changed column per row: a clear moves
  -- status, cleared_date and cleared_transaction_id together, and they are only
  -- meaningful read as a set.
  detail jsonb,

  created_at timestamptz not null default now(),
  created_by text
);

create index if not exists obligation_payment_audit_payment_idx
  on public.obligation_payment_audit (payment_id);

-- Access model copied verbatim from 012_square_rls.sql / 014_check_resolutions.sql:
-- RLS on, four permissive policies scoped to `authenticated` with a `true`
-- predicate. One business, one shared set of books, no per-user ownership.
alter table public.obligation_payments enable row level security;

drop policy if exists obligation_payments_select on public.obligation_payments;
create policy obligation_payments_select on public.obligation_payments
  for select to authenticated using (true);

drop policy if exists obligation_payments_insert on public.obligation_payments;
create policy obligation_payments_insert on public.obligation_payments
  for insert to authenticated with check (true);

drop policy if exists obligation_payments_update on public.obligation_payments;
create policy obligation_payments_update on public.obligation_payments
  for update to authenticated using (true) with check (true);

drop policy if exists obligation_payments_delete on public.obligation_payments;
create policy obligation_payments_delete on public.obligation_payments
  for delete to authenticated using (true);

alter table public.obligation_payment_audit enable row level security;

drop policy if exists obligation_payment_audit_select on public.obligation_payment_audit;
create policy obligation_payment_audit_select on public.obligation_payment_audit
  for select to authenticated using (true);

drop policy if exists obligation_payment_audit_insert on public.obligation_payment_audit;
create policy obligation_payment_audit_insert on public.obligation_payment_audit
  for insert to authenticated with check (true);

drop policy if exists obligation_payment_audit_update on public.obligation_payment_audit;
create policy obligation_payment_audit_update on public.obligation_payment_audit
  for update to authenticated using (true) with check (true);

drop policy if exists obligation_payment_audit_delete on public.obligation_payment_audit;
create policy obligation_payment_audit_delete on public.obligation_payment_audit
  for delete to authenticated using (true);

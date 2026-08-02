-- One-off checks: record a check written to someone who is NOT a scheduled bill.
--
-- Why this is needed
-- ------------------
-- 017 could only record a payment against an existing `cash_obligations` row,
-- because `obligation_id` was NOT NULL. There are only 9 scheduled bills, but the
-- bank history shows the majority of checks go to one-off payees — a seed
-- supplier, a repair, a hauler. Those checks float exactly like a rent check
-- does, so excluding them meant "Spendable Now" was overstated by every one of
-- them. A float number that ignores most of the float is worse than no number,
-- because it looks authoritative.
--
-- Design decisions
-- ----------------
-- Relaxing NOT NULL rather than inventing a placeholder obligation. The
-- alternative — a synthetic "Miscellaneous" obligation row to hang one-offs from —
-- would put fake data in `cash_obligations` (violating the no-placeholder-data
-- rule), corrupt the obligation forecast with a bill that isn't owed, and make
-- every consumer filter it back out. Dropping NOT NULL is backward compatible:
-- existing rows are untouched and every insert that worked before still works.
--
-- `payee_name` is free text, deliberately NOT a FK to `vendors`. The same
-- reasoning as `check_resolutions.resolved_payee`: the payee frequently is not in
-- `vendors` yet, and forcing vendor creation first would stop the owner recording
-- a check they just wrote. `payee_vendor_id` links it when the vendor does exist,
-- so the row is useful immediately and can be tightened later.
--
-- The CHECK constraint is the important part: it makes "identified by an
-- obligation OR by a payee name" a database invariant. Without it, a bug in the
-- action layer could insert a row with neither, producing an anonymous amount
-- silently reducing spendable cash with nothing on screen explaining why.
--
-- Additive, backward compatible, idempotent. Safe to re-run.

-- Allow a payment that belongs to no scheduled obligation.
alter table public.obligation_payments
  alter column obligation_id drop not null;

-- Who the one-off check was written to. Null for obligation-backed payments,
-- where the payee comes from the obligation's own vendor.
alter table public.obligation_payments
  add column if not exists payee_name text;

-- Optional link to a known vendor, when the payee happens to be one.
alter table public.obligation_payments
  add column if not exists payee_vendor_id uuid references public.vendors (id);

-- What the one-off check was for. `memo` already exists but is a free note on any
-- payment; this is the one-off's reason for existing and is what Reporting shows
-- when there is no obligation name to fall back on.
alter table public.obligation_payments
  add column if not exists purpose text;

-- Every payment must be identifiable as either an obligation payment or a named
-- one-off. Guards against an anonymous row quietly reducing spendable cash.
-- Existing rows all have obligation_id set, so this validates immediately.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'obligation_payments_identified_check'
      and conrelid = 'public.obligation_payments'::regclass
  ) then
    alter table public.obligation_payments
      add constraint obligation_payments_identified_check
      check (
        obligation_id is not null
        or (payee_name is not null and length(btrim(payee_name)) > 0)
      );
  end if;
end $$;

-- One-off checks are listed and grouped by payee (e.g. "how much have we written
-- to this hauler this year"), which is a scan without this.
create index if not exists obligation_payments_payee_idx
  on public.obligation_payments (payee_name)
  where payee_name is not null;

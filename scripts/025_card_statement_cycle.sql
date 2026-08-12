-- 025_card_statement_cycle.sql
--
-- Additive: record WHICH billing cycle a statement balance describes.
--
-- Why this is needed. `last_updated` records when a figure was TYPED, not which
-- cycle it describes, so those two can disagree: a statement entered today can
-- still be quoting June's cycle, and nothing in the read path could tell.
--
-- This became concrete on Amex 0-73009, which sat at a `statement_balance` of
-- $2 against a ~$9,948 balance. A blank would have been reported as "not
-- recorded"; $2 instead passed every check as a confirmed, trivially-small
-- payment, so the due-date collision test waved it through as safe while the
-- real statement was $10,904.40.
--
-- A guard on magnitude alone cannot fix that, because a genuinely paid-off card
-- that was then recharged looks identical to a mistyped one. The distinguishing
-- fact is the CYCLE: once a statement's period has been superseded by a newer
-- one, the recorded figure is known to be out of date regardless of its size.
--
-- Both columns are NULLABLE with no default. NULL means "cycle not recorded",
-- which the read path reports as unconfirmed rather than inventing a period --
-- the same rule already applied to `statement_balance`, where a blank must stay
-- NULL because 0 would assert the card is paid off.

alter table public.bank_accounts
  add column if not exists statement_period_start date,
  add column if not exists statement_period_end   date;

comment on column public.bank_accounts.statement_period_start is
  'First day of the billing cycle this statement_balance covers. NULL = not recorded.';
comment on column public.bank_accounts.statement_period_end is
  'Last day (closing date) of the billing cycle this statement_balance covers. NULL = not recorded. Used to detect a superseded statement.';

-- A cycle cannot end before it starts. Guards typos at the source rather than
-- leaving the read path to reason about impossible ranges. NULLs pass, so this
-- stays backward compatible with every existing row.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'statement_period_ordered'
  ) then
    alter table public.bank_accounts
      add constraint statement_period_ordered
      check (
        statement_period_start is null
        or statement_period_end is null
        or statement_period_end >= statement_period_start
      );
  end if;
end $$;

-- How long after a cycle closes its statement is still considered current.
--
-- Not an invented round number: card cycles here are monthly, so the longest
-- legitimate gap is a 31-day month plus a few days for the statement to be
-- issued and entered. Past that, a newer statement exists and the stored one is
-- superseded. Kept in business_settings (rule 5/6) so it stays tunable per this
-- business rather than compiled into the read path.
insert into public.business_settings (setting_key, label, value, unit, notes)
values (
  'card_statement_cycle_stale_days',
  'Card statement cycle considered superseded after',
  35,
  'days',
  'Days after a statement period closes before the recorded statement balance is treated as superseded rather than current. Monthly cycles run up to 31 days, plus a few days to issue and enter the statement.'
)
on conflict (setting_key) do nothing;

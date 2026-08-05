-- Distinguish a check that HAS been written from one that is merely planned.
--
-- Why this column is needed rather than testing `check_number is null`:
--
--   Two genuinely different states were previously indistinguishable —
--     (a) "I wrote check 1318 but never typed the number in", and
--     (b) "I owe this bill and will pay it by check, but haven't written it yet".
--
--   For (a) the payment date is a FACT, so matching a bank withdrawal on
--   amount + date is sound, and that is long-standing behaviour worth keeping.
--   For (b) the date is only an INTENTION, so the same amount+date match would
--   reject the real debit if it lands earlier than planned, and could accept an
--   unrelated same-amount withdrawal instead.
--
-- Default true so every historical row keeps today's behaviour: a check payment
-- created through "Write a Check" has always required a check number, meaning the
-- check existed.
--
-- The default is NOT correct for every existing row, however. Two bills were
-- logged as pay-by-check-later before this column existed (Gator Joe Exotic
-- Leathers $382, Law Office of Ryan Collins $375 — both audit-stamped
-- pending_draft: true with no check number). They are genuinely unwritten, so they
-- are backfilled to false below; leaving them true would let an unrelated
-- same-amount withdrawal be suggested as a match.
--
-- Meaningful only when payment_method = 'check'. For ACH the column is ignored
-- (an ACH draft is never "written"), and is left at its default rather than made
-- nullable so no reader has to handle a third, undefined state.

alter table obligation_payments
  add column if not exists check_written boolean not null default true;

-- Backfill the pre-existing pay-by-check-later bills. Scoped to outstanding checks
-- with no number: a cleared or void row is settled history and must not be touched,
-- and a numbered check is by definition written.
update obligation_payments
   set check_written = false
 where payment_method = 'check'
   and check_number is null
   and status = 'outstanding';

comment on column obligation_payments.check_written is
  'True when the physical check exists (so payment_date is a fact and amount+date bank matching is valid). False for a bill logged as pay-by-check before the check is written, where payment_date is only an intention. Ignored when payment_method = ''ach''.';

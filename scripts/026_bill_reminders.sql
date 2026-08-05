-- 026: self-scheduled bills, bill reminders, and stale uncleared checks.
--
-- Three related problems, all additive. Nothing is dropped or rewritten.
--
-- 1. A recurring obligation with an explicit `next_due_date` was pinned in the past
--    forever: `resolveNextDueDate` preferred that column and nothing ever advanced it.
--    MediaRite sat on 2026-08-01 and grew "more overdue" every day, even after payment.
--
-- 2. Some bills have NO vendor due date at all (MediaRite's invoice carries none). The
--    date on those is when the OWNER chooses to pay, so calling them "overdue" invents a
--    deadline the vendor never set. That is a different fact, so it gets its own column
--    rather than being folded into the due date.
--
-- 3. Reminders need a lead time, and it must be tunable rather than hardcoded.

begin;

-- A self-scheduled bill has no vendor deadline. Its date is a PLAN, not an obligation,
-- so it must never be reported as late. Default false: every existing row keeps its
-- current meaning (a real vendor due date) until explicitly marked otherwise.
alter table cash_obligations
  add column if not exists self_scheduled boolean not null default false;

comment on column cash_obligations.self_scheduled is
  'True when the vendor sets no due date and the date is simply when we choose to pay. '
  'Such a bill can be "coming up" or "not yet paid" but is NEVER overdue, because there '
  'is no deadline to miss. Keep false for anything with a real vendor due date.';

-- How many days ahead a bill starts reminding. Owner-chosen (3), not a guess, and
-- editable in Admin like every other threshold in this app.
insert into business_settings (setting_key, label, value, unit, notes)
values (
  'bill_reminder_lead_days',
  'Bill reminder lead time',
  3,
  'days',
  'How many days before its due date a bill starts appearing in reminders. Set to 3 by '
  'the owner. Raise it to batch check-writing further ahead.'
)
on conflict (setting_key) do nothing;

commit;

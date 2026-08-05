-- M0.5 — Card & credit truth.
--
-- Purpose: make credit-card exposure visible to capacity math, and stop an
-- untaken borrowing offer from looking like money.
--
-- Additive only. No account row is deleted and no cash balance is changed.

-- 1. Statement fields, so the planner can warn when a commitment lands right
--    before a card statement is due.
--
--    Deliberately NULLABLE with NO default. Null means "not tracked yet", which is
--    NOT the same as a real zero balance — a zero default would make an untracked
--    card look fully paid off. Every reader must handle null explicitly rather than
--    coercing it with `?? 0`.
alter table bank_accounts
  add column if not exists statement_balance numeric,
  add column if not exists statement_due_date date;

comment on column bank_accounts.statement_balance is
  'Balance shown on the latest card statement — the amount due by statement_due_date, which is usually LESS than current_balance because it excludes charges made since the statement closed. NULL means not tracked; never coerce to 0.';

comment on column bank_accounts.statement_due_date is
  'Date the current statement balance must be paid by. NULL means not tracked; never treat a null as "no payment due".';

-- 2. Remove the Square Capital loan offer figures.
--
--    Square Savings is a deposit account holding $7,042.65 of real cash. It also
--    carried credit_limit 56,750 / available_credit 47,480.44, which is a Square
--    Capital loan OFFER — borrowing offered but never taken.
--
--    It was NOT inflating any on-screen figure: `availableCredit` and
--    `operatingLiquidity` both filter to ('Line of Credit','Credit Card') and this
--    row is type 'Savings', so it was excluded. It is cleared because an untaken
--    offer is not a balance, and leaving it on a savings row invites exactly the
--    misreading that a future unfiltered sum would make.
--
--    Scoped by id so no other account can be touched by a stray type match.
update bank_accounts
   set credit_limit = 0,
       available_credit = 0,
       notes = 'Deposit account. Balance is entered manually — changes daily. '
               || 'A Square Capital loan offer previously stored here was removed: '
               || 'an offer that has not been accepted is not available credit.'
 where id = '0b7b261b-4ec7-431e-aebe-861e51095b33';

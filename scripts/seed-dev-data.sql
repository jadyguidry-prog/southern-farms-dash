-- ============================================================
-- Southern Farms Operations Center — development seed data
-- ============================================================
-- Populates known, stable business information only.
--
-- This script is IDEMPOTENT: every statement is guarded so it
-- inserts only when a matching record is absent. Running it
-- repeatedly will never duplicate or overwrite existing rows.
--
-- INTENTIONALLY NOT SEEDED (changes too often — enter these
-- manually via the Admin page):
--   * Business Checking balance
--   * Square Savings balance
--   * Line of Credit current + available balance
--   * Current inventory
--   * Upcoming vendor drafts
--   * Current payroll
--   * Actual receivables
-- ============================================================


-- ------------------------------------------------------------
-- BANK ACCOUNTS
-- Balances deliberately left at 0 — staff enter live figures.
-- ------------------------------------------------------------
-- NOTE: this name must match the label the ledger uses EXACTLY. Accounts are joined
-- to financial_transactions by free text, so seeding "Business Checking" (the old
-- name) while the ledger says "South Lafourche Bank Checking ending 2268" orphans
-- 1,061 transactions from their balance. That was a real bug. The guard below keys
-- on the same string, so it stays idempotent against the renamed row instead of
-- inserting a duplicate account and recreating the split.
insert into public.bank_accounts (account_name, institution, account_type, notes)
select 'South Lafourche Bank Checking ending 2268', 'South Lafourche Bank', 'Checking',
       'Balance is entered manually — changes daily.'
where not exists (
  select 1 from public.bank_accounts
  where account_name = 'South Lafourche Bank Checking ending 2268'
);

insert into public.bank_accounts (account_name, institution, account_type, notes)
select 'Square Savings', 'Square', 'Savings',
       'Balance is entered manually — changes daily.'
where not exists (
  select 1 from public.bank_accounts where account_name = 'Square Savings'
);

insert into public.bank_accounts (account_name, institution, account_type, notes)
select 'Business Line of Credit', 'South Lafourche Bank', 'Line of Credit',
       'Current and available credit are entered manually.'
where not exists (
  select 1 from public.bank_accounts where account_name = 'Business Line of Credit'
);


-- ------------------------------------------------------------
-- LOANS
-- ------------------------------------------------------------
insert into public.loans (
  loan_name, lender, loan_type, current_balance, original_balance,
  monthly_payment, interest_rate, payment_type, status, notes
)
select 'Square Loan', 'Square', 'Other', 48219.34, 0,
       0, 0, 'Revolving', 'Active',
       'Repaid automatically at 8.75% of daily Square sales — no fixed monthly payment.'
where not exists (
  select 1 from public.loans where loan_name = 'Square Loan'
);

insert into public.loans (
  loan_name, lender, loan_type, current_balance, original_balance,
  monthly_payment, interest_rate, payment_type, status
)
select 'Business Note', 'South Lafourche Bank', 'Term Loan', 53088.50, 0,
       816.60, 8.62, 'Principal + Interest', 'Active'
where not exists (
  select 1 from public.loans where loan_name = 'Business Note'
);


-- ------------------------------------------------------------
-- RECURRING MONTHLY EXPENSES (cash obligations)
-- ------------------------------------------------------------
insert into public.cash_obligations (
  obligation_name, category, amount, recurring, frequency, status, notes
)
select v.name, v.category, v.amount, true, 'Monthly', 'Pending',
       'Recurring monthly expense. Set the due date as needed.'
from (values
  ('Rent',      'Rent/Lease', 2811::numeric),
  ('Electric',  'Utility',    2200::numeric),
  ('Trash',     'Utility',     265::numeric),
  ('Gas',       'Utility',     135::numeric),
  ('Marketing', 'Other',       800::numeric)
) as v(name, category, amount)
where not exists (
  select 1 from public.cash_obligations o where o.obligation_name = v.name
);


-- ------------------------------------------------------------
-- RECEIVABLES — single placeholder
-- ------------------------------------------------------------
insert into public.receivables (customer_name, amount, amount_paid, status, notes)
select 'Unknown', 5000, 0, 'Open',
       'Placeholder — replace with individual customer invoices later.'
where not exists (
  select 1 from public.receivables where customer_name = 'Unknown'
);


-- ------------------------------------------------------------
-- BUSINESS SETTINGS (operating targets + wholesale average)
-- ------------------------------------------------------------
insert into public.business_settings (setting_key, label, value, unit, notes)
select v.k, v.l, v.val, v.unit, v.notes
from (values
  ('target_payroll_pct',       'Target Payroll Percentage',      15::numeric,    'percent',
   'Payroll should stay at or below this share of sales.'),
  ('warning_payroll_pct',      'Warning Payroll Percentage',     16::numeric,    'percent',
   'Payroll above this share of sales triggers a warning.'),
  ('min_cash_reserve',         'Target Minimum Cash Reserve',    15000::numeric, 'currency',
   'Keep at least this much cash on hand.'),
  ('preferred_weekly_sales',   'Preferred Weekly Sales',         18000::numeric, 'currency',
   'Weekly sales goal.'),
  ('minimum_weekly_sales',     'Minimum Weekly Sales',           17000::numeric, 'currency',
   'Weekly sales floor to stay healthy.'),
  ('avg_monthly_wholesale',    'Average Monthly Wholesale Sales', 6000::numeric, 'currency',
   'Typical monthly wholesale revenue.')
) as v(k, l, val, unit, notes)
where not exists (
  select 1 from public.business_settings b where b.setting_key = v.k
);

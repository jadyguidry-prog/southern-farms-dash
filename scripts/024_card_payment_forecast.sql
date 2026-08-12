-- Show a card payoff as money leaving on its due date, so a known five-figure
-- obligation stops being invisible to the cash forecast.
--
-- Additive only. No row is deleted, no balance is changed, no history is removed.
--
-- The problem: card purchases are (correctly) not cash events -- the cash leaves later,
-- when the card is paid from checking. But the forecast only ever saw those payoffs as
-- part of a MEDIAN weekly outflow, spread evenly across every day. Payoffs land once a
-- month, so the median week barely contains one: measured on the live ledger, excluding
-- them moves the median weekly outflow by only $705.24 of a $9,948.13 obligation.
-- The result was a forecast that charged a small daily fiction and nothing at all on the
-- day the money actually goes.
--
-- Live consequence on 2026-08-04: $9,948.13 falls due 2026-08-18. Nothing in the app
-- showed it, and it takes the cautious projection to $7,538.88 -- well under the
-- $15,000 reserve.

-- 1. How to recognise this account's payoffs in the ledger.
--
--    NULLABLE with no default. This is the text that identifies a payment TO this
--    account when it appears on an operating account, so those rows can be removed from
--    the estimated baseline once the payoff is modelled explicitly on its due date.
--    Leaving them in both places would charge the same money twice.
--
--    Why a stored column rather than a rule in code: the pattern is a fact about how
--    this bank labels this account, not a business rule, and it must be inspectable and
--    correctable without a deploy. A hardcoded regex would also be invisible when wrong.
--
--    NULL is meaningful and safe: it means "payoffs cannot be identified for this
--    account", and the engine then leaves the baseline untouched rather than guessing.
--    That is the conservative direction -- it keeps the historical smear instead of
--    silently removing real outflow.
alter table bank_accounts
  add column if not exists payment_description_match text;

comment on column bank_accounts.payment_description_match is
  'Case-insensitive substring that identifies a PAYMENT TO this account as it appears in financial_transactions.description on an operating account (e.g. "AMEX EPAYMENT"). Used to remove historical payoffs from the estimated spending baseline once the payoff is forecast explicitly on its statement due date, so the same money is not counted twice. NULL means payoffs cannot be identified for this account: the baseline is then left as-is, which keeps the old averaged behaviour rather than guessing. Must be specific enough not to catch unrelated rows -- "AXP" is NOT usable here because it also matches the IRS descriptor "USATAXPYMT".';

-- 2. Seed the Amex card from observed data.
--
--    Not invented: all ten payoffs in the ledger are labelled "AMEX EPAYMENT ACH PMT
--    <ref>", one per month, on the 19th-22nd. The trailing reference changes every
--    month, so the stable part is the prefix.
--
--    Verified this matcher hits exactly those 10 rows and nothing else. An earlier
--    attempt using "AXP" silently also matched every "IRS USATAXPYMT" row and inflated
--    apparent card spending by ~50 payments -- hence the specificity requirement above.
update bank_accounts
   set payment_description_match = 'AMEX EPAYMENT'
 where account_name = 'American Express ending 0-73009'
   and payment_description_match is null;

-- 3. How far ahead the cash forecast looks.
--
--    A setting, not a constant, because the right horizon depends on this business's
--    billing rhythm. The old projection was fixed at 7 days, which could not see a
--    statement due on day 14 no matter how large it was.
--
--    30 days covers a full statement cycle. The engine still extends the window when a
--    known dated obligation falls beyond it, because a horizon that stops just short of
--    a known five-figure payment is the exact failure being fixed here.
insert into business_settings (setting_key, label, value, unit, notes)
select
  'cash_forecast_horizon_days',
  'Cash Forecast Horizon (days)',
  '30',
  'days',
  'How many days ahead the cash forecast projects when looking for the low point. Must be long enough to include a card statement due date, or a large known payment stays invisible until it lands. The forecast automatically extends past this when a dated obligation falls beyond it. Raise it to plan further out; lower it for a tighter near-term view.'
where not exists (
  select 1 from business_settings where setting_key = 'cash_forecast_horizon_days'
);

-- 4. How much of the window counts as "this week" for the spendable headline.
--
--    Kept separate from the horizon on purpose. "Safe to spend today" answers a
--    near-term question, and stretching it across a whole month would collapse it to $0
--    permanently on any business whose cautious weeks run negative -- which this one
--    does (-$1,703/week at the lower quartile). A permanently-$0 headline is ignorable,
--    and an ignorable warning is worthless on the day it matters.
--
--    So the headline stays near-term and the reserve breach is reported over the full
--    horizon, with both standards stated wherever either number appears.
insert into business_settings (setting_key, label, value, unit, notes)
select
  'cash_near_term_days',
  'Spendable Window (days)',
  '7',
  'days',
  'The near-term window used for the "safe to spend" headline. Deliberately shorter than the forecast horizon: the headline answers "what can I spend now", while the reserve warning looks across the full horizon so a payment due later this month is still flagged.'
where not exists (
  select 1 from business_settings where setting_key = 'cash_near_term_days'
);

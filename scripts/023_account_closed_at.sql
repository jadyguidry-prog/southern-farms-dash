-- Mark an account as closed, so a card that no longer exists stops demanding
-- statement imports it will never receive.
--
-- Additive only. No row is deleted, no balance is changed, and no history is removed.
--
-- Why this is needed: card 0-72001 was replaced in December 2025. Its spending feed
-- correctly stopped, so the staleness engine reported it as months behind and told the
-- owner to "import the latest statement" for a card that cannot produce one. That is
-- noise, and noise is what trains someone to ignore a real alert — the same real alert
-- that hid $3.3k-$11.2k/month of card spending in the first place.

-- 1. The column.
--
--    NULLABLE with NO default, and it stores a DATE rather than a boolean. Null means
--    "open", which is the correct default for every existing row. A date also answers
--    "when", which a boolean cannot, and lets a reader tell a card closed last week
--    from one closed last year.
--
--    Deliberately NOT called `is_active`: the table already has an `is_active` flag
--    used elsewhere, and overloading it would change the meaning of existing reads.
alter table bank_accounts
  add column if not exists closed_at date;

comment on column bank_accounts.closed_at is
  'Date the account was closed. NULL means the account is open. A closed account KEEPS its balance and its transaction history and still counts toward money owed -- a closed card can carry a balance -- but it is excluded from data-freshness alerts, because no further statements will ever arrive. Never infer closure from a nickname or from an absence of recent transactions; a quiet card is not a closed card.';

-- 2. Close the replaced Amex.
--
--    Scoped by exact account_name so no other row can be caught by a stray match.
--    The date is the last transaction actually recorded on the card, which is the
--    last day it is known to have been in use. It is NOT invented: if the true
--    closure date differs, correcting this one column is safe and changes nothing else.
--
--    Its $1,946 apparent overpayment is intentionally left untouched and still
--    reported. The owner does not yet know whether that reflects a balance carried in
--    from before the imported history or genuinely missing December transactions, so
--    the reconciliation note continues to state both possibilities rather than
--    silently picking one.
update bank_accounts
   set closed_at = '2025-12-27'
 where account_name = 'American Express ending 0-72001'
   and closed_at is null;

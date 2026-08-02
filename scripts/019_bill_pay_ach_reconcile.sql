-- Bill Pay: automatic reconciliation of autopay/ACH bills from the checking feed.
--
-- Recurring bills whose cash_obligations.payment_method = 'ACH' are matched to the
-- bank debit that paid them and marked cleared on the ACTUAL posted date. Check
-- bills are unchanged (they keep the record-when-written + check-number flow).
--
-- No new columns are needed: the ACH/Check split already lives in
-- cash_obligations.payment_method, and the clearing link already lives in
-- obligation_payments.cleared_transaction_id.
--
-- The ONLY change here is a safety backstop. The auto-reconcile matcher already
-- refuses to consume a transaction that is already linked to a payment, but that
-- guard is application-level. This partial unique index makes the database itself
-- refuse to let one bank transaction clear two different bills, so a race between
-- a manual "confirm clear" and an auto-reconcile can never double-count.
--
-- Additive and safe: there are currently 0 payments, so no existing row can
-- violate it. Partial (WHERE ... is not null) so the many rows that are not yet
-- cleared are exempt and can all coexist.

create unique index if not exists obligation_payments_cleared_txn_uidx
  on public.obligation_payments (cleared_transaction_id)
  where cleared_transaction_id is not null;

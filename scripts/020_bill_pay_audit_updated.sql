-- Bill Pay: allow an 'updated' audit action.
--
-- Why: logging an invoice you will pay by check happens BEFORE the check is
-- written, so the check number is filled in later. That later write needs its own
-- audit action; the existing constraint permitted only created/cleared/uncleared/
-- voided, so recording the number would have failed the CHECK at runtime.
--
-- Strictly additive and reversible-by-nature: it only WIDENS the set of accepted
-- values. No rows are read, moved, or deleted, and every existing audit row stays
-- valid, so this cannot fail on existing data.
--
-- Safe to re-run.

alter table obligation_payment_audit
  drop constraint if exists obligation_payment_audit_action_check;

alter table obligation_payment_audit
  add constraint obligation_payment_audit_action_check
  check (action = any (array['created', 'cleared', 'uncleared', 'voided', 'updated']));

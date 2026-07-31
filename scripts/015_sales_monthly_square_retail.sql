-- Adds the Square retail/wholesale split to sales_monthly.
--
-- Why this is needed: sales_monthly already had square_net_sales, but net sales
-- bundles retail AND wholesale together (for 2026-06: retail 70,521.14 +
-- wholesale 8,571.89 = net 79,093.03). The reported `retail` column is retail
-- only, so there was no column anywhere holding a Square figure that could be
-- compared with, or promoted into, `retail`.
--
-- That gap is the whole reason a bank-deposit estimate was reported for nine
-- months while Square's own daily records for those months existed all along:
-- resolveFinal() could only choose between `calculated_*` and `manual_*`, and
-- Square simply had no seat at the table.
--
-- Additive and reversible: new nullable columns only. Nothing is dropped,
-- renamed, or backfilled, so every existing month reads exactly as before until
-- the owner approves a correction month by month. A NULL here means "Square has
-- no figure for this month", which is deliberately different from 0.

ALTER TABLE sales_monthly
  ADD COLUMN IF NOT EXISTS square_retail NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS square_wholesale NUMERIC(12, 2);

COMMENT ON COLUMN sales_monthly.square_retail IS
  'Retail sales for the month from Square daily records. NULL means Square has no data for this month. Outranks calculated_retail but not manual_retail.';

COMMENT ON COLUMN sales_monthly.square_wholesale IS
  'Wholesale sales for the month from Square daily records. NULL means Square has no data for this month.';

-- Records which months the owner has explicitly approved correcting to Square,
-- so a restatement of past revenue is always attributable and reversible.
CREATE TABLE IF NOT EXISTS sales_source_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_monthly_id UUID REFERENCES sales_monthly (id) ON DELETE CASCADE,
  month_key TEXT NOT NULL,
  previous_retail NUMERIC(12, 2),
  previous_source TEXT,
  new_retail NUMERIC(12, 2),
  new_source TEXT,
  difference NUMERIC(12, 2),
  actor_email TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sales_source_corrections_month_idx
  ON sales_source_corrections (month_key);

ALTER TABLE sales_source_corrections ENABLE ROW LEVEL SECURITY;

-- Access model follows the existing convention (policies named <table>_select /
-- _insert, scoped to `authenticated` with a `true` predicate -- this is a single
-- business with one shared set of books, so there is no per-user ownership).
--
-- Deliberate deviation: no _update or _delete policy. Every other table here has
-- all four, but this one is an append-only audit of revenue restatements. If a
-- correction row could be edited or removed, it would no longer be evidence of
-- what was changed. Corrections are reversed by recording a new row, not by
-- rewriting history.
DROP POLICY IF EXISTS sales_source_corrections_select ON sales_source_corrections;
CREATE POLICY sales_source_corrections_select
  ON sales_source_corrections FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS sales_source_corrections_insert ON sales_source_corrections;
CREATE POLICY sales_source_corrections_insert
  ON sales_source_corrections FOR INSERT
  TO authenticated
  WITH CHECK (true);

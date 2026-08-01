/**
 * Checks for the sales-tax review derivation.
 *
 * Sales tax is money collected for the state, so it is neither revenue nor an
 * expense. These checks pin the detection, the arithmetic, and — most
 * importantly — that the recommended treatment is the one which keeps cash flow
 * reconciling to the bank export.
 *
 * Run: npx tsx scripts/verify-sales-tax-review.ts
 */
import {
  isSalesTaxCategory,
  deriveSalesTaxReview,
  SALES_TAX_PASS_THROUGH_CATEGORY,
  type SalesTaxRow,
} from '../lib/sales-tax-review'
import { createClient } from '@supabase/supabase-js'

let pass = 0
let fail = 0
const failures: string[] = []

function eq<T>(actual: T, expected: T, label: string) {
  if (actual === expected) pass++
  else {
    fail++
    failures.push(`${label}: expected ${String(expected)}, got ${String(actual)}`)
  }
}
function ok(cond: boolean, label: string) {
  if (cond) pass++
  else {
    fail++
    failures.push(label)
  }
}
function approx(actual: number, expected: number, tol: number, label: string) {
  if (Math.abs(actual - expected) <= tol) pass++
  else {
    fail++
    failures.push(`${label}: expected ~${expected} (±${tol}), got ${actual}`)
  }
}

const row = (o: Partial<SalesTaxRow> & { id: string }): SalesTaxRow => ({
  transactionDate: '2025-09-17',
  amount: 100,
  description: 'LA DEPT OF REVENUE',
  expenseCategory: 'State Sales Tax',
  reviewStatus: '',
  transactionType: 'expense',
  ...o,
})

// ---------- detection ----------

ok(isSalesTaxCategory('State Sales Tax'), 'detect: the category actually in use')
ok(isSalesTaxCategory('sales tax'), 'detect: lowercase')
ok(isSalesTaxCategory('Sales & Use Tax'), 'detect: ampersand form')
ok(isSalesTaxCategory('Sales and Use Tax'), 'detect: spelled-out and')
ok(isSalesTaxCategory('  Sales  Tax  '), 'detect: tolerant of extra spacing')
ok(isSalesTaxCategory(SALES_TAX_PASS_THROUGH_CATEGORY), 'detect: the reclassified name is still recognised')
ok(!isSalesTaxCategory(''), 'detect: empty is not sales tax')
ok(!isSalesTaxCategory('Payroll Taxes'), 'detect: payroll tax is a REAL expense, not sales tax')
ok(!isSalesTaxCategory('Property Tax'), 'detect: property tax is a real expense')
ok(!isSalesTaxCategory('Taxes'), 'detect: a bare "Taxes" is too vague to assume')

// ---------- empty case ----------

eq(deriveSalesTaxReview([]), null, 'derive: no rows yields no card')
eq(
  deriveSalesTaxReview([row({ id: 'a', expenseCategory: 'Payroll Taxes' })]),
  null,
  'derive: unrelated categories yield no card',
)
eq(
  deriveSalesTaxReview([row({ id: 'a', reviewStatus: 'excluded' })]),
  null,
  'derive: already-excluded rows are not an open question',
)

// ---------- grouping and arithmetic ----------

const g = deriveSalesTaxReview([
  row({ id: 'b', transactionDate: '2026-06-25', amount: 700.5 }),
  row({ id: 'a', transactionDate: '2025-09-17', amount: 300.25 }),
  row({ id: 'c', transactionDate: '2026-01-02', amount: -100, description: 'LDR PAYMENT' }),
  row({ id: 'd', reviewStatus: 'excluded', amount: 9999 }),
])
ok(g !== null, 'derive: returns a group when open rows exist')
if (g) {
  eq(g.count, 3, 'derive: excluded row omitted from the count')
  approx(g.totalAmount, 1100.75, 0.001, 'derive: total uses absolute values')
  eq(g.firstDate, '2025-09-17', 'derive: earliest date')
  eq(g.lastDate, '2026-06-25', 'derive: latest date')
  eq(g.rows[0].id, 'a', 'derive: rows sorted oldest first')
  eq(g.payees.length, 2, 'derive: distinct payees listed')
  eq(g.currentCategories.join('|'), 'State Sales Tax', 'derive: reports the category in use today')

  // The recommendation is the safety-critical part.
  eq(g.treatments.length, 2, 'derive: exactly two treatments offered')
  const rec = g.treatments.filter((t) => t.recommended)
  eq(rec.length, 1, 'derive: exactly one recommendation')
  eq(rec[0].kind, 'reclassify', 'derive: RECLASSIFY is recommended, not exclude')
  eq(
    rec[0].category,
    SALES_TAX_PASS_THROUGH_CATEGORY,
    'derive: recommended treatment names the pass-through category',
  )
  const exc = g.treatments.find((t) => t.kind === 'exclude')
  eq(exc?.category, null, 'derive: exclude applies no category')
  ok(
    /no longer match the bank statement/i.test(exc?.rationale ?? ''),
    'derive: exclude warns that cash out stops matching the bank',
  )

  // Impact statements must state the real amount, not a placeholder.
  ok(g.expenseImpact.includes('1,100.75'), 'derive: expense impact states the actual total')
  ok(g.cashFlowImpact.includes('1,100.75'), 'derive: cash flow impact states the actual total')
  ok(
    /no change if reclassified/i.test(g.cashFlowImpact),
    'derive: cash flow impact leads with the fact that reclassifying is safe',
  )
  ok(
    /not cost of goods/i.test(g.grossProfitImpact),
    'derive: gross profit impact explains why COGS does not move',
  )
  eq(g.count, g.rows.length, 'derive: count always matches the rows shown')
}

// ---------- singular wording ----------

const one = deriveSalesTaxReview([row({ id: 'a', amount: 50 })])
ok(
  one !== null && / 1 payment\b/.test(one.expenseImpact),
  'derive: one row reads "1 payment", not "1 payments"',
)

// ---------- live data ----------

async function live() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log('  (live checks skipped — no credentials)')
    return
  }
  const db = createClient(url, key)
  const rows: SalesTaxRow[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('financial_transactions')
      .select(
        'id, transaction_date, description, normalized_description, amount, expense_category, review_status, transaction_type, deleted_at',
      )
      .range(from, from + 999)
    if (error) {
      console.log('  (live checks skipped —', error.message, ')')
      return
    }
    const batch = data ?? []
    for (const r of batch) {
      if (r.deleted_at) continue
      rows.push({
        id: String(r.id),
        transactionDate: String(r.transaction_date ?? '').slice(0, 10),
        amount: Math.abs(Number(r.amount) || 0),
        description: String(r.description ?? r.normalized_description ?? ''),
        expenseCategory: String(r.expense_category ?? '').trim(),
        reviewStatus: String(r.review_status ?? '').trim(),
        transactionType: String(r.transaction_type ?? '').trim(),
      })
    }
    if (batch.length < 1000) break
  }

  const group = deriveSalesTaxReview(rows)
  if (!group) {
    // Legitimate once the owner has acted on it.
    ok(true, 'live: no sales tax sitting in expenses (already handled)')
    return
  }
  ok(group.count > 0, 'live: sales tax group has rows')
  ok(group.totalAmount > 0, 'live: sales tax total is positive')
  const direct = rows
    .filter((r) => isSalesTaxCategory(r.expenseCategory) && r.reviewStatus !== 'excluded')
    .reduce((s, r) => s + r.amount, 0)
  approx(group.totalAmount, direct, 0.01, 'live: group total reconciles with a direct sum')
  eq(
    group.rows.filter((r) => r.reviewStatus === 'excluded').length,
    0,
    'live: no already-excluded row is presented as open',
  )
  ok(
    group.treatments.find((t) => t.recommended)?.kind === 'reclassify',
    'live: reclassify remains the recommended treatment',
  )
}

live()
  .catch((e) => {
    fail++
    failures.push(`live checks threw: ${e instanceof Error ? e.message : String(e)}`)
  })
  .finally(() => {
    console.log(`sales-tax review: ${pass} passed, ${fail} failed`)
    for (const f of failures) console.log('  FAIL ', f)
    if (fail > 0) process.exit(1)
  })

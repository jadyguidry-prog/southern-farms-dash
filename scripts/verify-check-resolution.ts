/**
 * Verification for the CHECK resolution overlay —
 *   npx tsx --env-file=.env.development.local scripts/verify-check-resolution.ts
 *
 * The failures that matter here are the ones that would look authoritative while
 * being wrong: a margin quoted while $292K of checks have no payee, a resolution
 * silently overwriting the bank export so the original can never be recovered, a
 * partial month's sales dividing a full month's costs into a flattering
 * percentage, an undo that half-restores, and a "monthly" cadence label pinned on
 * a set of dates with no rhythm at all. Each has a test.
 */

import {
  parseCheckNumber,
  summarizeChecks,
  findCheckSequences,
  describeCadence,
  suggestCheckGroups,
  checkResolutionProgress,
  type CheckRow,
  type CheckResolution,
} from '../lib/check-review'
import {
  isCogsCategory,
  deriveMonthlyCogs,
  grossProfitReadiness,
} from '../lib/check-resolution-service'
import { generateInsights, payrollHealth, type CheckInsightInput } from '../lib/health'
import { SETTING_DEFAULTS } from '../lib/queries'
import { createClient } from '@supabase/supabase-js'

let pass = 0
let fail = 0
const failures: string[] = []

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else {
    fail++
    failures.push(`${label}: expected ${e}, got ${a}`)
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

const row = (o: Partial<CheckRow> & { id: string }): CheckRow => ({
  transactionDate: '2026-01-15',
  amount: 100,
  checkNumber: null,
  description: 'CHECK',
  accountName: 'Operating',
  expenseCategory: '',
  vendorId: null,
  reviewStatus: '',
  ...o,
})

const res = (o: Partial<CheckResolution> & { financialTransactionId: string }): CheckResolution => ({
  checkNumber: null,
  resolvedPayee: 'Voirons',
  resolvedVendorId: null,
  resolvedCategory: 'Meat / COGS',
  memo: null,
  businessPurpose: null,
  reviewStatus: 'approved',
  confidence: null,
  resolutionSource: 'manual',
  reviewedBy: null,
  reviewedAt: null,
  bulkActionId: null,
  ...o,
})

// ---------- check number parsing ----------

eq(parseCheckNumber('CHECK # 1317'), '1317', 'parse: spaced hash form')
eq(parseCheckNumber('CHECK 1317'), '1317', 'parse: bare number form')
eq(parseCheckNumber('CHECK'), null, 'parse: unnumbered check yields null, not a guess')
eq(parseCheckNumber('CHECKCARD PURCHASE 1234'), null, 'parse: debit-card line is NOT a paper check')

// ---------- COGS matching ----------

for (const c of ['Meat / COGS', 'Food / COGS', 'Inventory / COGS', 'Bakery / COGS', 'COGS']) {
  ok(isCogsCategory(c), `cogs: "${c}" counts as cost of goods`)
}
for (const c of ['Operating Supplies', 'Payroll', 'Utilities', '', '   ']) {
  ok(!isCogsCategory(c), `cogs: "${c}" is NOT cost of goods`)
}
// Guard against a substring false positive.
ok(!isCogsCategory('Incognito Services'), 'cogs: "cogs" inside another word does not match')

// ---------- cadence ----------

eq(describeCadence(['2026-01-01', '2026-01-08']), null, 'cadence: two dates is one interval, not a rhythm')

const weekly = describeCadence(['2026-01-01', '2026-01-08', '2026-01-15', '2026-01-22'])
eq(weekly?.label, 'weekly', 'cadence: 7-day gaps read as weekly')
ok(weekly?.regular === true, 'cadence: consistent weekly gaps are regular')

/*
 * The real $2,677.50 pattern: monthly with a single long interruption. An
 * earlier spread-based rule called this "irregular" and buried an $18.7K group,
 * so this pins the corrected behaviour.
 */
const paused = describeCadence([
  '2025-05-01', '2025-05-29', '2025-07-03', '2025-07-31',
  '2025-09-02', '2025-10-02', '2026-01-25',
])
eq(paused?.label, 'monthly', 'cadence: a paused monthly pattern is still monthly')
ok(paused?.regular === true, 'cadence: one long pause does not disqualify a rhythm')
ok((paused?.breakCount ?? 0) >= 1, 'cadence: the pause is reported rather than hidden')

const scattered = describeCadence(['2026-01-01', '2026-01-03', '2026-02-20', '2026-06-01'])
eq(scattered?.label, 'irregular', 'cadence: scattered dates are not given a rhythm label')
ok(scattered?.regular === false, 'cadence: scattered dates are not called regular')

// Median, not mean: one huge gap must not drag the label.
const medianHeld = describeCadence(['2026-01-01', '2026-01-08', '2026-01-15', '2026-06-30'])
eq(medianHeld?.label, 'weekly', 'cadence: median resists a single outlier gap')

// ---------- sequences ----------

const seqRows = [
  row({ id: 'a', checkNumber: '1000', transactionDate: '2026-01-05', amount: 10 }),
  row({ id: 'b', checkNumber: '1001', transactionDate: '2026-01-05', amount: 20 }),
  row({ id: 'c', checkNumber: '1002', transactionDate: '2026-01-05', amount: 30 }),
  // Gap at 1003 — a likely void or missing row, so the run must break here.
  row({ id: 'd', checkNumber: '1004', transactionDate: '2026-02-05', amount: 40 }),
  row({ id: 'e', checkNumber: '1005', transactionDate: '2026-02-06', amount: 50 }),
]
const seqs = findCheckSequences(seqRows, { minLength: 2 })
eq(seqs.length, 2, 'sequence: a gap splits the run rather than bridging it')
// Ordered by DOLLARS, not by length — the same rule clusters use, because the
// point of the ordering is to move the most money first, not the most rows.
eq(seqs[0].checkNumbers, ['1004', '1005'], 'sequence: highest-value run first')
eq(seqs[0].total, 90, 'sequence: total sums the run')
eq(seqs[1].checkNumbers, ['1000', '1001', '1002'], 'sequence: the run before the gap is kept intact')
eq(seqs[1].total, 60, 'sequence: split run totals only its own members')
ok(seqs[1].sameDay === true, 'sequence: same-day run is flagged')
ok(seqs[0].sameDay === false, 'sequence: run spanning days is not flagged same-day')

// ---------- suggestions and confidence ----------

const clusterRows: CheckRow[] = [
  ...['2025-05-01', '2025-05-29', '2025-07-03', '2025-07-31', '2025-09-02'].map((d, i) =>
    row({ id: `m${i}`, amount: 2677.5, transactionDate: d, checkNumber: String(2000 + i) }),
  ),
  // Two identical amounts with no rhythm — a coincidence, not an arrangement.
  row({ id: 'x1', amount: 999.99, transactionDate: '2025-05-02' }),
  row({ id: 'x2', amount: 999.99, transactionDate: '2026-04-17' }),
]
const suggestions = suggestCheckGroups(clusterRows)
const monthlyCluster = suggestions.find((s) => s.key === 'amount:2677.50')
ok(monthlyCluster != null, 'suggest: repeating amount produces a cluster')
eq(monthlyCluster?.confidence, 'high', 'suggest: repeating amount + regular cadence is high confidence')
const coincidence = suggestions.find((s) => s.key === 'amount:999.99')
ok(
  coincidence == null || coincidence.confidence === 'low',
  'suggest: two identical amounts far apart are never high confidence',
)
ok(
  suggestions.every((s) => !/payee|paid to/i.test(s.label)),
  'suggest: no suggestion invents a payee name — the export has none',
)

// ---------- progress ----------

const progRows = [
  row({ id: 'p1', amount: 1000 }),
  row({ id: 'p2', amount: 500 }),
  row({ id: 'p3', amount: 250 }),
]
const prog = checkResolutionProgress(
  progRows,
  [
    res({ financialTransactionId: 'p1', resolvedCategory: 'Meat / COGS' }),
    res({ financialTransactionId: 'p2', resolvedCategory: 'Operating Supplies' }),
    // Pending must not count as resolved.
    res({ financialTransactionId: 'p3', reviewStatus: 'pending' }),
  ],
  isCogsCategory,
)
eq(prog.resolvedCount, 2, 'progress: only approved resolutions count')
eq(prog.resolvedAmount, 1500, 'progress: resolved dollars sum approved rows')
eq(prog.pendingCount, 1, 'progress: pending count excludes approved')
eq(prog.pendingAmount, 250, 'progress: pending dollars exclude approved')
eq(prog.cogsCount, 1, 'progress: only COGS-categorized resolutions count toward COGS')
eq(prog.cogsAmount, 1000, 'progress: non-COGS resolution adds no COGS dollars')
approx(prog.resolvedPctOfAmount, (1500 / 1750) * 100, 0.01, 'progress: percentage is of DOLLARS not count')

// ---------- monthly COGS overlay ----------

const txns = [
  { id: 't1', transactionDate: '2026-06-03', amount: 30000, expenseCategory: 'Meat / COGS', isCheck: false },
  { id: 't2', transactionDate: '2026-06-10', amount: 3425.66, expenseCategory: 'Food / COGS', isCheck: false },
  { id: 't3', transactionDate: '2026-06-15', amount: 5000, expenseCategory: 'Operating Supplies', isCheck: false },
  { id: 'c1', transactionDate: '2026-06-20', amount: 20000, expenseCategory: '', isCheck: true },
  { id: 'c2', transactionDate: '2026-06-25', amount: 28964, expenseCategory: '', isCheck: true },
]
const sales = new Map([['2026-06', { netSales: 79093.03, complete: true }]])

const noRes = deriveMonthlyCogs(txns, [], sales)
approx(noRes[0].baseCogs, 33425.66, 0.01, 'monthly: base COGS excludes non-COGS categories')
approx(noRes[0].unresolvedCheckAmount, 48964, 0.01, 'monthly: unattributed checks are tracked, not ignored')
eq(noRes[0].resolvedCheckCogs, 0, 'monthly: nothing resolved means no check COGS')
approx(noRes[0].totalCogs, 33425.66, 0.01, 'monthly: total equals base when no checks resolved')

const withCogs = deriveMonthlyCogs(
  txns,
  [res({ financialTransactionId: 'c1', resolvedCategory: 'Meat / COGS' })],
  sales,
)
approx(withCogs[0].resolvedCheckCogs, 20000, 0.01, 'monthly: resolved check adds to COGS')
approx(withCogs[0].totalCogs, 53425.66, 0.01, 'monthly: total folds in resolved check COGS')
approx(withCogs[0].unresolvedCheckAmount, 28964, 0.01, 'monthly: resolving one check shrinks the unknown')

// A check resolved to a non-COGS category is answered but adds no COGS.
const withNonCogs = deriveMonthlyCogs(
  txns,
  [res({ financialTransactionId: 'c1', resolvedCategory: 'Owner Draw' })],
  sales,
)
eq(withNonCogs[0].resolvedCheckCogs, 0, 'monthly: non-COGS resolution adds no COGS')
approx(
  withNonCogs[0].unresolvedCheckAmount,
  28964,
  0.01,
  'monthly: non-COGS resolution still removes the check from the unknown',
)

// A month with sales but zero COGS must still appear — that gap is the finding.
const gapMonths = deriveMonthlyCogs(
  [],
  [],
  new Map([['2025-07', { netSales: 50000, complete: true }]]),
)
eq(gapMonths.length, 1, 'monthly: a sales-only month is not dropped')
eq(gapMonths[0].baseCogs, 0, 'monthly: sales-only month reports zero COGS')
ok(gapMonths[0].salesComplete === true, 'monthly: completeness verdict is carried through')

// ---------- readiness gate ----------

const blocked = grossProfitReadiness(noRes, 48964)
ok(!blocked.ready, 'readiness: a margin is withheld while checks dwarf known COGS')
approx(blocked.unresolvedVsCogsRatio ?? 0, 48964 / 33425.66, 0.01, 'readiness: ratio is unresolved ÷ identified COGS')
ok(/no margin is shown/i.test(blocked.reason), 'readiness: reason states plainly that no margin is shown')

const clearedMonths = deriveMonthlyCogs(
  txns,
  [
    res({ financialTransactionId: 'c1', resolvedCategory: 'Meat / COGS' }),
    res({ financialTransactionId: 'c2', resolvedCategory: 'Meat / COGS' }),
  ],
  sales,
)
const cleared = grossProfitReadiness(clearedMonths, 0)
ok(cleared.ready, 'readiness: gate opens once every check is attributed')
approx(cleared.identifiedCogs, 82389.66, 0.01, 'readiness: identified COGS includes resolved checks')

// Just over tolerance must still block — the boundary is where a bug would hide.
const nearlyMonths = deriveMonthlyCogs(
  [
    ...txns.slice(0, 3),
    { id: 'c3', transactionDate: '2026-06-20', amount: 1800, expenseCategory: '', isCheck: true },
  ],
  [],
  sales,
)
ok(
  !grossProfitReadiness(nearlyMonths, 1800).ready,
  'readiness: 5.4% of COGS unresolved still blocks (just over the 5% tolerance)',
)
const withinMonths = deriveMonthlyCogs(
  [
    ...txns.slice(0, 3),
    { id: 'c4', transactionDate: '2026-06-20', amount: 1600, expenseCategory: '', isCheck: true },
  ],
  [],
  sales,
)
ok(
  grossProfitReadiness(withinMonths, 1600).ready,
  'readiness: 4.8% of COGS unresolved is within tolerance',
)

// ---------- advisor ----------

const checkInsight: CheckInsightInput = {
  pendingCount: 201,
  pendingAmount: 292487.68,
  resolvedCount: 0,
  resolvedPctOfAmount: 0,
  baseCogsAmount: 149197.85,
  unresolvedVsCogsRatio: 292487.68 / 149197.85,
  grossProfitReady: false,
  topClusters: [{ amount: 2677.5, count: 7, total: 18742.5, cadence: 'monthly' }],
  monthsMissingCogs: ['2025-07', '2025-08', '2026-02'],
}
const settings = { ...SETTING_DEFAULTS } as never
const pillars = {
  payroll: payrollHealth(0, SETTING_DEFAULTS as never),
  cash: { status: 'green', message: '' },
  sales: { status: 'green', message: '' },
} as never

const insights = generateInsights({ settings, pillars, checks: checkInsight })
const unresolved = insights.find((i) => i.id === 'auto-checks-unresolved')
ok(unresolved != null, 'advisor: unattributed checks raise an insight')
eq(unresolved?.severity, 'critical', 'advisor: unknown exceeding known COGS is critical')
ok(
  /overstating profit|overstated/i.test(unresolved?.detail ?? ''),
  'advisor: explains that profit would be overstated, not just that data is missing',
)
ok(
  insights.some((i) => i.id === 'auto-checks-clusters'),
  'advisor: points at the largest cluster as the fastest route',
)
const missing = insights.find((i) => i.id === 'auto-checks-months-missing-cogs')
ok(missing != null, 'advisor: months with sales but no COGS are raised')
ok(
  /categorization gap/i.test(missing?.detail ?? ''),
  'advisor: names it a categorization gap rather than implying no purchases',
)

// Below-parity ratio should warn rather than escalate.
const warnOnly = generateInsights({
  settings,
  pillars,
  checks: { ...checkInsight, pendingAmount: 40000, unresolvedVsCogsRatio: 0.27 },
})
eq(
  warnOnly.find((i) => i.id === 'auto-checks-unresolved')?.severity,
  'warning',
  'advisor: unresolved below parity with COGS warns rather than escalating',
)

// No checks at all must produce no check insights.
const none = generateInsights({ settings, pillars })
ok(
  !none.some((i) => i.id.startsWith('auto-checks-')),
  'advisor: no CHECK data produces no check insights rather than zeros',
)

// Fully resolved should acknowledge it.
const done = generateInsights({
  settings,
  pillars,
  checks: {
    ...checkInsight,
    pendingCount: 0,
    pendingAmount: 0,
    resolvedCount: 201,
    resolvedPctOfAmount: 100,
    grossProfitReady: true,
    topClusters: [],
    monthsMissingCogs: [],
  },
})
ok(
  done.some((i) => i.id === 'auto-checks-resolved'),
  'advisor: a cleared backlog is acknowledged',
)
ok(
  !done.some((i) => i.id === 'auto-checks-unresolved'),
  'advisor: cleared backlog raises no unresolved warning',
)

// ---------- live reconciliation ----------

async function reconcile() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log('\n(skipping live reconciliation — no credentials)')
    return
  }
  const db = createClient(url, key, { auth: { persistSession: false } })

  async function all<T>(table: string, cols: string): Promise<T[]> {
    const out: T[] = []
    let from = 0
    for (;;) {
      const { data, error } = await db.from(table).select(cols).range(from, from + 999)
      if (error) throw new Error(`${table}: ${error.message}`)
      out.push(...((data ?? []) as T[]))
      if (!data || data.length < 1000) break
      from += 1000
    }
    return out
  }

  type Txn = {
    id: string
    transaction_date: string
    description: string | null
    normalized_description: string | null
    amount: number | string | null
    expense_category: string | null
    check_number: string | null
  }
  const txnRows = await all<Txn>(
    'financial_transactions',
    'id, transaction_date, description, normalized_description, amount, expense_category, check_number',
  )

  const isCheck = (r: Txn) =>
    /^\s*CHECK\b/i.test(r.description ?? r.normalized_description ?? '')

  const prepared = txnRows.map((r) => ({
    id: r.id,
    transactionDate: (r.transaction_date ?? '').slice(0, 10),
    amount: Math.abs(Number(r.amount) || 0),
    expenseCategory: (r.expense_category ?? '').trim(),
    isCheck: isCheck(r),
  }))

  const liveChecks: CheckRow[] = txnRows.filter(isCheck).map((r) => ({
    id: r.id,
    transactionDate: (r.transaction_date ?? '').slice(0, 10),
    amount: Math.abs(Number(r.amount) || 0),
    checkNumber: r.check_number ?? parseCheckNumber(r.description ?? ''),
    description: r.description ?? '',
    accountName: '',
    expenseCategory: (r.expense_category ?? '').trim(),
    vendorId: null,
    reviewStatus: '',
  }))

  const months = deriveMonthlyCogs(prepared, [])
  const baseTotal = months.reduce((s, m) => s + m.baseCogs, 0)
  const unresolvedTotal = months.reduce((s, m) => s + m.unresolvedCheckAmount, 0)
  const directCogs = prepared
    .filter((t) => !t.isCheck && isCogsCategory(t.expenseCategory))
    .reduce((s, t) => s + t.amount, 0)
  const directChecks = liveChecks.reduce((s, r) => s + r.amount, 0)

  approx(baseTotal, directCogs, 0.01, 'live: monthly base COGS reconciles with a direct sum')
  approx(unresolvedTotal, directChecks, 0.01, 'live: unattributed check dollars reconcile with a direct sum')

  const summary = summarizeChecks(liveChecks)
  eq(summary.totalChecks, liveChecks.length, 'live: summary counts every check')
  approx(summary.totalAmount, directChecks, 0.01, 'live: summary dollars reconcile')

  const readiness = grossProfitReadiness(months, directChecks)
  ok(!readiness.ready, 'live: gross profit is currently withheld, as it should be')

  // The overlay must not have touched the source export.
  const categorizedChecks = liveChecks.filter((r) => r.expenseCategory.length > 0)
  eq(
    categorizedChecks.length,
    0,
    'live: no CHECK row has been written into expense_category — the export is untouched',
  )

  const { count: resCount } = await db
    .from('check_resolutions')
    .select('*', { count: 'exact', head: true })
  const { count: auditCount } = await db
    .from('check_resolution_audit')
    .select('*', { count: 'exact', head: true })
  ok(typeof resCount === 'number', 'live: check_resolutions table is readable')
  ok(typeof auditCount === 'number', 'live: check_resolution_audit table is readable')

  const clusters = suggestCheckGroups(liveChecks).filter((s) => s.kind === 'amount-cluster')
  ok(clusters.length > 0, 'live: real repeating amounts are detected')

  console.log(
    `\nLive data: ${liveChecks.length} checks, $${directChecks.toFixed(2)} unattributed against $${directCogs.toFixed(2)} categorized COGS (${(directChecks / directCogs).toFixed(2)}x).`,
  )
  console.log(`Resolutions on file: ${resCount ?? 0}. Audit entries: ${auditCount ?? 0}.`)
  console.log(`Top clusters: ${clusters.slice(0, 3).map((c) => `${c.count}x $${(c.total / c.count).toFixed(2)}`).join(', ')}.`)
  console.log(`Readiness: ${readiness.reason}`)
}

reconcile()
  .catch((e) => {
    fail++
    failures.push(`db reconciliation threw: ${e instanceof Error ? e.message : String(e)}`)
  })
  .finally(() => {
    console.log(`\n${pass} passed, ${fail} failed`)
    if (failures.length > 0) {
      console.log('\nFailures:')
      for (const f of failures) console.log(`  - ${f}`)
      process.exit(1)
    }
  })

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
  checkResolvedVia,
  type CheckRow,
  type CheckResolution,
} from '../lib/check-review'
import {
  isCogsCategory,
  deriveMonthlyCogs,
  grossProfitReadiness,
  marginWithheldReason,
  marginWithheldLabel,
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

// ---------- resolution routes ----------
// A check is answered by any of three routes. These pin each one, and pin that
// they are mutually exclusive, so the page can never re-ask an answered check.

eq(
  checkResolvedVia(row({ id: 'r1', expenseCategory: '', reviewStatus: '' }), undefined),
  'unresolved',
  'route: no category, not excluded, no overlay -> unresolved',
)
eq(
  checkResolvedVia(row({ id: 'r2', expenseCategory: 'COGS', reviewStatus: '' }), undefined),
  'categorized',
  'route: a ledger category alone resolves a check',
)
eq(
  checkResolvedVia(row({ id: 'r3', expenseCategory: '', reviewStatus: 'excluded' }), undefined),
  'excluded',
  'route: excluded resolves a check even with no category',
)
eq(
  checkResolvedVia(
    row({ id: 'r4', expenseCategory: 'COGS', reviewStatus: '' }),
    res({ financialTransactionId: 'x', resolvedCategory: 'Meat / COGS' }),
  ),
  'overlay',
  'route: an explicit resolution outranks a bulk-applied category',
)
eq(
  checkResolvedVia(row({ id: 'r5', expenseCategory: '   ', reviewStatus: '  ' }), undefined),
  'unresolved',
  'route: whitespace-only category is not a resolution',
)

// Excluded dollars must never reach COGS, even if a category was left behind.
const exProg = checkResolutionProgress(
  [
    row({ id: 'e1', amount: 800, expenseCategory: 'Meat / COGS', reviewStatus: 'excluded' }),
    row({ id: 'e2', amount: 200, expenseCategory: 'Meat / COGS', reviewStatus: '' }),
  ],
  [],
  isCogsCategory,
)
eq(exProg.excludedCount, 1, 'progress: excluded check counted as excluded')
eq(exProg.excludedAmount, 800, 'progress: excluded dollars tracked separately')
eq(exProg.categorizedCount, 1, 'progress: categorized check counted as categorized')
eq(exProg.cogsAmount, 200, 'progress: an EXCLUDED check never adds COGS dollars')
eq(exProg.pendingCount, 0, 'progress: neither check is still an open question')
eq(
  exProg.overlayAmount + exProg.categorizedAmount + exProg.excludedAmount + exProg.pendingAmount,
  1000,
  'progress: buckets partition total dollars',
)

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

// ---------- bank-data guard ----------
//
// The failure this prevents: a month where only a CARD statement was imported has
// full Square sales but a fragment of the real spend, so the margin computes to
// ~99% and reads as a spectacular month rather than as missing data. This was
// live — Jan/Feb/Mar 2026 showed 90.9%/99.9%/95.5% against $62–$5,557 of COGS.

const bankMap = new Map([['2026-06', true]])
const cardOnlyMap = new Map([['2026-06', false]])

// Baseline: with bank data present and every check attributed, a margin IS quoted.
// Asserted first, because a guard that blocks everything would also pass the
// negative tests below while being useless.
const quotableClean = deriveMonthlyCogs(
  txns.slice(0, 3),
  [],
  sales,
  bankMap,
)
ok(quotableClean[0].quotable, 'bank guard: a complete month with bank data is quotable')
eq(quotableClean[0].withheldReason, null, 'bank guard: nothing withheld on a clean month')
approx(
  quotableClean[0].marginPct ?? 0,
  ((79093.03 - 33425.66) / 79093.03) * 100,
  0.01,
  'bank guard: margin is sales less COGS over sales',
)

// The real-data shape: sales present, bank data absent, COGS a thin fragment.
const cardOnly = deriveMonthlyCogs(
  [{ id: 'x1', transactionDate: '2026-06-05', amount: 62.51, expenseCategory: 'Meat / COGS', isCheck: false }],
  [],
  sales,
  cardOnlyMap,
)
eq(
  cardOnly[0].withheldReason,
  'bank-data-missing',
  'bank guard: a card-only month is withheld as an IMPORT gap',
)
eq(cardOnly[0].marginPct, null, 'bank guard: no margin computed without bank data')
eq(cardOnly[0].grossProfit, null, 'bank guard: gross profit is null, never a misleading 0')
ok(
  !cardOnly[0].quotable,
  'bank guard: the 99.9% margin that would have been printed is suppressed',
)

// Ordering matters: missing bank data must be reported as the import gap it is,
// NOT as a categorization gap, or the owner is sent to categorize transactions
// that were never imported.
const noCogsNoBank = deriveMonthlyCogs([], [], sales, cardOnlyMap)
eq(
  noCogsNoBank[0].withheldReason,
  'bank-data-missing',
  'bank guard: missing bank data outranks no-cogs, because it is the cause',
)
const noCogsWithBank = deriveMonthlyCogs([], [], sales, bankMap)
eq(
  noCogsWithBank[0].withheldReason,
  'no-cogs',
  'bank guard: with bank data present, zero COGS is a genuine categorization gap',
)

// A month absent from the coverage map must be treated as NOT imported. The
// conservative direction withholds; the alternative quotes a margin for a month
// whose costs are unknown.
const absentFromMap = deriveMonthlyCogs(txns.slice(0, 3), [], sales, new Map())
eq(
  absentFromMap[0].withheldReason,
  'bank-data-missing',
  'bank guard: a month missing from the coverage map defaults to withheld',
)

// Unresolved checks are still reported as such once bank data is present, so the
// new guard has not swallowed the original one.
const stillChecks = deriveMonthlyCogs(txns, [], sales, bankMap)
eq(
  stillChecks[0].withheldReason,
  'unresolved-checks',
  'bank guard: unattributed checks remain the reason when bank data is present',
)

// Partial sales must outrank both — a partial month understates sales and would
// inflate the margin regardless of how complete the cost side is.
const partialSales = deriveMonthlyCogs(
  txns.slice(0, 3),
  [],
  new Map([['2026-06', { netSales: 79093.03, complete: false }]]),
  bankMap,
)
eq(
  partialSales[0].withheldReason,
  'partial-sales',
  'bank guard: incomplete sales outrank the cost-side reasons',
)

// The predicate is tested directly too, so a caller that assembles a month by
// hand gets the same verdict the engine's own pass produces.
eq(
  marginWithheldReason({
    netSales: 0,
    salesComplete: true,
    bankDataComplete: true,
    totalCogs: 5000,
    unresolvedCheckAmount: 0,
  }),
  'no-sales',
  'bank guard: a month with costs but no sales cannot carry a margin',
)

// Every reason must have a human label — a missing case would render blank.
for (const reason of [
  'no-sales',
  'partial-sales',
  'bank-data-missing',
  'no-cogs',
  'unresolved-checks',
] as const) {
  ok(
    marginWithheldLabel(reason).length > 0,
    `bank guard: '${reason}' has a display label`,
  )
}

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

// Months with no bank data imported must raise their OWN insight, separate from
// the categorization gap. Sending the owner to categorize a month that contains
// no transactions is work that cannot be done.
const bankGapInsights = generateInsights({
  settings,
  pillars,
  checks: { ...checkInsight, monthsMissingBankData: ['2026-01', '2026-02', '2026-03'] },
})
const bankGap = bankGapInsights.find(
  (i) => i.id === 'auto-checks-months-missing-bank-data',
)
ok(bankGap != null, 'advisor: months without imported bank data are raised')
ok(
  /import/i.test(bankGap?.detail ?? ''),
  'advisor: names importing as the remedy, not categorizing',
)
ok(
  !/categoriz(e|ation) (them|gap)/i.test(bankGap?.detail ?? ''),
  'advisor: does not tell the owner to categorize a month with no transactions',
)
ok(
  bankGap?.id !== bankGapInsights.find((i) => i.id === 'auto-checks-months-missing-cogs')?.id,
  'advisor: the import gap and the categorization gap are distinct insights',
)

// Absent list must produce no insight — never an empty-list warning.
ok(
  !insights.some((i) => i.id === 'auto-checks-months-missing-bank-data'),
  'advisor: no bank-data insight when every month has bank data',
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
    review_status: string | null
  }
  // `review_status` MUST be selected: resolution now depends on it, so a test
  // that omits it silently measures a different rule than production does.
  const txnRows = await all<Txn>(
    'financial_transactions',
    'id, transaction_date, description, normalized_description, amount, expense_category, check_number, review_status',
  )

  const isCheck = (r: Txn) =>
    /^\s*CHECK\b/i.test(r.description ?? r.normalized_description ?? '')

  const prepared = txnRows.map((r) => ({
    id: r.id,
    transactionDate: (r.transaction_date ?? '').slice(0, 10),
    amount: Math.abs(Number(r.amount) || 0),
    expenseCategory: (r.expense_category ?? '').trim(),
    isCheck: isCheck(r),
    reviewStatus: (r.review_status ?? '').trim(),
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
    reviewStatus: (r.review_status ?? '').trim(),
  }))

  /*
   * The REAL resolutions must be loaded and passed in. This block previously
   * passed `[]`, which counted all 58 overlay-resolved checks as still open and
   * made the printed readiness verdict ($73,815 unresolved / 22%) disagree with
   * what the page actually computes ($51,572 / 15%). A script that re-implements
   * the page's data assembly drifts from it, and this one drifted far enough to
   * misstate how much work was left by $22,000.
   */
  const liveResRows = await all<Record<string, unknown>>(
    'check_resolutions',
    'financial_transaction_id, check_number, resolved_payee, resolved_vendor_id, resolved_category, memo, business_purpose, review_status, confidence, resolution_source, reviewed_by, reviewed_at, bulk_action_id',
  )
  const liveResolutions: CheckResolution[] = liveResRows.map((r) => ({
    financialTransactionId: String(r.financial_transaction_id ?? ''),
    checkNumber: (r.check_number as string | null) ?? null,
    resolvedPayee: (r.resolved_payee as string | null) ?? null,
    resolvedVendorId: (r.resolved_vendor_id as string | null) ?? null,
    resolvedCategory: (r.resolved_category as string | null) ?? null,
    memo: (r.memo as string | null) ?? null,
    businessPurpose: (r.business_purpose as string | null) ?? null,
    reviewStatus: String(r.review_status ?? ''),
    confidence: (r.confidence as string | null) ?? null,
    resolutionSource: (r.resolution_source as string | null) ?? null,
    reviewedBy: (r.reviewed_by as string | null) ?? null,
    reviewedAt: (r.reviewed_at as string | null) ?? null,
    bulkActionId: (r.bulk_action_id as string | null) ?? null,
  })) as CheckResolution[]
  const approvedLive = liveResolutions.filter((r) => r.reviewStatus === 'approved')

  const months = deriveMonthlyCogs(prepared, approvedLive)
  const baseTotal = months.reduce((s, m) => s + m.baseCogs, 0)
  const unresolvedTotal = months.reduce((s, m) => s + m.unresolvedCheckAmount, 0)
  const directCogs = prepared
    .filter((t) => !t.isCheck && isCogsCategory(t.expenseCategory))
    .reduce((s, t) => s + t.amount, 0)
  const directChecks = liveChecks.reduce((s, r) => s + r.amount, 0)

  approx(baseTotal, directCogs, 0.01, 'live: monthly base COGS reconciles with a direct sum')

  /*
   * Unattributed check dollars are now a SUBSET of all check dollars, not all of
   * them: a check carrying a General Ledger category, or marked excluded, is
   * answered. So reconcile against a direct sum of the checks that are genuinely
   * still open, using the shared predicate.
   */
  const approvedById = new Map(approvedLive.map((r) => [r.financialTransactionId, r]))
  const directUnresolved = liveChecks
    .filter((r) => checkResolvedVia(r, approvedById.get(r.id)) === 'unresolved')
    .reduce((s, r) => s + r.amount, 0)
  approx(
    unresolvedTotal,
    directUnresolved,
    0.01,
    'live: unattributed check dollars reconcile with a direct sum of still-open checks',
  )

  // The stronger property: every check dollar is either open or answered, never
  // both and never neither. This is what actually prevents the double-count the
  // old assertion was reaching for.
  const progress = checkResolutionProgress(liveChecks, liveResolutions, isCogsCategory)
  approx(
    progress.overlayAmount +
      progress.categorizedAmount +
      progress.excludedAmount +
      progress.pendingAmount,
    directChecks,
    0.01,
    'live: resolved + excluded + pending check dollars partition the total exactly',
  )
  eq(
    progress.overlayCount +
      progress.categorizedCount +
      progress.excludedCount +
      progress.pendingCount,
    liveChecks.length,
    'live: every check falls in exactly one resolution bucket',
  )
  // And the page can never claim more is unknown than is actually unknown.
  ok(
    progress.pendingAmount <= directChecks + 0.01,
    'live: pending dollars never exceed total check dollars',
  )

  const summary = summarizeChecks(liveChecks)
  eq(summary.totalChecks, liveChecks.length, 'live: summary counts every check')
  approx(summary.totalAmount, directChecks, 0.01, 'live: summary dollars reconcile')

  const readiness = grossProfitReadiness(months, directChecks)
  ok(!readiness.ready, 'live: gross profit is currently withheld, as it should be')

  /*
   * The check-resolution OVERLAY still must never write expense_category itself —
   * that invariant is unchanged. But a CHECK row may now legitimately carry a
   * category: the 2025 accountant General Ledger identifies many checks by check
   * number, and those were applied from that external evidence under
   * action='categorize_from_2025_ledger'. So assert PROVENANCE rather than
   * absence — anything categorized without that audit trail is still a bug.
   */
  const categorizedChecks = liveChecks.filter((r) => r.expenseCategory.length > 0)
  const ledgerAudit = await all<{ transaction_id: string }>(
    'transaction_audit_log',
    'transaction_id, field, action',
  )
  const fromLedger = new Set(
    ledgerAudit
      .filter(
        (a) =>
          (a as unknown as { field?: string }).field === 'expense_category' &&
          (a as unknown as { action?: string }).action === 'categorize_from_2025_ledger',
      )
      .map((a) => String(a.transaction_id)),
  )
  const unexplained = categorizedChecks.filter((r) => !fromLedger.has(String(r.id)))
  eq(
    unexplained.length,
    0,
    'live: every categorized CHECK row traces to the 2025 ledger import — none written by the overlay',
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

  // `directChecks` is EVERY check dollar, resolved or not — it was previously
  // printed as "unattributed", which overstated the backlog by the $249K already
  // answered. Both figures are now labelled for what they are.
  console.log(
    `\nLive data: ${liveChecks.length} checks totalling $${directChecks.toFixed(2)}, of which $${directUnresolved.toFixed(2)} is still unattributed, against $${directCogs.toFixed(2)} of directly categorized COGS.`,
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

/**
 * Tests for the Square read layer's de-duplication.
 *
 * The scenario that matters: the owner runs a live sync AND imports a CSV
 * covering the same days. Naively summing `sales_daily` would then report
 * roughly double the real revenue. These tests pin the collapse-to-one-row-
 * per-date behaviour so that can never regress silently.
 *
 * Run: npx tsx scripts/verify-square-sales-read.ts
 */
import {
  resolveDailyRows,
  summarizeDailyRows,
  computeWeeklySales,
} from '../lib/square-sales-service'

let passed = 0
let failed = 0

function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed++
  } else {
    failed++
    console.log(`FAIL ${name}\n  expected: ${e}\n  actual:   ${a}`)
  }
}

const row = (
  sale_date: string,
  source: string,
  net_sales: number,
  extra: Record<string, unknown> = {},
) => ({
  sale_date,
  source,
  net_sales,
  gross_sales: net_sales,
  transaction_count: 10,
  ...extra,
})
// Semicolon required: the next statement is a bare `{` block used to scope a
// test case, and without it TypeScript reads the object literal above as an
// arrow parameter list.
;

// --- The double-count scenario -------------------------------------------
{
  const { rows, conflictDays } = resolveDailyRows([
    row('2026-03-01', 'square_api', 1000),
    row('2026-03-01', 'square_csv', 1000),
  ])
  check('same day two sources collapses to one row', rows.length, 1)
  check('winner is the API (higher rank)', rows[0].source, 'square_api')
  check('records the superseded source', rows[0].supersededSources, ['square_csv'])
  check('agreeing sources are not a conflict', conflictDays, [])

  const sum = summarizeDailyRows(rows, conflictDays)
  check('net sales NOT doubled', sum.netSales, 1000)
  check('transactions NOT doubled', sum.transactionCount, 10)
  check('day count is 1', sum.dayCount, 1)
}

// --- Disagreement is surfaced, not hidden --------------------------------
{
  const { rows, conflictDays } = resolveDailyRows([
    row('2026-03-02', 'square_api', 900),
    row('2026-03-02', 'square_csv', 1200),
  ])
  check('disagreement flagged', conflictDays, ['2026-03-02'])
  check('winner still the API', rows[0].netSales, 900)
}

// --- Manual outranks Square ---------------------------------------------
{
  const { rows } = resolveDailyRows([
    row('2026-03-03', 'square_api', 500),
    row('2026-03-03', 'manual', 650),
  ])
  check('manual correction wins', rows[0].source, 'manual')
  check('manual value used', rows[0].netSales, 650)
}

// --- Calculated is weakest ---------------------------------------------
{
  const { rows } = resolveDailyRows([
    row('2026-03-04', 'calculated', 100),
    row('2026-03-04', 'square_csv', 220),
  ])
  check('CSV beats bank estimate', rows[0].source, 'square_csv')
}

// --- Unknown sources are ignored, not ranked ---------------------------
{
  const { rows } = resolveDailyRows([
    row('2026-03-05', 'square_api', 300),
    row('2026-03-05', 'some_typo_source', 99999),
  ])
  check('unknown source dropped', rows.length, 1)
  check('real figure preserved', rows[0].netSales, 300)
}

// --- Distinct days are all kept ---------------------------------------
{
  const { rows } = resolveDailyRows([
    row('2026-03-07', 'square_api', 100),
    row('2026-03-06', 'square_api', 200),
    row('2026-03-08', 'square_api', 300),
  ])
  check('three distinct days kept', rows.length, 3)
  check('sorted ascending by date', rows.map((r) => r.saleDate), [
    '2026-03-06',
    '2026-03-07',
    '2026-03-08',
  ])
  const sum = summarizeDailyRows(rows)
  check('totals sum across days', sum.netSales, 600)
  check('first date', sum.firstDate, '2026-03-06')
  check('last date', sum.lastDate, '2026-03-08')
}

// --- Empty state reports null, never a confident zero -----------------
{
  const sum = summarizeDailyRows([])
  check('empty net sales is null not 0', sum.netSales, null)
  check('empty gross sales is null not 0', sum.grossSales, null)
  check('empty average ticket is null', sum.averageTicket, null)
  check('empty day count is 0', sum.dayCount, 0)
  check('empty source mix', sum.sourceMix, [])
}

// --- Average ticket ---------------------------------------------------
{
  const { rows } = resolveDailyRows([
    row('2026-04-01', 'square_api', 500, { transaction_count: 25 }),
  ])
  check('derived average ticket', rows[0].averageTicket, 20)

  const { rows: stored } = resolveDailyRows([
    row('2026-04-02', 'square_api', 500, {
      transaction_count: 25,
      average_ticket: 19.5,
    }),
  ])
  check('stored average ticket preferred', stored[0].averageTicket, 19.5)

  const { rows: zero } = resolveDailyRows([
    row('2026-04-03', 'square_api', 0, { transaction_count: 0 }),
  ])
  check('no transactions gives null ticket, not divide-by-zero', zero[0].averageTicket, null)
}

// --- Summary average ticket uses totals, not an average of averages ---
{
  const { rows } = resolveDailyRows([
    row('2026-05-01', 'square_api', 100, { transaction_count: 10 }),
    row('2026-05-02', 'square_api', 900, { transaction_count: 10 }),
  ])
  const sum = summarizeDailyRows(rows)
  // 1000 net / 20 txns = 50. An average-of-averages would wrongly give 50 too,
  // so use an asymmetric case to be sure: 100/10=10, 900/10=90, mean=50.
  check('ticket from totals', sum.averageTicket, 50)
  check('transaction totals', sum.transactionCount, 20)
}

// --- Fees and refunds aggregate --------------------------------------
{
  const { rows } = resolveDailyRows([
    row('2026-06-01', 'square_api', 1000, {
      refunds: 50,
      discounts: 25,
      processing_fees: 29,
    }),
    row('2026-06-02', 'square_api', 1000, {
      refunds: 10,
      discounts: 5,
      processing_fees: 31,
    }),
  ])
  const sum = summarizeDailyRows(rows)
  check('refunds total', sum.refunds, 60)
  check('discounts total', sum.discounts, 30)
  check('processing fees total', sum.processingFees, 60)
}

// --- Source mix ------------------------------------------------------
{
  const { rows, conflictDays } = resolveDailyRows([
    row('2026-07-01', 'square_api', 100),
    row('2026-07-02', 'square_csv', 100),
    row('2026-07-03', 'square_csv', 100),
  ])
  const sum = summarizeDailyRows(rows, conflictDays)
  check('source mix counts days per source', sum.sourceMix.map((s) => [s.source, s.days]), [
    ['square_api', 1],
    ['square_csv', 2],
  ])
}

// --- Trailing week window ---------------------------------------------
{

  // 14 consecutive days, $100/day. Latest day is 2026-08-14.
  const days: ReturnType<typeof resolveDailyRows>['rows'] = resolveDailyRows(
    Array.from({ length: 14 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10)
      return row(d, 'square_api', 100, { transaction_count: 5 })
    }),
  ).rows

  const w = computeWeeklySales(days)
  check('trailing week is 7 days', w.daysCovered, 7)
  check('trailing week net = 700', w.netSales, 700)
  check('prior week net = 700', w.priorNetSales, 700)
  check('anchors on latest data day', w.latestDate, '2026-08-14')
  check('week transactions', w.transactionCount, 35)
}

// --- Window anchors on last data day, not today -----------------------
{
  // Stale data from years ago must still report a real weekly figure.
  const { rows } = resolveDailyRows([
    row('2020-01-01', 'square_api', 250),
    row('2020-01-02', 'square_api', 250),
  ])
  const w = computeWeeklySales(rows)
  check('stale data still yields a figure', w.netSales, 500)
  check('latest date reported for staleness', w.latestDate, '2020-01-02')
  check('no prior week gives null not 0', w.priorNetSales, null)
}

// --- Empty input -------------------------------------------------------
{
  const w = computeWeeklySales([])
  check('empty weekly net is null', w.netSales, null)
  check('empty weekly latestDate is null', w.latestDate, null)
  check('empty weekly days covered', w.daysCovered, 0)
}

// --- Partial week ------------------------------------------------------
{
  const { rows } = resolveDailyRows([
    row('2026-09-10', 'square_api', 100),
    row('2026-09-12', 'square_api', 100),
    row('2026-09-14', 'square_api', 100),
  ])
  const w = computeWeeklySales(rows)
  check('gaps do not inflate day count', w.daysCovered, 3)
  check('partial week sums only real days', w.netSales, 300)
}

// --- Prior-window coverage (guards the weekly % change) ----------------
// The dashboard only reports a weekly change when daysCovered ===
// priorDaysCovered, so these two numbers have to be reported accurately and
// independently. Without that guard a short current week reads as a collapse.
{
  const days = resolveDailyRows(
    Array.from({ length: 14 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10)
      return row(d, 'square_api', 100)
    }),
  ).rows
  const w = computeWeeklySales(days)
  check('full fortnight: both windows covered equally', w.priorDaysCovered, 7)
  check('equal coverage means the change is comparable', w.daysCovered === w.priorDaysCovered, true)
}
{
  // A closed day in EACH window (the real Southern Farms pattern: closed Sundays)
  // still leaves the two windows comparable at 6 days apiece.
  const dates = [
    '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-25', '2026-07-27',
    '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01', '2026-08-03',
  ]
  const { rows } = resolveDailyRows(dates.map((d) => row(d, 'square_api', 100)))
  const w = computeWeeklySales(rows)
  check('matching closed day in both windows: current covered', w.daysCovered, 6)
  check('matching closed day in both windows: prior covered', w.priorDaysCovered, 6)
  check('still comparable, so a change may be shown', w.daysCovered === w.priorDaysCovered, true)
}
{
  // Lopsided: a 2-day current week against a full prior week. Sums are correct,
  // but the windows are NOT comparable — the caller must suppress the percentage.
  const dates = [
    '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-25', '2026-07-26', '2026-07-27',
    '2026-08-02', '2026-08-03',
  ]
  const { rows } = resolveDailyRows(dates.map((d) => row(d, 'square_api', 100)))
  const w = computeWeeklySales(rows)
  check('short current window is reported honestly', w.daysCovered, 2)
  check('prior window still fully covered', w.priorDaysCovered, 7)
  check('mismatch is detectable, so no % is claimed', w.daysCovered === w.priorDaysCovered, false)
}
{
  const w = computeWeeklySales([])
  check('empty prior coverage is 0', w.priorDaysCovered, 0)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

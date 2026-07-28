/**
 * Verification for lib/square-csv.ts — run with: npx tsx scripts/verify-square-csv.ts
 *
 * Focus is on the traps: money formats Square actually emits, dates that could
 * shift across a month boundary, and summary rows that would double-count.
 */

import {
  parseMoney,
  parseCount,
  parseCsvDate,
  normalizeHeader,
  matchHeaders,
  detectReportType,
  isTotalsRow,
  parseDailyReport,
  parseItemsReport,
  summarizeDaily,
  type CsvRow,
} from '../lib/square-csv'

let pass = 0
let fail = 0
const failures: string[] = []

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
  } else {
    fail++
    failures.push(`${label}\n    expected: ${e}\n    actual:   ${a}`)
  }
}

/* ---------------- parseMoney ---------------- */
eq(parseMoney('$1,234.56'), 1234.56, 'money: currency + thousands separator')
eq(parseMoney('1234.56'), 1234.56, 'money: plain')
eq(parseMoney('-$5.00'), -5, 'money: leading minus with symbol')
eq(parseMoney('($5.00)'), -5, 'money: accounting negative parens')
eq(parseMoney('$0.00'), 0, 'money: zero is zero, not null')
eq(parseMoney('0'), 0, 'money: bare zero')
eq(parseMoney(''), null, 'money: empty is null (absent, not zero)')
eq(parseMoney('—'), null, 'money: em dash is null')
eq(parseMoney('N/A'), null, 'money: N/A is null')
eq(parseMoney(undefined), null, 'money: undefined is null')
eq(parseMoney('abc'), null, 'money: garbage is null')
eq(parseMoney('.50'), 0.5, 'money: leading decimal point')
eq(parseMoney('$1,000,000.00'), 1000000, 'money: millions')
// Critical: null vs 0 distinction. If empty parsed as 0 we could not tell
// "Square reported zero sales" from "column missing".
eq(parseMoney('') === 0, false, 'money: empty must NOT equal zero')

/* ---------------- parseCount ---------------- */
eq(parseCount('42'), 42, 'count: plain')
eq(parseCount('1,234'), 1234, 'count: thousands separator')
eq(parseCount(''), null, 'count: empty is null')
eq(parseCount('3.7'), 4, 'count: rounds fractional')
eq(parseCount('abc'), null, 'count: garbage is null')

/* ---------------- parseCsvDate ---------------- */
eq(parseCsvDate('2026-01-15'), '2026-01-15', 'date: ISO')
eq(parseCsvDate('1/15/2026'), '2026-01-15', 'date: US M/D/YYYY')
eq(parseCsvDate('01/15/2026'), '2026-01-15', 'date: US padded')
eq(parseCsvDate('15/01/2026'), '2026-01-15', 'date: D/M when first > 12')
eq(parseCsvDate('1/5/26'), '2026-01-05', 'date: two-digit year')
eq(parseCsvDate('Jan 5, 2026'), '2026-01-05', 'date: month name')
eq(parseCsvDate('5 Jan 2026'), '2026-01-05', 'date: day-first month name')
eq(parseCsvDate('2026-01-15 14:30:00'), '2026-01-15', 'date: strips time')
eq(parseCsvDate('2026-01-15T14:30:00Z'), '2026-01-15', 'date: strips ISO time')
eq(parseCsvDate('2026-02-30'), null, 'date: rejects impossible Feb 30')
eq(parseCsvDate('2026-13-01'), null, 'date: rejects month 13')
eq(parseCsvDate(''), null, 'date: empty is null')
eq(parseCsvDate('not a date'), null, 'date: garbage is null')

// THE month-boundary trap: the first of a month must never roll back to the
// previous month regardless of the server's timezone.
eq(parseCsvDate('2026-03-01'), '2026-03-01', 'date: first of month stays put')
eq(parseCsvDate('3/1/2026'), '2026-03-01', 'date: US first of month stays put')
eq(parseCsvDate('2025-12-31'), '2025-12-31', 'date: year end stays put')
eq(parseCsvDate('2026-01-01'), '2026-01-01', 'date: year start stays put')

/* ---------------- headers ---------------- */
eq(normalizeHeader('Net Sales ($)'), 'netsales', 'header: strips parens and space')
eq(normalizeHeader('net_sales'), 'netsales', 'header: strips underscore')
eq(normalizeHeader('  NET SALES  '), 'netsales', 'header: trims and lowercases')

const dailyHeaders = [
  'Date', 'Gross Sales', 'Discounts', 'Net Sales', 'Tax', 'Tips', 'Fees', 'Transactions',
]
const m = matchHeaders(dailyHeaders)
eq(m.date, 'Date', 'match: date')
eq(m.grossSales, 'Gross Sales', 'match: gross')
eq(m.netSales, 'Net Sales', 'match: net')
eq(m.taxes, 'Tax', 'match: tax')
eq(detectReportType(dailyHeaders), 'daily', 'detect: daily report')

const itemHeaders = ['Item', 'Category', 'Qty', 'Gross Sales', 'Discounts', 'Net Sales']
eq(detectReportType(itemHeaders), 'items', 'detect: items report')
eq(detectReportType(['Foo', 'Bar']), null, 'detect: unrecognised file')

// A column must not be claimed by two fields. "Count" could match both
// transactionCount and units; whichever claims it first must own it.
const dupHeaders = ['Date', 'Net Sales', 'Count']
const dm = matchHeaders(dupHeaders)
const claimedTwice = dm.transactionCount === 'Count' && dm.units === 'Count'
eq(claimedTwice, false, 'match: no column claimed by two fields')

/* ---------------- totals rows ---------------- */
eq(isTotalsRow({ Item: 'Total', 'Net Sales': '$100' }), true, 'totals: Total')
eq(isTotalsRow({ Item: 'Grand Total', 'Net Sales': '$100' }), true, 'totals: Grand Total')
eq(isTotalsRow({ Item: 'Tomatoes', 'Net Sales': '$100' }), false, 'totals: real item')

/* ---------------- daily report ---------------- */
const dailyRows: CsvRow[] = [
  { Date: '2026-01-15', 'Gross Sales': '$1,000.00', Discounts: '$50.00', 'Net Sales': '$950.00', Tax: '$76.00', Tips: '$20.00', Fees: '$29.00', Transactions: '25' },
  { Date: '2026-01-16', 'Gross Sales': '$500.00', Discounts: '', 'Net Sales': '$500.00', Tax: '$40.00', Tips: '', Fees: '$14.50', Transactions: '12' },
  { Date: 'garbage', 'Gross Sales': '$100.00', Discounts: '', 'Net Sales': '$100.00', Tax: '', Tips: '', Fees: '', Transactions: '1' },
  { Date: 'Total', 'Gross Sales': '$1,500.00', Discounts: '$50.00', 'Net Sales': '$1,450.00', Tax: '', Tips: '', Fees: '', Transactions: '37' },
]
const dr = parseDailyReport(dailyHeaders, dailyRows)
eq(dr.rows.length, 2, 'daily: two good rows')
eq(dr.rejected.length, 2, 'daily: bad date and totals row rejected')
eq(dr.rows[0].saleDate, '2026-01-15', 'daily: first date')
eq(dr.rows[0].grossSales, 1000, 'daily: gross')
eq(dr.rows[0].netSales, 950, 'daily: net')
eq(dr.rows[0].transactionCount, 25, 'daily: count')
eq(dr.rows[1].tips, 0, 'daily: empty tips becomes 0 in output')
// The totals row must be rejected, never summed into the data.
eq(
  dr.rows.reduce((s, r) => s + r.grossSales, 0),
  1500,
  'daily: totals row not double-counted',
)

const sum = summarizeDaily(dr.rows)
eq(sum.periodStart, '2026-01-15', 'summary: period start')
eq(sum.periodEnd, '2026-01-16', 'summary: period end')
eq(sum.totalGross, 1500, 'summary: total gross')

// Duplicate date within one file must be flagged, not silently overwrite.
const dupDaily = parseDailyReport(dailyHeaders, [
  { Date: '2026-01-15', 'Gross Sales': '$100.00', Discounts: '', 'Net Sales': '$100.00', Tax: '', Tips: '', Fees: '', Transactions: '1' },
  { Date: '2026-01-15', 'Gross Sales': '$200.00', Discounts: '', 'Net Sales': '$200.00', Tax: '', Tips: '', Fees: '', Transactions: '2' },
])
eq(dupDaily.rows.length, 1, 'daily: duplicate date not imported twice')
eq(dupDaily.rejected.length, 1, 'daily: duplicate date reported')

// Derivation: when net is missing it should be computed from gross.
const noNet = parseDailyReport(['Date', 'Gross Sales', 'Discounts'], [
  { Date: '2026-02-01', 'Gross Sales': '$100.00', Discounts: '$10.00' },
])
eq(noNet.rows[0].netSales, 90, 'daily: derives net from gross minus discounts')

// And when gross is missing it should be computed from net.
const noGross = parseDailyReport(['Date', 'Net Sales', 'Discounts'], [
  { Date: '2026-02-01', 'Net Sales': '$90.00', Discounts: '$10.00' },
])
eq(noGross.rows[0].grossSales, 100, 'daily: derives gross from net plus discounts')

// Negative discounts (Square sometimes exports them signed) must not inflate.
const negDisc = parseDailyReport(['Date', 'Gross Sales', 'Discounts', 'Net Sales'], [
  { Date: '2026-02-01', 'Gross Sales': '$100.00', Discounts: '-$10.00', 'Net Sales': '$90.00' },
])
eq(negDisc.rows[0].discounts, 10, 'daily: signed discount normalised to positive')

/* ---------------- items report ---------------- */
const itemRows: CsvRow[] = [
  { Item: 'Tomatoes', Category: 'Produce', Qty: '10', 'Gross Sales': '$50.00', Discounts: '$5.00', 'Net Sales': '$45.00' },
  { Item: 'Eggs', Category: 'Dairy', Qty: '24', 'Gross Sales': '$120.00', Discounts: '', 'Net Sales': '$120.00' },
  { Item: '', Category: 'Produce', Qty: '1', 'Gross Sales': '$1.00', Discounts: '', 'Net Sales': '$1.00' },
  { Item: 'Total', Category: '', Qty: '35', 'Gross Sales': '$171.00', Discounts: '$5.00', 'Net Sales': '$166.00' },
]
const ir = parseItemsReport(itemHeaders, itemRows, { start: '2026-01-01', end: '2026-01-31' })
eq(ir.rows.length, 2, 'items: two good rows')
eq(ir.rejected.length, 2, 'items: blank name and totals rejected')
eq(ir.rows[0].itemName, 'Tomatoes', 'items: name')
eq(ir.rows[0].categoryName, 'Produce', 'items: category')
eq(ir.rows[0].units, 10, 'items: units')
eq(ir.rows[0].periodStart, '2026-01-01', 'items: period carried through')
eq(ir.rows[1].categoryName, 'Dairy', 'items: second category')

console.log(`\n${pass} passed, ${fail} failed\n`)
if (failures.length) {
  console.log('FAILURES:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}

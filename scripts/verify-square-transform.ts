/**
 * Verification harness for the pure Square transforms.
 *
 * Run: npx tsx scripts/verify-square-transform.ts
 *
 * Focuses on the traps that would silently misstate revenue: cent/dollar
 * conversion, bigint amounts, sale-date vs deposit-date, timezone month
 * boundaries, non-revenue order states, and tax/tip exclusion.
 */
import {
  moneyToDollars,
  round2,
  saleDateOf,
  channelOf,
  normalizeOrder,
  rollupDaily,
  rollupMonthly,
  rollupProducts,
  rollupEmployees,
  buildCatalogMaps,
  attachCategories,
  parseQuantity,
  isCountableState,
} from '../lib/square-transform'

let pass = 0
let fail = 0

function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    console.log(`  ok  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}\n        expected ${e}\n        actual   ${a}`)
  }
}

console.log('\n-- money conversion (cents -> dollars) --')
check('bigint cents', moneyToDollars({ amount: 12345n }), 123.45)
check('number cents', moneyToDollars({ amount: 12345 }), 123.45)
check('string cents', moneyToDollars({ amount: '12345' }), 123.45)
check('zero', moneyToDollars({ amount: 0n }), 0)
check('null money is 0 not NaN', moneyToDollars(null), 0)
check('undefined amount is 0', moneyToDollars({}), 0)
check('garbage string is 0', moneyToDollars({ amount: 'abc' }), 0)
check('single cent', moneyToDollars({ amount: 1n }), 0.01)
check('large amount', moneyToDollars({ amount: 3641600n }), 36416)
check('no float dust', round2(0.1 + 0.2), 0.3)

console.log('\n-- sale date uses closedAt, never a deposit date --')
check(
  'prefers closedAt',
  saleDateOf({ createdAt: '2026-01-10T12:00:00Z', closedAt: '2026-01-11T12:00:00Z' }),
  '2026-01-11',
)
check(
  'falls back to createdAt',
  saleDateOf({ createdAt: '2026-01-10T12:00:00Z', closedAt: null }),
  '2026-01-10',
)
check('no dates -> null', saleDateOf({}), null)
// The month-boundary trap: 7pm Jan 31 in Chicago is Feb 1 in UTC.
check(
  'late-night sale stays in its local month',
  saleDateOf({ closedAt: '2026-02-01T01:30:00Z' }, 'America/Chicago'),
  '2026-01-31',
)
check(
  'without timezone falls back to UTC date',
  saleDateOf({ closedAt: '2026-02-01T01:30:00Z' }),
  '2026-02-01',
)
check(
  'bad timezone does not throw',
  saleDateOf({ closedAt: '2026-02-01T01:30:00Z' }, 'Not/AZone'),
  '2026-02-01',
)

console.log('\n-- channel classification --')
check('POS is retail', channelOf({ source: { name: 'Square Point of Sale' } }), 'retail')
check('invoice is wholesale', channelOf({ source: { name: 'Invoices' } }), 'wholesale')
check('online is retail', channelOf({ source: { name: 'Online Store' } }), 'retail')
check('missing source defaults retail', channelOf({}), 'retail')
check(
  'custom wholesale source respected',
  channelOf({ source: { name: 'Farm Stand Bulk' } }, ['bulk']),
  'wholesale',
)

console.log('\n-- order normalization: tax and tips are not revenue --')
const order = normalizeOrder({
  id: 'ORD1',
  locationId: 'L1',
  state: 'COMPLETED',
  closedAt: '2026-01-15T16:00:00Z',
  source: { name: 'Square Point of Sale' },
  totalMoney: { amount: 11800n },
  totalTaxMoney: { amount: 800n },
  totalTipMoney: { amount: 1000n },
  totalDiscountMoney: { amount: 500n },
  lineItems: [
    { uid: 'A', name: 'Tomatoes', quantity: '2', grossSalesMoney: { amount: 6000n } },
    { uid: 'B', name: 'Eggs', quantity: '1', grossSalesMoney: { amount: 4500n } },
  ],
})
check('gross from line items', order?.grossSales, 105)
check('net excludes tax and tip, less discount', order?.netSales, 100)
check('tax captured separately', order?.totalTax, 8)
check('tip captured separately', order?.totalTip, 10)
check('sale date set', order?.saleDate, '2026-01-15')
check('line items kept', order?.lineItems.length, 2)
check('order with no id is rejected', normalizeOrder({ state: 'COMPLETED' }), null)

const noLines = normalizeOrder({
  id: 'ORD2',
  state: 'COMPLETED',
  closedAt: '2026-01-15T16:00:00Z',
  totalMoney: { amount: 10800n },
  totalTaxMoney: { amount: 800n },
})
check('falls back to total when no line items', noLines?.grossSales, 100)

console.log('\n-- line item uid fallback keeps resync idempotent --')
const noUid = normalizeOrder({
  id: 'ORD3',
  state: 'COMPLETED',
  closedAt: '2026-01-15T16:00:00Z',
  lineItems: [{ name: 'X', grossSalesMoney: { amount: 100n } }],
})
check('index-based uid', noUid?.lineItems[0].lineItemUid, 'idx-0')

console.log('\n-- quantity parsing --')
check('integer string', parseQuantity('3'), 3)
check('decimal weight', parseQuantity('2.5'), 2.5)
check('null', parseQuantity(null), 0)

console.log('\n-- only completed orders count as revenue --')
check('COMPLETED counts', isCountableState('COMPLETED'), true)
check('OPEN excluded', isCountableState('OPEN'), false)
check('CANCELED excluded', isCountableState('CANCELED'), false)
check('DRAFT excluded', isCountableState('DRAFT'), false)

const mixed = [
  normalizeOrder({
    id: 'C1', locationId: 'L1', state: 'COMPLETED',
    closedAt: '2026-01-15T16:00:00Z',
    source: { name: 'Square Point of Sale' },
    lineItems: [{ uid: 'a', grossSalesMoney: { amount: 10000n }, name: 'x' }],
  })!,
  normalizeOrder({
    id: 'C2', locationId: 'L1', state: 'CANCELED',
    closedAt: '2026-01-15T17:00:00Z',
    lineItems: [{ uid: 'b', grossSalesMoney: { amount: 99900n }, name: 'y' }],
  })!,
  normalizeOrder({
    id: 'C3', locationId: 'L1', state: 'COMPLETED',
    closedAt: '2026-01-16T17:00:00Z',
    source: { name: 'Invoices' },
    lineItems: [{ uid: 'c', grossSalesMoney: { amount: 20000n }, name: 'z' }],
  })!,
]
const daily = rollupDaily(mixed, { '2026-01-16': 25 })
check('canceled order excluded from day', daily[0].netSales, 100)
check('one txn counted on day 1', daily[0].transactionCount, 1)
check('retail bucket', daily[0].retailSales, 100)
check('invoice lands in wholesale', daily[1].wholesaleSales, 200)
check('refunds attached by date', daily[1].refunds, 25)
check('average ticket', daily[0].averageTicket, 100)

console.log('\n-- monthly rollup --')
const monthly = rollupMonthly(daily)
check('single month', monthly.length, 1)
check('year', monthly[0].year, 2026)
check('month name', monthly[0].month, 'Jan')
check('retail total', monthly[0].retail, 100)
check('wholesale total', monthly[0].wholesale, 200)
check('txn count', monthly[0].transactionCount, 2)

// Month-end boundary must not leak into the next month.
const endOfMonth = rollupMonthly([
  { saleDate: '2026-01-31', squareLocationId: 'L1', grossSales: 50, netSales: 50,
    retailSales: 50, wholesaleSales: 0, discounts: 0, refunds: 0, taxes: 0,
    tips: 0, transactionCount: 1, averageTicket: 50 },
  { saleDate: '2026-02-01', squareLocationId: 'L1', grossSales: 70, netSales: 70,
    retailSales: 70, wholesaleSales: 0, discounts: 0, refunds: 0, taxes: 0,
    tips: 0, transactionCount: 1, averageTicket: 70 },
])
check('splits across months', endOfMonth.length, 2)
check('Jan 31 stays in Jan', endOfMonth[0].retail, 50)
check('Feb 1 in Feb', endOfMonth[1].month, 'Feb')

console.log('\n-- catalog category attribution --')
const maps = buildCatalogMaps([
  { squareObjectId: 'CAT1', objectType: 'CATEGORY', name: 'Produce', categoryId: null, parentItemId: null },
  { squareObjectId: 'ITEM1', objectType: 'ITEM', name: 'Tomatoes', categoryId: 'CAT1', parentItemId: null },
  { squareObjectId: 'VAR1', objectType: 'ITEM_VARIATION', name: 'Pint', categoryId: null, parentItemId: 'ITEM1' },
])
check('category name mapped', maps.categoryNameById['CAT1'], 'Produce')
check('variation inherits parent category', maps.categoryIdByVariationId['VAR1'], 'CAT1')

const withCat = attachCategories(
  [normalizeOrder({
    id: 'P1', state: 'COMPLETED', closedAt: '2026-01-15T16:00:00Z',
    lineItems: [{ uid: 'a', name: 'Tomatoes', variationName: 'Pint',
      catalogObjectId: 'VAR1', quantity: '2', grossSalesMoney: { amount: 800n } }],
  })!],
  maps,
)
const products = rollupProducts(withCat, maps.categoryNameById)
check('product name includes variation', products[0].product, 'Tomatoes (Pint)')
check('product revenue', products[0].revenue, 8)
check('product category resolved', products[0].categoryName, 'Produce')
check('units', products[0].units, 2)

console.log('\n-- employee attribution --')
const emp = rollupEmployees(
  [
    { teamMemberId: 'T1', amount: 100, saleDate: '2026-01-15', status: 'COMPLETED' },
    { teamMemberId: 'T1', amount: 50, saleDate: '2026-01-15', status: 'COMPLETED' },
    { teamMemberId: null, amount: 20, saleDate: '2026-01-15', status: 'COMPLETED' },
    { teamMemberId: 'T1', amount: 999, saleDate: '2026-01-15', status: 'FAILED' },
  ],
  { T1: 'Dana' },
)
check('named employee total', emp[0].revenue, 150)
check('employee name resolved', emp[0].employeeName, 'Dana')
check('average ticket', emp[0].averageTicket, 75)
check('failed payment excluded', emp.length, 2)
check('unattributed kept, not dropped', emp[1].employeeName, 'Unattributed')

console.log(`\n${pass} passed, ${fail} failed\n`)
if (fail > 0) process.exit(1)

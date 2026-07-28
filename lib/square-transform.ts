/**
 * Pure transforms for Square API payloads.
 *
 * No database, no network, no `square` SDK import — everything here is a plain
 * function over plain objects so it can be unit tested and reasoned about.
 *
 * Two rules drive this whole file:
 *
 * 1. Square returns money in the currency's smallest unit (cents for USD) and,
 *    in the current SDK, as a `bigint`. Every amount is converted to dollars
 *    exactly once, here, at the boundary. Nothing downstream divides by 100.
 * 2. A sale belongs to the day it was MADE, not the day the money landed in the
 *    bank. Square settles 1-2 business days later, so using a deposit date
 *    would silently shift revenue across month boundaries and misstate every
 *    month-end. `saleDateOf` encodes that choice.
 */

/** Square money shape. `amount` may be bigint, number or numeric string. */
export type SquareMoney = {
  amount?: bigint | number | string | null
  currency?: string | null
} | null | undefined

/**
 * Convert a Square money object to dollars.
 *
 * Returns 0 for null/undefined/unparseable input rather than throwing: a
 * missing optional field (tip, discount, service charge) legitimately means
 * "none", and a sync must not abort over an absent tip.
 */
export function moneyToDollars(money: SquareMoney): number {
  if (money == null) return 0
  const raw = money.amount
  if (raw == null) return 0

  let cents: number
  if (typeof raw === 'bigint') {
    cents = Number(raw)
  } else if (typeof raw === 'number') {
    cents = raw
  } else {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return 0
    cents = parsed
  }

  if (!Number.isFinite(cents)) return 0
  // Round to cents to avoid float dust like 12.340000000000001.
  return Math.round(cents) / 100
}

/** Sum several money objects into dollars in one pass. */
export function sumMoney(...monies: SquareMoney[]): number {
  return round2(monies.reduce((total, m) => total + moneyToDollars(m), 0))
}

/** Round to 2dp, killing float artifacts before they reach the database. */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

/**
 * The authoritative sale date as `YYYY-MM-DD`.
 *
 * Prefers `closedAt` (when the sale actually completed) and falls back to
 * `createdAt` for still-open orders. Deliberately ignores any settlement or
 * deposit timestamp.
 *
 * `timezone` should be the Square location's timezone. Without it, a 7pm sale
 * in a US timezone is stored by UTC date and lands on tomorrow — quietly
 * moving end-of-month sales into the next month.
 */
export function saleDateOf(
  order: { closedAt?: string | null; createdAt?: string | null },
  timezone?: string | null,
): string | null {
  const iso = order.closedAt || order.createdAt
  if (!iso) return null
  return toLocalDateString(iso, timezone)
}

/** Format an ISO instant as a YYYY-MM-DD calendar date in `timezone`. */
export function toLocalDateString(
  iso: string,
  timezone?: string | null,
): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null

  if (!timezone) return d.toISOString().slice(0, 10)

  try {
    // en-CA gives YYYY-MM-DD directly.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d)
  } catch {
    // Unknown timezone string: fall back to UTC rather than losing the record.
    return d.toISOString().slice(0, 10)
  }
}

/**
 * Classify an order into a sales channel.
 *
 * Square's `source.name` tells us where the sale originated. In-person POS and
 * online orders are retail; invoices are how wholesale//bulk buyers are billed,
 * so those map to wholesale. `explicitWholesaleSources` lets the owner extend
 * this from settings without a code change.
 */
export function channelOf(
  order: { source?: { name?: string | null } | null },
  explicitWholesaleSources: string[] = [],
): 'retail' | 'wholesale' {
  const source = (order.source?.name || '').toLowerCase()
  const wholesaleMarkers = [
    'invoice',
    'wholesale',
    ...explicitWholesaleSources.map((s) => s.toLowerCase()),
  ]
  return wholesaleMarkers.some((m) => m && source.includes(m))
    ? 'wholesale'
    : 'retail'
}

// ---------------------------------------------------------------------------
// Order normalization
// ---------------------------------------------------------------------------

export type NormalizedLineItem = {
  lineItemUid: string
  catalogObjectId: string | null
  name: string
  variationName: string | null
  categoryId: string | null
  quantity: number
  grossSales: number
  totalDiscount: number
  totalTax: number
  totalMoney: number
}

export type NormalizedOrder = {
  squareOrderId: string
  squareLocationId: string | null
  state: string | null
  createdAt: string | null
  closedAt: string | null
  saleDate: string | null
  sourceName: string | null
  customerId: string | null
  teamMemberId: string | null
  channel: 'retail' | 'wholesale'
  grossSales: number
  netSales: number
  totalDiscount: number
  totalTax: number
  totalTip: number
  totalServiceCharge: number
  totalMoney: number
  returnedMoney: number
  lineItems: NormalizedLineItem[]
}

type RawOrderish = {
  id?: string | null
  locationId?: string | null
  state?: string | null
  createdAt?: string | null
  closedAt?: string | null
  customerId?: string | null
  source?: { name?: string | null } | null
  totalMoney?: SquareMoney
  totalTaxMoney?: SquareMoney
  totalDiscountMoney?: SquareMoney
  totalTipMoney?: SquareMoney
  totalServiceChargeMoney?: SquareMoney
  netAmountDueMoney?: SquareMoney
  returnAmounts?: { totalMoney?: SquareMoney } | null
  lineItems?: RawLineItemish[] | null
  tenders?: { id?: string | null }[] | null
}

type RawLineItemish = {
  uid?: string | null
  catalogObjectId?: string | null
  name?: string | null
  variationName?: string | null
  quantity?: string | number | null
  basePriceMoney?: SquareMoney
  grossSalesMoney?: SquareMoney
  totalDiscountMoney?: SquareMoney
  totalTaxMoney?: SquareMoney
  totalMoney?: SquareMoney
  catalogVersion?: unknown
}

/**
 * Normalize a Square order into flat dollar figures.
 *
 * Returns null when the order has no id — an unidentifiable order can't be
 * stored idempotently, and inventing a key would create duplicates on resync.
 */
export function normalizeOrder(
  order: RawOrderish,
  opts: { timezone?: string | null; wholesaleSources?: string[] } = {},
): NormalizedOrder | null {
  if (!order?.id) return null

  const grossSales = sumMoney(...(order.lineItems || []).map((li) => li.grossSalesMoney))
  const totalDiscount = moneyToDollars(order.totalDiscountMoney)
  const totalTax = moneyToDollars(order.totalTaxMoney)
  const totalTip = moneyToDollars(order.totalTipMoney)
  const totalServiceCharge = moneyToDollars(order.totalServiceChargeMoney)
  const totalMoney = moneyToDollars(order.totalMoney)
  const returnedMoney = moneyToDollars(order.returnAmounts?.totalMoney)

  // Fall back to the order total when line items are absent (some sources omit
  // them); otherwise gross would read 0 for a real sale.
  const effectiveGross =
    grossSales > 0 ? grossSales : round2(totalMoney - totalTax - totalTip)

  // Net sales = gross less discounts and returns, excluding tax and tips.
  // Tax is government money and tips are staff money; neither is revenue.
  const netSales = round2(effectiveGross - totalDiscount - returnedMoney)

  const saleDate = saleDateOf(order, opts.timezone)

  return {
    squareOrderId: order.id,
    squareLocationId: order.locationId ?? null,
    state: order.state ?? null,
    createdAt: order.createdAt ?? null,
    closedAt: order.closedAt ?? null,
    saleDate,
    sourceName: order.source?.name ?? null,
    customerId: order.customerId ?? null,
    teamMemberId: null,
    channel: channelOf(order, opts.wholesaleSources),
    grossSales: round2(effectiveGross),
    netSales,
    totalDiscount,
    totalTax,
    totalTip,
    totalServiceCharge,
    totalMoney,
    returnedMoney,
    lineItems: normalizeLineItems(order.lineItems, saleDate),
  }
}

function normalizeLineItems(
  items: RawLineItemish[] | null | undefined,
  saleDate: string | null,
): NormalizedLineItem[] {
  if (!items?.length) return []
  return items.map((li, index) => ({
    // `uid` is optional in the API. Fall back to the index so the
    // (order_id, line_item_uid) unique index stays stable across resyncs
    // instead of inserting duplicates each time.
    lineItemUid: li.uid || `idx-${index}`,
    catalogObjectId: li.catalogObjectId ?? null,
    name: li.name || 'Unnamed item',
    variationName: li.variationName ?? null,
    categoryId: null,
    quantity: parseQuantity(li.quantity),
    grossSales: moneyToDollars(li.grossSalesMoney ?? li.basePriceMoney),
    totalDiscount: moneyToDollars(li.totalDiscountMoney),
    totalTax: moneyToDollars(li.totalTaxMoney),
    totalMoney: moneyToDollars(li.totalMoney),
    saleDate,
  })) as NormalizedLineItem[]
}

/** Square sends quantity as a decimal string ("1", "2.5" for weighed goods). */
export function parseQuantity(q: string | number | null | undefined): number {
  if (q == null) return 0
  const n = typeof q === 'number' ? q : Number(q)
  return Number.isFinite(n) ? n : 0
}

// ---------------------------------------------------------------------------
// Daily rollup
// ---------------------------------------------------------------------------

export type DailyRollup = {
  saleDate: string
  squareLocationId: string | null
  grossSales: number
  netSales: number
  retailSales: number
  wholesaleSales: number
  discounts: number
  refunds: number
  taxes: number
  tips: number
  transactionCount: number
  averageTicket: number
}

/**
 * Aggregate normalized orders into per-day, per-location rows.
 *
 * Only completed orders count. Square keeps DRAFT/OPEN orders (abandoned carts,
 * open tabs) which are not revenue yet, and CANCELED ones which never were —
 * counting them would inflate sales.
 */
export function rollupDaily(
  orders: NormalizedOrder[],
  refundsByDate: Record<string, number> = {},
): DailyRollup[] {
  const buckets = new Map<string, DailyRollup>()

  for (const o of orders) {
    if (!o.saleDate) continue
    if (!isCountableState(o.state)) continue

    const key = `${o.saleDate}|${o.squareLocationId ?? '-'}`
    let b = buckets.get(key)
    if (!b) {
      b = {
        saleDate: o.saleDate,
        squareLocationId: o.squareLocationId,
        grossSales: 0,
        netSales: 0,
        retailSales: 0,
        wholesaleSales: 0,
        discounts: 0,
        refunds: 0,
        taxes: 0,
        tips: 0,
        transactionCount: 0,
        averageTicket: 0,
      }
      buckets.set(key, b)
    }

    b.grossSales += o.grossSales
    b.netSales += o.netSales
    b.discounts += o.totalDiscount
    b.taxes += o.totalTax
    b.tips += o.totalTip
    b.transactionCount += 1
    if (o.channel === 'wholesale') b.wholesaleSales += o.netSales
    else b.retailSales += o.netSales
  }

  for (const b of buckets.values()) {
    b.refunds = round2(refundsByDate[b.saleDate] ?? 0)
    b.grossSales = round2(b.grossSales)
    b.netSales = round2(b.netSales)
    b.retailSales = round2(b.retailSales)
    b.wholesaleSales = round2(b.wholesaleSales)
    b.discounts = round2(b.discounts)
    b.taxes = round2(b.taxes)
    b.tips = round2(b.tips)
    b.averageTicket =
      b.transactionCount > 0 ? round2(b.netSales / b.transactionCount) : 0
  }

  return [...buckets.values()].sort((a, b) => a.saleDate.localeCompare(b.saleDate))
}

/** COMPLETED orders are revenue. DRAFT/OPEN/CANCELED are not. */
export function isCountableState(state: string | null | undefined): boolean {
  if (!state) return true // Older/simple payloads omit state; assume real.
  return state.toUpperCase() === 'COMPLETED'
}

// ---------------------------------------------------------------------------
// Monthly rollup (feeds the existing sales_monthly shape)
// ---------------------------------------------------------------------------

export const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

export type MonthlyRollup = {
  year: number
  month: string
  monthOrder: number
  wholesale: number
  retail: number
  grossSales: number
  netSales: number
  discounts: number
  refunds: number
  taxes: number
  tips: number
  transactionCount: number
}

/** Aggregate daily rows into the month shape the Sales page already reads. */
export function rollupMonthly(daily: DailyRollup[]): MonthlyRollup[] {
  const buckets = new Map<string, MonthlyRollup>()

  for (const d of daily) {
    // Parse the Y-M-D string directly. `new Date('2026-01-31')` parses as UTC
    // midnight and can report the previous month in negative-offset zones.
    const [ys, ms] = d.saleDate.split('-')
    const year = Number(ys)
    const monthOrder = Number(ms)
    if (!Number.isFinite(year) || !Number.isFinite(monthOrder)) continue

    const key = `${year}-${monthOrder}`
    let b = buckets.get(key)
    if (!b) {
      b = {
        year,
        month: MONTH_NAMES[monthOrder - 1] ?? String(monthOrder),
        monthOrder,
        wholesale: 0, retail: 0, grossSales: 0, netSales: 0,
        discounts: 0, refunds: 0, taxes: 0, tips: 0, transactionCount: 0,
      }
      buckets.set(key, b)
    }

    b.wholesale += d.wholesaleSales
    b.retail += d.retailSales
    b.grossSales += d.grossSales
    b.netSales += d.netSales
    b.discounts += d.discounts
    b.refunds += d.refunds
    b.taxes += d.taxes
    b.tips += d.tips
    b.transactionCount += d.transactionCount
  }

  const out = [...buckets.values()]
  for (const b of out) {
    b.wholesale = round2(b.wholesale)
    b.retail = round2(b.retail)
    b.grossSales = round2(b.grossSales)
    b.netSales = round2(b.netSales)
    b.discounts = round2(b.discounts)
    b.refunds = round2(b.refunds)
    b.taxes = round2(b.taxes)
    b.tips = round2(b.tips)
  }
  return out.sort((a, b) => a.year - b.year || a.monthOrder - b.monthOrder)
}

// ---------------------------------------------------------------------------
// Product / category / employee rollups
// ---------------------------------------------------------------------------

export type ProductRollup = {
  product: string
  categoryName: string | null
  revenue: number
  units: number
}

export function rollupProducts(
  orders: NormalizedOrder[],
  categoryNameById: Record<string, string> = {},
): ProductRollup[] {
  const map = new Map<string, ProductRollup>()
  for (const o of orders) {
    if (!isCountableState(o.state)) continue
    for (const li of o.lineItems) {
      const name = li.variationName ? `${li.name} (${li.variationName})` : li.name
      let row = map.get(name)
      if (!row) {
        row = {
          product: name,
          categoryName: li.categoryId ? categoryNameById[li.categoryId] ?? null : null,
          revenue: 0,
          units: 0,
        }
        map.set(name, row)
      }
      row.revenue += li.grossSales - li.totalDiscount
      row.units += li.quantity
    }
  }
  const out = [...map.values()]
  for (const r of out) {
    r.revenue = round2(r.revenue)
    r.units = round2(r.units)
  }
  return out.sort((a, b) => b.revenue - a.revenue)
}

export type CategoryRollup = { categoryName: string; revenue: number; units: number }

export function rollupCategories(
  orders: NormalizedOrder[],
  categoryNameById: Record<string, string> = {},
): CategoryRollup[] {
  const map = new Map<string, CategoryRollup>()
  for (const o of orders) {
    if (!isCountableState(o.state)) continue
    for (const li of o.lineItems) {
      const cat =
        (li.categoryId ? categoryNameById[li.categoryId] : null) || 'Uncategorized'
      let row = map.get(cat)
      if (!row) {
        row = { categoryName: cat, revenue: 0, units: 0 }
        map.set(cat, row)
      }
      row.revenue += li.grossSales - li.totalDiscount
      row.units += li.quantity
    }
  }
  const out = [...map.values()]
  for (const r of out) {
    r.revenue = round2(r.revenue)
    r.units = round2(r.units)
  }
  return out.sort((a, b) => b.revenue - a.revenue)
}

export type EmployeeRollup = {
  teamMemberId: string | null
  employeeName: string
  revenue: number
  transactionCount: number
  averageTicket: number
}

/**
 * Per-employee sales, attributed via the payment's team member.
 *
 * Orders themselves often lack a team member, so payments are the reliable
 * link. Payments with no team member are grouped as "Unattributed" rather than
 * silently dropped, so the totals still reconcile.
 */
export function rollupEmployees(
  payments: {
    teamMemberId: string | null
    amount: number
    saleDate: string | null
    status?: string | null
  }[],
  nameById: Record<string, string> = {},
): EmployeeRollup[] {
  const map = new Map<string, EmployeeRollup>()
  for (const p of payments) {
    if (p.status && p.status.toUpperCase() !== 'COMPLETED') continue
    const id = p.teamMemberId
    const name = (id ? nameById[id] : null) || 'Unattributed'
    const key = id || 'unattributed'
    let row = map.get(key)
    if (!row) {
      row = {
        teamMemberId: id,
        employeeName: name,
        revenue: 0,
        transactionCount: 0,
        averageTicket: 0,
      }
      map.set(key, row)
    }
    row.revenue += p.amount
    row.transactionCount += 1
  }
  const out = [...map.values()]
  for (const r of out) {
    r.revenue = round2(r.revenue)
    r.averageTicket =
      r.transactionCount > 0 ? round2(r.revenue / r.transactionCount) : 0
  }
  return out.sort((a, b) => b.revenue - a.revenue)
}

/**
 * Build a categoryId -> name map, and an itemId -> categoryId map, from
 * catalog rows so line items can be attributed to categories.
 */
export function buildCatalogMaps(
  objects: {
    squareObjectId: string
    objectType: string
    name: string | null
    categoryId: string | null
    parentItemId: string | null
  }[],
): {
  categoryNameById: Record<string, string>
  categoryIdByItemId: Record<string, string>
  categoryIdByVariationId: Record<string, string>
} {
  const categoryNameById: Record<string, string> = {}
  const categoryIdByItemId: Record<string, string> = {}
  const categoryIdByVariationId: Record<string, string> = {}

  for (const o of objects) {
    if (o.objectType === 'CATEGORY' && o.name) {
      categoryNameById[o.squareObjectId] = o.name
    }
    if (o.objectType === 'ITEM' && o.categoryId) {
      categoryIdByItemId[o.squareObjectId] = o.categoryId
    }
  }
  // Variations inherit their parent item's category.
  for (const o of objects) {
    if (o.objectType === 'ITEM_VARIATION' && o.parentItemId) {
      const cat = categoryIdByItemId[o.parentItemId]
      if (cat) categoryIdByVariationId[o.squareObjectId] = cat
    }
  }

  return { categoryNameById, categoryIdByItemId, categoryIdByVariationId }
}

/** Attach category ids to line items using the catalog maps. */
export function attachCategories(
  orders: NormalizedOrder[],
  maps: ReturnType<typeof buildCatalogMaps>,
): NormalizedOrder[] {
  return orders.map((o) => ({
    ...o,
    lineItems: o.lineItems.map((li) => {
      if (!li.catalogObjectId) return li
      const cat =
        maps.categoryIdByVariationId[li.catalogObjectId] ??
        maps.categoryIdByItemId[li.catalogObjectId] ??
        null
      return { ...li, categoryId: cat }
    }),
  }))
}

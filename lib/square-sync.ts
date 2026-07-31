/**
 * Square -> Supabase sync engine.
 *
 * Design constraints that shaped this file:
 *
 * 1. Idempotent. Every write is an upsert on a natural Square id, so re-running
 *    a sync (or overlapping two) can never duplicate revenue.
 * 2. Overlapping windows. Incremental syncs re-fetch a short window before the
 *    last success rather than starting exactly where they stopped, because
 *    Square can make an order visible slightly after its timestamp. Combined
 *    with (1) the overlap is free.
 * 3. Never destroy other sources. Rollups only ever touch rows whose source is
 *    a Square source; manual and bank-derived figures are left alone.
 * 4. Partial failure is recorded, not swallowed. Sync state carries the error
 *    so the settings screen can show what actually went wrong.
 */
import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getSquareClient,
  describeSquareError,
  getSquareConfigState,
  withRetry,
} from '@/lib/square-client'
import {
  normalizeOrder,
  rollupDaily,
  rollupMonthly,
  rollupProducts,
  rollupCategories,
  rollupEmployees,
  buildCatalogMaps,
  attachCategories,
  moneyToDollars,
  toLocalDateString,
  round2,
  type NormalizedOrder,
} from '@/lib/square-transform'

/** How far back an incremental sync re-reads, to catch late-arriving orders. */
const OVERLAP_MINUTES = 90

/** Square's max page size for order search. */
const ORDER_PAGE_SIZE = 500

/** Safety valve so a misconfiguration can't spin forever. */
/**
 * Runaway-loop guard for Square's cursor pagination, not a data limit.
 *
 * At 200 it silently truncated a real account at exactly 20,000 payments
 * (200 pages x 100). A cap that stops quietly understates revenue, so it is
 * raised well past any plausible page count and hitting it is now reported as
 * a truncation warning rather than passing for a clean sync.
 */
const MAX_PAGES = 5000

function warnIfTruncated(resource: string, pages: number) {
  if (pages < MAX_PAGES) return false
  console.warn(
    `[v0] ${resource}: hit the ${MAX_PAGES}-page ceiling; data is TRUNCATED and totals will be understated.`,
  )
  return true
}

export type SyncResource =
  | 'locations'
  | 'catalog'
  | 'team'
  | 'orders'
  | 'payments'
  | 'refunds'
  | 'shifts'
  | 'rollups'

export type SyncOutcome = {
  ok: boolean
  resource: SyncResource
  recordsSynced: number
  error?: string
}

export type FullSyncResult = {
  ok: boolean
  outcomes: SyncOutcome[]
  /** First error encountered, for a one-line summary in the UI. */
  error?: string
  startedAt: string
  finishedAt: string
  ordersSynced: number
  daysAffected: number
}

/* ------------------------------------------------------------------ */
/* Sync state                                                          */
/* ------------------------------------------------------------------ */

/**
 * Resolve the Supabase client for sync work.
 *
 * The sync runs in two very different contexts:
 *  - From the Settings screen ("Sync now"), inside a request, where the
 *    cookie-bound client is correct and RLS applies as the signed-in user.
 *  - From a schedule or a script, where there is no request and therefore no
 *    `cookies()`. Without this fallback a scheduled sync is impossible, which
 *    would defeat the point of using the API instead of manual CSV exports.
 *
 * Only the specific "outside a request scope" failure falls through to the
 * service-role client. Any other error is rethrown, so a genuine Supabase
 * misconfiguration surfaces instead of being silently upgraded to a
 * privileged client.
 */
async function getSyncDb() {
  try {
    return await createClient()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const outsideRequest =
      message.includes('was called outside a request scope') ||
      message.includes('requestAsyncStorage') ||
      message.includes('work-unit-async-storage')

    if (!outsideRequest) throw err
    return createServiceClient()
  }
}

/**
 * PostgREST caps every select at ~1000 rows and reports no error when it
 * truncates, so an unpaginated read of a large table silently returns a
 * fraction of the data. That is exactly how the first real sync produced two
 * weeks of revenue out of two years of orders: the rollup only ever saw the
 * first 1000 orders. Every bulk read below must page explicitly.
 */
const PAGE_SIZE = 1000

async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{
    data: T[] | null
    error: { message: string } | null
  }>,
  label: string,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`${label}: ${error.message}`)
    const batch = data ?? []
    out.push(...batch)
    // A short page means this was the last one.
    if (batch.length < PAGE_SIZE) break
  }
  return out
}

type SyncStateRow = {
  resource: string
  cursor: string | null
  last_synced_through: string | null
  last_run_at: string | null
  last_success_at: string | null
  last_error: string | null
  status: string | null
  records_synced: number | null
}

export async function getSyncState(): Promise<SyncStateRow[]> {
  const supabase = await getSyncDb()
  const { data } = await supabase.from('square_sync_state').select('*')
  return (data ?? []) as SyncStateRow[]
}

export type SquareDataCounts = {
  orders: number
  payments: number
  refunds: number
  catalogItems: number
  salesDays: number
  earliestSale: string | null
  latestSale: string | null
}

/**
 * Row counts for the settings screen, so the owner can see at a glance whether
 * Square data actually landed rather than having to trust a "success" message.
 */
export async function getSquareDataCounts(): Promise<SquareDataCounts> {
  const supabase = await getSyncDb()

  const count = async (table: string) => {
    const { count: c } = await supabase
      .from(table)
      .select('*', { count: 'exact', head: true })
    return c ?? 0
  }

  const [orders, payments, refunds, catalogItems, salesDays] = await Promise.all([
    count('square_orders'),
    count('square_payments'),
    count('square_refunds'),
    count('square_catalog_objects'),
    count('sales_daily'),
  ])

  // Range of real sale dates, so an empty state can say *why* it is empty.
  const { data: earliest } = await supabase
    .from('sales_daily')
    .select('sale_date')
    .order('sale_date', { ascending: true })
    .limit(1)
    .maybeSingle()
  const { data: latest } = await supabase
    .from('sales_daily')
    .select('sale_date')
    .order('sale_date', { ascending: false })
    .limit(1)
    .maybeSingle()

  return {
    orders,
    payments,
    refunds,
    catalogItems,
    salesDays,
    earliestSale: (earliest as { sale_date?: string } | null)?.sale_date ?? null,
    latestSale: (latest as { sale_date?: string } | null)?.sale_date ?? null,
  }
}

async function readState(resource: SyncResource): Promise<SyncStateRow | null> {
  const supabase = await getSyncDb()
  const { data } = await supabase
    .from('square_sync_state')
    .select('*')
    .eq('resource', resource)
    .maybeSingle()
  return (data as SyncStateRow) ?? null
}

async function writeState(
  resource: SyncResource,
  patch: Partial<Omit<SyncStateRow, 'resource'>>,
): Promise<void> {
  const supabase = await getSyncDb()
  await supabase
    .from('square_sync_state')
    .upsert(
      { resource, ...patch, updated_at: new Date().toISOString() },
      { onConflict: 'resource' },
    )
}

/**
 * The start of the window to fetch.
 *
 * Backs up by OVERLAP_MINUTES from the last success so an order that became
 * visible late is still picked up. With no prior success it falls back to
 * `defaultStart`, which the caller sets from how much history is wanted.
 */
function windowStart(state: SyncStateRow | null, defaultStart: Date): Date {
  if (!state?.last_synced_through) return defaultStart
  const through = new Date(state.last_synced_through)
  if (Number.isNaN(through.getTime())) return defaultStart
  return new Date(through.getTime() - OVERLAP_MINUTES * 60_000)
}

/* ------------------------------------------------------------------ */
/* Locations                                                           */
/* ------------------------------------------------------------------ */

export async function syncLocations(): Promise<SyncOutcome> {
  const resource: SyncResource = 'locations'
  await writeState(resource, { last_run_at: new Date().toISOString(), status: 'running' })
  try {
    const client = getSquareClient()
    const supabase = await getSyncDb()
    const response = await withRetry(() => client.locations.list())
    const locations = response.locations ?? []

    if (locations.length > 0) {
      const rows = locations.map((l, i) => ({
        square_location_id: l.id ?? '',
        name: l.name ?? 'Unnamed location',
        currency: l.currency ?? null,
        timezone: l.timezone ?? null,
        status: l.status ?? null,
        address: l.address?.addressLine1 ?? null,
        // Square has no "primary location" flag; the first active one is the
        // best available default and only seeds the UI selection.
        is_default: i === 0,
        synced_at: new Date().toISOString(),
      })).filter((r) => r.square_location_id)

      const { error } = await supabase
        .from('square_locations')
        .upsert(rows, { onConflict: 'square_location_id' })
      if (error) throw new Error(error.message)
    }

    await writeState(resource, {
      status: 'ok',
      last_error: null,
      last_success_at: new Date().toISOString(),
      records_synced: locations.length,
    })
    return { ok: true, resource, recordsSynced: locations.length }
  } catch (error) {
    const message = describeSquareError(error)
    await writeState(resource, { status: 'error', last_error: message })
    return { ok: false, resource, recordsSynced: 0, error: message }
  }
}

/** The default location's timezone, used to bucket sales into the right day. */
export async function getLocationTimezone(): Promise<string | null> {
  const supabase = await getSyncDb()
  const { data } = await supabase
    .from('square_locations')
    .select('timezone, is_default')
    .order('is_default', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { timezone: string | null } | null)?.timezone ?? null
}

/* ------------------------------------------------------------------ */
/* Catalog + team                                                      */
/* ------------------------------------------------------------------ */

export async function syncCatalog(): Promise<SyncOutcome> {
  const resource: SyncResource = 'catalog'
  await writeState(resource, { last_run_at: new Date().toISOString(), status: 'running' })
  try {
    const client = getSquareClient()
    const supabase = await getSyncDb()

    const rows: Record<string, unknown>[] = []
    let pages = 0

    // `catalog.list` returns a core.Page, which paginates via
    // hasNextPage()/getNextPage() -- there is no `.cursor` on the page object.
    let page = await withRetry(() =>
      client.catalog.list({ types: 'ITEM,ITEM_VARIATION,CATEGORY' }),
    )

    for (;;) {
      for (const raw of page.data ?? []) {
        const o = raw as {
          id?: string
          type?: string
          itemData?: {
            name?: string
            categoryId?: string
            reportingCategory?: { id?: string }
          }
          categoryData?: { name?: string }
          itemVariationData?: {
            name?: string
            itemId?: string
            sku?: string
            priceMoney?: { amount?: bigint | number | null; currency?: string }
          }
          isDeleted?: boolean
        }
        if (!o.id || !o.type) continue

        const name =
          o.itemData?.name ?? o.categoryData?.name ?? o.itemVariationData?.name ?? null

        rows.push({
          square_object_id: o.id,
          object_type: o.type,
          name,
          // Square moved item categorisation to `reportingCategory`; fall back
          // to the legacy `categoryId` so older catalogs still map.
          category_id:
            o.itemData?.reportingCategory?.id ?? o.itemData?.categoryId ?? null,
          parent_item_id: o.itemVariationData?.itemId ?? null,
          sku: o.itemVariationData?.sku ?? null,
          price: o.itemVariationData?.priceMoney
            ? moneyToDollars(o.itemVariationData.priceMoney)
            : null,
          is_deleted: Boolean(o.isDeleted),
          synced_at: new Date().toISOString(),
        })
      }
      pages++
      if (!page.hasNextPage() || warnIfTruncated(resource, pages)) break
      page = await withRetry(() => page.getNextPage())
    }

    if (rows.length > 0) {
      const { error } = await supabase
        .from('square_catalog_objects')
        .upsert(rows, { onConflict: 'square_object_id' })
      if (error) throw new Error(error.message)
    }

    await writeState(resource, {
      status: 'ok',
      last_error: null,
      last_success_at: new Date().toISOString(),
      records_synced: rows.length,
    })
    return { ok: true, resource, recordsSynced: rows.length }
  } catch (error) {
    const message = describeSquareError(error)
    await writeState(resource, { status: 'error', last_error: message })
    return { ok: false, resource, recordsSynced: 0, error: message }
  }
}

export async function syncTeam(): Promise<SyncOutcome> {
  const resource: SyncResource = 'team'
  await writeState(resource, { last_run_at: new Date().toISOString(), status: 'running' })
  try {
    const client = getSquareClient()
    const supabase = await getSyncDb()

    const response = await withRetry(() => client.teamMembers.search({}))
    const members = response.teamMembers ?? []

    if (members.length > 0) {
      const rows = members
        .map((m) => ({
          square_team_member_id: m.id ?? '',
          given_name: m.givenName ?? null,
          family_name: m.familyName ?? null,
          display_name:
            [m.givenName, m.familyName].filter(Boolean).join(' ') ||
            m.emailAddress ||
            'Unnamed',
          status: m.status ?? null,
          synced_at: new Date().toISOString(),
        }))
        .filter((r) => r.square_team_member_id)

      const { error } = await supabase
        .from('square_team_members')
        .upsert(rows, { onConflict: 'square_team_member_id' })
      if (error) throw new Error(error.message)
    }

    await writeState(resource, {
      status: 'ok',
      last_error: null,
      last_success_at: new Date().toISOString(),
      records_synced: members.length,
    })
    return { ok: true, resource, recordsSynced: members.length }
  } catch (error) {
    const message = describeSquareError(error)
    await writeState(resource, { status: 'error', last_error: message })
    return { ok: false, resource, recordsSynced: 0, error: message }
  }
}

/* ------------------------------------------------------------------ */
/* Orders                                                             */
/* ------------------------------------------------------------------ */

export type OrderSyncResult = SyncOutcome & {
  orders: NormalizedOrder[]
  affectedDates: string[]
}

/**
 * Pull orders in the window and store them plus their line items.
 *
 * Returns the normalized orders so the caller can build rollups without
 * re-reading them from the database.
 */
export async function syncOrders(opts: {
  since?: Date
  locationIds?: string[]
  timezone?: string | null
}): Promise<OrderSyncResult> {
  const resource: SyncResource = 'orders'
  await writeState(resource, { last_run_at: new Date().toISOString(), status: 'running' })

  const empty = { orders: [] as NormalizedOrder[], affectedDates: [] as string[] }
  try {
    const client = getSquareClient()
    const supabase = await getSyncDb()

    let locationIds = opts.locationIds
    if (!locationIds || locationIds.length === 0) {
      const { data } = await supabase.from('square_locations').select('square_location_id')
      locationIds = (data ?? []).map((r) => (r as { square_location_id: string }).square_location_id)
    }
    if (locationIds.length === 0) {
      throw new Error(
        'No Square locations are known yet. Run a location sync first, or check the token has Merchant read access.',
      )
    }

    const state = await readState(resource)
    // Default to 24 months of history on a first run — enough for
    // year-over-year comparison without an unbounded backfill.
    const defaultStart = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000)
    const start = opts.since ?? windowStart(state, defaultStart)
    const runStart = new Date()

    const normalized: NormalizedOrder[] = []
    let cursor: string | undefined
    let pages = 0

    do {
      const response = await withRetry(() =>
        client.orders.search({
          locationIds,
          cursor,
          limit: ORDER_PAGE_SIZE,
          query: {
            filter: {
              dateTimeFilter: {
                // Filter on closedAt: an order's revenue belongs to the day it
                // was completed, and Square only sets closedAt then.
                closedAt: { startAt: start.toISOString(), endAt: runStart.toISOString() },
              },
              stateFilter: { states: ['COMPLETED'] },
            },
            sort: { sortField: 'CLOSED_AT', sortOrder: 'ASC' },
          },
        }),
      )

      const orders = response.orders ?? []
      for (const o of orders) {
        const n = normalizeOrder(o as never, { timezone: opts.timezone })
        if (n) normalized.push(n)
      }
      cursor = response.cursor
      pages++
    } while (cursor && !warnIfTruncated(resource, pages))

    // Attach categories so product/category rollups can attribute line items.
    const catalog = await fetchAllRows(
      (from, to) =>
        supabase
          .from('square_catalog_objects')
          .select('square_object_id, object_type, name, category_id, parent_item_id')
          .order('square_object_id', { ascending: true })
          .range(from, to),
      'square_catalog_objects',
    )
    const maps = buildCatalogMaps(
      (catalog ?? []).map((c) => {
        const r = c as {
          square_object_id: string
          object_type: string
          name: string | null
          category_id: string | null
          parent_item_id: string | null
        }
        return {
          squareObjectId: r.square_object_id,
          objectType: r.object_type,
          name: r.name,
          categoryId: r.category_id,
          parentItemId: r.parent_item_id,
        }
      }),
    )
    const withCategories = attachCategories(normalized, maps)

    if (withCategories.length > 0) {
      const orderRows = withCategories.map((o) => ({
        square_order_id: o.squareOrderId,
        square_location_id: o.squareLocationId,
        state: o.state,
        created_at: o.createdAt,
        closed_at: o.closedAt,
        sale_date: o.saleDate,
        source_name: o.sourceName,
        customer_id: o.customerId,
        team_member_id: o.teamMemberId,
        channel: o.channel,
        gross_sales: o.grossSales,
        net_sales: o.netSales,
        total_discount: o.totalDiscount,
        total_tax: o.totalTax,
        total_tip: o.totalTip,
        total_service_charge: o.totalServiceCharge,
        total_money: o.totalMoney,
        returned_money: o.returnedMoney,
        line_item_count: o.lineItems.length,
        synced_at: new Date().toISOString(),
      }))

      // Chunked to stay under statement/payload limits on large backfills.
      for (const chunk of chunked(orderRows, 500)) {
        const { error } = await supabase
          .from('square_orders')
          .upsert(chunk, { onConflict: 'square_order_id' })
        if (error) throw new Error(error.message)
      }

      const lineRows = withCategories.flatMap((o) =>
        o.lineItems.map((li) => ({
          square_order_id: o.squareOrderId,
          line_item_uid: li.lineItemUid,
          catalog_object_id: li.catalogObjectId,
          name: li.name,
          variation_name: li.variationName,
          category_id: li.categoryId,
          category_name: li.categoryId ? maps.categoryNameById[li.categoryId] ?? null : null,
          quantity: li.quantity,
          gross_sales: li.grossSales,
          total_discount: li.totalDiscount,
          total_tax: li.totalTax,
          total_money: li.totalMoney,
          sale_date: o.saleDate,
          synced_at: new Date().toISOString(),
        })),
      )
      for (const chunk of chunked(lineRows, 500)) {
        const { error } = await supabase
          .from('square_order_line_items')
          .upsert(chunk, { onConflict: 'square_order_id,line_item_uid' })
        if (error) throw new Error(error.message)
      }
    }

    const affectedDates = [
      ...new Set(withCategories.map((o) => o.saleDate).filter(Boolean) as string[]),
    ].sort()

    await writeState(resource, {
      status: 'ok',
      last_error: null,
      last_success_at: new Date().toISOString(),
      last_synced_through: runStart.toISOString(),
      records_synced: withCategories.length,
    })

    return {
      ok: true,
      resource,
      recordsSynced: withCategories.length,
      orders: withCategories,
      affectedDates,
    }
  } catch (error) {
    const message = describeSquareError(error)
    await writeState(resource, { status: 'error', last_error: message })
    return { ok: false, resource, recordsSynced: 0, error: message, ...empty }
  }
}

/* ------------------------------------------------------------------ */
/* Payments + refunds                                                 */
/* ------------------------------------------------------------------ */

export type PaymentSyncResult = SyncOutcome & {
  payments: { teamMemberId: string | null; amount: number; saleDate: string | null; status: string | null }[]
}

export async function syncPayments(opts: {
  since?: Date
  timezone?: string | null
}): Promise<PaymentSyncResult> {
  const resource: SyncResource = 'payments'
  await writeState(resource, { last_run_at: new Date().toISOString(), status: 'running' })
  try {
    const client = getSquareClient()
    const supabase = await getSyncDb()
    const state = await readState(resource)
    const defaultStart = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000)
    const start = opts.since ?? windowStart(state, defaultStart)
    const runStart = new Date()

    const rows: Record<string, unknown>[] = []
    const forRollup: PaymentSyncResult['payments'] = []
    let pages = 0

    // `payments.list` returns a core.Page: walk it with hasNextPage()/getNextPage().
    let page = await withRetry(() =>
      client.payments.list({
        beginTime: start.toISOString(),
        endTime: runStart.toISOString(),
        sortOrder: 'ASC',
      }),
    )

    for (;;) {
      for (const raw of page.data ?? []) {
        const p = raw as {
          id?: string
          orderId?: string
          locationId?: string
          createdAt?: string
          status?: string
          sourceType?: string
          teamMemberId?: string
          receiptNumber?: string
          amountMoney?: { amount?: bigint | number | null; currency?: string }
          tipMoney?: { amount?: bigint | number | null; currency?: string }
          appFeeMoney?: { amount?: bigint | number | null; currency?: string }
          refundedMoney?: { amount?: bigint | number | null; currency?: string }
          processingFee?: { amountMoney?: { amount?: bigint | number | null; currency?: string } }[]
          cardDetails?: { card?: { cardBrand?: string } }
        }
        if (!p.id) continue

        // Square reports each fee separately; the owner cares about the total.
        const processingFee = (p.processingFee ?? []).reduce(
          (sum, f) => sum + moneyToDollars(f.amountMoney),
          0,
        )
        const saleDate = p.createdAt
          ? toLocalDateString(p.createdAt, opts.timezone)
          : null

        rows.push({
          square_payment_id: p.id,
          square_order_id: p.orderId ?? null,
          square_location_id: p.locationId ?? null,
          created_at: p.createdAt ?? null,
          sale_date: saleDate,
          status: p.status ?? null,
          source_type: p.sourceType ?? null,
          card_brand: p.cardDetails?.card?.cardBrand ?? null,
          team_member_id: p.teamMemberId ?? null,
          receipt_number: p.receiptNumber ?? null,
          amount: moneyToDollars(p.amountMoney),
          tip_amount: moneyToDollars(p.tipMoney),
          app_fee: moneyToDollars(p.appFeeMoney),
          refunded_amount: moneyToDollars(p.refundedMoney),
          processing_fee: round2(processingFee),
          synced_at: new Date().toISOString(),
        })

        forRollup.push({
          teamMemberId: p.teamMemberId ?? null,
          amount: moneyToDollars(p.amountMoney),
          saleDate,
          status: p.status ?? null,
        })
      }
      pages++
      if (!page.hasNextPage() || warnIfTruncated(resource, pages)) break
      page = await withRetry(() => page.getNextPage())
    }

    for (const chunk of chunked(rows, 500)) {
      const { error } = await supabase
        .from('square_payments')
        .upsert(chunk, { onConflict: 'square_payment_id' })
      if (error) throw new Error(error.message)
    }

    await writeState(resource, {
      status: 'ok',
      last_error: null,
      last_success_at: new Date().toISOString(),
      last_synced_through: runStart.toISOString(),
      records_synced: rows.length,
    })
    return { ok: true, resource, recordsSynced: rows.length, payments: forRollup }
  } catch (error) {
    const message = describeSquareError(error)
    await writeState(resource, { status: 'error', last_error: message })
    return { ok: false, resource, recordsSynced: 0, error: message, payments: [] }
  }
}

export type RefundSyncResult = SyncOutcome & { refundsByDate: Record<string, number> }

export async function syncRefunds(opts: {
  since?: Date
  timezone?: string | null
}): Promise<RefundSyncResult> {
  const resource: SyncResource = 'refunds'
  await writeState(resource, { last_run_at: new Date().toISOString(), status: 'running' })
  try {
    const client = getSquareClient()
    const supabase = await getSyncDb()
    const state = await readState(resource)
    const defaultStart = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000)
    const start = opts.since ?? windowStart(state, defaultStart)
    const runStart = new Date()

    const rows: Record<string, unknown>[] = []
    const refundsByDate: Record<string, number> = {}
    let pages = 0

    // `refunds.list` returns a core.Page: walk it with hasNextPage()/getNextPage().
    let page = await withRetry(() =>
      client.refunds.list({
        beginTime: start.toISOString(),
        endTime: runStart.toISOString(),
        sortOrder: 'ASC',
      }),
    )

    for (;;) {
      for (const raw of page.data ?? []) {
        const r = raw as {
          id?: string
          paymentId?: string
          orderId?: string
          locationId?: string
          createdAt?: string
          status?: string
          reason?: string
          amountMoney?: { amount?: bigint | number | null; currency?: string }
          processingFee?: { amountMoney?: { amount?: bigint | number | null; currency?: string } }[]
        }
        if (!r.id) continue

        const amount = moneyToDollars(r.amountMoney)
        const saleDate = r.createdAt ? toLocalDateString(r.createdAt, opts.timezone) : null
        const processingFee = (r.processingFee ?? []).reduce(
          (sum, f) => sum + moneyToDollars(f.amountMoney),
          0,
        )

        rows.push({
          square_refund_id: r.id,
          square_payment_id: r.paymentId ?? null,
          square_order_id: r.orderId ?? null,
          square_location_id: r.locationId ?? null,
          created_at: r.createdAt ?? null,
          sale_date: saleDate,
          status: r.status ?? null,
          reason: r.reason ?? null,
          amount,
          processing_fee: round2(processingFee),
          synced_at: new Date().toISOString(),
        })

        // Only completed refunds reduce sales; pending ones may never settle.
        if (saleDate && (r.status ?? '').toUpperCase() === 'COMPLETED') {
          refundsByDate[saleDate] = round2((refundsByDate[saleDate] ?? 0) + amount)
        }
      }
      pages++
      if (!page.hasNextPage() || warnIfTruncated(resource, pages)) break
      page = await withRetry(() => page.getNextPage())
    }

    for (const chunk of chunked(rows, 500)) {
      const { error } = await supabase
        .from('square_refunds')
        .upsert(chunk, { onConflict: 'square_refund_id' })
      if (error) throw new Error(error.message)
    }

    await writeState(resource, {
      status: 'ok',
      last_error: null,
      last_success_at: new Date().toISOString(),
      last_synced_through: runStart.toISOString(),
      records_synced: rows.length,
    })
    return { ok: true, resource, recordsSynced: rows.length, refundsByDate }
  } catch (error) {
    const message = describeSquareError(error)
    await writeState(resource, { status: 'error', last_error: message })
    return { ok: false, resource, recordsSynced: 0, error: message, refundsByDate: {} }
  }
}

/* ------------------------------------------------------------------ */
/* Shifts (labor timecards)                                           */
/* ------------------------------------------------------------------ */

/**
 * Pull Square Labor timecards so labor cost has a real source.
 *
 * These are *timecards*, not payroll. Square's Payroll API is access-restricted,
 * so gross-to-net, withholdings and employer taxes are not available here.
 * Everything derived from this table is therefore an hours x wage estimate and
 * must be labelled as such: it is a floor for labor cost, not what was paid.
 *
 * Three Square details drive the shape of this function:
 *  - The wage lives on each shift rather than on the employee, so a mid-period
 *    raise is captured per shift instead of retroactively rewriting history.
 *  - Deleting a shift in Square makes it vanish from search rather than coming
 *    back flagged. A row that disappears is tombstoned via `is_deleted` instead
 *    of being hard-deleted, so a correction can never silently erase labor
 *    history the owner has already reviewed.
 *  - `ShiftQuery` is deprecated at Square API version 2025-05-21 in favour of
 *    the newer timecards surface. The client pins 2025-01-23, where this is
 *    still the supported call; when that version is raised this function has to
 *    move to `labor.timecards.search` (same fields, `timecards` in place of
 *    `shifts`).
 */
export async function syncShifts(opts: {
  since?: Date
}): Promise<SyncOutcome & { truncated: boolean }> {
  const resource: SyncResource = 'shifts'
  await writeState(resource, { last_run_at: new Date().toISOString(), status: 'running' })
  try {
    const client = getSquareClient()
    const supabase = await getSyncDb()
    const state = await readState(resource)
    const defaultStart = new Date(Date.now() - 730 * 24 * 60 * 60 * 1000)
    const start = opts.since ?? windowStart(state, defaultStart)
    const runStart = new Date()

    const rows: Record<string, unknown>[] = []
    const seenIds: string[] = []
    let pages = 0
    let cursor: string | undefined
    let truncated = false

    for (;;) {
      const response = await withRetry(() =>
        client.labor.shifts.search({
          query: {
            filter: {
              // Inclusive lower bound, so the overlap window applies here.
              start: { startAt: start.toISOString() },
            },
            sort: { field: 'START_AT', order: 'ASC' },
          },
          limit: 200,
          cursor,
        }),
      )

      for (const t of response.shifts ?? []) {
        if (!t.id) continue
        seenIds.push(t.id)

        // Breaks matter for cost: unpaid time is on the clock but not payable.
        const breaks = t.breaks ?? []
        let unpaidMinutes = 0
        let paidMinutes = 0
        for (const b of breaks) {
          if (!b.startAt || !b.endAt) continue
          const mins = (new Date(b.endAt).getTime() - new Date(b.startAt).getTime()) / 60_000
          if (!Number.isFinite(mins) || mins < 0) continue
          if (b.isPaid) paidMinutes += mins
          else unpaidMinutes += mins
        }

        const hourlyRate = t.wage?.hourlyRate
          ? moneyToDollars(t.wage.hourlyRate)
          : null

        rows.push({
          square_shift_id: t.id,
          square_team_member_id: t.teamMemberId ?? '',
          square_location_id: t.locationId ?? '',
          start_at: t.startAt ?? null,
          end_at: t.endAt ?? null,
          timezone: t.timezone ?? null,
          job_id: t.wage?.jobId ?? null,
          job_title: t.wage?.title ?? null,
          hourly_rate: hourlyRate,
          wage_currency: t.wage?.hourlyRate?.currency ?? null,
          tip_eligible: t.wage?.tipEligible ?? null,
          declared_cash_tips: t.declaredCashTipMoney
            ? moneyToDollars(t.declaredCashTipMoney)
            : null,
          status: t.status ?? null,
          breaks: breaks,
          break_count: breaks.length,
          unpaid_break_minutes: Math.round(unpaidMinutes),
          paid_break_minutes: Math.round(paidMinutes),
          version: t.version ?? null,
          square_created_at: t.createdAt ?? null,
          square_updated_at: t.updatedAt ?? null,
          is_deleted: false,
          deleted_detected_at: null,
          raw: t,
          synced_at: new Date().toISOString(),
        })
      }

      pages++
      cursor = response.cursor ?? undefined
      if (!cursor) break
      if (warnIfTruncated(resource, pages)) {
        truncated = true
        break
      }
    }

    for (const chunk of chunked(rows, 500)) {
      const { error } = await supabase
        .from('square_shifts')
        .upsert(chunk, { onConflict: 'square_shift_id' })
      if (error) throw new Error(error.message)
    }

    /*
     * Tombstone timecards Square no longer returns for this window.
     *
     * Only done on a complete (non-truncated) read: if pagination bailed early,
     * the rows we did not reach are not missing, merely unseen, and marking them
     * deleted would understate labor cost — the exact failure mode that made the
     * page ceiling worth reporting in the first place.
     */
    let tombstoned = 0
    if (!truncated) {
      const existing = await fetchAllRows<{ square_shift_id: string }>(
        (from, to) =>
          supabase
            .from('square_shifts')
            .select('square_shift_id')
            .gte('start_at', start.toISOString())
            .eq('is_deleted', false)
            .range(from, to),
        'square_shifts existing ids',
      )
      const seen = new Set(seenIds)
      const missing = existing
        .map((r) => r.square_shift_id)
        .filter((id) => !seen.has(id))

      for (const chunk of chunked(missing, 500)) {
        const { error } = await supabase
          .from('square_shifts')
          .update({
            is_deleted: true,
            deleted_detected_at: new Date().toISOString(),
          })
          .in('square_shift_id', chunk)
        if (error) throw new Error(error.message)
      }
      tombstoned = missing.length
      if (tombstoned > 0) {
        console.log(`[v0] shifts: tombstoned ${tombstoned} timecard(s) removed in Square.`)
      }
    }

    await writeState(resource, {
      status: truncated ? 'error' : 'ok',
      last_error: truncated
        ? `Hit the ${MAX_PAGES}-page ceiling; labor data is truncated.`
        : null,
      last_success_at: truncated ? undefined : new Date().toISOString(),
      // A truncated read must not advance the watermark, or the unseen tail
      // would be skipped forever on the next incremental run.
      last_synced_through: truncated ? undefined : runStart.toISOString(),
      records_synced: rows.length,
    })

    return {
      ok: !truncated,
      resource,
      recordsSynced: rows.length,
      truncated,
      error: truncated
        ? `Hit the ${MAX_PAGES}-page ceiling; labor data is truncated.`
        : undefined,
    }
  } catch (error) {
    const message = describeSquareError(error)
    await writeState(resource, { status: 'error', last_error: message })
    return { ok: false, resource, recordsSynced: 0, error: message, truncated: false }
  }
}

/* ------------------------------------------------------------------ */
/* Rollups                                                            */
/* ------------------------------------------------------------------ */

/**
 * Rebuild the reporting tables from synced Square data.
 *
 * Reads orders back out of the database rather than using only the current
 * batch, so a day that received orders across several syncs is recomputed
 * whole instead of being overwritten with a partial total.
 */
export async function rebuildRollups(opts: {
  affectedDates?: string[]
  refundsByDate?: Record<string, number>
  payments?: PaymentSyncResult['payments']
}): Promise<SyncOutcome> {
  const resource: SyncResource = 'rollups'
  await writeState(resource, { last_run_at: new Date().toISOString(), status: 'running' })
  try {
    const supabase = await getSyncDb()

    // Recompute whole months, not just the changed days: a month's figure is a
    // sum over its days, so a partial-day update still needs the month total.
    const months = new Set<string>()
    for (const d of opts.affectedDates ?? []) months.add(d.slice(0, 7))

    // Bound the read to the affected months so a routine sync doesn't scan
    // two years of orders.
    const sorted = [...months].sort()
    const monthFrom = months.size > 0 ? `${sorted[0]}-01` : null
    const monthTo = months.size > 0 ? endOfMonth(sorted[sorted.length - 1]) : null

    const orderRows = await fetchAllRows((from, to) => {
      let q = supabase
        .from('square_orders')
        .select(
          'square_order_id, square_location_id, state, sale_date, channel, gross_sales, net_sales, total_discount, total_tax, total_tip, team_member_id',
        )
      if (monthFrom && monthTo) q = q.gte('sale_date', monthFrom).lte('sale_date', monthTo)
      // Order by a unique key: an unordered paged read can repeat or skip rows.
      return q.order('square_order_id', { ascending: true }).range(from, to)
    }, 'square_orders')

    const lineRows = await fetchAllRows(
      (from, to) =>
        supabase
          .from('square_order_line_items')
          .select(
            'square_order_id, line_item_uid, catalog_object_id, name, variation_name, category_id, category_name, quantity, gross_sales, total_discount, total_tax, total_money',
          )
          .order('square_order_id', { ascending: true })
          .order('line_item_uid', { ascending: true })
          .range(from, to),
      'square_order_line_items',
    )

    const linesByOrder = new Map<string, Record<string, unknown>[]>()
    for (const l of lineRows ?? []) {
      const r = l as Record<string, unknown>
      const id = String(r.square_order_id)
      const list = linesByOrder.get(id) ?? []
      list.push(r)
      linesByOrder.set(id, list)
    }

    const orders: NormalizedOrder[] = (orderRows ?? []).map((o) => {
      const r = o as Record<string, unknown>
      const lines = linesByOrder.get(String(r.square_order_id)) ?? []
      return {
        squareOrderId: String(r.square_order_id),
        squareLocationId: (r.square_location_id as string) ?? null,
        state: (r.state as string) ?? null,
        createdAt: null,
        closedAt: null,
        saleDate: (r.sale_date as string) ?? null,
        sourceName: null,
        customerId: null,
        teamMemberId: (r.team_member_id as string) ?? null,
        channel: (r.channel as 'retail' | 'wholesale') ?? 'retail',
        grossSales: Number(r.gross_sales ?? 0),
        netSales: Number(r.net_sales ?? 0),
        totalDiscount: Number(r.total_discount ?? 0),
        totalTax: Number(r.total_tax ?? 0),
        totalTip: Number(r.total_tip ?? 0),
        totalServiceCharge: 0,
        totalMoney: 0,
        returnedMoney: 0,
        lineItems: lines.map((l) => ({
          lineItemUid: String(l.line_item_uid),
          catalogObjectId: (l.catalog_object_id as string) ?? null,
          name: (l.name as string) ?? '',
          variationName: (l.variation_name as string) ?? null,
          categoryId: (l.category_id as string) ?? null,
          quantity: Number(l.quantity ?? 0),
          grossSales: Number(l.gross_sales ?? 0),
          totalDiscount: Number(l.total_discount ?? 0),
          totalTax: Number(l.total_tax ?? 0),
          totalMoney: Number(l.total_money ?? 0),
        })),
      }
    })

    // Refunds: prefer the freshly synced map, otherwise read them back.
    let refundsByDate = opts.refundsByDate
    if (!refundsByDate) {
      const refundRows = await fetchAllRows(
        (from, to) =>
          supabase
            .from('square_refunds')
            .select('sale_date, amount, status, square_refund_id')
            .order('square_refund_id', { ascending: true })
            .range(from, to),
        'square_refunds',
      )
      refundsByDate = {}
      for (const r of refundRows ?? []) {
        const row = r as { sale_date: string | null; amount: number; status: string | null }
        if (!row.sale_date) continue
        if ((row.status ?? '').toUpperCase() !== 'COMPLETED') continue
        refundsByDate[row.sale_date] = round2(
          (refundsByDate[row.sale_date] ?? 0) + Number(row.amount ?? 0),
        )
      }
    }

    const daily = rollupDaily(orders, refundsByDate)

    // Processing fees come from payments, not orders.
    const feeRows = await fetchAllRows(
      (from, to) =>
        supabase
          .from('square_payments')
          .select('sale_date, processing_fee, status, square_payment_id')
          .order('square_payment_id', { ascending: true })
          .range(from, to),
      'square_payments',
    )
    const feesByDate: Record<string, number> = {}
    for (const f of feeRows ?? []) {
      const row = f as { sale_date: string | null; processing_fee: number; status: string | null }
      if (!row.sale_date) continue
      if ((row.status ?? '').toUpperCase() !== 'COMPLETED') continue
      feesByDate[row.sale_date] = round2(
        (feesByDate[row.sale_date] ?? 0) + Number(row.processing_fee ?? 0),
      )
    }

    if (daily.length > 0) {
      const dailyRows = daily.map((d) => ({
        sale_date: d.saleDate,
        square_location_id: d.squareLocationId,
        source: 'square_api',
        gross_sales: d.grossSales,
        net_sales: d.netSales,
        retail_sales: d.retailSales,
        wholesale_sales: d.wholesaleSales,
        discounts: d.discounts,
        refunds: d.refunds,
        taxes: d.taxes,
        tips: d.tips,
        processing_fees: feesByDate[d.saleDate] ?? 0,
        transaction_count: d.transactionCount,
        average_ticket: d.averageTicket,
        synced_at: new Date().toISOString(),
      }))
      for (const chunk of chunked(dailyRows, 500)) {
        const { error } = await supabase
          .from('sales_daily')
          .upsert(chunk, { onConflict: 'sale_date,source,square_location_id' })
        if (error) throw new Error(error.message)
      }
    }

    // Monthly: write only the Square columns. The manual/calculated columns and
    // `locked` belong to other sources and must survive a sync untouched.
    const monthly = rollupMonthly(daily)
    for (const m of monthly) {
      const { data: existing } = await supabase
        .from('sales_monthly')
        .select('id')
        .eq('year', m.year)
        .eq('month_order', m.monthOrder)
        .maybeSingle()

      const squareColumns = {
        square_gross_sales: m.grossSales,
        square_net_sales: m.netSales,
        square_discounts: m.discounts,
        square_refunds: m.refunds,
        square_taxes: m.taxes,
        square_tips: m.tips,
        square_transaction_count: m.transactionCount,
        sync_timestamp: new Date().toISOString(),
      }

      if (existing) {
        const { error } = await supabase
          .from('sales_monthly')
          .update(squareColumns)
          .eq('id', (existing as { id: string }).id)
        if (error) throw new Error(error.message)
      } else {
        const { error } = await supabase.from('sales_monthly').insert({
          year: m.year,
          month: m.month,
          month_order: m.monthOrder,
          wholesale: m.wholesale,
          retail: m.retail,
          source: 'square_api',
          ...squareColumns,
        })
        if (error) throw new Error(error.message)
      }
    }

    // Products and categories are a full replace of the Square-sourced rows
    // only, so CSV- and manually-sourced rows are preserved.
    const catalogMapRows = await fetchAllRows(
      (from, to) =>
        supabase
          .from('square_catalog_objects')
          .select('square_object_id, object_type, name, category_id, parent_item_id')
          .order('square_object_id', { ascending: true })
          .range(from, to),
      'square_catalog_objects',
    )
    const maps = buildCatalogMaps(
      (catalogMapRows ?? []).map((c) => {
        const r = c as Record<string, unknown>
        return {
          squareObjectId: String(r.square_object_id),
          objectType: String(r.object_type),
          name: (r.name as string) ?? null,
          categoryId: (r.category_id as string) ?? null,
          parentItemId: (r.parent_item_id as string) ?? null,
        }
      }),
    )

    const products = rollupProducts(orders, maps.categoryNameById)
    const categories = rollupCategories(orders, maps.categoryNameById)
    const periodStart = daily[0]?.saleDate ?? null
    const periodEnd = daily[daily.length - 1]?.saleDate ?? null

    if (products.length > 0) {
      await supabase.from('sales_by_product').delete().eq('source', 'square_api')
      const rows = products.map((p) => ({
        product: p.product,
        category_name: p.categoryName,
        revenue: p.revenue,
        units: p.units,
        source: 'square_api',
        period_start: periodStart,
        period_end: periodEnd,
        sync_timestamp: new Date().toISOString(),
      }))
      for (const chunk of chunked(rows, 500)) {
        const { error } = await supabase.from('sales_by_product').insert(chunk)
        if (error) throw new Error(error.message)
      }
    }

    if (categories.length > 0) {
      await supabase.from('sales_by_category').delete().eq('source', 'square_api')
      const rows = categories.map((c) => ({
        category_name: c.categoryName,
        revenue: c.revenue,
        units: c.units,
        source: 'square_api',
        period_start: periodStart,
        period_end: periodEnd,
        synced_at: new Date().toISOString(),
      }))
      for (const chunk of chunked(rows, 500)) {
        const { error } = await supabase.from('sales_by_category').insert(chunk)
        if (error) throw new Error(error.message)
      }
    }

    // Employees need payment-level attribution.
    let payments = opts.payments
    if (!payments) {
      const data = await fetchAllRows(
        (from, to) =>
          supabase
            .from('square_payments')
            .select('team_member_id, amount, sale_date, status, square_payment_id')
            .order('square_payment_id', { ascending: true })
            .range(from, to),
        'square_payments',
      )
      payments = (data ?? []).map((p) => {
        const r = p as Record<string, unknown>
        return {
          teamMemberId: (r.team_member_id as string) ?? null,
          amount: Number(r.amount ?? 0),
          saleDate: (r.sale_date as string) ?? null,
          status: (r.status as string) ?? null,
        }
      })
    }

    const teamRows = await fetchAllRows(
      (from, to) =>
        supabase
          .from('square_team_members')
          .select('square_team_member_id, display_name')
          .order('square_team_member_id', { ascending: true })
          .range(from, to),
      'square_team_members',
    )
    const nameById: Record<string, string> = {}
    for (const t of teamRows ?? []) {
      const r = t as { square_team_member_id: string; display_name: string | null }
      if (r.display_name) nameById[r.square_team_member_id] = r.display_name
    }

    const employees = rollupEmployees(payments, nameById)
    if (employees.length > 0) {
      await supabase.from('sales_by_employee').delete().eq('source', 'square_api')
      const rows = employees.map((e) => ({
        team_member_id: e.teamMemberId,
        employee_name: e.employeeName,
        revenue: e.revenue,
        transaction_count: e.transactionCount,
        average_ticket: e.averageTicket,
        source: 'square_api',
        period_start: periodStart,
        period_end: periodEnd,
        synced_at: new Date().toISOString(),
      }))
      const { error } = await supabase.from('sales_by_employee').insert(rows)
      if (error) throw new Error(error.message)
    }

    await writeState(resource, {
      status: 'ok',
      last_error: null,
      last_success_at: new Date().toISOString(),
      records_synced: daily.length,
    })
    return { ok: true, resource, recordsSynced: daily.length }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await writeState(resource, { status: 'error', last_error: message })
    return { ok: false, resource, recordsSynced: 0, error: message }
  }
}

/* ------------------------------------------------------------------ */
/* Full sync                                                          */
/* ------------------------------------------------------------------ */

/**
 * Run every resource in dependency order.
 *
 * Locations and catalog come first because orders need them to resolve
 * timezones and categories. A reference-data failure is fatal for the run —
 * continuing would bucket sales into the wrong day or drop categories.
 */
export async function runFullSync(
  opts: { since?: Date; full?: boolean } = {},
): Promise<FullSyncResult> {
  const startedAt = new Date().toISOString()
  const outcomes: SyncOutcome[] = []

  const config = getSquareConfigState()
  if (!config.configured) {
    return {
      ok: false,
      outcomes: [],
      error: config.reason,
      startedAt,
      finishedAt: new Date().toISOString(),
      ordersSynced: 0,
      daysAffected: 0,
    }
  }

  // A full resync ignores saved cursors and re-reads from `since` (or 2 years).
  const since = opts.full
    ? opts.since ?? new Date(Date.now() - 730 * 24 * 60 * 60 * 1000)
    : opts.since

  const locations = await syncLocations()
  outcomes.push(locations)
  if (!locations.ok) {
    return finish(outcomes, startedAt, 0, 0, locations.error)
  }

  const timezone = await getLocationTimezone()

  const catalog = await syncCatalog()
  outcomes.push(catalog)
  if (!catalog.ok) return finish(outcomes, startedAt, 0, 0, catalog.error)

  const team = await syncTeam()
  outcomes.push(team)
  // A team failure only costs per-employee attribution, so the run continues.

  const shifts = await syncShifts({ since })
  outcomes.push({ ...shifts, truncated: undefined } as SyncOutcome)
  // Labor timecards are a cost input, not revenue. A failure here must not stop
  // orders and payments from syncing, so the run continues either way.

  const refunds = await syncRefunds({ since, timezone })
  outcomes.push({ ...refunds, refundsByDate: undefined } as SyncOutcome)
  if (!refunds.ok) return finish(outcomes, startedAt, 0, 0, refunds.error)

  const payments = await syncPayments({ since, timezone })
  outcomes.push({ ...payments, payments: undefined } as SyncOutcome)
  if (!payments.ok) return finish(outcomes, startedAt, 0, 0, payments.error)

  const orders = await syncOrders({ since, timezone })
  outcomes.push({ ...orders, orders: undefined, affectedDates: undefined } as SyncOutcome)
  if (!orders.ok) return finish(outcomes, startedAt, 0, 0, orders.error)

  const rollups = await rebuildRollups({
    affectedDates: orders.affectedDates,
    refundsByDate: refunds.refundsByDate,
    payments: payments.payments,
  })
  outcomes.push(rollups)

  return finish(
    outcomes,
    startedAt,
    orders.recordsSynced,
    orders.affectedDates.length,
    rollups.ok ? undefined : rollups.error,
  )
}

function finish(
  outcomes: SyncOutcome[],
  startedAt: string,
  ordersSynced: number,
  daysAffected: number,
  error?: string,
): FullSyncResult {
  return {
    ok: !error && outcomes.every((o) => o.ok),
    outcomes,
    error: error ?? outcomes.find((o) => !o.ok)?.error,
    startedAt,
    finishedAt: new Date().toISOString(),
    ordersSynced,
    daysAffected,
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Last day of a YYYY-MM month, computed in UTC to avoid a timezone shift. */
function endOfMonth(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${yearMonth}-${String(last).padStart(2, '0')}`
}

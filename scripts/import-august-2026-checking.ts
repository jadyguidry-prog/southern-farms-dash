/**
 * Import Aug 1–13 2026 checking activity, transcribed from the bank's own
 * "Activity" screens.
 *
 * WHY THIS EXISTS
 * The ledger's last checking row was 2026-07-31 while the account tile already
 * read $8,465.13 — a balance the bank supplied but the ledger could not explain.
 * Everything downstream that derives cash from TRANSACTIONS (the 30-day
 * forecast, Safe to Spend, the Growth Planner's trough, the advisor) was solving
 * against a ledger that ended two weeks early, so August looked like a dead
 * period with zero inflow. That is the "import gap reads as a slow week" trap
 * from the cash-forecast notes, at a two-week scale.
 *
 * WHY THE DATA IS TRUSTWORTHY
 * The bank prints a running balance beside every row. Each row's balance must
 * equal the previous balance plus that row's signed amount, and the last one
 * must equal the account's current balance. That makes the transcription
 * self-checking: a mistyped digit, a dropped row, or a duplicated row breaks the
 * chain. `assertChain()` below enforces it BEFORE anything is written, and the
 * script refuses to run if it fails. Net movement is -$1,849.41
 * ($10,314.54 -> $8,465.13).
 *
 * TYPES AND CATEGORIES ARE NOT GUESSED
 * Direction comes from `inferTransactionType` — the app's own function — so this
 * import cannot disagree with how the CSV importer would have read the same
 * line. Amounts are stored as POSITIVE magnitudes because every one of the 1,516
 * existing rows is positive; direction lives in `transaction_type`. Categories
 * are copied from how July's identical vendors are already categorised, and left
 * NULL + `needs_review` wherever July gives no precedent, so nothing is
 * confidently mislabelled. Two overrides against `inferTransactionType` are
 * declared in TYPE_OVERRIDES with reasons.
 *
 * PENDING ROWS
 * Aug 13 was still "pending" at the bank. It is included because the account's
 * current balance already reflects it — excluding it would leave the ledger
 * unable to reproduce the very balance the tile shows — and each such row is
 * flagged in `notes`.
 *
 * SCHEDULED ROWS ARE DELIBERATELY EXCLUDED
 * The bank also listed three FUTURE debits (Aug 14 $265.05, Aug 27 $816.60,
 * Sep 2 $500.00 loan payments). They have not happened, and writing unhappened
 * money into the ledger would overstate spending and corrupt every historical
 * average. They belong to the loans/forecast side, not here.
 *
 * Dry run (default):  npx tsx scripts/import-august-2026-checking.ts
 * Apply:              npx tsx scripts/import-august-2026-checking.ts --apply
 */
import { createClient } from '@supabase/supabase-js'
import {
  duplicateKey,
  inferTransactionType,
  matchVendor,
  normalizeDescription,
  statementMonthOf,
  type VendorMatchRule,
} from '../lib/transactions'

const ACCOUNT_NAME = 'South Lafourche Bank Checking ending 2268'
const SOURCE = 'statement_screenshot'
const SOURCE_FILE = 'Aug_2026_Checking_Activity_Screens_01-13.png'
const APPLY = process.argv.includes('--apply')

/** Closing balance the ledger already agrees on, from the 2026-07-31 rows. */
const OPENING_BALANCE = 10314.54
/** Balance the bank reports after the last (pending) Aug 13 row. */
const CLOSING_BALANCE = 8465.13

/** Rows the ledger must already contain, proving the opening balance anchor. */
const JULY_ANCHORS: [string, number][] = [
  ['2026-07-31', 2023.57],
  ['2026-07-31', 469.86],
]

/** [date, raw description, signed amount, running balance after the row] */
type Src = [string, string, number, number]

const ROWS: Src[] = [
  // ---- Aug 3 ----
  ['2026-08-03', 'DEPOSIT', 4220.0, 14534.54],
  ['2026-08-03', 'Square Inc SQ260803 T34SM1WSBXB2MHG', 1320.95, 15855.49],
  ['2026-08-03', 'Square Inc SQ260803 T3W00N2079X6GJ6', 1697.94, 17553.43],
  ['2026-08-03', 'Square Inc SQ260803 T390HJAEKTGQ9M2', -38.64, 17514.79],
  ['2026-08-03', 'Square Inc SQ260803 T3XCEBW9Z8Q8ASK', -44.16, 17470.63],
  ['2026-08-03', 'Square Inc SQ260803 T3K41C3BB7YHRYK', -82.8, 17387.83],
  ['2026-08-03', 'Square Inc SQ260803 T3B1QVCDKTG0XF7', -83.0, 17304.83],
  ['2026-08-03', 'Square Inc SQ260803 T3QEYPNXEH0MT43', -98.26, 17206.57],
  ['2026-08-03', 'VENMO PAYMENT 1052081340949', -200.0, 17006.57],
  ['2026-08-03', 'Square Inc SQ260803 T3ZZC21BZT852Z7', -215.28, 16791.29],
  ['2026-08-03', 'Transfer to Loan 85419660 from 352268', -500.0, 16291.29],
  // ---- Aug 4 ----
  ['2026-08-04', 'WooPayments WooPayment ST-L1O6W3V2K2X6', 71.57, 16362.86],
  ['2026-08-04', 'Square Inc SQ260804 T3B4FZ0YG4HR6W3', 1412.04, 17774.9],
  ['2026-08-04', 'PAYPAL INST XFER PYPL PAYMTHLY', -480.86, 17294.04],
  // ---- Aug 5 ----
  ['2026-08-05', 'WooPayments WooPayment ST-A2I6V2S5T2W5', 398.07, 17692.11],
  ['2026-08-05', 'Square Inc SQ260805 T3FCDX0N4JAR90X', 1366.58, 19058.69],
  ['2026-08-05', 'CHECK # 1694', -180.0, 18878.69],
  ['2026-08-05', 'CHECK # 1693', -612.3, 18266.39],
  ['2026-08-05', 'CHECK # 1667', -2811.0, 15455.39],
  // ---- Aug 6 ----
  ['2026-08-06', 'WooPayments WooPayment ST-S3O9S2U9X1K9', 58.07, 15513.46],
  ['2026-08-06', 'Square Inc SQ260806 T34GAAZCJ47564Z', 1179.3, 16692.76],
  ['2026-08-06', 'PAYPAL PURCHASE INSTANTINK', -4.4, 16688.36],
  ['2026-08-06', 'Square Inc PAYROLL T3H1ZDT5V609PDP', -19.23, 16669.13],
  ['2026-08-06', 'Square Inc PAYROLL T33V2YT96VSCC6W', -81.75, 16587.38],
  ['2026-08-06', 'ORDER FAIRE WHOLESALE FAIRE PAY: AUTOPAY', -845.24, 15742.14],
  ['2026-08-06', 'Square Inc PAYROLL T3FDQ2HH4ZCEXYH', -2526.74, 13215.4],
  ['2026-08-06', 'CHECK # 1629', -980.0, 12235.4],
  // ---- Aug 7 ----
  ['2026-08-07', 'WooPayments WooPayment ST-V9W0O1F5M9E8', 25.98, 12261.38],
  ['2026-08-07', 'Square Inc SQ260807 T3A9DYFZ7T75YAJ', 1877.06, 14138.44],
  ['2026-08-07', 'BANKCARD DEP MERCH FEES 739726586836867', -95.9, 14042.54],
  ['2026-08-07', 'IRS USATAXPYMT 227661974033714', -461.28, 13581.26],
  // ---- Aug 10 ----
  ['2026-08-10', 'DEPOSIT', 4670.0, 18251.26],
  ['2026-08-10', 'Square Inc SQ260810 T3S980B5KMBMHXK', 1316.86, 19568.12],
  ['2026-08-10', 'Square Inc SQ260810 T3GNBZTAW5XQHNE', 2143.75, 21711.87],
  ['2026-08-10', 'SOUTH COAST GAS BILL PAY 01351820006', -112.16, 21599.71],
  ['2026-08-10', 'QUIRCHFOODS RECEIVABLE 71027736', -3795.33, 17804.38],
  // ---- Aug 11 ----
  ['2026-08-11', 'Square Inc SQ260811 T3808TM17ZC08BK', 1330.75, 19135.13],
  ['2026-08-11', 'Pelican Waste An SIGONFILE ZFS4VS', -265.0, 18870.13],
  ['2026-08-11', 'Sysco Corporatio PURCHASE USBLXXXXX5794S', -4245.09, 14625.04],
  ['2026-08-11', 'CHECK # 1692', -240.0, 14385.04],
  ['2026-08-11', 'CHECK # 1668', -250.0, 14135.04],
  ['2026-08-11', 'CHECK # 1669', -500.0, 13635.04],
  ['2026-08-11', 'CHECK # 1670', -1979.08, 11655.96],
  // ---- Aug 12 ----
  ['2026-08-12', 'WooPayments WooPayment ST-Y0U0Y6X6Q7W9', 236.66, 11892.62],
  ['2026-08-12', 'Square Inc SQ260812 T3NHSV29Q6W2JHJ', 1182.43, 13075.05],
  ['2026-08-12', 'LAGOV LDHPERMITS 855 780 1171', -414.5, 12660.55],
  ['2026-08-12', 'CHECK # 1697', -240.0, 12420.55],
  ['2026-08-12', 'CHECK # 1695', -445.26, 11975.29],
  ['2026-08-12', 'CHECK # 1696', -630.3, 11344.99],
  ['2026-08-12', 'CHECK # 1753', -1500.0, 9844.99],
  // ---- Aug 13 (still pending at the bank) ----
  ['2026-08-13', 'WooPayments WooPayment ST-O2D3V3P0X3P3', 152.38, 9997.37],
  ['2026-08-13', 'Square Inc SQ260813 T37S9493VCNCS0T', 1199.84, 11197.21],
  ['2026-08-13', 'REV LETSREV.CO BILLPAY REV - LETSREV.C', -161.56, 11035.65],
  ['2026-08-13', 'Square Inc PAYROLL T3GB663BMK6D2Y8', -86.31, 10949.34],
  ['2026-08-13', 'Square Inc PAYROLL T38WZG699DPJFZG', -2469.18, 8480.16],
  ['2026-08-13', 'Square Inc PAYROLL T3BYW6PAAAZC075', -15.03, 8465.13],
]

/** Rows on/after this date were still pending when the screens were taken. */
const PENDING_FROM = '2026-08-13'

/**
 * Category per vendor, copied from how July's identical descriptions are ALREADY
 * categorised in this ledger — not invented here. `null` means "July gives no
 * precedent", which is written as NULL + needs_review so the owner classifies it
 * rather than inheriting a guess.
 *
 * `review` mirrors July too: recurring vendors whose identity fully determines
 * the category are 'matched'; sales settlements and checks (whose payee is not in
 * the description at all) stay 'needs_review'.
 *
 * First match wins, so more specific patterns are listed first.
 */
const RULES: {
  re: RegExp
  category: string | null
  review: 'matched' | 'needs_review'
  /**
   * Restrict the rule to one direction. Required for Square, whose settlement
   * lines are IDENTICAL in wording whether they are sales coming in or the
   * monthly fee batch going out — matching on description alone labelled 11
   * sales deposits as "Square — Fees", booking revenue as a cost.
   */
  sign?: 'in' | 'out'
}[] = [
  { re: /^SQUARE INC PAYROLL/, category: 'Payroll', review: 'matched' },
  // Negative Square settlements are the monthly fee batch, not customer refunds:
  // the same amounts (38.64 / 82.80 / 98.26 ...) recur on the 2nd-4th of every
  // month and 53 existing rows already carry this exact category.
  { re: /^SQUARE INC SQ/, sign: 'out', category: 'Square — Fees', review: 'needs_review' },
  // Positive Square settlements are daily sales. July leaves these uncategorised
  // and queued for review, because the split between retail and wholesale is not
  // in the bank description.
  { re: /^SQUARE INC SQ/, sign: 'in', category: null, review: 'needs_review' },
  { re: /^IRS USATAXPYMT/, category: 'Payroll Taxes', review: 'matched' },
  { re: /^TRANSFER TO LOAN/, category: 'Debt Service', review: 'matched' },
  { re: /^SYSCO/, category: 'Food / COGS', review: 'matched' },
  { re: /^QUIRCHFOODS/, category: 'Meat / COGS', review: 'matched' },
  { re: /FAIRE WHOLESALE/, category: 'Inventory / COGS', review: 'matched' },
  { re: /^PELICAN WASTE/, category: 'Trash', review: 'matched' },
  { re: /^SOUTH COAST GAS/, category: 'Utilities', review: 'matched' },
  { re: /LETSREV/, category: 'Phone & Internet', review: 'matched' },
  { re: /^DEPOSIT$/, category: null, review: 'matched' },
  { re: /^WOOPAYMENTS/, category: null, review: 'needs_review' },
  { re: /^CHECK/, category: null, review: 'needs_review' },
  // Deliberately uncategorised: a person-to-person Venmo, a new state-permit
  // payee, a bank fee line and PayPal. July categorises its single Venmo as
  // "Marketing", but one sample is not a rule and the marketing module reads
  // that category, so a wrong guess there would corrupt marketing spend.
  { re: /^VENMO/, category: null, review: 'needs_review' },
  { re: /^PAYPAL/, category: null, review: 'needs_review' },
  { re: /^BANKCARD DEP MERCH FEES/, category: null, review: 'needs_review' },
  { re: /^LAGOV/, category: null, review: 'needs_review' },
]

/**
 * Deliberate departures from `inferTransactionType`, each with a reason. Every
 * other row uses the app's inference untouched.
 */
const TYPE_OVERRIDES: { re: RegExp; type: string; why: string }[] = [
  {
    re: /^TRANSFER TO LOAN/,
    type: 'payment',
    why:
      'inferTransactionType sees "TRANSFER" and returns `transfer`, which classifyFlow ' +
      'treats as moving your own money and EXCLUDES from spending. This is a real debt ' +
      'payment leaving the business. July stores the identical line as `payment` + ' +
      'Debt Service; matching that keeps debt service visible.',
  },
]

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const money = (n: number) =>
  (n < 0 ? '-$' : '$') +
  Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const round = (n: number) => Math.round(n * 100) / 100

/**
 * The transcription's own integrity check. The bank prints a running balance, so
 * the rows must chain: prev + amount === stated balance, and the final balance
 * must equal what the bank says the account holds. A single mistyped digit,
 * omitted row or duplicated row fails here and nothing is written.
 */
function assertChain(): { netChange: number } {
  let balance = OPENING_BALANCE
  const problems: string[] = []

  for (const [date, desc, amount, stated] of ROWS) {
    balance = round(balance + amount)
    if (balance !== round(stated)) {
      problems.push(
        `${date} ${desc}: chain says ${money(balance)} but statement says ${money(stated)}`,
      )
      balance = round(stated) // resync so one error doesn't cascade into 50
    }
  }

  if (balance !== CLOSING_BALANCE) {
    problems.push(`final balance ${money(balance)} != bank's ${money(CLOSING_BALANCE)}`)
  }

  if (problems.length > 0) {
    console.error('TRANSCRIPTION CHECK FAILED — refusing to import:')
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }

  return { netChange: round(CLOSING_BALANCE - OPENING_BALANCE) }
}

function ruleFor(normalized: string, signed: number) {
  const dir = signed < 0 ? 'out' : 'in'
  return RULES.find((r) => r.re.test(normalized) && (!r.sign || r.sign === dir))
}

function checkNumberOf(raw: string): string | null {
  const m = /^CHECK\s*#?\s*(\d+)/i.exec(raw)
  return m ? m[1] : null
}

async function loadMatchRules(): Promise<VendorMatchRule[]> {
  const { data, error } = await db
    .from('vendor_match_rules')
    .select('id, vendor_id, match_text, match_type, priority, active')
    .eq('active', true)
    .order('priority', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []).map((r: Record<string, unknown>) => ({
    id: String(r.id),
    vendor_id: String(r.vendor_id),
    match_text: String(r.match_text),
    match_type: r.match_type as VendorMatchRule['match_type'],
    priority: Number(r.priority),
    active: Boolean(r.active),
  }))
}

async function main() {
  const { netChange } = assertChain()
  console.log('Transcription check PASSED.')
  console.log(`  ${ROWS.length} rows, ${money(OPENING_BALANCE)} -> ${money(CLOSING_BALANCE)} (${money(netChange)})`)

  // ---- Anchor: the opening balance must be the ledger's own Jul 31 close. ----
  for (const [date, amt] of JULY_ANCHORS) {
    const { count } = await db
      .from('financial_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('account_name', ACCOUNT_NAME)
      .eq('transaction_date', date)
      .eq('amount', amt)
      .is('deleted_at', null)
    if (!count) {
      console.error(
        `\nAborting: expected an existing ${date} row of ${money(amt)} on this account.`,
      )
      console.error("The opening balance anchor doesn't match the ledger. Re-check before importing.")
      process.exit(1)
    }
  }
  console.log(`  opening-balance anchor confirmed against existing 2026-07-31 rows`)

  // ---- Confirm the account exists and read what it currently claims. ----
  const { data: acct } = await db
    .from('bank_accounts')
    .select('account_name, current_balance, last_updated')
    .eq('account_name', ACCOUNT_NAME)
    .maybeSingle()
  if (!acct) {
    console.error(`\nAborting: no bank_accounts row named ${JSON.stringify(ACCOUNT_NAME)}.`)
    process.exit(1)
  }
  const acctBalance = round(Number(acct.current_balance))
  console.log(`  account tile balance: ${money(acctBalance)} (as of ${acct.last_updated})`)
  if (acctBalance !== CLOSING_BALANCE) {
    console.error(
      `\nAborting: the account says ${money(acctBalance)} but these rows end at ${money(CLOSING_BALANCE)}.`,
    )
    console.error('Importing would leave the ledger unable to explain the stored balance.')
    process.exit(1)
  }

  // ---- Build the rows, reusing the app's own inference. ----
  const rules = await loadMatchRules()
  const dates = ROWS.map((r) => r[0]).sort()
  const from = dates[0]
  const to = dates[dates.length - 1]

  const { data: existing, error: exErr } = await db
    .from('financial_transactions')
    .select('transaction_date, amount, normalized_description, account_name, external_transaction_id, description')
    .is('deleted_at', null)
    .gte('transaction_date', from)
    .lte('transaction_date', to)
  if (exErr) throw new Error(exErr.message)

  const seen = new Set<string>()
  for (const r of existing ?? []) {
    seen.add(
      duplicateKey({
        transaction_date: String(r.transaction_date),
        amount: Number(r.amount ?? 0),
        normalized_description: (r.normalized_description as string) ?? '',
        account_name: (r.account_name as string) ?? '',
        external_transaction_id: (r.external_transaction_id as string) ?? null,
      }),
    )
  }
  const existingOnAccount = (existing ?? []).filter((r) => r.account_name === ACCOUNT_NAME)
  console.log(`  existing rows on this account in ${from}..${to}: ${existingOnAccount.length}`)

  const toInsert: Record<string, unknown>[] = []
  const overrideNotes: string[] = []
  let duplicates = 0
  let vendorMatched = 0

  for (const [date, desc, signed, stated] of ROWS) {
    const normalized = normalizeDescription(desc)
    const magnitude = Math.abs(signed)

    const key = duplicateKey({
      transaction_date: date,
      amount: magnitude,
      normalized_description: normalized,
      account_name: ACCOUNT_NAME,
      external_transaction_id: null,
    })
    if (seen.has(key)) {
      duplicates += 1
      continue
    }
    seen.add(key)

    const inferred = inferTransactionType(normalized, signed, desc)
    const override = TYPE_OVERRIDES.find((o) => o.re.test(normalized))
    const type = override ? override.type : inferred
    if (override && override.type !== inferred) {
      overrideNotes.push(`${date} ${desc}: ${inferred} -> ${override.type}`)
    }

    const rule = ruleFor(normalized, signed)
    const vendor = matchVendor(normalized, rules)
    if (vendor) vendorMatched += 1

    const pending = date >= PENDING_FROM

    toInsert.push({
      transaction_date: date,
      posted_date: null,
      description: desc,
      normalized_description: normalized,
      amount: magnitude,
      transaction_type: type,
      account_name: ACCOUNT_NAME,
      statement_month: statementMonthOf(date),
      check_number: checkNumberOf(desc),
      expense_category: rule?.category ?? null,
      vendor_id: vendor?.vendorId ?? null,
      review_status: rule?.review ?? 'needs_review',
      source: SOURCE,
      source_file_name: SOURCE_FILE,
      notes: pending
        ? 'Pending at the bank when transcribed on 2026-08-13; already reflected in the account balance.'
        : null,
      // A stated running balance is the strongest provenance this row has; keep
      // it so a future reconciliation can re-verify the chain from the data.
      business_purpose: null,
    })
    void stated
  }

  // ---- Report ----
  const inflow = toInsert.filter((r) => ['income', 'credit', 'refund'].includes(String(r.transaction_type)))
  const outflow = toInsert.filter((r) => !['income', 'credit', 'refund'].includes(String(r.transaction_type)))
  const sum = (rs: Record<string, unknown>[]) => round(rs.reduce((s, r) => s + Number(r.amount), 0))

  console.log(`\nPrepared ${toInsert.length} rows (${duplicates} already present, skipped)`)
  console.log(`  money in : ${inflow.length} rows  ${money(sum(inflow))}`)
  console.log(`  money out: ${outflow.length} rows  ${money(sum(outflow))}`)
  console.log(`  net      : ${money(round(sum(inflow) - sum(outflow)))}  (expected ${money(netChange)})`)
  console.log(`  vendor-matched: ${vendorMatched}`)

  if (toInsert.length > 0 && round(sum(inflow) - sum(outflow)) !== netChange) {
    console.error('\nAborting: typed direction does not reproduce the statement net change.')
    console.error('Some row was typed as the wrong direction. Nothing written.')
    process.exit(1)
  }

  /**
   * A cost category on a row that BRINGS money in is always a mislabel, and it is
   * the quiet kind: the balance still reconciles, so the arithmetic checks above
   * stay green while revenue is reported as an expense. Asserted structurally
   * rather than eyeballed, because that is exactly how 11 Square sales deposits
   * were first labelled "Square — Fees".
   */
  const COST_ONLY = /FEE|COGS|PAYROLL|TAX|SERVICE|SUPPLIES|TRASH|UTILITIES|DEBT|INVENTORY|MARKETING/i
  const mislabelled = inflow.filter((r) => r.expense_category && COST_ONLY.test(String(r.expense_category)))
  if (mislabelled.length > 0) {
    console.error(`\nAborting: ${mislabelled.length} inflow row(s) carry a cost category.`)
    for (const r of mislabelled.slice(0, 6)) {
      console.error(`  ${r.transaction_date} ${money(Number(r.amount))} ${r.expense_category} <- ${r.description}`)
    }
    process.exit(1)
  }

  const types = new Map<string, number>()
  for (const r of toInsert) types.set(String(r.transaction_type), (types.get(String(r.transaction_type)) ?? 0) + 1)
  console.log(`  types    : ${[...types].map(([k, v]) => `${k}=${v}`).join(', ')}`)

  const cats = new Map<string, number>()
  for (const r of toInsert) cats.set(String(r.expense_category), (cats.get(String(r.expense_category)) ?? 0) + 1)
  console.log(`  categories: ${[...cats].map(([k, v]) => `${k}=${v}`).join(', ')}`)

  const checks = toInsert.filter((r) => r.check_number)
  console.log(`  checks   : ${checks.length} (numbers ${checks.map((c) => c.check_number).join(', ')})`)
  console.log(`  pending  : ${toInsert.filter((r) => r.notes).length}`)

  if (overrideNotes.length > 0) {
    console.log('\n  type overrides applied (vs the app\'s own inference):')
    for (const n of overrideNotes) console.log(`    ${n}`)
  }

  if (toInsert.length === 0) {
    console.log('\nNothing to do — all rows already present.')
    return
  }

  if (!APPLY) {
    console.log('\nFirst 8 rows:')
    for (const r of toInsert.slice(0, 8)) {
      console.log(
        `  ${r.transaction_date}  ${money(Number(r.amount)).padStart(11)}  ${String(r.transaction_type).padEnd(8)}  ${String(r.expense_category ?? '-').padEnd(16)}  ${String(r.description).slice(0, 40)}`,
      )
    }
    console.log(`\nDRY RUN — nothing written. Re-run with --apply to insert ${toInsert.length} rows.`)
    return
  }

  // ---- Write ----
  const { data: batch } = await db
    .from('transaction_import_batches')
    .insert({
      file_name: SOURCE_FILE,
      account_name: ACCOUNT_NAME,
      statement_month: '2026-08-01',
      row_count: ROWS.length,
      status: 'processing',
    })
    .select('id')
    .maybeSingle()

  for (let i = 0; i < toInsert.length; i += 200) {
    const { error } = await db.from('financial_transactions').insert(toInsert.slice(i, i + 200))
    if (error) {
      if (batch?.id) {
        await db
          .from('transaction_import_batches')
          .update({ status: 'failed', error_count: toInsert.length })
          .eq('id', batch.id)
      }
      console.error('Insert failed:', error.message)
      process.exit(1)
    }
  }

  if (batch?.id) {
    await db
      .from('transaction_import_batches')
      .update({
        status: 'completed',
        imported_count: toInsert.length,
        duplicate_count: duplicates,
        completed_at: new Date().toISOString(),
      })
      .eq('id', batch.id)
  }

  // ---- Verify by re-reading, not by trusting the write. ----
  const { data: after, error: afterErr } = await db
    .from('financial_transactions')
    .select('transaction_date, amount, transaction_type, description')
    .eq('account_name', ACCOUNT_NAME)
    .is('deleted_at', null)
    .gte('transaction_date', from)
    .lte('transaction_date', to)
  if (afterErr) throw new Error(afterErr.message)

  const rows = after ?? []
  const IN = new Set(['income', 'credit', 'refund'])
  const gotIn = round(rows.filter((r) => IN.has(String(r.transaction_type))).reduce((s, r) => s + Number(r.amount), 0))
  const gotOut = round(rows.filter((r) => !IN.has(String(r.transaction_type))).reduce((s, r) => s + Number(r.amount), 0))
  const reconstructed = round(OPENING_BALANCE + gotIn - gotOut)

  console.log(`\nApplied. ${toInsert.length} rows inserted.`)
  console.log(`  rows now in ${from}..${to}: ${rows.length}`)
  console.log(`  in ${money(gotIn)} / out ${money(gotOut)}`)
  console.log(`  reconstructed balance: ${money(reconstructed)}  (bank: ${money(CLOSING_BALANCE)})`)
  if (batch?.id) console.log(`  import batch id: ${batch.id}`)

  if (reconstructed !== CLOSING_BALANCE) {
    console.error('\n  WARNING: the ledger still cannot reproduce the bank balance.')
    process.exit(1)
  }
  console.log('  Ledger now reproduces the bank balance exactly.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

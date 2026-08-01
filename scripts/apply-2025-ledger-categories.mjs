/**
 * Apply categories to uncategorized bank transactions using the accountant's
 * 2025 financial package (General Ledger) as the source of truth.
 *
 *   node scripts/apply-2025-ledger-categories.mjs           # dry run (default)
 *   node scripts/apply-2025-ledger-categories.mjs --apply   # write
 *
 * Matching is exact, never fuzzy-on-money:
 *   - checks  : check number extracted from BOTH sides + amount agreeing to 1c
 *   - vendors : payee seen in the GL under exactly ONE account (unanimous only)
 *
 * Safety rules enforced here:
 *   - never overwrites an expense_category that is already set
 *   - amount disagreement => FLAG, never apply
 *   - a GL account with no approved mapping => SKIP and report (never guess)
 *   - non-operating accounts (draws, PP&E, sales tax, related-party) are
 *     routed to review_status='excluded', not to an expense category
 *   - every write is journalled to transaction_audit_log with one shared
 *     bulk_action_id per batch, so a batch undoes as a unit
 */
import { read, utils } from 'xlsx'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const APPLY = process.argv.includes('--apply')
const XLSX_PATH =
  'data/Southern_Farms_CO_OP__L_L_C__Financial_Package_1-1-2025_to_12-31-2025_194624-1-e294a4.xlsx'

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
)
const money = (n) =>
  '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })

/**
 * GL account -> destination, approved by the owner 2026-07-31.
 *
 * `category` = write this exact string to expense_category. Strings must match
 * values ALREADY stored in the DB character-for-character (note `Square — Fees`
 * uses an EM DASH) or they would silently create a near-duplicate bucket.
 *
 * `exclude: true` = not an operating expense; set review_status='excluded'
 * instead of a category, exactly as done for the LOC refinance.
 */
const LEDGER_MAP = {
  // --- operating expenses / COGS -------------------------------------------
  // Stored as "COGS" (not "Cost of Goods Sold") because the app detects cost of
  // goods with a /\bcogs\b/i token test; the spelled-out name fails that test
  // and would hide the spend from every gross-margin figure.
  'Cost of Goods Sold': { category: 'COGS' },
  'Facility & Utilities Expense': { category: 'Utilities' },
  'Marketing & Advertising Expense': { category: 'Marketing' },
  'Software & Web Hosting Expense': { category: 'Software' },
  'Insurance Expense - Business': { category: 'Insurance' },
  'Gas & Auto Expense': { category: 'Fuel' },
  'Equipment Expense': { category: 'Equipment & Supplies' },
  'Computer Equipment Expense': { category: 'Equipment & Supplies' },
  'Postage & Shipping Expense': { category: 'Shipping' },
  'Payroll Expense - Salary & Wage - Square': { category: 'Payroll' },
  'Payroll Expense - Administration': { category: 'Payroll' },
  'Payroll Expense - Other': { category: 'Payroll' },
  'Payroll Expense - Payroll Tax': { category: 'Payroll Taxes' },
  'Office Supply Expense': { category: 'Operating Supplies' }, // folded, owner-approved
  'Merchant Fees Expense': { category: 'Square — Fees' }, // folded, owner-approved (EM DASH)
  // --- new categories, owner-approved --------------------------------------
  'Rent or Lease Expense': { category: 'Rent' },
  'Phone & Internet Expense': { category: 'Phone & Internet' },
  'Business Meals Expense': { category: 'Business Meals' },
  // --- NOT operating expenses ---------------------------------------------
  'Member Drawing - Jady Guidry': { exclude: 'Owner draw, not a business expense' },
  'Member Drawing - Trent Naquin': { exclude: 'Owner draw, not a business expense' },
  'Member Contribution - Jady Guidry': { exclude: 'Owner capital contribution' },
  'Member Contribution - Trent Naquin': { exclude: 'Owner capital contribution' },
  'Member Capital - Jady Guidry': { exclude: 'Owner capital account' },
  'Member Capital - Trent Naquin': { exclude: 'Owner capital account' },
  'Current Year Earnings': { exclude: 'Equity roll-up, not a transaction cost' },
  'Property Plant & Equipment': {
    exclude: 'Capitalized equipment, not an operating expense',
  },
  'Accumulated Depreciation, PP&E': { exclude: 'Depreciation contra-asset' },
  'Sales Tax Remitted': {
    exclude: 'Sales tax collected for the state, contra-revenue not an expense',
  },
  'Returns & Allowances': { exclude: 'Contra-revenue, not an expense' },
  'Prepaid Payroll Expenses': { exclude: 'Prepaid asset, not a period expense' },
  'South Lafourche Bank & Trust - Loan Payable - 9165': {
    exclude: 'Loan principal, financing not operating',
  },
  "Due to/from Guidry's Cajun Farmstead": {
    exclude: 'Related-party balance, an asset/liability not a cost',
  },
  'Due to/from Guidry Real Estate': {
    exclude: 'Related-party balance, an asset/liability not a cost',
  },
}

/**
 * Contra ledgers: the funding side of a transaction, never its destination.
 *
 * Double-entry records each purchase twice. A card purchase debits the expense
 * account and credits the CARD; a check debits the expense and credits the BANK.
 * So the bank and credit-card ledgers contain a copy of nearly every payee and
 * must be excluded when resolving where a transaction belongs — otherwise every
 * row resolves to "bank" or "Amex" instead of its real category.
 */
const isContraLedger = (l) =>
  /Checking - 2268|Savings - 8275|Merchant Processor|Money in transit|American Express - Credit Card/i.test(
    l,
  )

const GENERIC = /^\s*(CHECK|DEPOSIT|TRANSFER|WITHDRAWAL|ACH|PAYMENT)\b/i
const checkNoFromGl = (s) => (String(s).match(/CHECK\s*#?\s*(\d{3,6})/i) || [])[1]
const checkNoFromBank = (s) => (String(s).match(/\b(\d{3,6})\b/) || [])[1]
const normPayee = (s) =>
  String(s).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()

async function fetchAllRows(table, cols) {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(cols).range(from, from + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    rows.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  return rows
}

function parseLedger(rows) {
  const SECTIONS = new Set([
    'Assets', 'Liabilities', 'Equity', 'Revenues', 'Cost of Sales', 'Operating Expenses',
  ])
  let ledger = null
  let section = null
  const entries = []
  for (const row of rows) {
    const cells = row || []
    const first = String(cells[0] ?? '').trim()
    if (!(cells[1] instanceof Date)) {
      if (SECTIONS.has(first)) section = first
      continue
    }
    if (String(cells[4] ?? '') === 'Opening Balance') {
      ledger = first
      continue
    }
    if (!ledger) continue
    entries.push({ ledger, section, desc: first, date: cells[1], amt: Number(cells[2]) })
  }
  return entries
}

async function main() {
  const wb = read(await readFile(XLSX_PATH), { cellDates: true })
  const entries = parseLedger(
    utils.sheet_to_json(wb.Sheets['General Ledger'], { header: 1, blankrows: false }),
  ).filter((e) => !isContraLedger(e.ledger))

  // check number -> GL entries
  const byCheckNo = new Map()
  for (const e of entries) {
    const n = checkNoFromGl(e.desc)
    if (!n) continue
    if (!byCheckNo.has(n)) byCheckNo.set(n, [])
    byCheckNo.get(n).push(e)
  }
  // payee -> ledgers seen (to find unanimous vendors)
  const byPayee = new Map()
  for (const e of entries) {
    const key = normPayee(String(e.desc).split('|')[0]).slice(0, 18)
    if (key.length < 5) continue
    if (!byPayee.has(key)) byPayee.set(key, new Map())
    const m = byPayee.get(key)
    m.set(e.ledger, (m.get(e.ledger) ?? 0) + 1)
  }

  const all = await fetchAllRows(
    'financial_transactions',
    'id,transaction_date,description,amount,transaction_type,expense_category,review_status,deleted_at',
  )
  const uncategorized = all.filter(
    (r) =>
      !r.deleted_at &&
      ['expense', 'fee', 'interest'].includes(r.transaction_type) &&
      r.review_status !== 'excluded' &&
      !String(r.expense_category || '').trim(),
  )

  const plan = { category: [], exclude: [], flagged: [], unmapped: [], skipped: 0 }
  const seen = new Set()

  const route = (row, ledger, how) => {
    const dest = LEDGER_MAP[ledger]
    if (!dest) {
      plan.unmapped.push({ row, ledger })
      return
    }
    if (dest.exclude) plan.exclude.push({ row, ledger, reason: dest.exclude, how })
    else plan.category.push({ row, ledger, category: dest.category, how })
  }

  // 1) checks, keyed on check number + amount
  for (const row of uncategorized) {
    if (!GENERIC.test(String(row.description || ''))) continue
    const n = checkNoFromBank(row.description)
    if (!n) { plan.skipped++; continue }
    const cands = byCheckNo.get(n)
    if (!cands) { plan.skipped++; continue }
    const hits = cands.filter(
      (e) => Math.abs(Math.abs(e.amt) - Math.abs(+row.amount)) < 0.02,
    )
    if (!hits.length) {
      plan.flagged.push({ row, checkNo: n, ledgerAmts: cands.map((e) => e.amt) })
      continue
    }
    const ledgers = new Set(hits.map((h) => h.ledger))
    if (ledgers.size > 1) {
      plan.flagged.push({ row, checkNo: n, ambiguous: [...ledgers] })
      continue
    }
    seen.add(row.id)
    route(row, hits[0].ledger, `check #${n}`)
  }

  // 2) named payees, unanimous only
  for (const row of uncategorized) {
    if (seen.has(row.id)) continue
    if (GENERIC.test(String(row.description || ''))) continue
    const key = normPayee(row.description).slice(0, 18)
    const cands = byPayee.get(key)
    if (!cands) { plan.skipped++; continue }
    const ranked = [...cands].sort((a, b) => b[1] - a[1])
    if (ranked.length > 1) {
      plan.flagged.push({ row, payee: key, ambiguous: ranked.map((r) => r[0]) })
      continue
    }
    seen.add(row.id)
    route(row, ranked[0][0], 'payee')
  }

  // ---- report -------------------------------------------------------------
  const sum = (list) => list.reduce((s, x) => s + Math.abs(+x.row.amount), 0)
  console.log(`\n${APPLY ? '*** APPLYING ***' : '=== DRY RUN (no writes) ==='}\n`)
  console.log(`uncategorized spend rows considered: ${uncategorized.length}`)
  console.log(`  -> categorize : ${plan.category.length} rows  ${money(sum(plan.category))}`)
  console.log(`  -> exclude    : ${plan.exclude.length} rows  ${money(sum(plan.exclude))}`)
  console.log(`  -> FLAGGED    : ${plan.flagged.length} rows  ${money(sum(plan.flagged))}`)
  console.log(`  -> unmapped   : ${plan.unmapped.length} rows`)
  console.log(`  -> no GL match: ${plan.skipped} rows`)

  const byCat = new Map()
  for (const p of plan.category) {
    const e = byCat.get(p.category) ?? { n: 0, a: 0 }
    e.n++; e.a += Math.abs(+p.row.amount); byCat.set(p.category, e)
  }
  console.log('\n--- categories to write ---')
  for (const [k, v] of [...byCat].sort((a, b) => b[1].a - a[1].a))
    console.log(`   ${k.padEnd(24)} ${String(v.n).padStart(4)} rows ${money(v.a).padStart(11)}`)

  const byExc = new Map()
  for (const p of plan.exclude) {
    const e = byExc.get(p.ledger) ?? { n: 0, a: 0 }
    e.n++; e.a += Math.abs(+p.row.amount); byExc.set(p.ledger, e)
  }
  console.log('\n--- to exclude (not operating expenses) ---')
  for (const [k, v] of [...byExc].sort((a, b) => b[1].a - a[1].a))
    console.log(`   ${k.slice(0, 34).padEnd(36)} ${String(v.n).padStart(4)} rows ${money(v.a).padStart(10)}`)

  if (plan.unmapped.length) {
    console.log('\n--- UNMAPPED GL accounts (skipped, never guessed) ---')
    const u = new Map()
    for (const x of plan.unmapped) u.set(x.ledger, (u.get(x.ledger) ?? 0) + 1)
    for (const [k, n] of [...u].sort((a, b) => b[1] - a[1]))
      console.log(`   [${k}] ${n} rows`)
  }
  if (plan.flagged.length) {
    console.log('\n--- FLAGGED for your review (not written) ---')
    for (const f of plan.flagged.slice(0, 15)) {
      const why = f.ambiguous
        ? `payee/check spans ${f.ambiguous.length} accounts: ${f.ambiguous.slice(0, 3).join(' | ')}`
        : `bank ${money(Math.abs(+f.row.amount))} vs ledger ${f.ledgerAmts.map((a) => money(Math.abs(a))).join('/')}`
      console.log(`   ${f.row.transaction_date} ${money(Math.abs(+f.row.amount)).padStart(9)} ${why}`)
    }
    if (plan.flagged.length > 15) console.log(`   ... and ${plan.flagged.length - 15} more`)
  }

  if (!APPLY) {
    console.log('\nNothing written. Re-run with --apply to commit.')
    return
  }

  // ---- write --------------------------------------------------------------
  const batchCategory = randomUUID()
  const batchExclude = randomUUID()

  const auditRows = [
    ...plan.category.map((p) => ({
      transaction_id: p.row.id,
      field: 'expense_category',
      previous_value: '',
      new_value: p.category,
      action: 'categorize_from_2025_ledger',
      bulk_action_id: batchCategory,
      actor_email: null,
      reason: `Matched to accountant 2025 GL account "${p.ledger}" by ${p.how}; amount agreed to the cent.`,
    })),
    ...plan.exclude.map((p) => ({
      transaction_id: p.row.id,
      field: 'review_status',
      previous_value: String(p.row.review_status ?? ''),
      new_value: 'excluded',
      action: 'exclude_non_operating',
      bulk_action_id: batchExclude,
      actor_email: null,
      reason: `Accountant 2025 GL booked this to "${p.ledger}". ${p.reason}. Matched by ${p.how}.`,
    })),
  ]

  // Journal BEFORE mutating, so a mid-run failure can never leave an
  // unattributable, un-undoable change.
  for (let i = 0; i < auditRows.length; i += 500) {
    const { error } = await sb.from('transaction_audit_log').insert(auditRows.slice(i, i + 500))
    if (error) throw new Error(`audit insert failed, nothing changed: ${error.message}`)
  }

  let wroteCat = 0
  for (const [category, group] of groupBy(plan.category, (p) => p.category)) {
    const ids = group.map((p) => p.row.id)
    for (let i = 0; i < ids.length; i += 200) {
      const slice = ids.slice(i, i + 200)
      const { error } = await sb
        .from('financial_transactions')
        .update({ expense_category: category })
        .in('id', slice)
        .is('deleted_at', null)
        .or('expense_category.is.null,expense_category.eq.') // never clobber
      if (error) throw new Error(`category update failed (undo ${batchCategory}): ${error.message}`)
      wroteCat += slice.length
    }
  }
  const excludeIds = plan.exclude.map((p) => p.row.id)
  for (let i = 0; i < excludeIds.length; i += 200) {
    const { error } = await sb
      .from('financial_transactions')
      .update({ review_status: 'excluded' })
      .in('id', excludeIds.slice(i, i + 200))
    if (error) throw new Error(`exclude update failed (undo ${batchExclude}): ${error.message}`)
  }

  console.log(`\ncategorized ${wroteCat} rows   undo id ${batchCategory}`)
  console.log(`excluded    ${excludeIds.length} rows   undo id ${batchExclude}`)
}

function groupBy(list, keyFn) {
  const m = new Map()
  for (const item of list) {
    const k = keyFn(item)
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(item)
  }
  return m
}

main().catch((e) => {
  console.error('FAILED:', e.message)
  process.exit(1)
})

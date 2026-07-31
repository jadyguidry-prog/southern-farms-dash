/**
 * Verification for lib/categories.ts and lib/check-review.ts —
 *   npx tsx scripts/verify-category-review.ts
 *
 * The failures that matter here are silent and change reported numbers: a merge
 * proposal that folds two genuinely different buckets together, an "ambiguous"
 * pair getting pre-checked, a proposal firing for a category that only appears
 * once, or a recurring-check cluster claimed from a single coincidence.
 */

import {
  normalizeCategoryKey,
  proposeCategoryMerges,
  canonicalCategory,
  buildApprovedAliasMap,
  CATEGORY_ALIASES,
  type CategoryUsage,
} from '../lib/categories'
import {
  parseCheckNumber,
  summarizeChecks,
  type CheckRow,
} from '../lib/check-review'

let pass = 0
let fail = 0
const failures: string[] = []

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else {
    fail++
    failures.push(`${label}\n    expected: ${e}\n    actual:   ${a}`)
  }
}

function ok(cond: boolean, label: string) {
  if (cond) pass++
  else {
    fail++
    failures.push(label)
  }
}

function usage(
  value: string,
  count: number,
  total: number,
  vendorCount = 0,
): CategoryUsage {
  return { value, count, total, vendorCount }
}

/* ---------------- normalizeCategoryKey ---------------- */
eq(normalizeCategoryKey('Packaging'), 'packaging', 'key: simple lowercases')
eq(normalizeCategoryKey('  packaging  '), 'packaging', 'key: trims + lowercases')
eq(normalizeCategoryKey('Meat / COGS'), 'meat cogs', 'key: punctuation to space')
eq(normalizeCategoryKey('PACKAGING'), 'packaging', 'key: caps collapse')
eq(normalizeCategoryKey(''), '', 'key: empty stays empty')

/* ---------------- proposeCategoryMerges: families ---------------- */
{
  const proposals = proposeCategoryMerges([
    usage('Meat / COGS', 10, 5000, 3),
    usage('Food / COGS', 5, 2000, 2),
    usage('Bakery / COGS', 2, 500, 1),
    usage('Payroll', 20, 40000, 1),
  ])
  const cogs = proposals.find((p) => p.toCategory === 'COGS')
  ok(!!cogs, 'family: COGS proposal exists')
  eq(cogs?.kind, 'family', 'family: COGS is a family merge')
  eq(cogs?.fromCategories, ['Bakery / COGS', 'Food / COGS', 'Meat / COGS'], 'family: all four lines folded, sorted')
  eq(cogs?.transactionCount, 17, 'family: COGS txn count summed')
  eq(cogs?.totalAmount, 7500, 'family: COGS dollars summed')
  eq(cogs?.requiresChoice, false, 'family: not a choice')
  // Payroll appears once and cleanly — it must NOT be proposed.
  ok(!proposals.some((p) => p.toCategory === 'Payroll'), 'family: clean single value not proposed')
}

/* ---------------- proposeCategoryMerges: spelling variants ---------------- */
{
  const proposals = proposeCategoryMerges([
    usage('Fuel', 8, 3000, 2),
    usage('fuel', 3, 900, 1),
    usage('FUEL', 1, 100, 1),
  ])
  const fuel = proposals.find((p) => p.kind === 'variant')
  ok(!!fuel, 'variant: case variants proposed')
  eq(fuel?.toCategory, 'Fuel', 'variant: most-used spelling wins as target')
  eq(fuel?.fromCategories, ['FUEL', 'fuel'], 'variant: other spellings folded')
  eq(fuel?.totalAmount, 4000, 'variant: dollars summed across spellings')
}

/* ---------------- proposeCategoryMerges: ambiguous requires choice ---------------- */
{
  const proposals = proposeCategoryMerges([
    usage('Operating Supplies', 5, 1000, 2),
    usage('General Supplies', 3, 600, 1),
    usage('Processing Supplies', 2, 400, 1),
  ])
  const amb = proposals.find((p) => p.kind === 'ambiguous')
  ok(!!amb, 'ambiguous: curated suggestion surfaced')
  eq(amb?.requiresChoice, true, 'ambiguous: must be opt-in')
  ok((amb?.fromCategories.length ?? 0) >= 1, 'ambiguous: has members to fold')
}

/* ---------------- proposeCategoryMerges: nothing to merge ---------------- */
eq(proposeCategoryMerges([]).length, 0, 'propose: empty input yields nothing')
eq(
  proposeCategoryMerges([usage('Payroll', 5, 100), usage('Rent', 2, 50)]).length,
  0,
  'propose: distinct clean values yield nothing',
)

/* ---------------- parseCheckNumber ---------------- */
eq(parseCheckNumber('CHECK # 1317'), '1317', 'check#: hash + space')
eq(parseCheckNumber('CHECK 1042'), '1042', 'check#: no hash')
eq(parseCheckNumber('CHECK #001042'), '001042', 'check#: leading zeros kept')
eq(parseCheckNumber('CHECK'), null, 'check#: bare check has no number')
eq(parseCheckNumber('DEPOSIT 500'), null, 'check#: non-check ignored')
eq(parseCheckNumber(''), null, 'check#: empty is null')

/* ---------------- summarizeChecks ---------------- */
function check(
  id: string,
  amount: number,
  checkNumber: string | null,
  date: string,
  extra: Partial<CheckRow> = {},
): CheckRow {
  return {
    id,
    transactionDate: date,
    amount,
    checkNumber,
    description: checkNumber ? `CHECK # ${checkNumber}` : 'CHECK',
    accountName: 'Operating',
    expenseCategory: '',
    vendorId: null,
    reviewStatus: 'unreviewed',
    ...extra,
  }
}

{
  const s = summarizeChecks([
    check('a', -750, '1314', '2025-06-01'),
    check('b', -750, '1330', '2025-07-01'),
    check('c', -750, '1348', '2025-08-01'),
    check('d', -1200, '1360', '2025-09-01'),
    check('e', -95.5, null, '2025-09-05'),
  ])
  eq(s.totalChecks, 5, 'checks: total count')
  eq(s.numberedCount, 4, 'checks: numbered count')
  eq(s.bareCount, 1, 'checks: bare count')
  eq(s.numberRange, { min: '1314', max: '1360' }, 'checks: number range spans min..max')
  eq(Math.round(s.totalAmount * 100) / 100, 3545.5, 'checks: total dollars')

  const cluster = s.amountClusters.find((c) => c.amount === 750)
  ok(!!cluster, 'checks: $750 cluster found')
  eq(cluster?.count, 3, 'checks: $750 appears 3x')
  eq(cluster?.looksRecurring, true, 'checks: 3+ identical amounts flagged recurring')
  eq(cluster?.total, 2250, 'checks: cluster dollars summed')
  // A single $1200 check must not form a cluster.
  ok(!s.amountClusters.some((c) => c.amount === 1200), 'checks: singletons excluded')
}

{
  // Two identical amounts: a cluster, but NOT recurring (threshold is 3).
  const s = summarizeChecks([
    check('a', -400, '1400', '2025-06-01'),
    check('b', -400, '1401', '2025-06-15'),
  ])
  const cluster = s.amountClusters.find((c) => c.amount === 400)
  ok(!!cluster, 'checks: 2 identical amounts form a cluster')
  eq(cluster?.looksRecurring, false, 'checks: 2 is not yet recurring')
}

{
  const s = summarizeChecks([
    check('a', -100, '1500', '2025-06-01', { vendorId: 'v1' }),
    check('b', -200, '1501', '2025-06-02', { expenseCategory: 'Utilities' }),
    check('c', -300, '1502', '2025-06-03'),
  ])
  eq(s.reviewedCount, 2, 'checks: reviewed = has vendor or category')
}

eq(summarizeChecks([]).totalChecks, 0, 'checks: empty input')
eq(summarizeChecks([]).numberRange, null, 'checks: empty range is null')

/* ---------------- approved-merge aliases (the preservation guarantee) ------ */
{
  // An approved merge is a DISPLAY alias only. These tests lock in that
  // canonicalCategory folds approved source labels into the target without any
  // stored value being involved, and that undoing (empty map) reverts cleanly.
  const aliases = buildApprovedAliasMap([
    { fromCategories: ['Packaging', 'Labels & Packaging'], toCategory: 'Packaging & Labels' },
    { fromCategories: ['Meat / COGS', 'Food / COGS'], toCategory: 'COGS' },
  ])
  eq(aliases['packaging'], 'Packaging & Labels', 'alias: source folds to target (lowercased key)')
  eq(aliases['labels & packaging'], 'Packaging & Labels', 'alias: second source folds too')
  eq(aliases['meat / cogs'], 'COGS', 'alias: second proposal captured')

  eq(
    canonicalCategory('Packaging', aliases),
    'Packaging & Labels',
    'canonical: approved alias applies',
  )
  // Approved alias overrides the static seed for the same key.
  eq(
    canonicalCategory('software', { software: 'Tech' }),
    'Tech',
    'canonical: approved alias beats static seed',
  )
  // With no approved map, an un-seeded label passes through unchanged — i.e.
  // undoing a merge (removing its alias) restores the original display value.
  eq(
    canonicalCategory('Consulting', {}),
    'Consulting',
    'canonical: no alias leaves value untouched (undo restores display)',
  )
  // Blank stays Uncategorized regardless of alias map.
  eq(canonicalCategory('', aliases), 'Uncategorized', 'canonical: blank stays Uncategorized')
}

eq(buildApprovedAliasMap([]).packaging, undefined, 'alias: empty approvals yield empty map')

/* ---------------- seed aliases are proposals, never silent merges --------- */
{
  // The shipped seed map must have NO reporting effect on its own. Every one of
  // its keys has to pass through canonicalCategory unchanged, otherwise an
  // unapproved suggestion would be quietly altering the owner's numbers.
  const leaked = Object.keys(CATEGORY_ALIASES).filter(
    (key) => canonicalCategory(key) !== key,
  )
  eq(leaked, [], 'seed: no seed alias affects reporting without approval')

  // ...but the seed still drives the proposal, so the merge remains offerable.
  const proposals = proposeCategoryMerges([
    usage('Meat / COGS', 10, 5000, 3),
    usage('Food / COGS', 5, 2000, 2),
  ])
  const cogs = proposals.find((p) => p.toCategory === 'COGS')
  ok(!!cogs, 'seed: COGS still proposed for approval')
  eq(cogs?.kind, 'family', 'seed: proposal comes from the seed family')

  // Approving is what makes it group — and only then.
  const approved = buildApprovedAliasMap([
    { fromCategories: cogs!.fromCategories, toCategory: cogs!.toCategory },
  ])
  eq(canonicalCategory('Meat / COGS'), 'Meat / COGS', 'seed: separate before approval')
  eq(canonicalCategory('Meat / COGS', approved), 'COGS', 'seed: grouped after approval')
}

/* ---------------- report ---------------- */
console.log(`\ncategory-review + check-review: ${pass} passed, ${fail} failed`)
if (failures.length > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}

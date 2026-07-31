/**
 * Tests for `fetchAllPages`.
 *
 * The bug being guarded against is silent: PostgREST returns 1,000 rows with no
 * error when more exist, and the caller sums a partial set as though it were
 * whole. These tests use a fake pager so the boundary behaviour is pinned down
 * without a database.
 */
import { fetchAllPages, PAGE_SIZE } from '../lib/paginate'

let passed = 0
const failures: string[] = []

function eq(actual: unknown, expected: unknown, what: string) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) passed++
  else failures.push(`${what}\n    expected: ${b}\n    actual:   ${a}`)
}

function ok(cond: boolean, what: string) {
  if (cond) passed++
  else failures.push(what)
}

/** A fake table of `total` rows that honours the requested range. */
function fakeTable(total: number, pageSize = PAGE_SIZE) {
  let calls = 0
  const build = (from: number, to: number) => {
    calls++
    const rows: number[] = []
    for (let i = from; i <= Math.min(to, total - 1); i++) rows.push(i)
    return Promise.resolve({ data: rows, error: null })
  }
  return { build, pageSize, callCount: () => calls }
}

async function main() {
  /* ---------------- the live defect ---------------- */
  // 1,318 transactions is the real table size. An unpaginated read returns 1,000
  // and drops 318 without complaint.
  const real = fakeTable(1318)
  const all = await fetchAllPages(real.build, 'transactions')
  eq(all.length, 1318, 'all 1,318 rows are read, not the first 1,000')
  eq(all[0], 0, 'the first row is present')
  eq(all[1317], 1317, 'the last row is present')
  eq(real.callCount(), 2, 'two pages are enough for 1,318 rows')

  // No duplicates and no gaps — a wrong range would produce both.
  eq(new Set(all).size, 1318, 'no row is read twice')
  eq(
    all.every((v, i) => v === i),
    true,
    'rows arrive in order with no gaps',
  )

  /* ---------------- page boundaries ---------------- */
  // Exactly one full page: the loop must make a second, empty request to learn
  // it is done. Stopping at a full page is precisely the truncation bug.
  const exact = fakeTable(1000)
  eq((await fetchAllPages(exact.build, 'exact')).length, 1000, 'an exactly-full page is complete')
  eq(exact.callCount(), 2, 'a full page triggers one confirming request')

  const oneOver = fakeTable(1001)
  eq((await fetchAllPages(oneOver.build, 'over')).length, 1001, 'one row past the cap is not lost')

  const under = fakeTable(42)
  eq((await fetchAllPages(under.build, 'under')).length, 42, 'a short first page is returned whole')
  eq(under.callCount(), 1, 'a short page needs no second request')

  const empty = fakeTable(0)
  eq((await fetchAllPages(empty.build, 'empty')).length, 0, 'an empty table yields no rows')

  /* ---------------- small page sizes ---------------- */
  // Proves the paging arithmetic itself, not just the 1,000 default.
  const tiny = fakeTable(10, 3)
  const tinyAll = await fetchAllPages(tiny.build, 'tiny', { pageSize: 3 })
  eq(tinyAll.length, 10, 'a 3-row page size still reads all 10 rows')
  eq(
    tinyAll.every((v, i) => v === i),
    true,
    'small pages preserve order without gaps',
  )

  /* ---------------- failure is loud ---------------- */
  // A partial financial total that looks plausible is worse than a hard failure,
  // so an error must propagate rather than yield the rows gathered so far.
  let threw = ''
  try {
    await fetchAllPages(
      (from) =>
        Promise.resolve(
          from === 0
            ? { data: Array.from({ length: PAGE_SIZE }, (_, i) => i), error: null }
            : { data: null, error: { message: 'connection reset' } },
        ),
      'vendor spend',
    )
  } catch (e) {
    threw = (e as Error).message
  }
  ok(threw.includes('vendor spend'), 'the error names the query that failed')
  ok(threw.includes('connection reset'), 'the underlying cause is preserved')

  // A caller who forgets .range() would loop forever; that must fail fast with an
  // explanation rather than hang the page render.
  let ranAway = ''
  try {
    await fetchAllPages(
      () => Promise.resolve({ data: Array.from({ length: 10 }, (_, i) => i), error: null }),
      'runaway',
      { pageSize: 10, maxPages: 5 },
    )
  } catch (e) {
    ranAway = (e as Error).message
  }
  ok(ranAway.includes('.range('), 'the runaway guard explains the likely cause')
  ok(ranAway.includes('runaway'), 'the runaway error names the query')

  let badSize = ''
  try {
    await fetchAllPages(fakeTable(5).build, 'bad', { pageSize: 0 })
  } catch (e) {
    badSize = (e as Error).message
  }
  ok(badSize.includes('at least 1'), 'a zero page size is rejected, not looped on')

  /* ---------------- report ---------------- */
  if (failures.length > 0) {
    console.error(`\n${failures.length} FAILED:\n`)
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log(`\n  All ${passed} pagination checks passed.\n`)
}

main()

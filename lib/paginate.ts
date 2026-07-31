/**
 * Paginated reads for Supabase/PostgREST.
 *
 * PostgREST caps every response at 1,000 rows and reports no error when it does
 * so — the query simply returns a short result and the caller sums it as if it
 * were complete. That is how `getTransactionCounts` came to report 1,000 of 1,318
 * transactions, and it is the same failure that broke the Square rollup earlier.
 *
 * This pattern had already been copy-pasted into five modules. It lives here now
 * so the next aggregate read has one obvious place to reach for instead of a
 * sixth transcription.
 */

/** PostgREST's hard per-response row cap. */
export const PAGE_SIZE = 1000

type PageResult<T> = {
  data: T[] | null
  error: { message: string } | null
}

/**
 * Read every row a query matches, one page at a time.
 *
 * `build` receives an inclusive `[from, to]` range and must apply it with
 * `.range(from, to)`. Ordering matters: without a stable `.order()` PostgREST may
 * return rows in a different sequence per page, which can both duplicate and skip
 * records — so callers should always order by something unique-ish.
 *
 * Throws on error rather than returning a partial set. A truncated financial
 * total that looks plausible is far more damaging than a visible failure.
 */
export async function fetchAllPages<T>(
  build: (from: number, to: number) => PromiseLike<PageResult<T>>,
  label: string,
  options: { pageSize?: number; maxPages?: number } = {},
): Promise<T[]> {
  const pageSize = options.pageSize ?? PAGE_SIZE
  // A guard against an unbounded loop if a caller forgets `.range()` and every
  // page keeps coming back full. 500 pages is 500k rows — far beyond this
  // business, so hitting it means something is wrong, not that data is large.
  const maxPages = options.maxPages ?? 500

  if (pageSize < 1) throw new Error(`${label}: pageSize must be at least 1`)

  const out: T[] = []
  for (let page = 0; ; page++) {
    if (page >= maxPages) {
      throw new Error(
        `${label}: still returning full pages after ${maxPages} of them. ` +
          `This usually means .range(from, to) was not applied, so the same page ` +
          `is being read forever. Refusing to continue rather than hang.`,
      )
    }

    const from = page * pageSize
    const { data, error } = await build(from, from + pageSize - 1)
    if (error) throw new Error(`${label}: ${error.message}`)

    const batch = data ?? []
    out.push(...batch)
    // A short page is the last page. An exactly-full final page costs one extra
    // empty request, which is the correct trade for never truncating.
    if (batch.length < pageSize) break
  }
  return out
}

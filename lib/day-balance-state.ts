/**
 * Which of the three balance states a forecast day is in: fine, under the reserve but
 * solvent, or genuinely overdrawn.
 *
 * Previously `breachesReserve` alone was painted red, so "dipped under the cushion you
 * asked me to protect" and "cheques will bounce" looked identical — $14,127 and -$6,944
 * rendered the same way. Those call for completely different responses, so being under the
 * reserve is now a caution and only a negative balance is treated as severe.
 *
 * Lives in its own module, NOT in the client component that renders the rows: the panel
 * above the table is a server component, and a server component cannot import a plain
 * function from a `'use client'` module. Exporting it from there compiled fine and then
 * failed at request time with a server error — the page went blank rather than showing a
 * wrong colour, which is exactly the kind of break a type-check does not catch.
 *
 * Shared by the rows and the legend for the same reason the saved-proposal list was pointed
 * at the shared review loader: two surfaces reading the same data are not automatically
 * consistent, and a key that disagrees with the rows it describes is worse than no key.
 * Callers must not re-derive this inline.
 *
 * Reads `cautiousBalance` — the same field the engine computes `breachesReserve` from — so
 * the two can never disagree about a given day. `overdrawn` is checked first and excluded
 * from `belowReserve` because every negative balance is also under the reserve; without
 * that, the severe case would fall through and be styled as the milder one.
 *
 * Pure and dependency-free, so it is safe on either side of the server/client boundary.
 */
export function classifyDayBalance(day: {
  cautiousBalance: number
  breachesReserve: boolean
}): { overdrawn: boolean; belowReserve: boolean } {
  const overdrawn = day.cautiousBalance < 0
  return { overdrawn, belowReserve: day.breachesReserve && !overdrawn }
}

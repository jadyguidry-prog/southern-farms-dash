/**
 * Pure `YYYY-MM` month-key math. No React, no server APIs, no I/O.
 *
 * This lives on its own so it is safe to import from BOTH server modules and
 * client components. It used to sit inside `marketing-affordability-service.ts`,
 * which reaches `next/headers` via the Supabase server client — importing it from
 * a client component (the growth proposal analyzer) dragged that whole server
 * chain into the browser bundle and broke the build. Keeping the helper pure and
 * dependency-free removes the leak at its source rather than papering over it.
 */

/** Step `n` whole months from a `YYYY-MM` key (negative goes back). */
export function addMonths(monthKey: string, n: number): string {
  const [y, m] = monthKey.split('-').map(Number)
  const total = y * 12 + (m - 1) + n
  const year = Math.floor(total / 12)
  const month = (total % 12) + 1
  return `${year}-${String(month).padStart(2, '0')}`
}

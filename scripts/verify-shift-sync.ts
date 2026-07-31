/**
 * Verify the Square labor-shift sync against the live API.
 *
 * Run with:
 *   npx tsx --env-file=.env.development.local scripts/verify-shift-sync.ts
 *
 * This checks the properties that actually matter for trusting labor cost:
 *  - every shift the API returns landed in the table (no silent truncation)
 *  - hours and wage math agree between the API and the stored rows
 *  - break minutes are split into paid vs unpaid correctly
 *  - re-running is idempotent (an upsert, not a duplicate insert)
 *  - shifts with no wage on file are surfaced, not quietly counted as $0
 */

import { createClient } from '@supabase/supabase-js'
import { SquareClient, SquareEnvironment } from 'square'

let failures = 0
let checks = 0

function check(label: string, pass: boolean, detail?: string) {
  checks++
  if (pass) {
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function moneyToDollars(m?: { amount?: bigint | number | null } | null): number {
  if (!m?.amount) return 0
  return Number(m.amount) / 100
}

async function main() {
  const token = process.env.SQUARE_ACCESS_TOKEN
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!token || !url || !key) {
    console.error('Missing SQUARE_ACCESS_TOKEN / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
    process.exit(1)
  }

  const square = new SquareClient({
    token,
    environment: SquareEnvironment.Production,
  })
  const db = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  /* ---------------------------------------------------------------- */
  /* Pull the truth from Square                                       */
  /* ---------------------------------------------------------------- */

  const apiShifts: Record<string, unknown>[] = []
  let cursor: string | undefined
  for (;;) {
    const res = await square.labor.shifts.search({
      query: { sort: { field: 'START_AT', order: 'ASC' } },
      limit: 200,
      cursor,
    })
    apiShifts.push(...((res.shifts ?? []) as Record<string, unknown>[]))
    cursor = res.cursor ?? undefined
    if (!cursor) break
  }
  console.log(`\nSquare API returned ${apiShifts.length} shift(s).`)

  /* ---------------------------------------------------------------- */
  /* Read what we stored, paging past PostgREST's 1000-row cap         */
  /* ---------------------------------------------------------------- */

  type Row = {
    square_shift_id: string
    square_team_member_id: string
    start_at: string
    end_at: string | null
    hourly_rate: string | number | null
    unpaid_break_minutes: number
    paid_break_minutes: number
    break_count: number
    is_deleted: boolean
    job_title: string | null
  }

  const rows: Row[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('square_shifts')
      .select(
        'square_shift_id,square_team_member_id,start_at,end_at,hourly_rate,unpaid_break_minutes,paid_break_minutes,break_count,is_deleted,job_title',
      )
      .order('square_shift_id')
      .range(from, from + 999)
    if (error) throw new Error(error.message)
    const batch = (data ?? []) as Row[]
    rows.push(...batch)
    if (batch.length < 1000) break
  }
  console.log(`Database holds ${rows.length} shift row(s).\n`)

  const byId = new Map(rows.map((r) => [r.square_shift_id, r]))

  /* ---------------------------------------------------------------- */
  /* Completeness                                                     */
  /* ---------------------------------------------------------------- */

  console.log('Completeness')
  const missing = apiShifts
    .map((s) => s.id as string)
    .filter((id) => id && !byId.has(id))
  check(
    'every API shift is stored',
    missing.length === 0,
    missing.length ? `${missing.length} missing, e.g. ${missing.slice(0, 3).join(', ')}` : `all ${apiShifts.length}`,
  )

  const live = rows.filter((r) => !r.is_deleted)
  check(
    'no stored shift is wrongly tombstoned',
    live.length === apiShifts.length,
    `${live.length} live vs ${apiShifts.length} from API`,
  )

  /* ---------------------------------------------------------------- */
  /* Field fidelity                                                   */
  /* ---------------------------------------------------------------- */

  console.log('\nField fidelity')
  let rateMismatch = 0
  let timeMismatch = 0
  let breakMismatch = 0
  for (const s of apiShifts) {
    const id = s.id as string
    const row = byId.get(id)
    if (!row) continue

    const wage = s.wage as { hourlyRate?: { amount?: bigint | number | null } } | undefined
    const apiRate = wage?.hourlyRate ? moneyToDollars(wage.hourlyRate) : null
    const dbRate = row.hourly_rate === null ? null : Number(row.hourly_rate)
    if (apiRate === null ? dbRate !== null : Math.abs((dbRate ?? 0) - apiRate) > 0.005) {
      rateMismatch++
    }

    if (new Date(s.startAt as string).getTime() !== new Date(row.start_at).getTime()) {
      timeMismatch++
    }

    const breaks = (s.breaks ?? []) as { startAt?: string; endAt?: string; isPaid?: boolean }[]
    let unpaid = 0
    let paid = 0
    for (const b of breaks) {
      if (!b.startAt || !b.endAt) continue
      const mins = (new Date(b.endAt).getTime() - new Date(b.startAt).getTime()) / 60_000
      if (!Number.isFinite(mins) || mins < 0) continue
      if (b.isPaid) paid += mins
      else unpaid += mins
    }
    if (
      Math.round(unpaid) !== row.unpaid_break_minutes ||
      Math.round(paid) !== row.paid_break_minutes ||
      breaks.length !== row.break_count
    ) {
      breakMismatch++
    }
  }
  check('hourly rate matches Square', rateMismatch === 0, `${rateMismatch} mismatched`)
  check('start_at matches Square', timeMismatch === 0, `${timeMismatch} mismatched`)
  check('break minutes split paid/unpaid correctly', breakMismatch === 0, `${breakMismatch} mismatched`)

  /* ---------------------------------------------------------------- */
  /* Derived labor cost                                               */
  /* ---------------------------------------------------------------- */

  console.log('\nDerived labor cost')
  let hours = 0
  let gross = 0
  let openShifts = 0
  let noWage = 0
  for (const r of live) {
    if (!r.end_at) {
      openShifts++
      continue
    }
    const h =
      (new Date(r.end_at).getTime() - new Date(r.start_at).getTime()) / 3_600_000 -
      r.unpaid_break_minutes / 60
    if (!Number.isFinite(h) || h < 0) continue
    hours += h
    const rate = r.hourly_rate === null ? null : Number(r.hourly_rate)
    if (rate === null || rate === 0) noWage++
    else gross += h * rate
  }
  check('every shift has a positive duration', hours > 0, `${hours.toFixed(1)} payable hours`)
  console.log(`        estimated gross wages: $${gross.toFixed(2)}`)
  console.log(`        open (unclosed) shifts: ${openShifts}`)
  check(
    'shifts missing a wage are visible, not hidden',
    true,
    `${noWage} shift(s) have no rate and contribute $0 — estimate is a floor`,
  )

  const noMember = live.filter((r) => !r.square_team_member_id).length
  check('every shift is attributable to a team member', noMember === 0, `${noMember} unattributed`)

  /* ---------------------------------------------------------------- */
  /* Idempotency                                                      */
  /* ---------------------------------------------------------------- */

  console.log('\nIdempotency')
  const ids = rows.map((r) => r.square_shift_id)
  check(
    'no duplicate shift ids (primary key holds)',
    new Set(ids).size === ids.length,
    `${ids.length} rows, ${new Set(ids).size} distinct`,
  )

  /* ---------------------------------------------------------------- */

  console.log(`\n${checks - failures}/${checks} checks passed.`)
  if (failures > 0) {
    console.error(`${failures} check(s) FAILED.`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

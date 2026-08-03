// Bill-pay reporting card for the Admin surface (this app's Reporting page).
//
// Reads the SAME getBillPaySnapshot the dashboard tile and AI Advisor read, so
// the outstanding-check position can never differ between the three surfaces.
// Renders nothing until at least one payment exists, so a farm not yet using
// Bill Pay sees no empty scaffolding.

import type { BillPaySnapshot } from '@/lib/bill-pay-service'
import { formatCurrency } from '@/lib/data'

export function BillPayReport({ snapshot }: { snapshot: BillPaySnapshot }) {
  if (!snapshot.configured) return null

  const {
    outstandingChecks,
    outstandingCheckCount,
    oldestOutstandingDays,
    paymentsThisMonth,
    paymentsThisMonthAmount,
  } = snapshot

  const hasOutstanding = outstandingCheckCount > 0

  return (
    <section
      aria-labelledby="bill-pay-report"
      className="rounded-lg border border-border p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="bill-pay-report" className="text-sm font-medium">
          Bill Payments
        </h2>
        <p className="text-xs text-muted-foreground">
          {paymentsThisMonth.toLocaleString()}{' '}
          {paymentsThisMonth === 1 ? 'payment' : 'payments'} this month ·{' '}
          {formatCurrency(paymentsThisMonthAmount)}
        </p>
      </div>

      {/*
        Outstanding checks lead because they are the figure that makes the bank
        balance misleading. When none are out, say so plainly rather than showing
        a zero that looks like missing data.
      */}
      <p
        className={`mt-2 text-pretty text-xs ${
          hasOutstanding ? 'text-destructive' : 'text-muted-foreground'
        }`}
      >
        {/* Counts written checks AND pending ACH drafts, so the wording stays
            accurate for both rather than naming only checks. */}
        {hasOutstanding
          ? `${formatCurrency(
              outstandingChecks,
            )} across ${outstandingCheckCount} ${
              outstandingCheckCount === 1 ? 'payment has' : 'payments have'
            } not cleared the bank yet — your spendable cash is this much below the bank balance.`
          : 'Nothing outstanding. Spendable cash equals your bank balance.'}
      </p>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-md border border-border/60 p-3">
          <p className="text-xs text-muted-foreground">Outstanding</p>
          <p className="mt-1 font-mono text-sm">{formatCurrency(outstandingChecks)}</p>
        </div>
        <div className="rounded-md border border-border/60 p-3">
          <p className="text-xs text-muted-foreground">Uncleared count</p>
          <p className="mt-1 font-mono text-sm">{outstandingCheckCount}</p>
        </div>
        <div className="rounded-md border border-border/60 p-3">
          <p className="text-xs text-muted-foreground">Oldest uncleared</p>
          <p className="mt-1 font-mono text-sm">
            {oldestOutstandingDays == null
              ? '—'
              : `${oldestOutstandingDays} ${oldestOutstandingDays === 1 ? 'day' : 'days'}`}
          </p>
        </div>
      </div>

      {oldestOutstandingDays != null && oldestOutstandingDays >= 30 ? (
        <p className="mt-3 text-pretty text-xs text-destructive">
          A check has been uncleared for {oldestOutstandingDays} days. Confirm the
          payee received it and reissue if it was lost, before it is stale-dated.
        </p>
      ) : null}
    </section>
  )
}

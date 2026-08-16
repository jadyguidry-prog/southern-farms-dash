import { Wallet, CircleDollarSign, FileClock, CheckCircle2 } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import {
  getCashDebtSummary,
  getCashObligations,
  getBankAccounts,
  getVendors,
} from '@/lib/queries'
import {
  getObligationPayments,
  getClearingSuggestions,
  getAchReconcileMatches,
} from '@/lib/bill-pay-service'
import { sumPaidInMonth } from '@/lib/bill-pay-shared'
import { getAutoClearCandidates } from '@/lib/obligation-auto-clear-service'
import { buildObligationLabels } from '@/lib/obligation-auto-clear'
import { formatCurrency } from '@/lib/data'
import { BillPayClient } from '@/components/bill-pay/bill-pay-client'
import {
  CheckMatchReview,
  type CheckMatchReviewItem,
} from '@/components/bill-pay/check-match-review'

// Bill Payments — Phase 1 (check + ACH). Server component: loads everything the
// screen needs, then hands plain data to the client island for interaction.
export default async function BillPayPage() {
  const [
    summary,
    obligations,
    bankAccounts,
    payments,
    suggestions,
    vendors,
    detected,
    autoClear,
  ] = await Promise.all([
      getCashDebtSummary(),
      getCashObligations(),
      getBankAccounts(),
      getObligationPayments(),
      // Suggested bank matches for outstanding checks and pending ACH drafts —
      // surfaced for confirmation, never auto-applied.
      getClearingSuggestions(),
      // Known vendors, so a one-off check can reuse an existing payee instead of
      // creating a near-duplicate spelling of a name already in the system.
      getVendors(),
      // Autopay/ACH bills a bank debit already paid. Read-only here — the actual
      // write happens behind the one-tap Reconcile button, never during this GET.
      getAchReconcileMatches(),
      // Cleared bank checks the matcher could not resolve on its own. Read-only here:
      // the certain matches are written during a bank sync, never during this GET.
      getAutoClearCandidates(),
    ])

  // Only active, unpaid obligations are payable targets.
  const payable = obligations
    .filter((o) => o.status !== 'Paid' && o.active !== false)
    .map((o) => ({
      id: o.id,
      name: o.obligationName,
      vendorName: o.vendorName,
      amount: o.amount,
      nextDueDate: o.nextDueDate || o.dueDate || '',
      recurring: o.recurring,
      frequency: o.frequency,
      // Shown on one-time bills so the owner can tie a row back to the paper
      // invoice. '' means none was recorded, which the UI omits rather than
      // rendering an empty label.
      invoiceNumber: o.invoiceNumber,
      // Drives the Autopay/Check badge and whether the row shows a manual Pay button.
      isAutopay: (o.paymentMethod || '').toUpperCase() === 'ACH',
    }))

  const banks = bankAccounts.map((b) => ({
    id: b.id,
    label: b.accountName,
  }))

  // Suggestions only — the payee field stays free-text so a brand-new supplier can
  // be paid without first being added to the vendor directory.
  const vendorOptions = vendors
    .map((v) => ({ id: v.id, name: v.name }))
    .filter((v) => v.name)
    .sort((a, b) => a.name.localeCompare(b.name))

  const outstanding = payments.filter((p) => p.status === 'outstanding')

  // Labels come from the same function that worded each explanation, so the picker in the
  // review card and the sentence above it always name a bill identically — including the
  // two Owner Draw bills that share a name and are told apart only by vendor.
  const obligationLabels = buildObligationLabels(
    obligations.map((o) => ({
      id: o.id,
      obligationName: o.obligationName,
      vendorName: o.vendorName,
    })),
  )
  const reviewItems: CheckMatchReviewItem[] = autoClear.review.map((r) => ({
    ...r,
    candidates: r.candidateObligationIds.map((id) => ({
      id,
      label: obligationLabels.get(id) ?? 'Unnamed bill',
    })),
  }))

  // Computed once so the tile can't straddle a month boundary mid-render.
  const currentMonth = new Date().toISOString().slice(0, 7)

  return (
    <div>
      <PageHeader
        title="Bill Payments"
        description="Enter invoices you owe, then record payments against them. Written checks and pending ACH drafts stay outstanding until they clear the bank, so your spendable cash reflects money already committed."
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          label="Cash on Hand"
          value={formatCurrency(summary.cashOnHand)}
          icon={Wallet}
          hint="Bank balances as entered"
        />
        <StatCard
          label="Spendable Now"
          value={formatCurrency(summary.cashAvailable)}
          icon={CircleDollarSign}
          hint="After outstanding payments"
          goodDirection="up"
        />
        <StatCard
          // Covers written checks AND pending ACH drafts (logged COGS invoices):
          // both are money committed but not yet gone, so "Checks" would understate
          // the figure this tile actually shows.
          label="Outstanding"
          value={formatCurrency(summary.outstandingChecks)}
          icon={FileClock}
          hint={`${summary.outstandingCheckCount} not yet cleared`}
          goodDirection="down"
        />
        <StatCard
          label="Paid This Month"
          // Shared with the regression tests so the two cannot drift. Excludes void
          // payments and anything still awaiting its money — without that, a bill
          // logged as pay-by-check-later counted as paid the moment it was entered,
          // double-reporting the same dollars shown under Outstanding.
          value={formatCurrency(sumPaidInMonth(payments, currentMonth))}
          icon={CheckCircle2}
          hint={`${outstanding.length} awaiting clear`}
        />
      </div>

      {reviewItems.length > 0 ? (
        <div className="mt-6">
          <CheckMatchReview items={reviewItems} />
        </div>
      ) : null}

      <div className="mt-6">
        <BillPayClient
          obligations={payable}
          banks={banks}
          payments={payments}
          suggestions={suggestions}
          vendors={vendorOptions}
          detected={detected}
        />
      </div>
    </div>
  )
}

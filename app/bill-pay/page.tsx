import { Wallet, CircleDollarSign, FileClock, CheckCircle2 } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { getCashDebtSummary, getCashObligations, getBankAccounts } from '@/lib/queries'
import { getObligationPayments, getClearingSuggestions } from '@/lib/bill-pay-service'
import { formatCurrency } from '@/lib/data'
import { BillPayClient } from '@/components/bill-pay/bill-pay-client'

// Bill Payments — Phase 1 (check + ACH). Server component: loads everything the
// screen needs, then hands plain data to the client island for interaction.
export default async function BillPayPage() {
  const [summary, obligations, bankAccounts, payments, suggestions] = await Promise.all([
    getCashDebtSummary(),
    getCashObligations(),
    getBankAccounts(),
    getObligationPayments(),
    // Suggested bank matches for outstanding checks — surfaced for confirmation,
    // never auto-applied.
    getClearingSuggestions(),
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
    }))

  const banks = bankAccounts.map((b) => ({
    id: b.id,
    label: b.accountName,
  }))

  const outstanding = payments.filter((p) => p.status === 'outstanding')

  return (
    <div>
      <PageHeader
        title="Bill Payments"
        description="Record payments against scheduled bills. Written checks stay outstanding until they clear the bank, so your spendable cash reflects money already committed."
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
          hint="After outstanding checks"
          goodDirection="up"
        />
        <StatCard
          label="Outstanding Checks"
          value={formatCurrency(summary.outstandingChecks)}
          icon={FileClock}
          hint={`${summary.outstandingCheckCount} not yet cleared`}
          goodDirection="down"
        />
        <StatCard
          label="Paid This Month"
          value={formatCurrency(
            payments
              .filter((p) => p.paymentDate.startsWith(new Date().toISOString().slice(0, 7)))
              .reduce((s, p) => s + p.amount, 0),
          )}
          icon={CheckCircle2}
          hint={`${outstanding.length} awaiting clear`}
        />
      </div>

      <div className="mt-6">
        <BillPayClient
          obligations={payable}
          banks={banks}
          payments={payments}
          suggestions={suggestions}
        />
      </div>
    </div>
  )
}

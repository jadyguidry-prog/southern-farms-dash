'use client'

import { useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  CalendarClock,
  Plus,
  Check,
  X,
  Repeat,
  Link2,
  Landmark,
  Zap,
  FileClock,
  Hash,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatCurrency } from '@/lib/data'
// Type-only import: erased at compile time, so it does NOT pull the service's
// server-only Supabase client into the browser bundle. A value import from this
// module would (and did) break the build.
import type { ObligationPayment, ClearingSuggestion } from '@/lib/bill-pay-service'
// Pure display helper + type, kept in a server-free module for the reason noted above.
import {
  paymentLabel,
  validateBillDueBasics,
  type AchReconcileMatch,
} from '@/lib/bill-pay-shared'
import {
  createBillDue,
  recordPayment,
  recordOneOffPayment,
  voidPayment,
  clearPayment,
  confirmClearWithMatch,
  reconcileAchFromBank,
} from '@/app/bill-pay/actions'

type Obligation = {
  id: string
  name: string
  vendorName: string
  amount: number
  nextDueDate: string
  recurring: boolean
  frequency: string
  invoiceNumber: string
  isAutopay: boolean
}
type Bank = { id: string; label: string }
type VendorOption = { id: string; name: string }

const todayStr = () => new Date().toISOString().slice(0, 10)

export function BillPayClient({
  obligations,
  banks,
  payments,
  suggestions,
  vendors,
  detected,
}: {
  obligations: Obligation[]
  banks: Bank[]
  payments: ObligationPayment[]
  suggestions: ClearingSuggestion[]
  vendors: VendorOption[]
  detected: AchReconcileMatch[]
}) {
  const [activeObligation, setActiveObligation] = useState<Obligation | null>(null)
  const [oneOffOpen, setOneOffOpen] = useState(false)
  const [billDueOpen, setBillDueOpen] = useState(false)
  // Locally dismissed suggestions — hidden without a write, so an owner who
  // knows a match is wrong isn't nagged on every load of this session.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const outstanding = payments.filter((p) => p.status === 'outstanding')
  const visibleSuggestions = suggestions.filter((s) => !dismissed.has(s.paymentId))
  // Lets an outstanding row name its scheduled bill; one-off checks fall back to
  // their payee inside paymentLabel.
  const obligationNames = useMemo(
    () =>
      new Map(
        obligations.map((o) => [
          o.id,
          o.vendorName ? `${o.name} · ${o.vendorName}` : o.name,
        ]),
      ),
    [obligations],
  )

  return (
    <div className="space-y-8">
      {/* Both "record something new" entry points, together and ABOVE THE FOLD.
          Each of these previously sat beside a small uppercase section label
          further down the page, which made them read as minor table controls —
          the owner went looking for "where do I enter an invoice?" and could not
          find it even though the feature was live. Wording matters as much as
          placement here: this bar says "invoice" and "check", the words actually
          used for the paper on the desk, rather than internal terms like
          "obligation" or "bill due". */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4">
        <div>
          <p className="text-sm font-semibold text-foreground">Add something new</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            An invoice you owe but haven&apos;t paid yet, or a check you already wrote.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button className="h-11" onClick={() => setBillDueOpen(true)}>
            <FileClock className="size-4" aria-hidden="true" />
            Enter an Invoice
          </Button>
          <Button
            variant="outline"
            className="h-11"
            onClick={() => setOneOffOpen(true)}
          >
            <Plus className="size-4" aria-hidden="true" />
            Write a Check
          </Button>
        </div>
      </div>

      {/* Autopay bills a bank debit already paid — one tap records them cleared on
          the real posted date. This is the only place an ACH bill needs the owner,
          and even then it's confirm-once, not data entry. */}
      {detected.length > 0 && <ReconcileBanner detected={detected} />}

      {/* Scheduled bills — each row can be paid */}
      <section>
        {/* Entry point for a new invoice lives in the action bar at the top of the
            page, not here — beside this de-emphasized label it was undiscoverable. */}
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Scheduled Bills
        </h3>
        {obligations.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              No active obligations. Add recurring bills in Cash &amp; Debt to pay them here.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {obligations.map((o) => (
              <Card key={o.id}>
                <CardContent className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    {/* Vendor is shown because obligations can share a name and
                        differ only by who is paid — there are two $1,500 "Owner
                        Draw" rows for different people. Without the vendor they
                        are indistinguishable and the wrong one gets paid. */}
                    <p className="flex items-center gap-2 truncate font-medium text-foreground">
                      <span className="truncate">
                        {o.name}
                        {o.vendorName ? (
                          <span className="font-normal text-muted-foreground">
                            {' · '}
                            {o.vendorName}
                          </span>
                        ) : null}
                      </span>
                      <MethodBadge isAutopay={o.isAutopay} />
                    </p>
                    <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-mono">{formatCurrency(o.amount)}</span>
                      {o.recurring && (
                        <span className="inline-flex items-center gap-1">
                          <Repeat className="size-3" aria-hidden="true" />
                          {o.frequency || 'Recurring'}
                        </span>
                      )}
                      {o.nextDueDate && (
                        <span className="inline-flex items-center gap-1">
                          <CalendarClock className="size-3" aria-hidden="true" />
                          {o.nextDueDate}
                        </span>
                      )}
                      {/* Only rendered when one was actually recorded — an empty
                          invoice label would imply a missing number rather than a
                          bill (rent, a draw) that never had one. */}
                      {o.invoiceNumber && (
                        <span className="inline-flex items-center gap-1">
                          <Hash className="size-3" aria-hidden="true" />
                          {o.invoiceNumber}
                        </span>
                      )}
                    </p>
                  </div>
                  {/* Autopay bills are cleared by the bank feed, not by hand — so
                      the row shows no Pay button, avoiding a double-recorded payment.
                      Checks still get the manual Pay dialog. */}
                  {o.isAutopay ? (
                    <span className="shrink-0 text-xs text-muted-foreground">Auto</span>
                  ) : (
                    <Button
                      size="sm"
                      className="h-11 shrink-0"
                      onClick={() => setActiveObligation(o)}
                    >
                      <Plus className="size-4" aria-hidden="true" />
                      Pay
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* Suggested bank matches — surfaced for confirmation, never auto-applied */}
      {visibleSuggestions.length > 0 && (
        <section>
          <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <Link2 className="size-4" aria-hidden="true" />
            Suggested Bank Matches
          </h3>
          <p className="mb-3 text-xs text-muted-foreground">
            These outstanding checks look like they cleared the bank. Confirm each
            to mark it cleared — nothing is applied automatically.
          </p>
          <div className="space-y-2">
            {visibleSuggestions.map((s) => (
              <SuggestionRow
                key={s.paymentId}
                suggestion={s}
                onDismiss={() =>
                  setDismissed((prev) => new Set(prev).add(s.paymentId))
                }
              />
            ))}
          </div>
        </section>
      )}

      {/* One-off payments — checks with no scheduled bill behind them. Without this
          the float number is silently optimistic, since most checks the owner
          writes are not against the recurring obligations. */}
      <section>
        {/* "Write a Check" now lives in the top action bar alongside the invoice
            entry point, so both ways of recording something new are in one place. */}
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          One-Off Payment
        </h3>
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            For a check that isn&apos;t one of the bills above — a seed supplier, a
            repair, a one-time contractor. It reduces your spendable cash the same
            way, and stays outstanding until it clears.
          </CardContent>
        </Card>
      </section>

      {/* Outstanding checks — spendable-cash impact lives here */}
      <section>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Outstanding Checks
          {outstanding.length > 0 && (
            <Badge variant="secondary" className="font-mono">
              {formatCurrency(outstanding.reduce((s, p) => s + p.amount, 0))}
            </Badge>
          )}
        </h3>
        {outstanding.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              No outstanding checks. Written checks appear here until they clear the bank.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {outstanding.map((p) => (
              <OutstandingRow key={p.id} payment={p} label={paymentLabel(p, obligationNames)} />
            ))}
          </div>
        )}
      </section>

      <RecordPaymentDialog
        key={activeObligation?.id ?? 'none'}
        obligation={activeObligation}
        banks={banks}
        onClose={() => setActiveObligation(null)}
      />

      {/* Remounted per open, same as the payment dialogs, so a previous invoice's
          number can never be saved onto the next bill. */}
      <BillDueDialog
        key={billDueOpen ? 'bill-due-open' : 'bill-due-closed'}
        open={billDueOpen}
        vendors={vendors}
        onClose={() => setBillDueOpen(false)}
      />

      {/* Remounted per open so a previous entry never bleeds into the next check. */}
      <OneOffPaymentDialog
        key={oneOffOpen ? 'one-off-open' : 'one-off-closed'}
        open={oneOffOpen}
        banks={banks}
        vendors={vendors}
        onClose={() => setOneOffOpen(false)}
      />
    </div>
  )
}

/** Small marker so a glance tells whether a bill clears itself or needs a check. */
function MethodBadge({ isAutopay }: { isAutopay: boolean }) {
  return isAutopay ? (
    <Badge
      variant="secondary"
      className="shrink-0 gap-1 text-[10px] font-normal uppercase tracking-wide"
    >
      <Zap className="size-3" aria-hidden="true" />
      Autopay
    </Badge>
  ) : (
    <Badge
      variant="outline"
      className="shrink-0 gap-1 text-[10px] font-normal uppercase tracking-wide"
    >
      <Landmark className="size-3" aria-hidden="true" />
      Check
    </Badge>
  )
}

/**
 * The one-tap reconcile prompt. Autopay bills are cleared by the bank, not by hand,
 * so the only thing the owner does is confirm the machine's matches once — the
 * dates come straight from the bank, no data entry. Kept a distinct, calm callout
 * rather than an alarming alert, since a matched autopay is good news, not a problem.
 */
function ReconcileBanner({ detected }: { detected: AchReconcileMatch[] }) {
  const [pending, startTransition] = useTransition()
  const total = detected.reduce((sum, m) => sum + m.amount, 0)

  const onReconcile = () => {
    startTransition(async () => {
      const res = await reconcileAchFromBank()
      if (res.ok) {
        toast.success(
          res.count === 1
            ? '1 autopay bill marked paid from the bank.'
            : `${res.count} autopay bills marked paid from the bank.`,
        )
      } else {
        toast.error(res.error ?? 'Could not reconcile from the bank.')
      }
    })
  }

  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Zap className="size-4 text-primary" aria-hidden="true" />
            {detected.length === 1
              ? '1 autopay bill was paid by the bank'
              : `${detected.length} autopay bills were paid by the bank`}
            <span className="font-mono text-muted-foreground">{formatCurrency(total)}</span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {detected
              .slice(0, 3)
              .map((m) => `${m.vendorName} (${m.postedDate})`)
              .join(', ')}
            {detected.length > 3 ? `, +${detected.length - 3} more` : ''}. Recorded on
            the actual posted date — you can void any one later if it&apos;s wrong.
          </p>
        </div>
        <Button className="h-11 shrink-0" onClick={onReconcile} disabled={pending}>
          <Check className="size-4" aria-hidden="true" />
          {pending ? 'Reconciling…' : `Reconcile ${detected.length} from bank`}
        </Button>
      </CardContent>
    </Card>
  )
}

function OutstandingRow({
  payment,
  label,
}: {
  payment: ObligationPayment
  label: string
}) {
  const [pending, startTransition] = useTransition()

  const onClear = () => {
    startTransition(async () => {
      const res = await clearPayment(payment.id, todayStr())
      if (res.ok) toast.success('Check marked cleared.')
      else toast.error(res.error ?? 'Could not clear the check.')
    })
  }
  const onVoid = () => {
    startTransition(async () => {
      const res = await voidPayment(payment.id)
      if (res.ok) toast.success('Payment voided.')
      else toast.error(res.error ?? 'Could not void the payment.')
    })
  }

  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          {/* Who was paid leads, because a list of bare check numbers is unreadable
              once one-off checks sit alongside scheduled bills. */}
          <p className="truncate text-sm font-medium text-foreground">
            {label}
            <span className="ml-2 font-mono text-muted-foreground">
              {formatCurrency(payment.amount)}
            </span>
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {payment.checkNumber ? `Check #${payment.checkNumber} · ` : ''}
            Written {payment.paymentDate}
            {payment.purpose ? ` · ${payment.purpose}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-11"
            onClick={onClear}
            disabled={pending}
          >
            <Check className="size-4" aria-hidden="true" />
            Cleared
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-11 text-destructive hover:text-destructive"
            onClick={onVoid}
            disabled={pending}
            aria-label="Void payment"
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function SuggestionRow({
  suggestion,
  onDismiss,
}: {
  suggestion: ClearingSuggestion
  onDismiss: () => void
}) {
  const [pending, startTransition] = useTransition()

  const onConfirm = () => {
    startTransition(async () => {
      const res = await confirmClearWithMatch(suggestion.paymentId, suggestion.transactionId)
      if (res.ok) toast.success('Check confirmed cleared against the bank record.')
      else toast.error(res.error ?? 'Could not confirm the match.')
    })
  }

  const strong = suggestion.matchType === 'check_number'

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
            {suggestion.checkNumber ? `Check #${suggestion.checkNumber}` : 'Payment'}
            <span className="font-mono text-muted-foreground">
              {formatCurrency(suggestion.amount)}
            </span>
            <Badge variant={strong ? 'default' : 'secondary'} className="text-xs font-normal">
              {strong ? 'Check # match' : 'Amount + date match'}
            </Badge>
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            Written {suggestion.paymentDate} · bank {suggestion.transactionDate}
            {suggestion.transactionDescription
              ? ` · ${suggestion.transactionDescription}`
              : ''}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" className="h-11" onClick={onConfirm} disabled={pending}>
            <Check className="size-4" aria-hidden="true" />
            {pending ? 'Confirming…' : 'Confirm cleared'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-11"
            onClick={onDismiss}
            disabled={pending}
            aria-label="Dismiss this suggestion"
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function RecordPaymentDialog({
  obligation,
  banks,
  onClose,
}: {
  obligation: Obligation | null
  banks: Bank[]
  onClose: () => void
}) {
  const open = obligation !== null
  // The parent remounts this component per obligation (via `key`), so seeding
  // state from props at mount is correct and needs no reset effect.
  const [pending, startTransition] = useTransition()
  const [method, setMethod] = useState<'check' | 'ach'>('check')
  const [amount, setAmount] = useState(obligation ? String(obligation.amount) : '')
  const [paymentDate, setPaymentDate] = useState(todayStr())
  const [checkNumber, setCheckNumber] = useState('')
  const [bankAccountId, setBankAccountId] = useState<string>('')
  const [memo, setMemo] = useState('')
  const [rollForward, setRollForward] = useState(true)

  const submit = () => {
    if (!obligation) return
    startTransition(async () => {
      const res = await recordPayment({
        obligationId: obligation.id,
        amount: Number(amount),
        paymentDate,
        paymentMethod: method,
        checkNumber: method === 'check' ? checkNumber : undefined,
        bankAccountId: bankAccountId || null,
        memo,
        rollForward: obligation.recurring && rollForward,
      })
      if (res.ok) {
        toast.success(
          res.error
            ? res.error
            : method === 'ach'
              ? 'ACH payment recorded and cleared.'
              : 'Check recorded. It stays outstanding until it clears.',
        )
        onClose()
      } else {
        toast.error(res.error ?? 'Could not record the payment.')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Record Payment</DialogTitle>
          <DialogDescription>
            {/* Include the vendor for the same reason as the list row: confirming
                a payment must show WHO is being paid, not just the bill name. */}
            {obligation
              ? [obligation.name, obligation.vendorName].filter(Boolean).join(' · ')
              : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="bp-method">Method</Label>
              <Select value={method} onValueChange={(v) => setMethod(v as 'check' | 'ach')}>
                <SelectTrigger id="bp-method" className="mt-1 h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="check">Check</SelectItem>
                  <SelectItem value="ach">ACH / Transfer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="bp-amount">Amount</Label>
              <Input
                id="bp-amount"
                inputMode="decimal"
                className="mt-1 h-11 text-base"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="bp-date">Payment date</Label>
              <Input
                id="bp-date"
                type="date"
                className="mt-1 h-11 text-base"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
              />
            </div>
            {method === 'check' && (
              <div>
                <Label htmlFor="bp-check">Check #</Label>
                <Input
                  id="bp-check"
                  inputMode="numeric"
                  className="mt-1 h-11 text-base"
                  value={checkNumber}
                  onChange={(e) => setCheckNumber(e.target.value)}
                  placeholder="e.g. 1318"
                />
              </div>
            )}
          </div>

          <div>
            <Label htmlFor="bp-bank">Paid from</Label>
            <Select value={bankAccountId} onValueChange={(v) => setBankAccountId(v ?? '')}>
              <SelectTrigger id="bp-bank" className="mt-1 h-11">
                <SelectValue placeholder="Select account (optional)" />
              </SelectTrigger>
              <SelectContent>
                {banks.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="bp-memo">Memo (optional)</Label>
            <Input
              id="bp-memo"
              className="mt-1 h-11 text-base"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="What this covers"
            />
          </div>

          {obligation?.recurring && (
            <label className="flex items-start gap-3 rounded-md border border-border bg-muted/40 p-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4"
                checked={rollForward}
                onChange={(e) => setRollForward(e.target.checked)}
              />
              <span className="text-muted-foreground">
                Advance next due date to the following {obligation.frequency || 'period'} so
                this recurring bill stays in the forecast.
              </span>
            </label>
          )}
        </div>

        <DialogFooter className="mt-2 gap-2 sm:gap-2">
          <Button variant="outline" className="h-11" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button className="h-11" onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : 'Record Payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Enter an invoice that is DUE but not yet paid.
 *
 * The distinction this screen has to hold: RecordPaymentDialog says "money left
 * the account", this says "money is owed". Conflating them is what makes a cash
 * forecast wrong in the expensive direction — an unrecorded bill makes the
 * balance look better than it is right up until the check is written.
 *
 * Validation runs client-side with the SAME shared predicate the server action
 * uses (validateBillDueBasics), so the two cannot disagree about what a valid
 * bill is; the server still re-validates because a client check is not a guard.
 */
function BillDueDialog({
  open,
  vendors,
  onClose,
}: {
  open: boolean
  vendors: VendorOption[]
  onClose: () => void
}) {
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState('')
  const [vendorName, setVendorName] = useState('')
  const [amount, setAmount] = useState('')
  const [dueDate, setDueDate] = useState(todayStr())
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [notes, setNotes] = useState('')

  // Same pattern as the one-off payee: picking a known vendor fills the text but
  // leaves it editable, so a brand-new supplier is never blocked.
  // Accepts null because the Select can emit a cleared value; an unknown or
  // cleared id leaves the typed name alone rather than blanking it.
  const pickVendor = (id: string | null) => {
    const v = vendors.find((x) => x.id === id)
    if (v) setVendorName(v.name)
  }

  const problem = validateBillDueBasics({
    obligationName: name,
    amount: Number(amount),
    dueDate,
  })

  const submit = () => {
    startTransition(async () => {
      const res = await createBillDue({
        obligationName: name,
        vendorName,
        amount: Number(amount),
        dueDate,
        invoiceNumber,
        notes,
      })
      if (res.ok) {
        toast.success('Bill recorded. It now shows as owed and is ready to pay.')
        onClose()
      } else {
        toast.error(res.error ?? 'Could not save the bill.')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Enter an Invoice</DialogTitle>
          <DialogDescription>
            An invoice you owe but haven&apos;t paid. It counts against your cash
            forecast right away, then clears when you pay it here.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="bd-name">What is this bill for?</Label>
            <Input
              id="bd-name"
              className="mt-1 h-11 text-base"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Feed delivery"
            />
          </div>

          <div>
            <Label htmlFor="bd-vendor">Vendor</Label>
            <Input
              id="bd-vendor"
              className="mt-1 h-11 text-base"
              value={vendorName}
              onChange={(e) => setVendorName(e.target.value)}
              placeholder="Who you owe"
            />
            {vendors.length > 0 && (
              <Select value="" onValueChange={pickVendor}>
                <SelectTrigger className="mt-2 h-11">
                  <SelectValue placeholder="Or pick an existing vendor" />
                </SelectTrigger>
                <SelectContent>
                  {vendors.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="bd-amount">Amount</Label>
              <Input
                id="bd-amount"
                inputMode="decimal"
                className="mt-1 h-11 text-base"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div>
              <Label htmlFor="bd-due">Due date</Label>
              <Input
                id="bd-due"
                type="date"
                className="mt-1 h-11 text-base"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>

          <div>
            <Label htmlFor="bd-invoice">Invoice # (optional)</Label>
            <Input
              id="bd-invoice"
              className="mt-1 h-11 text-base"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              placeholder="From the vendor's invoice"
            />
          </div>

          <div>
            <Label htmlFor="bd-notes">Notes (optional)</Label>
            <Input
              id="bd-notes"
              className="mt-1 h-11 text-base"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything worth remembering"
            />
          </div>

          {/* One-time only. A recurring bill needs a frequency and a schedule
              anchor, which belong in Cash & Debt — offering "recurring" here
              would create a bill with no schedule that silently never repeats. */}
          <p className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            This saves a one-time bill. For a bill that repeats every month, add it
            in Cash &amp; Debt so its schedule is set correctly.
          </p>
        </div>

        <DialogFooter className="mt-2 gap-2 sm:gap-2">
          <Button variant="outline" className="h-11" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button className="h-11" onClick={submit} disabled={pending || problem !== null}>
            {pending ? 'Saving…' : 'Save Invoice'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * A check with no scheduled bill behind it. Mirrors RecordPaymentDialog's fields so
 * the two feel like one flow, minus the obligation-specific roll-forward, and plus
 * a payee (which the obligation would otherwise have supplied).
 */
function OneOffPaymentDialog({
  open,
  banks,
  vendors,
  onClose,
}: {
  open: boolean
  banks: Bank[]
  vendors: VendorOption[]
  onClose: () => void
}) {
  const [pending, startTransition] = useTransition()
  const [method, setMethod] = useState<'check' | 'ach'>('check')
  const [payeeName, setPayeeName] = useState('')
  const [payeeVendorId, setPayeeVendorId] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [paymentDate, setPaymentDate] = useState(todayStr())
  const [checkNumber, setCheckNumber] = useState('')
  const [bankAccountId, setBankAccountId] = useState('')
  const [purpose, setPurpose] = useState('')
  const [memo, setMemo] = useState('')

  // Picking a known vendor fills the payee, but the text stays editable so the
  // owner is never trapped by the list — and typing over it drops the vendor link
  // so a stored id can't contradict a visibly different name.
  const pickVendor = (id: string | null) => {
    const v = vendors.find((x) => x.id === id)
    if (!v) return
    setPayeeVendorId(v.id)
    setPayeeName(v.name)
  }

  const submit = () => {
    startTransition(async () => {
      const res = await recordOneOffPayment({
        payeeName,
        payeeVendorId,
        amount: Number(amount),
        paymentDate,
        paymentMethod: method,
        checkNumber: method === 'check' ? checkNumber : undefined,
        bankAccountId: bankAccountId || null,
        purpose,
        memo,
      })
      if (res.ok) {
        toast.success(
          method === 'ach'
            ? 'ACH payment recorded and cleared.'
            : 'Check recorded. It stays outstanding until it clears.',
        )
        onClose()
      } else {
        toast.error(res.error ?? 'Could not record the payment.')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>One-Off Payment</DialogTitle>
          <DialogDescription>
            A payment with no scheduled bill behind it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="oo-payee">Pay to</Label>
            <Input
              id="oo-payee"
              className="mt-1 h-11 text-base"
              value={payeeName}
              onChange={(e) => {
                setPayeeName(e.target.value)
                // Typed name no longer matches the picked vendor — drop the link.
                setPayeeVendorId(null)
              }}
              placeholder="e.g. Coastal Seed Supply"
            />
            {vendors.length > 0 && (
              <div className="mt-2">
                <Select value={payeeVendorId ?? ''} onValueChange={pickVendor}>
                  <SelectTrigger id="oo-vendor" className="h-11">
                    <SelectValue placeholder="Or pick a known vendor" />
                  </SelectTrigger>
                  <SelectContent>
                    {vendors.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="oo-method">Method</Label>
              <Select value={method} onValueChange={(v) => setMethod(v as 'check' | 'ach')}>
                <SelectTrigger id="oo-method" className="mt-1 h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="check">Check</SelectItem>
                  <SelectItem value="ach">ACH / Transfer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="oo-amount">Amount</Label>
              <Input
                id="oo-amount"
                inputMode="decimal"
                className="mt-1 h-11 text-base"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="oo-date">Payment date</Label>
              <Input
                id="oo-date"
                type="date"
                className="mt-1 h-11 text-base"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
              />
            </div>
            {method === 'check' && (
              <div>
                <Label htmlFor="oo-check">Check #</Label>
                <Input
                  id="oo-check"
                  inputMode="numeric"
                  className="mt-1 h-11 text-base"
                  value={checkNumber}
                  onChange={(e) => setCheckNumber(e.target.value)}
                  placeholder="e.g. 1318"
                />
              </div>
            )}
          </div>

          <div>
            <Label htmlFor="oo-purpose">What it was for</Label>
            <Input
              id="oo-purpose"
              className="mt-1 h-11 text-base"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="e.g. Tractor hydraulic repair"
            />
          </div>

          <div>
            <Label htmlFor="oo-bank">Paid from</Label>
            <Select value={bankAccountId} onValueChange={(v) => setBankAccountId(v ?? '')}>
              <SelectTrigger id="oo-bank" className="mt-1 h-11">
                <SelectValue placeholder="Select account (optional)" />
              </SelectTrigger>
              <SelectContent>
                {banks.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="oo-memo">Memo (optional)</Label>
            <Input
              id="oo-memo"
              className="mt-1 h-11 text-base"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="Anything else worth recording"
            />
          </div>
        </div>

        <DialogFooter className="mt-2 gap-2 sm:gap-2">
          <Button variant="outline" className="h-11" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button className="h-11" onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : 'Record Payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

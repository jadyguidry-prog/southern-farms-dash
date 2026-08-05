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
<<<<<<< HEAD
  FileClock,
  Hash,
=======
  FileText,
  Undo2,
>>>>>>> origin/v0/jadyguidry-prog-f71cb68d
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
<<<<<<< HEAD
=======
import {
  paymentLabel,
  isAwaitingPayment,
  type AchReconcileMatch,
} from '@/lib/bill-pay-shared'
>>>>>>> origin/v0/jadyguidry-prog-f71cb68d
import {
  paymentLabel,
  validateBillDueBasics,
  sumPaymentsForObligation,
  paymentDefaultAmount,
  remainingOnOneTimeBill,
  isOverpayment,
  type AchReconcileMatch,
} from '@/lib/bill-pay-shared'
import {
  createBillDue,
  recordPayment,
  recordOneOffPayment,
  voidPayment,
  convertPaymentToInvoice,
  clearPayment,
  unclearPayment,
  recordCheckNumber,
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

/** A date n days out, for seeding an expected ACH draft date. */
const daysFromToday = (n: number) =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

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
<<<<<<< HEAD
  const [oneOffOpen, setOneOffOpen] = useState(false)
  const [billDueOpen, setBillDueOpen] = useState(false)
=======
  // Which flavour of one-off entry is open. 'check' is a check being written now;
  // 'invoice' logs a COGS invoice whose ACH draft will pull in a few days.
  const [oneOffMode, setOneOffMode] = useState<'check' | 'invoice' | null>(null)
>>>>>>> origin/v0/jadyguidry-prog-f71cb68d
  // Locally dismissed suggestions — hidden without a write, so an owner who
  // knows a match is wrong isn't nagged on every load of this session.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const outstanding = payments.filter((p) => p.status === 'outstanding')
  // Recently cleared, newest first. These were already fetched but never rendered,
  // which is why a clear recorded by mistake had no way back — the row simply
  // vanished from the page. Capped at 8: enough to undo a slip, short enough that
  // the outstanding work stays the focus of the page.
  const recentlyCleared = useMemo(
    () =>
      payments
        .filter((p) => p.status === 'cleared')
        .sort((a, b) => (b.clearedDate ?? '').localeCompare(a.clearedDate ?? ''))
        .slice(0, 8),
    [payments],
  )
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
            These outstanding checks and pending drafts look like they cleared the
            bank. Confirm each to mark it cleared — nothing is applied automatically.
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
<<<<<<< HEAD
        {/* "Write a Check" now lives in the top action bar alongside the invoice
            entry point, so both ways of recording something new are in one place. */}
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          One-Off Payment
        </h3>
=======
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            One-Off Payment
          </h3>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-11"
              onClick={() => setOneOffMode('check')}
            >
              <Plus className="size-4" aria-hidden="true" />
              Write a check
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-11"
              onClick={() => setOneOffMode('invoice')}
            >
              <FileText className="size-4" aria-hidden="true" />
              Log an invoice
            </Button>
          </div>
        </div>
>>>>>>> origin/v0/jadyguidry-prog-f71cb68d
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">Write a check</span>
              {
                ' for a payment that isn’t one of the bills above — a seed supplier, a repair, a one-time contractor.'
              }
            </p>
            <p className="mt-2">
              <span className="font-medium text-foreground">Log an invoice</span>
              {
                ' when a bill arrives that will be drafted by ACH in a few days (Sysco, Quirch). Enter the amount and the date you expect it to pull — it reduces your spendable cash right away, then clears itself when the draft posts.'
              }
            </p>
          </CardContent>
        </Card>
      </section>

      {/* Outstanding checks — spendable-cash impact lives here */}
      <section>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Outstanding
          {outstanding.length > 0 && (
            <Badge variant="secondary" className="font-mono">
              {formatCurrency(outstanding.reduce((s, p) => s + p.amount, 0))}
            </Badge>
          )}
        </h3>
        {outstanding.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              Nothing outstanding. Written checks and pending ACH drafts appear here
              until they clear the bank.
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

<<<<<<< HEAD
      {/* paidTotal comes from the payment list this page already loads, so the
          form can default to what's STILL owed instead of re-offering the full
          invoice after a partial payment. Meaningful for one-time bills only —
          see paymentDefaultAmount. */}
=======
      {/* Recently cleared, purely so a mistaken clear can be undone. Hidden when
          empty rather than showing an empty-state card, since it is a correction
          tool and not something to act on day to day. */}
      {recentlyCleared.length > 0 && (
        <section>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Recently Cleared
          </h3>
          <div className="space-y-2">
            {recentlyCleared.map((p) => (
              <ClearedRow key={p.id} payment={p} label={paymentLabel(p, obligationNames)} />
            ))}
          </div>
        </section>
      )}

>>>>>>> origin/v0/jadyguidry-prog-f71cb68d
      <RecordPaymentDialog
        key={activeObligation?.id ?? 'none'}
        obligation={activeObligation}
        paidTotal={
          activeObligation
            ? sumPaymentsForObligation(payments, activeObligation.id)
            : 0
        }
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
        key={oneOffMode ?? 'one-off-closed'}
        open={oneOffMode !== null}
        mode={oneOffMode ?? 'check'}
        banks={banks}
        vendors={vendors}
        onClose={() => setOneOffMode(null)}
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
<<<<<<< HEAD
  // Confirmation is required because the conversion DELETES the payment record and
  // moves money from "already spent" back to "still owed".
  const [confirmConvert, setConfirmConvert] = useState(false)
=======
  const [numberOpen, setNumberOpen] = useState(false)
  const [draftNumber, setDraftNumber] = useState('')

  // Shared with the server so the label can never disagree with the validation.
  // Covers an ACH awaiting its draft AND a check the owner hasn't written yet.
  const isDraft = isAwaitingPayment(payment)
  // A check promised but not yet written: the one case where we can still capture
  // the number, which is what lets check-resolution match it to the bank later.
  // Offered whenever a check has no number, whether it is unwritten (capturing the
  // number also marks it written) or written-but-unlogged (the number simply fills a
  // gap). Both cases benefit, so this stays keyed on the missing number.
  const needsCheckNumber = payment.paymentMethod === 'check' && !payment.checkNumber
>>>>>>> origin/v0/jadyguidry-prog-f71cb68d

  const onClear = () => {
    startTransition(async () => {
      const res = await clearPayment(payment.id, todayStr())
      if (res.ok) toast.success(isDraft ? 'Payment marked cleared.' : 'Check marked cleared.')
      else toast.error(res.error ?? 'Could not clear the payment.')
    })
  }
  const onSaveNumber = () => {
    startTransition(async () => {
      const res = await recordCheckNumber(payment.id, draftNumber)
      if (res.ok) {
        toast.success('Check number saved.')
        setNumberOpen(false)
        setDraftNumber('')
      } else toast.error(res.error ?? 'Could not save the check number.')
    })
  }
  const onVoid = () => {
    startTransition(async () => {
      const res = await voidPayment(payment.id)
      if (res.ok) toast.success('Payment voided.')
      else toast.error(res.error ?? 'Could not void the payment.')
    })
  }
  const onConvert = () => {
    setConfirmConvert(false)
    startTransition(async () => {
      const res = await convertPaymentToInvoice(payment.id)
      if (res.ok) toast.success('Moved to invoices due. It is no longer counted as paid.')
      else toast.error(res.error ?? 'Could not convert this payment.')
    })
  }

  // A payment WITH a check number means a physical check exists, so converting it
  // is a much stronger claim than for a row that was never sent. Both are allowed
  // (a check can be written and never mailed) but the confirm text differs.
  const hasCheckNumber = Boolean(payment.checkNumber)

  return (
    <Card>
      {/* Column wrapper so the check-number input can appear BELOW the row instead
          of squeezing the payee name on a phone. */}
      <CardContent className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          {/* Who was paid leads, because a list of bare check numbers is unreadable
              once one-off checks sit alongside scheduled bills. */}
          <p className="truncate text-sm font-medium text-foreground">
            {label}
            <span className="ml-2 font-mono text-muted-foreground">
              {formatCurrency(payment.amount)}
            </span>
          </p>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {/* A logged bill awaiting payment, not a written check — saying "Written"
                would misdescribe it. The wording follows the actual method so a
                check-to-be-written is never labelled ACH. */}
            {isDraft && (
              <Badge variant="outline" className="text-xs font-normal">
                {payment.paymentMethod === 'ach' ? 'ACH · pending draft' : 'Check not written yet'}
              </Badge>
            )}
            <p className="min-w-0 truncate text-xs text-muted-foreground">
              {payment.checkNumber ? `Check #${payment.checkNumber} · ` : ''}
              {isDraft ? 'Expected' : 'Written'} {payment.paymentDate}
              {payment.purpose ? ` · ${payment.purpose}` : ''}
            </p>
          </div>
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
          {/* For the case this panel can't distinguish on its own: the entry was
              logged as a payment but the money never left. Icon-only to keep the
              row readable; the label is on the tooltip and the confirm dialog. */}
          <Button
            size="sm"
            variant="ghost"
            className="h-11"
            onClick={() => setConfirmConvert(true)}
            disabled={pending}
            title="Not paid yet — move to invoices due"
            aria-label="Not paid yet — move to invoices due"
          >
            <FileClock className="size-4" aria-hidden="true" />
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
      </div>

      {/* Only for a check that hasn't been written: capturing the number here is
          what lets the bank feed match it later. */}
      {needsCheckNumber && !numberOpen && (
        <Button
          size="sm"
          variant="ghost"
          className="h-11 self-start px-2 text-xs"
          onClick={() => setNumberOpen(true)}
          disabled={pending}
        >
          Add check number
        </Button>
      )}
      {needsCheckNumber && numberOpen && (
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Label htmlFor={`num-${payment.id}`} className="text-xs">
              Check # you wrote
            </Label>
            <Input
              id={`num-${payment.id}`}
              inputMode="numeric"
              className="mt-1 h-11 text-base"
              value={draftNumber}
              onChange={(e) => setDraftNumber(e.target.value)}
              placeholder="e.g. 1318"
              // Enter submits, but not mid-IME-composition.
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  e.preventDefault()
                  onSaveNumber()
                }
              }}
            />
          </div>
          <Button
            size="sm"
            className="h-11"
            onClick={onSaveNumber}
            disabled={pending || !draftNumber.trim()}
          >
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-11"
            onClick={() => {
              setNumberOpen(false)
              setDraftNumber('')
            }}
            disabled={pending}
          >
            Cancel
          </Button>
        </div>
      )}
      </CardContent>
    </Card>
  )
}

/**
 * A cleared payment with a way back to outstanding.
 *
 * Deliberately offers un-clear and NOT void. Void means the payment never happened
 * and drops it out of the float entirely, which would overstate spendable cash;
 * un-clearing says "this hasn't actually left the bank yet", which is what a
 * mistaken clear needs.
 */
function ClearedRow({
  payment,
  label,
}: {
  payment: ObligationPayment
  label: string
}) {
  const [pending, startTransition] = useTransition()

  const onUnclear = () => {
    startTransition(async () => {
      const res = await unclearPayment(payment.id)
      if (res.ok) toast.success('Moved back to outstanding.')
      else toast.error(res.error ?? 'Could not undo the clear.')
    })
  }

  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">
            {label}
            <span className="ml-2 font-mono text-muted-foreground">
              {formatCurrency(payment.amount)}
            </span>
          </p>
          <p className="mt-0.5 min-w-0 truncate text-xs text-muted-foreground">
            {payment.checkNumber ? `Check #${payment.checkNumber} · ` : ''}
            Cleared {payment.clearedDate ?? payment.paymentDate}
            {payment.purpose ? ` · ${payment.purpose}` : ''}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-11 shrink-0"
          onClick={onUnclear}
          disabled={pending}
        >
          <Undo2 className="size-4" aria-hidden="true" />
          Not cleared
        </Button>
      </CardContent>

      <Dialog open={confirmConvert} onOpenChange={setConfirmConvert}>
        <DialogContent className="max-w-md grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
          <DialogHeader>
            <DialogTitle>Move to invoices due?</DialogTitle>
            <DialogDescription>
              {label} · {formatCurrency(payment.amount)}
            </DialogDescription>
          </DialogHeader>

          <div className="-mx-1 min-h-0 space-y-3 overflow-y-auto px-1 text-sm leading-relaxed">
            <p className="text-muted-foreground">
              This treats the money as{' '}
              <span className="font-semibold text-foreground">still owed</span> rather
              than already spent. Your spendable cash goes up by{' '}
              {formatCurrency(payment.amount)}, and the invoice appears in your payable
              list and cash forecast, due {payment.paymentDate}.
            </p>
            <p className="text-muted-foreground">
              The payment record is deleted, so this won&apos;t show as a voided check.
            </p>
            {hasCheckNumber && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-foreground">
                Check #{payment.checkNumber} is recorded against this payment. Only do
                this if that check was never actually sent.
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmConvert(false)}>
              Cancel
            </Button>
            <Button onClick={onConvert} disabled={pending}>
              {pending ? 'Moving…' : 'Move to invoices due'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
      if (res.ok) toast.success('Payment confirmed cleared against the bank record.')
      else toast.error(res.error ?? 'Could not confirm the match.')
    })
  }

  const isDraft = suggestion.matchType === 'vendor_amount'
  // A check number and a payee-name hit are both near-certain; a bare amount+date
  // pairing is the only genuine guess, so only it is styled as the weaker match.
  const strong = suggestion.matchType !== 'amount_date'
  const matchLabel =
    suggestion.matchType === 'check_number'
      ? 'Check # match'
      : isDraft
        ? 'Vendor + amount match'
        : 'Amount + date match'

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
            {suggestion.checkNumber
              ? `Check #${suggestion.checkNumber}`
              : suggestion.payeeName || 'Payment'}
            <span className="font-mono text-muted-foreground">
              {formatCurrency(suggestion.amount)}
            </span>
            <Badge variant={strong ? 'default' : 'secondary'} className="text-xs font-normal">
              {matchLabel}
            </Badge>
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {isDraft ? 'Expected' : 'Written'} {suggestion.paymentDate} · bank{' '}
            {suggestion.transactionDate}
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
  paidTotal,
  banks,
  onClose,
}: {
  obligation: Obligation | null
  paidTotal: number
  banks: Bank[]
  onClose: () => void
}) {
  const open = obligation !== null
  // The parent remounts this component per obligation (via `key`), so seeding
  // state from props at mount is correct and needs no reset effect.
  const [pending, startTransition] = useTransition()
  const [method, setMethod] = useState<'check' | 'ach'>('check')
  // Defaults to what is STILL owed, not the full invoice — see
  // paymentDefaultAmount for the $1,850-against-a-$1,450-bill bug this closes.
  const [amount, setAmount] = useState(
    obligation ? String(paymentDefaultAmount(obligation, paidTotal)) : '',
  )
  const [paymentDate, setPaymentDate] = useState(todayStr())
  const [checkNumber, setCheckNumber] = useState('')
  const [bankAccountId, setBankAccountId] = useState<string>('')
  const [memo, setMemo] = useState('')
  const [rollForward, setRollForward] = useState(true)

  // Partial-payment context, one-time bills only. A recurring bill's history
  // spans every period it has ever been paid for, so "already paid" against a
  // single period's amount would be nonsense (see remainingOnOneTimeBill).
  const hasPriorPayments = !!obligation && !obligation.recurring && paidTotal > 0
  const remaining = obligation
    ? remainingOnOneTimeBill(obligation.amount, paidTotal)
    : 0
  const overpaying = !!obligation && isOverpayment(obligation, paidTotal, Number(amount))

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
<<<<<<< HEAD
      {/* Same pinned-footer grid as the invoice form — see the note there. This one
          grew taller when the partial-payment balance block was added. */}
=======
      {/* grid-rows pins the title and the action buttons while only the fields
          scroll, so "Record Payment" stays reachable on a short window. */}
>>>>>>> origin/v0/jadyguidry-prog-f71cb68d
      <DialogContent className="max-w-md grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
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

<<<<<<< HEAD
        <div className="-mx-1 min-h-0 space-y-4 overflow-y-auto px-1">
          {/* Only shown once a partial payment exists, so the owner can see WHY the
              amount below is less than the invoice total. Without this the reduced
              default would look like the bill had been entered wrong. */}
          {hasPriorPayments && (
            <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
              <p className="text-muted-foreground">
                Already paid{' '}
                <span className="font-semibold text-foreground">
                  {formatCurrency(paidTotal)}
                </span>{' '}
                of {formatCurrency(obligation.amount)}.
              </p>
              <p className="mt-1 text-muted-foreground">
                {remaining > 0 ? (
                  <>
                    Still owed:{' '}
                    <span className="font-semibold text-foreground">
                      {formatCurrency(remaining)}
                    </span>
                  </>
                ) : (
                  'This bill is already fully covered.'
                )}
              </p>
            </div>
          )}

=======
        {/* -mx-1 px-1 so focus rings on the inputs aren't clipped by the scroll box. */}
        <div className="-mx-1 space-y-4 overflow-y-auto px-1">
>>>>>>> origin/v0/jadyguidry-prog-f71cb68d
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
                aria-describedby={overpaying ? 'bp-amount-warning' : undefined}
              />
            </div>
          </div>

          {/* Advisory, never a block: overpaying can be legitimate (a late fee, or an
              invoice entered below the real figure) and refusing the write would stop
              the owner recording what actually left the account. See isOverpayment. */}
          {overpaying && (
            <p
              id="bp-amount-warning"
              role="status"
              className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm leading-relaxed text-foreground"
            >
              This is more than the {formatCurrency(remaining)} still owed on this bill.
              You can still record it if the extra is real — a late fee, or an invoice
              entered too low — otherwise check the amount.
            </p>
          )}

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
      {/* Three grid rows — header / scrolling body / footer — so Save Invoice stays
          pinned and visible no matter how short the window is. Without this the
          form ran past the bottom of a 552px-tall viewport and the submit button
          couldn't be reached at all. */}
      <DialogContent className="max-w-md grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle>Enter an Invoice</DialogTitle>
          <DialogDescription>
            An invoice you owe but haven&apos;t paid. It counts against your cash
            forecast right away, then clears when you pay it here.
          </DialogDescription>
        </DialogHeader>

        {/* -mx-1 px-1 keeps focus rings from being clipped by the scroll edge. */}
        <div className="-mx-1 min-h-0 space-y-4 overflow-y-auto px-1">
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
  mode,
  banks,
  vendors,
  onClose,
}: {
  open: boolean
  /**
   * 'invoice' logs a bill that is not yet paid: the payment is recorded as PENDING so
   * it floats against spendable cash, and the date entered is when the money is
   * expected to leave rather than a settled payment date. The bill may be settled by
   * ACH draft OR by a check the owner has not written yet.
   */
  mode: 'check' | 'invoice'
  banks: Bank[]
  vendors: VendorOption[]
  onClose: () => void
}) {
  const isInvoice = mode === 'invoice'
  const [pending, startTransition] = useTransition()
  // ACH is only the DEFAULT for an invoice, not a constraint. This used to be locked
  // to ACH on the theory that an invoice is always drafted, which quietly made it
  // impossible to log a bill destined for a handwritten check.
  const [method, setMethod] = useState<'check' | 'ach'>(isInvoice ? 'ach' : 'check')
  const [payeeName, setPayeeName] = useState('')
  const [payeeVendorId, setPayeeVendorId] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  // Seeded a few days out for an invoice, matching the real gap between a COGS
  // invoice arriving and the draft pulling. Editable — it is only a starting point.
  const [paymentDate, setPaymentDate] = useState(isInvoice ? daysFromToday(3) : todayStr())
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
        // Invoice mode records a draft that has not pulled yet, so it must float
        // rather than be marked settled on entry.
        pending: isInvoice,
      })
      if (res.ok) {
        toast.success(
          isInvoice
            ? 'Invoice logged. It reduces spendable cash until the draft posts.'
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
<<<<<<< HEAD
      {/* Same pinned-footer grid as the invoice form — see the note there. */}
=======
      {/* Same pinning as Record Payment: this form is the tallest in the app, so
          the Save button must stay visible rather than sit below the viewport. */}
>>>>>>> origin/v0/jadyguidry-prog-f71cb68d
      <DialogContent className="max-w-md grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
        <DialogHeader>
          <DialogTitle>{isInvoice ? 'Log an Invoice' : 'One-Off Payment'}</DialogTitle>
          <DialogDescription>
            {isInvoice
              ? 'A bill that will be drafted by ACH. Enter the amount and when you expect it to pull.'
              : 'A payment with no scheduled bill behind it.'}
          </DialogDescription>
        </DialogHeader>

<<<<<<< HEAD
        <div className="-mx-1 min-h-0 space-y-4 overflow-y-auto px-1">
=======
        <div className="-mx-1 space-y-4 overflow-y-auto px-1">
>>>>>>> origin/v0/jadyguidry-prog-f71cb68d
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
              placeholder={isInvoice ? 'e.g. Sysco' : 'e.g. Coastal Seed Supply'}
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

          {/* Method is offered for BOTH modes now. It was hidden for invoices, which
              left no way to say a bill would be paid by check. */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="oo-method">
                {isInvoice ? 'How will you pay it?' : 'Method'}
              </Label>
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
              <Label htmlFor="oo-amount">
                {isInvoice ? 'Amount on the invoice' : 'Amount'}
              </Label>
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

          <div className={method === 'check' ? 'grid grid-cols-2 gap-3' : undefined}>
            <div>
              <Label htmlFor="oo-date">
                {isInvoice
                  ? method === 'check'
                    ? 'When do you plan to pay it?'
                    : 'Expected draft date'
                  : 'Payment date'}
              </Label>
              <Input
                id="oo-date"
                type="date"
                className="mt-1 h-11 text-base"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
              />
              {isInvoice && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {method === 'check'
                    ? 'Roughly when you expect to write the check. A few days off is fine — the bank match uses the vendor and amount.'
                    : 'Roughly when the ACH will pull. A few days off is fine — the bank match uses the vendor and amount.'}
                </p>
              )}
            </div>
            {method === 'check' && (
              <div>
                {/* Required when writing a check, optional when logging a bill you
                    have not written the check for yet. The server enforces the same
                    split via validatePaymentBasics(allowUnwrittenCheck). */}
                <Label htmlFor="oo-check">
                  {isInvoice ? 'Check # (if written)' : 'Check #'}
                </Label>
                <Input
                  id="oo-check"
                  inputMode="numeric"
                  className="mt-1 h-11 text-base"
                  value={checkNumber}
                  onChange={(e) => setCheckNumber(e.target.value)}
                  placeholder={isInvoice ? 'Leave blank until written' : 'e.g. 1318'}
                />
                {isInvoice && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Optional. Add it later from the bill list once you write the check.
                  </p>
                )}
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
              placeholder={
                isInvoice ? 'e.g. Weekly produce order' : 'e.g. Tractor hydraulic repair'
              }
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
            {pending ? 'Saving…' : isInvoice ? 'Log Invoice' : 'Record Payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

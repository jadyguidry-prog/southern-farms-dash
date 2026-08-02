'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { CalendarClock, Plus, Check, X, Repeat } from 'lucide-react'
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
import type { ObligationPayment } from '@/lib/bill-pay-service'
import { recordPayment, voidPayment, clearPayment } from '@/app/bill-pay/actions'

type Obligation = {
  id: string
  name: string
  vendorName: string
  amount: number
  nextDueDate: string
  recurring: boolean
  frequency: string
}
type Bank = { id: string; label: string }

const todayStr = () => new Date().toISOString().slice(0, 10)

export function BillPayClient({
  obligations,
  banks,
  payments,
}: {
  obligations: Obligation[]
  banks: Bank[]
  payments: ObligationPayment[]
}) {
  const [activeObligation, setActiveObligation] = useState<Obligation | null>(null)
  const outstanding = payments.filter((p) => p.status === 'outstanding')

  return (
    <div className="space-y-8">
      {/* Scheduled bills — each row can be paid */}
      <section>
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
                    <p className="truncate font-medium text-foreground">{o.name}</p>
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
                    </p>
                  </div>
                  <Button
                    size="sm"
                    className="h-11 shrink-0"
                    onClick={() => setActiveObligation(o)}
                  >
                    <Plus className="size-4" aria-hidden="true" />
                    Pay
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
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
              <OutstandingRow key={p.id} payment={p} />
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
    </div>
  )
}

function OutstandingRow({ payment }: { payment: ObligationPayment }) {
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
          <p className="truncate text-sm font-medium text-foreground">
            {payment.checkNumber ? `Check #${payment.checkNumber}` : 'Payment'}
            <span className="ml-2 font-mono text-muted-foreground">
              {formatCurrency(payment.amount)}
            </span>
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">Written {payment.paymentDate}</p>
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
            {obligation ? obligation.name : ''}
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

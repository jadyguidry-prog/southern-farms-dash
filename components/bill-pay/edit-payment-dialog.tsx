'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ObligationPayment } from '@/lib/bill-pay-service'
import { editPayment } from '@/app/bill-pay/actions'
import { formatCurrency } from '@/lib/data'

/**
 * Correct an already-recorded payment or check.
 *
 * One dialog for both outstanding and cleared payments. The difference is handled by the
 * server, which refuses the first save when the edit would break a cleared payment's bank
 * match and returns a warning; the owner then confirms and the same values are re-sent.
 * Doing the check server-side means the warning cannot be bypassed by a stale client.
 *
 * The payee field is only shown for a ONE-OFF check. An obligation-backed payment takes
 * its name from the parent bill, so an editable payee here would look like it renamed the
 * vendor while actually writing an override that the list ignores.
 */
export function EditPaymentDialog({
  payment,
  label,
  open,
  onOpenChange,
}: {
  payment: ObligationPayment
  label: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [pending, startTransition] = useTransition()
  const [amount, setAmount] = useState(String(payment.amount))
  const [paymentDate, setPaymentDate] = useState(payment.paymentDate.slice(0, 10))
  const [payeeName, setPayeeName] = useState(payment.payeeName ?? '')
  const [checkNumber, setCheckNumber] = useState(payment.checkNumber ?? '')
  const [purpose, setPurpose] = useState(payment.purpose ?? '')
  const [memo, setMemo] = useState(payment.memo ?? '')
  const [warning, setWarning] = useState<string | null>(null)

  const isOneOff = !payment.obligationId
  const isCheck = payment.paymentMethod === 'check'

  function submit(acknowledge: boolean) {
    startTransition(async () => {
      const res = await editPayment(
        {
          paymentId: payment.id,
          amount: Number(amount),
          paymentDate,
          // Only send the payee for a one-off; an obligation-backed payment must keep
          // deriving its name from the bill.
          payeeName: isOneOff ? payeeName : payment.payeeName,
          checkNumber,
          purpose,
          memo,
        },
        acknowledge,
      )
      if (res.ok) {
        toast.success('Payment updated.')
        setWarning(null)
        onOpenChange(false)
        return
      }
      if (res.reconciliationWarning) {
        setWarning(res.reconciliationWarning)
        return
      }
      toast.error(res.error ?? 'Could not update the payment.')
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Drop a pending warning on close so reopening doesn't present a stale
        // confirmation for an edit the owner walked away from.
        if (!next) setWarning(null)
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit payment</DialogTitle>
          <DialogDescription>
            {label} · currently {formatCurrency(payment.amount)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`edit-amount-${payment.id}`}>Amount</Label>
              <Input
                id={`edit-amount-${payment.id}`}
                type="number"
                step="any"
                inputMode="decimal"
                className="h-11 text-base"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value)
                  // Any change invalidates a warning that was raised for the previous
                  // values, so the owner can't confirm an edit they've since altered.
                  setWarning(null)
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`edit-date-${payment.id}`}>
                {payment.status === 'cleared' ? 'Payment date' : isCheck ? 'Date written' : 'Date'}
              </Label>
              <Input
                id={`edit-date-${payment.id}`}
                type="date"
                className="h-11 text-base"
                value={paymentDate}
                onChange={(e) => {
                  setPaymentDate(e.target.value)
                  setWarning(null)
                }}
              />
            </div>
          </div>

          {isOneOff && (
            <div className="space-y-1.5">
              <Label htmlFor={`edit-payee-${payment.id}`}>Paid to</Label>
              <Input
                id={`edit-payee-${payment.id}`}
                className="h-11 text-base"
                value={payeeName}
                onChange={(e) => setPayeeName(e.target.value)}
              />
            </div>
          )}

          {isCheck && (
            <div className="space-y-1.5">
              <Label htmlFor={`edit-check-${payment.id}`}>Check number</Label>
              <Input
                id={`edit-check-${payment.id}`}
                inputMode="numeric"
                className="h-11 text-base"
                value={checkNumber}
                onChange={(e) => setCheckNumber(e.target.value)}
                placeholder="e.g. 1318"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor={`edit-purpose-${payment.id}`}>What it was for</Label>
            <Input
              id={`edit-purpose-${payment.id}`}
              className="h-11 text-base"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="Optional"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`edit-memo-${payment.id}`}>Memo</Label>
            <Input
              id={`edit-memo-${payment.id}`}
              className="h-11 text-base"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="Optional"
            />
          </div>

          {warning && (
            <div className="flex gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3">
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-destructive"
                aria-hidden="true"
              />
              <div className="min-w-0 text-sm leading-relaxed">
                <p className="text-foreground">{warning}</p>
                <p className="mt-1 text-muted-foreground">
                  If the check itself was written for a different amount, save anyway. If
                  you are fixing a mis-match, use &quot;Not cleared&quot; first so the
                  bank match is released.
                </p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={() => submit(Boolean(warning))}
            disabled={pending || !amount.trim() || !paymentDate}
            variant={warning ? 'destructive' : 'default'}
          >
            {pending ? 'Saving…' : warning ? 'Save anyway' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

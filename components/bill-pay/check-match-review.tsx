'use client'

import { useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import Link from 'next/link'
import { Landmark, Check, X, HelpCircle } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatCurrency } from '@/lib/data'
// Type-only: the pure module is client-safe, but importing the type keeps this file
// honest about not reaching for anything server-side.
import type { AutoClearReview, ReviewReason } from '@/lib/obligation-auto-clear'
import { resolveAutoClearItem } from '@/app/bill-pay/actions'

/**
 * A review row plus the bill labels it might belong to. The labels are built on the
 * server by buildObligationLabels, the same function that worded the explanation, so the
 * picker and the sentence above it can never disagree about a bill's name.
 */
export type CheckMatchReviewItem = AutoClearReview & {
  candidates: { id: string; label: string }[]
}

/**
 * Which reasons are worth the owner's attention right now.
 *
 * An orphan check (`unrecognized_check`) is usually ordinary spending that was never
 * tracked as a bill — there are dozens in this ledger. Mixing those into the same list as
 * a bill that looks genuinely unpaid would bury four useful rows under twenty-six
 * uninteresting ones, so orphans live behind a toggle instead.
 */
const ACTIONABLE: ReviewReason[] = [
  'amount_mismatch',
  'possible_unrecorded_payment',
  'ambiguous_amount',
  'ambiguous_check',
]

const REASON_BADGE: Record<ReviewReason, string> = {
  amount_mismatch: 'Amount differs',
  possible_unrecorded_payment: 'Looks unpaid',
  ambiguous_amount: 'Which bill?',
  ambiguous_check: 'Which check?',
  unrecognized_check: 'No match',
}

function ReviewRow({ item }: { item: CheckMatchReviewItem }) {
  const [pending, startTransition] = useTransition()
  // Seeded only when there is exactly one candidate. With several, an empty picker forces
  // a deliberate choice rather than letting a default quietly become the answer.
  const [choice, setChoice] = useState(
    item.candidates.length === 1 ? item.candidates[0].id : '',
  )

  const run = (
    input: Parameters<typeof resolveAutoClearItem>[0],
    successMessage: string,
  ) => {
    startTransition(async () => {
      const res = await resolveAutoClearItem(input)
      if (res.ok) toast.success(successMessage)
      else toast.error(res.error ?? 'Could not update that item.')
    })
  }

  const onDismiss = () =>
    run(
      { transactionId: item.transactionId, choice: 'dismiss' },
      'Marked as not a bill payment.',
    )

  const onAcceptBank = () =>
    run(
      {
        transactionId: item.transactionId,
        choice: 'accept_bank',
        paymentId: item.paymentId,
      },
      `Corrected to ${formatCurrency(item.bankAmount)} and marked cleared.`,
    )

  const onLink = () => {
    if (!choice) {
      toast.error('Choose which bill this check paid.')
      return
    }
    run(
      { transactionId: item.transactionId, choice: 'link', obligationId: choice },
      'Recorded as paid from the bank.',
    )
  }

  const needsPicker = item.candidates.length > 1
  const canLink =
    item.reason === 'possible_unrecorded_payment' ||
    item.reason === 'ambiguous_amount' ||
    item.reason === 'ambiguous_check'

  return (
    <div className="border-t border-border py-4 first:border-t-0 first:pt-0">
      {/* Stacked, not tabular. The /admin records table pushes its action column
          off-screen on a phone; this layout keeps every control reachable without
          sideways scrolling. */}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-sm font-medium text-foreground">
          {item.checkNumber ? `Check #${item.checkNumber}` : 'Bank debit'}
        </span>
        <span className="font-mono text-sm text-foreground">
          {formatCurrency(item.bankAmount)}
        </span>
        <span className="text-xs text-muted-foreground">{item.postedDate}</span>
        <Badge variant="secondary" className="ml-auto text-xs">
          {REASON_BADGE[item.reason]}
        </Badge>
      </div>

      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {item.explanation}
      </p>

      {item.reason === 'amount_mismatch' && item.recordedAmount !== undefined ? (
        <p className="mt-2 font-mono text-xs text-muted-foreground">
          you recorded {formatCurrency(item.recordedAmount)} · bank cleared{' '}
          {formatCurrency(item.bankAmount)}
        </p>
      ) : null}

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        {/* onValueChange yields string | null when cleared, so the null is coerced back to
            the empty-string "nothing chosen" state the submit guard checks. */}
        {canLink && needsPicker ? (
          <Select value={choice} onValueChange={(v) => setChoice(v ?? '')}>
            <SelectTrigger className="h-11 w-full sm:w-64">
              <SelectValue placeholder="Which bill did this pay?" />
            </SelectTrigger>
            <SelectContent>
              {item.candidates.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {item.reason === 'amount_mismatch' ? (
            <Button className="h-11" onClick={onAcceptBank} disabled={pending}>
              <Check className="size-4" aria-hidden="true" />
              Use bank amount
            </Button>
          ) : null}

          {canLink ? (
            <Button className="h-11" onClick={onLink} disabled={pending}>
              <Check className="size-4" aria-hidden="true" />
              {item.candidates.length === 1
                ? `Record ${item.candidates[0].label} as paid`
                : 'Record as paid'}
            </Button>
          ) : null}

          <Button
            variant="outline"
            className="h-11"
            onClick={onDismiss}
            disabled={pending}
          >
            <X className="size-4" aria-hidden="true" />
            Not a bill
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * The review queue for bank checks the matcher would not clear on its own.
 *
 * Only exact check-number-and-amount matches clear automatically; everything the machine
 * is not certain about lands here with a plain-English reason, which is the manual
 * verification step the owner asked for.
 */
export function CheckMatchReview({ items }: { items: CheckMatchReviewItem[] }) {
  const { actionable, orphans } = useMemo(
    () => ({
      actionable: items.filter((i) => ACTIONABLE.includes(i.reason)),
      orphans: items.filter((i) => i.reason === 'unrecognized_check'),
    }),
    [items],
  )

  if (items.length === 0) return null

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Landmark className="size-4 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-sm font-medium text-foreground">
            Bank checks needing a look
          </h2>
          <Badge variant="secondary" className="text-xs">
            {actionable.length} to verify
          </Badge>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Checks that cleared your bank are matched to bills automatically when the check
          number and amount both line up exactly. These did not, so they are yours to
          confirm.
        </p>

        {actionable.length > 0 ? (
          <div className="mt-4">
            {actionable.map((item) => (
              <ReviewRow key={item.transactionId} item={item} />
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">
            Nothing needs verifying right now.
          </p>
        )}

        {/* Orphan checks are deliberately NOT listed here. Check Resolution already walks
            every payee-less CHECK line in the ledger, so listing a subset of the same bank
            rows under a different question ("not a bill?" vs "who was paid?") would make
            the owner work the same rows twice in two places. One pointer, no second queue. */}
        {orphans.length > 0 ? (
          <p className="mt-4 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
            <HelpCircle
              className="mr-1 inline size-3.5 align-[-2px]"
              aria-hidden="true"
            />
            {orphans.length} other cleared {orphans.length === 1 ? 'check' : 'checks'} match
            no bill on record — usually ordinary spending that was never tracked as a bill.
            Name who they were paid to in{' '}
            <Link href="/check-resolution" className="font-medium underline">
              Check Resolution
            </Link>
            .
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

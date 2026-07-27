'use client'

import { useState, useTransition } from 'react'
import { Repeat, Check, X, TrendingUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { formatCurrency } from '@/lib/data'
import type { RecurringSuggestion } from '@/lib/transaction-queries'
import { approveRecurringSuggestion } from '@/app/vendors/transactions/actions'

const CADENCE_LABELS: Record<string, string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Annual',
}

function addForCadence(lastDate: string, cadence: string): string {
  const d = new Date(`${lastDate}T00:00:00`)
  if (Number.isNaN(d.getTime())) return ''
  const map: Record<string, () => void> = {
    weekly: () => d.setDate(d.getDate() + 7),
    biweekly: () => d.setDate(d.getDate() + 14),
    monthly: () => d.setMonth(d.getMonth() + 1),
    quarterly: () => d.setMonth(d.getMonth() + 3),
    annual: () => d.setFullYear(d.getFullYear() + 1),
  }
  ;(map[cadence] ?? map.monthly)()
  return d.toISOString().slice(0, 10)
}

export function RecurringSuggestions({
  suggestions,
}: {
  suggestions: RecurringSuggestion[]
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const visible = suggestions.filter(
    (s) => !dismissed.has(s.key) && !s.alreadyTracked,
  )

  if (visible.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Repeat className="size-4" aria-hidden="true" />
            Recurring charges
          </CardTitle>
          <CardDescription>
            No new recurring patterns detected yet. Once several statements are
            imported, repeating charges show up here so you can turn them into
            tracked cash obligations.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Repeat className="size-4" aria-hidden="true" />
          Recurring charges detected
        </CardTitle>
        <CardDescription>
          These repeat on a regular schedule in your imported history. Approving
          one creates a tracked cash obligation used by the cash-flow forecast.
          Nothing is added until you approve it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && (
          <p
            role="alert"
            className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        {visible.map((s) => {
          const suggestedDate = addForCadence(s.lastDate, s.cadence)
          const isActive = activeKey === s.key
          return (
            <div
              key={s.key}
              className="flex flex-col gap-3 rounded-lg border border-border p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">{s.vendorName || 'Unknown vendor'}</p>
                  <p className="truncate text-sm text-muted-foreground" title={s.sampleDescription}>
                    {s.sampleDescription}
                  </p>
                </div>
                <Badge variant="secondary" className="bg-primary/10 text-primary">
                  {Math.round(s.confidence)}% confident
                </Badge>
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <Stat label="Cadence" value={CADENCE_LABELS[s.cadence] ?? s.cadence} />
                <Stat label="Avg amount" value={formatCurrency(s.averageAmount)} />
                <Stat label="Seen" value={`${s.occurrences}x`} />
                <Stat
                  label="Last charge"
                  value={new Date(`${s.lastDate}T00:00:00`).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: '2-digit',
                  })}
                />
              </div>

              {isActive ? (
                <ApproveForm
                  suggestion={s}
                  defaultDate={suggestedDate}
                  pending={pending}
                  onCancel={() => setActiveKey(null)}
                  onSubmit={(amount, nextDueDate) => {
                    setError(null)
                    startTransition(async () => {
                      const res = await approveRecurringSuggestion({
                        vendorId: s.vendorId,
                        vendorName: s.vendorName,
                        label: `${s.vendorName} (${CADENCE_LABELS[s.cadence] ?? s.cadence})`,
                        amount,
                        cadence: s.cadence,
                        nextDueDate,
                        category: '',
                      })
                      if (!res.ok) setError(res.error ?? 'Could not create obligation.')
                      else {
                        setActiveKey(null)
                        setDismissed((prev) => new Set(prev).add(s.key))
                      }
                    })
                  }}
                />
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    className="h-11"
                    onClick={() => setActiveKey(s.key)}
                  >
                    <TrendingUp className="size-4" aria-hidden="true" />
                    Track as obligation
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-11"
                    onClick={() =>
                      setDismissed((prev) => new Set(prev).add(s.key))
                    }
                  >
                    <X className="size-4" aria-hidden="true" />
                    Dismiss
                  </Button>
                </div>
              )}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

function ApproveForm({
  suggestion,
  defaultDate,
  pending,
  onCancel,
  onSubmit,
}: {
  suggestion: RecurringSuggestion
  defaultDate: string
  pending: boolean
  onCancel: () => void
  onSubmit: (amount: number, nextDueDate: string) => void
}) {
  const [amount, setAmount] = useState(suggestion.averageAmount.toFixed(2))
  const [date, setDate] = useState(defaultDate)

  return (
    <form
      className="flex flex-col gap-3 rounded-md bg-muted/40 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(Number(amount), date)
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Amount</span>
          <Input
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="h-11"
            required
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Next due date</span>
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-11"
            required
          />
        </label>
      </div>
      <div className="flex gap-2">
        <Button type="submit" className="h-11" disabled={pending}>
          <Check className="size-4" aria-hidden="true" />
          Create obligation
        </Button>
        <Button type="button" variant="ghost" className="h-11" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  )
}

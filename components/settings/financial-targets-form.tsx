'use client'

import { useState, useTransition } from 'react'
import { Loader2, CheckCircle2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { saveBusinessSettings } from '@/app/admin/actions'

type FieldDef = {
  key: string
  label: string
  // 'days' is a plain integer count, so it takes neither the $ prefix nor the % suffix.
  unit: 'percent' | 'currency' | 'days'
  hint: string
}

const FIELDS: FieldDef[] = [
  {
    key: 'target_payroll_pct',
    label: 'Payroll % Target',
    unit: 'percent',
    hint: 'Payroll should stay at or below this share of sales.',
  },
  {
    key: 'warning_payroll_pct',
    label: 'Payroll % Warning',
    unit: 'percent',
    hint: 'Above this, the dashboard flags payroll in red.',
  },
  {
    key: 'target_gross_profit_pct',
    label: 'Gross Profit % Target',
    unit: 'percent',
    hint: 'The margin the Gross Profit gauge measures against.',
  },
  {
    key: 'min_cash_reserve',
    label: 'Min Cash Reserve',
    unit: 'currency',
    hint: 'Business health turns to Caution below this.',
  },
  {
    key: 'preferred_weekly_sales',
    label: 'Preferred Weekly Sales',
    unit: 'currency',
    hint: 'Your weekly sales goal.',
  },
  {
    key: 'minimum_weekly_sales',
    label: 'Minimum Weekly Sales',
    unit: 'currency',
    hint: 'The weekly floor to stay healthy.',
  },
  {
    key: 'avg_monthly_wholesale',
    label: 'Avg Monthly Wholesale',
    unit: 'currency',
    hint: 'Typical monthly wholesale revenue.',
  },
  {
    key: 'bill_reminder_lead_days',
    label: 'Bill Reminder Lead Time',
    unit: 'days',
    hint: 'How many days ahead a bill starts showing in "Bills to pay".',
  },
  {
    key: 'orphan_check_review_days',
    label: 'Unmatched Check Review Window',
    unit: 'days',
    hint: 'How far back to flag a cleared check that matches no bill on record.',
  },
]

// Accepts the whole settings object (which also carries a `rows` array) and
// pulls just the numeric target for each field.
//
// A missing value becomes an EMPTY string, never "0". Showing 0 for an absent setting
// makes a failed read look like a deliberate choice — and for a lead time specifically, a
// silent 0 would mean "only warn me on the due date itself", quietly removing all the
// advance notice while appearing to work. Empty renders as a blank box the owner can see
// needs filling in.
function toFormState(values: Record<string, unknown>) {
  return Object.fromEntries(
    FIELDS.map((f) => {
      const raw = values[f.key]
      const n = Number(raw)
      return [f.key, raw == null || !Number.isFinite(n) ? '' : String(n)]
    }),
  ) as Record<string, string>
}

export function FinancialTargetsForm({
  values,
}: {
  values: Record<string, unknown>
}) {
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(
    null,
  )
  // Controlled inputs so a revalidated server value never conflicts with an
  // uncontrolled defaultValue after saving.
  const [form, setForm] = useState(() => toFormState(values))

  function onSubmit(formData: FormData) {
    setMessage(null)
    startTransition(async () => {
      const res = await saveBusinessSettings(formData)
      if (res?.error) setMessage({ type: 'err', text: res.error })
      else setMessage({ type: 'ok', text: res?.success ?? 'Targets saved.' })
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Financial Targets</CardTitle>
        <CardDescription>
          These values drive the health indicators, payroll thresholds, and sales
          goals across the dashboard.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={onSubmit}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FIELDS.map((f) => (
              <div key={f.key} className="space-y-2">
                <Label htmlFor={f.key}>{f.label}</Label>
                <div className="relative">
                  {f.unit === 'currency' && (
                    <span
                      className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
                      aria-hidden="true"
                    >
                      $
                    </span>
                  )}
                  <Input
                    id={f.key}
                    name={f.key}
                    type="number"
                    step="any"
                    min="0"
                    inputMode="decimal"
                    value={form[f.key]}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, [f.key]: e.target.value }))
                    }
                    className={
                      f.unit === 'currency'
                        ? 'pl-7 font-mono'
                        : f.unit === 'percent'
                          ? 'pr-7 font-mono'
                          : 'pr-12 font-mono'
                    }
                  />
                  {f.unit === 'percent' && (
                    <span
                      className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
                      aria-hidden="true"
                    >
                      %
                    </span>
                  )}
                  {f.unit === 'days' && (
                    <span
                      className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
                      aria-hidden="true"
                    >
                      days
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{f.hint}</p>
              </div>
            ))}
          </div>

          <div className="mt-6 flex items-center justify-end gap-3">
            {message && (
              <span
                className={`flex items-center gap-1.5 text-sm ${
                  message.type === 'ok' ? 'text-primary' : 'text-destructive'
                }`}
                role="status"
              >
                {message.type === 'ok' ? (
                  <CheckCircle2 className="size-4" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="size-4" aria-hidden="true" />
                )}
                {message.text}
              </span>
            )}
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              {pending ? 'Saving…' : 'Save targets'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

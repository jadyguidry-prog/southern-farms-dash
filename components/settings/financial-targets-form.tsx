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
  unit: 'percent' | 'currency'
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
]

function toFormState(values: Record<string, number>) {
  return Object.fromEntries(
    FIELDS.map((f) => [f.key, String(values[f.key] ?? 0)]),
  ) as Record<string, string>
}

export function FinancialTargetsForm({
  values,
}: {
  values: Record<string, number>
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
                        : 'pr-7 font-mono'
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

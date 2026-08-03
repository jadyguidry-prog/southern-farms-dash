'use client'

/**
 * Activation + outcome tracking for an approved commitment (M5).
 *
 * This is where a forecast becomes a fact. Two things are recorded: that it went
 * live (once), and what it cost/earned (per month). Everything shown here comes from
 * the shared `summarizeOutcomes`, so the figures match the admin report exactly.
 *
 * The interface is deliberately blunt about uncertainty:
 *   - unrecorded months are listed as "not recorded", never as $0
 *   - added sales require an attribution level, and the form refuses a figure the
 *     owner has marked unmeasurable rather than quietly accepting it
 *   - sales are compared against the proposal's own required-sales-by-margin table,
 *     never against its gross-profit break-even
 */

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  ATTRIBUTION_CAVEATS,
  ATTRIBUTION_LABELS,
  type Attribution,
  type OutcomeSummary,
} from '@/lib/growth-outcomes'
import {
  activateProposal,
  deleteProposalOutcome,
  recordProposalOutcome,
} from '@/app/growth/proposal-store'
import { formatCurrency } from '@/lib/data'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

const SELECT_CLASS =
  'h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number)
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
  })
}

/** Cost variance colour: over budget is bad, under is good, unrecorded is neutral. */
function varianceTone(v: number | null): string {
  if (v == null) return 'text-muted-foreground'
  if (v > 0) return 'text-amber-700'
  if (v < 0) return 'text-emerald-700'
  return 'text-foreground'
}

export function OutcomeTracker({
  proposalId,
  approved,
  outcomes,
}: {
  proposalId: string
  approved: boolean
  outcomes: OutcomeSummary
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // Activation form
  const [startDate, setStartDate] = useState('')
  const [upfront, setUpfront] = useState('')

  // Month form
  const [monthKey, setMonthKey] = useState('')
  const [cost, setCost] = useState('')
  const [revenue, setRevenue] = useState('')
  const [attribution, setAttribution] = useState<Attribution>('not_measurable')

  function onActivate() {
    setError(null)
    startTransition(async () => {
      const res = await activateProposal({
        proposalId,
        actualStartDate: startDate,
        actualUpfrontCost: upfront.trim() === '' ? 0 : Number(upfront),
      })
      if (!res.ok) setError(res.error ?? 'Could not save that.')
      else router.refresh()
    })
  }

  function onRecordMonth() {
    setError(null)
    startTransition(async () => {
      const res = await recordProposalOutcome({
        proposalId,
        monthKey,
        actualCost: cost.trim() === '' ? null : Number(cost),
        revenueImpact: revenue.trim() === '' ? null : Number(revenue),
        attribution,
      })
      if (!res.ok) {
        setError(res.error ?? 'Could not save that.')
      } else {
        setCost('')
        setRevenue('')
        setAttribution('not_measurable')
        router.refresh()
      }
    })
  }

  function onDeleteMonth(mk: string) {
    startTransition(async () => {
      await deleteProposalOutcome(proposalId, mk)
      router.refresh()
    })
  }

  // Not approved yet: tracking actuals for something never committed to would be
  // recording fiction, so the panel explains the prerequisite instead.
  if (!approved) {
    return (
      <section className="rounded-lg border border-border bg-card p-4" aria-labelledby="tracking-h">
        <h2 id="tracking-h" className="text-base font-semibold">
          What it actually cost
        </h2>
        <p className="mt-2 text-pretty text-sm text-muted-foreground">
          Once you mark this as one you went ahead with, you can record what it really
          cost each month and compare that against the forecast above.
        </p>
      </section>
    )
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4" aria-labelledby="tracking-h">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="tracking-h" className="text-base font-semibold">
            What it actually cost
          </h2>
          <p className="text-sm text-muted-foreground">
            Forecast was {formatCurrency(outcomes.forecastMonthlyCost)}/mo
            {outcomes.forecastUpfrontCost > 0
              ? ` plus ${formatCurrency(outcomes.forecastUpfrontCost)} upfront`
              : ''}
            .
          </p>
        </div>
      </div>

      <p className="mt-3 text-pretty text-sm font-medium">{outcomes.headline}</p>

      {error ? (
        <p className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {!outcomes.activated ? (
        <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
          <p className="text-sm font-medium">Record when it started</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="start-date">Date it actually began</Label>
              <Input
                id="start-date"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="upfront">Upfront cost actually paid</Label>
              <Input
                id="upfront"
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                placeholder={outcomes.forecastUpfrontCost > 0 ? String(outcomes.forecastUpfrontCost) : '0'}
                value={upfront}
                onChange={(e) => setUpfront(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Button onClick={onActivate} disabled={pending || !startDate}>
              {pending ? 'Saving…' : 'It started on this date'}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-4 sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">Started</dt>
              <dd className="text-sm font-medium">
                {new Date(
                  `${outcomes.activation?.actualStartDate}T00:00:00`,
                ).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Months recorded</dt>
              <dd className="text-sm font-medium">
                {outcomes.monthsRecorded} of {outcomes.monthsElapsed}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Actual cost so far</dt>
              <dd className="text-sm font-medium">
                {/* Never $0 for an unrecorded history — that would read as free. */}
                {outcomes.actualCostOverRecorded == null
                  ? 'Not recorded'
                  : formatCurrency(outcomes.actualCostOverRecorded)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                vs forecast{outcomes.monthsRecorded > 0 ? ' (recorded months)' : ''}
              </dt>
              <dd className={`text-sm font-medium ${varianceTone(outcomes.costVariance)}`}>
                {outcomes.costVariance == null
                  ? '—'
                  : `${outcomes.costVariance > 0 ? '+' : ''}${formatCurrency(outcomes.costVariance)}`}
              </dd>
            </div>
          </dl>

          {outcomes.upfrontVariance != null && outcomes.upfrontVariance !== 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Upfront cost came in{' '}
              <span className={varianceTone(outcomes.upfrontVariance)}>
                {formatCurrency(Math.abs(outcomes.upfrontVariance))}{' '}
                {outcomes.upfrontVariance > 0 ? 'over' : 'under'}
              </span>{' '}
              the forecast.
            </p>
          ) : null}

          {/* Margin checks: the only honest way to judge recorded SALES, since the
              break-even is expressed in gross profit and the margin is unknown. */}
          {outcomes.marginChecks.length > 0 ? (
            <div className="mt-4 border-t border-border pt-4">
              <p className="text-sm font-medium">
                Does {formatCurrency(outcomes.avgMonthlyDefensibleRevenue ?? 0)}/mo of attributed
                sales cover it?
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Depends on your margin, which we do not know — so here it is at several.
              </p>
              <div className="relative mt-2 overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">
                    Whether attributed sales cover the commitment at each assumed margin
                  </caption>
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th scope="col" className="py-1.5 pr-4 font-medium">
                        If margin is
                      </th>
                      <th scope="col" className="py-1.5 pr-4 font-medium">
                        Sales needed
                      </th>
                      <th scope="col" className="py-1.5 font-medium">
                        Covered?
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {outcomes.marginChecks.map((m) => (
                      <tr key={m.marginPct} className="border-b border-border/50 last:border-0">
                        <td className="py-1.5 pr-4">{m.marginPct}%</td>
                        <td className="py-1.5 pr-4">
                          {formatCurrency(m.requiredMonthlySales)}/mo
                        </td>
                        <td
                          className={`py-1.5 font-medium ${m.clears ? 'text-emerald-700' : 'text-amber-700'}`}
                        >
                          {m.clears ? 'Yes' : 'No'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {outcomes.nonDefensibleRevenue != null ? (
            <p className="mt-3 text-pretty text-sm text-muted-foreground">
              A further {formatCurrency(outcomes.nonDefensibleRevenue)} of sales was recorded
              against this, but only as{' '}
              {(ATTRIBUTION_LABELS[outcomes.weakestAttribution ?? 'not_measurable'] ?? '').toLowerCase()}
              , so it is not counted as a return.
            </p>
          ) : null}

          {/* Month-by-month history */}
          <div className="mt-4 border-t border-border pt-4">
            <p className="text-sm font-medium">Month by month</p>
            <div className="relative mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">
                  Forecast and actual cost for each month since this commitment started
                </caption>
                <thead>
                  <tr className="border-b border-border text-left">
                    <th scope="col" className="py-1.5 pr-4 font-medium">
                      Month
                    </th>
                    <th scope="col" className="py-1.5 pr-4 font-medium">
                      Actual cost
                    </th>
                    <th scope="col" className="py-1.5 pr-4 font-medium">
                      vs forecast
                    </th>
                    <th scope="col" className="py-1.5 pr-4 font-medium">
                      Added sales
                    </th>
                    <th scope="col" className="py-1.5 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {outcomes.months.map((m) => (
                    <tr key={m.monthKey} className="border-b border-border/50 last:border-0">
                      <td className="py-1.5 pr-4 whitespace-nowrap">{monthLabel(m.monthKey)}</td>
                      <td className="py-1.5 pr-4 whitespace-nowrap">
                        {m.actualCost == null ? (
                          <span className="text-muted-foreground">Not recorded</span>
                        ) : (
                          formatCurrency(m.actualCost)
                        )}
                      </td>
                      <td className={`py-1.5 pr-4 whitespace-nowrap ${varianceTone(m.costVariance)}`}>
                        {m.costVariance == null
                          ? '—'
                          : `${m.costVariance > 0 ? '+' : ''}${formatCurrency(m.costVariance)}`}
                      </td>
                      <td className="py-1.5 pr-4 whitespace-nowrap">
                        {m.revenueImpact == null ? (
                          <span className="text-muted-foreground">Not measured</span>
                        ) : (
                          <>
                            {formatCurrency(m.revenueImpact)}
                            <span className="ml-1.5 text-xs text-muted-foreground">
                              {ATTRIBUTION_LABELS[m.attribution].toLowerCase()}
                            </span>
                          </>
                        )}
                      </td>
                      <td className="py-1.5 whitespace-nowrap">
                        {m.recorded || m.revenueImpact != null ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onDeleteMonth(m.monthKey)}
                            disabled={pending}
                          >
                            Clear
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Entry form */}
          <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
            <p className="text-sm font-medium">Record a month</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="month-key">Month</Label>
                <select
                  id="month-key"
                  value={monthKey}
                  onChange={(e) => setMonthKey(e.target.value)}
                  className={SELECT_CLASS}
                >
                  <option value="">Pick a month…</option>
                  {outcomes.months.map((m) => (
                    <option key={m.monthKey} value={m.monthKey}>
                      {monthLabel(m.monthKey)}
                      {m.recorded ? ' (recorded — will replace)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="actual-cost">What it cost that month</Label>
                <Input
                  id="actual-cost"
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  placeholder={String(outcomes.forecastMonthlyCost)}
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="revenue">Added sales you credit to it (optional)</Label>
                <Input
                  id="revenue"
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  placeholder="Leave blank if unknown"
                  value={revenue}
                  onChange={(e) => setRevenue(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="attribution">How sure are you of that?</Label>
                <select
                  id="attribution"
                  value={attribution}
                  onChange={(e) => setAttribution(e.target.value as Attribution)}
                  className={SELECT_CLASS}
                >
                  {(Object.keys(ATTRIBUTION_LABELS) as Attribution[]).map((a) => (
                    <option key={a} value={a}>
                      {ATTRIBUTION_LABELS[a]}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  {ATTRIBUTION_CAVEATS[attribution]}
                </p>
              </div>
            </div>
            <div>
              <Button
                onClick={onRecordMonth}
                disabled={pending || !monthKey || (cost.trim() === '' && revenue.trim() === '')}
              >
                {pending ? 'Saving…' : 'Save this month'}
              </Button>
            </div>
          </div>
        </>
      )}
    </section>
  )
}

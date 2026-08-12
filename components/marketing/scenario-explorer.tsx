'use client'

import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { formatCurrency } from '@/lib/data'
import type { Scenario, ScenarioRisk } from '@/lib/marketing-affordability-service'

/**
 * "What if I spent $X more?" answered against real cash.
 *
 * The point of the interaction is to make the reserve breach visible: the owner
 * can step up through the amounts and watch exactly where the account stops
 * being able to carry it, rather than being handed a single verdict to trust.
 */

const RISK_STYLE: Record<ScenarioRisk, { badge: string; bar: string; ring: string }> = {
  Safe: {
    badge: 'border-transparent bg-emerald-600 text-white',
    bar: 'bg-emerald-600',
    ring: 'border-emerald-600',
  },
  Caution: {
    badge: 'border-transparent bg-amber-500 text-white',
    bar: 'bg-amber-500',
    ring: 'border-amber-500',
  },
  'High Risk': {
    badge: 'border-transparent bg-amber-600 text-white',
    bar: 'bg-amber-600',
    ring: 'border-amber-600',
  },
  Unsafe: {
    badge: 'border-transparent bg-destructive text-white',
    bar: 'bg-destructive',
    ring: 'border-destructive',
  },
}

export function ScenarioExplorer({
  scenarios,
  minCashReserve,
  projectedCash,
  daysCashTarget,
}: {
  scenarios: Scenario[]
  minCashReserve: number
  projectedCash: number
  daysCashTarget: number
}) {
  const [index, setIndex] = useState(0)
  const active = scenarios[index]

  if (!active) return null

  const style = RISK_STYLE[active.risk]
  // Bar is drawn against the reserve target so "how close am I to the line" is
  // a length the eye can read, not a subtraction the owner has to do.
  const scale = Math.max(minCashReserve, projectedCash, 1)
  const cashPct = Math.max(0, Math.min(100, (Math.max(0, active.endingCash) / scale) * 100))
  const reservePct = Math.max(0, Math.min(100, (minCashReserve / scale) * 100))

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="p-6 pb-0">
        <CardTitle>What if I spent more?</CardTitle>
        <CardDescription className="text-pretty">
          Each amount is subtracted from the {formatCurrency(projectedCash)}{' '}
          projected to be left after this month&apos;s known bills, then checked against your{' '}
          {formatCurrency(minCashReserve)} reserve target.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-5 p-6">
        <div
          className="flex flex-wrap gap-2"
          role="radiogroup"
          aria-label="Additional monthly marketing spend"
        >
          {scenarios.map((s, i) => (
            <button
              key={s.increase}
              type="button"
              role="radio"
              aria-checked={i === index}
              onClick={() => setIndex(i)}
              className={cn(
                'rounded-lg border px-3 py-2 font-mono text-sm font-semibold transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                i === index
                  ? `${RISK_STYLE[s.risk].ring} bg-accent text-accent-foreground`
                  : 'border-border bg-card text-muted-foreground hover:bg-accent/50',
              )}
            >
              +{formatCurrency(s.increase)}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-foreground text-pretty">
              Spending {formatCurrency(active.increase)} more this month
            </p>
            <Badge className={style.badge}>{active.risk}</Badge>
          </div>

          {/* Cash remaining, with the reserve target marked on the same scale. */}
          <div className="relative h-3 w-full overflow-hidden rounded-full bg-border">
            <div className={cn('h-full', style.bar)} style={{ width: `${cashPct}%` }} />
            <div
              className="absolute inset-y-0 w-0.5 bg-foreground"
              style={{ left: `${reservePct}%` }}
              aria-hidden="true"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Bar is cash left; the line is your {formatCurrency(minCashReserve)} reserve target.
          </p>

          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Cash left
              </dt>
              <dd className="mt-1 font-mono text-lg font-semibold text-foreground">
                {formatCurrency(active.endingCash)}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Versus reserve
              </dt>
              <dd
                className={cn(
                  'mt-1 font-mono text-lg font-semibold',
                  active.reserveRemaining < 0 ? 'text-destructive' : 'text-foreground',
                )}
              >
                {active.reserveRemaining < 0 ? '-' : '+'}
                {formatCurrency(Math.abs(active.reserveRemaining))}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Days of cash
              </dt>
              <dd className="mt-1 font-mono text-lg font-semibold text-foreground">
                {active.daysCashOnHand > 0 ? Math.round(active.daysCashOnHand) : '—'}
                <span className="ml-1 font-sans text-xs font-normal text-muted-foreground">
                  vs {daysCashTarget} target
                </span>
              </dd>
            </div>
          </dl>

          <p className="text-sm leading-relaxed text-foreground text-pretty">{active.note}</p>
        </div>
      </CardContent>
    </Card>
  )
}

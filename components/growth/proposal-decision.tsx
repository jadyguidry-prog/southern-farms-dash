/**
 * Renders a full ProposalDecision.
 *
 * Presentation only — every number here was computed server-side by the pure
 * engine. The job of this file is to make a genuinely useful answer readable:
 * verdict first, then cost, cash impact, resilience, ROI, and — when it does not
 * fit — the concrete changes that would make it work.
 */

import type { ProposalDecision, Verdict } from '@/lib/growth-proposals'
import { CheckCircle2, AlertTriangle, XCircle } from 'lucide-react'

function money(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`
}

function formatISO(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

const VERDICT_STYLES: Record<
  Verdict,
  { icon: typeof CheckCircle2; border: string; bg: string; iconColor: string }
> = {
  Supported: {
    icon: CheckCircle2,
    border: 'border-emerald-500/30',
    bg: 'bg-emerald-500/5',
    iconColor: 'text-emerald-600',
  },
  'Supported with conditions': {
    icon: AlertTriangle,
    border: 'border-amber-500/30',
    bg: 'bg-amber-500/5',
    iconColor: 'text-amber-600',
  },
  'Not supported': {
    icon: XCircle,
    border: 'border-destructive/30',
    bg: 'bg-destructive/5',
    iconColor: 'text-destructive',
  },
}

export function ProposalDecisionView({
  decision,
  modeLabel,
  confidencePct,
}: {
  decision: ProposalDecision
  modeLabel: string
  confidencePct: number
}) {
  const v = VERDICT_STYLES[decision.verdict]
  const VerdictIcon = v.icon

  return (
    <div className="flex flex-col gap-5">
      {/* Verdict + summary */}
      <div className={`flex flex-col gap-2 rounded-lg border ${v.border} ${v.bg} p-4`}>
        <div className="flex items-center gap-2">
          <VerdictIcon className={`size-5 shrink-0 ${v.iconColor}`} aria-hidden="true" />
          <h3 className="text-base font-semibold text-foreground">{decision.verdict}</h3>
          <span className="ml-auto text-xs text-muted-foreground">
            {modeLabel} · {confidencePct}% confidence
          </span>
        </div>
        <p className="text-sm leading-relaxed text-foreground text-pretty">{decision.summary}</p>
      </div>

      {/* Cost breakdown */}
      <Panel title="What it costs">
        <dl className="grid grid-cols-3 gap-3">
          <Stat label="Monthly" value={money(decision.monthlyCost)} />
          <Stat label="Upfront" value={money(decision.upfrontCost)} />
          <Stat label="First-year total" value={money(decision.firstYearCost)} />
        </dl>
        {decision.costLines.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-1.5 border-t border-border pt-3">
            {decision.costLines.map((line, i) => (
              <li key={i} className="flex flex-col gap-0.5 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-foreground">{line.label}</span>
                  <span className="font-mono text-foreground">
                    {money(line.amount)}
                    <span className="text-xs text-muted-foreground">
                      {line.cadence === 'monthly' ? '/mo' : ' once'}
                    </span>
                  </span>
                </div>
                {line.note ? (
                  <span className="text-xs leading-relaxed text-muted-foreground text-pretty">
                    {line.note}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {decision.costCaveats.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-1.5">
            {decision.costCaveats.map((c, i) => (
              <li
                key={i}
                className="flex gap-2 text-xs leading-relaxed text-muted-foreground text-pretty"
              >
                <span aria-hidden="true">-</span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>

      {/* Cash impact */}
      <Panel title="What it does to your cash">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Lowest cash" value={money(decision.lowestProjectedCash)} sub={`in ${decision.lowestMonthKey}`} />
          <Stat
            label="Above reserve"
            value={money(decision.reserveRemaining)}
            tone={decision.reserveRemaining < 0 ? 'bad' : undefined}
          />
          <Stat label="Days of cash" value={`${decision.daysOfCashAtLow}`} sub="at the low point" />
          {/* A survivable drop of 0 does NOT mean "survives a 0% drop" — it means the
              proposal already fails at today's numbers, before any downturn. Showing
              "0%" as if it were a threshold reads as a near-pass; it isn't one. */}
          <Stat
            label={decision.survivesSalesDeclinePct <= 0 ? "Downturn headroom" : "Survives a drop of"}
            value={
              decision.survivesSalesDeclinePct <= 0
                ? 'None'
                : `${decision.survivesSalesDeclinePct}%`
            }
            sub={
              decision.survivesSalesDeclinePct <= 0
                ? "doesn't fit even at today's sales"
                : `${modeLabel} wants ${decision.requiredResiliencePct}%`
            }
            tone={
              decision.survivesSalesDeclinePct < decision.requiredResiliencePct ? 'warn' : 'good'
            }
          />
        </dl>
        {decision.bindingConstraint ? (
          <p className="mt-3 border-t border-border pt-3 text-sm leading-relaxed text-foreground text-pretty">
            <span className="font-medium">What binds first:</span> {decision.bindingConstraint}
          </p>
        ) : null}
        {decision.tradeoffs.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1.5">
            {decision.tradeoffs.map((t, i) => (
              <li
                key={i}
                className="flex gap-2 text-xs leading-relaxed text-muted-foreground text-pretty"
              >
                <span aria-hidden="true">-</span>
                <span>{t}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>

      {/* Revenue-based ROI */}
      <Panel title="What it has to earn back">
        <p className="text-sm leading-relaxed text-foreground text-pretty">
          To break even, this needs to generate at least{' '}
          <span className="font-semibold">{money(decision.roi.breakevenMonthlyGrossProfit)}/mo</span>{' '}
          in additional gross profit
          {decision.roi.upfrontToRecover > 0 ? (
            <>
              {' '}
              and recover {money(decision.roi.upfrontToRecover)} upfront
            </>
          ) : null}
          . That is stated in profit, not sales, because your true margin is not
          confirmed here.
        </p>
        {decision.roi.requiredMonthlySalesAtAssumed != null &&
        decision.roi.assumedMarginPct != null ? (
          <p className="mt-2 text-sm leading-relaxed text-foreground text-pretty">
            At the {decision.roi.assumedMarginPct}% margin you entered, that is about{' '}
            <span className="font-semibold">
              {money(decision.roi.requiredMonthlySalesAtAssumed)}/mo
            </span>{' '}
            in added sales. Treated as your assumption, not a verified number.
          </p>
        ) : (
          <div className="mt-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Required added sales, by margin
            </p>
            <ul className="flex flex-wrap gap-2">
              {decision.roi.sensitivity.map((row) => (
                <li
                  key={row.marginPct}
                  className="rounded-md border border-border px-2.5 py-1.5 text-xs"
                >
                  <span className="text-muted-foreground">at {row.marginPct}%:</span>{' '}
                  <span className="font-mono text-foreground">
                    {money(row.requiredMonthlySales)}/mo
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground text-pretty">
              A sensitivity range, not a claim. Enter your margin above to narrow it to
              one number.
            </p>
          </div>
        )}
      </Panel>

      {/* Conditions */}
      {decision.conditions.length > 0 ? (
        <Panel title="Conditions before you commit">
          <ul className="flex flex-col gap-2">
            {decision.conditions.map((c, i) => (
              <li key={i} className="flex gap-2 text-sm leading-relaxed text-foreground text-pretty">
                <span aria-hidden="true" className="text-muted-foreground">
                  -
                </span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {/* Alternatives — what would have to change */}
      {decision.alternatives.length > 0 ? (
        <Panel title="What would have to change">
          <ul className="flex flex-col gap-3">
            {decision.alternatives.map((a, i) => (
              <li key={i} className="flex flex-col gap-1">
                <p className="text-sm font-medium text-foreground text-pretty">{a.label}</p>
                <p className="text-sm leading-relaxed text-muted-foreground text-pretty">
                  {a.detail}
                </p>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {/* Monitoring + review */}
      <Panel title="If you go ahead, watch this">
        <ul className="flex flex-col gap-2">
          {decision.monitoringPlan.map((m, i) => (
            <li key={i} className="flex gap-2 text-sm leading-relaxed text-foreground text-pretty">
              <span aria-hidden="true" className="text-muted-foreground">
                -
              </span>
              <span>{m}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 border-t border-border pt-3 text-sm text-muted-foreground">
          Next review: <span className="font-medium text-foreground">{formatISO(decision.nextReviewDate)}</span>
        </p>
      </Panel>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border p-4">
      <h4 className="mb-3 text-sm font-semibold text-foreground">{title}</h4>
      {children}
    </div>
  )
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: string
  sub?: string
  tone?: 'good' | 'warn' | 'bad'
}) {
  const valueColor =
    tone === 'bad' ? 'text-destructive' : tone === 'warn' ? 'text-amber-600' : 'text-foreground'
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={`font-mono text-lg font-semibold ${valueColor}`}>{value}</dd>
      {sub ? <span className="text-xs text-muted-foreground">{sub}</span> : null}
    </div>
  )
}

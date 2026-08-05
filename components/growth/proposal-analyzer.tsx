'use client'

/**
 * Proposal analyzer — the "test a specific investment" surface.
 *
 * This is the only interactive piece on the Growth page. The owner picks a
 * proposal type, fills in type-specific fields, and gets back the full decision.
 * All money math runs server-side against the SAME snapshot the ladder uses, so a
 * proposal can never contradict the headline. This component only collects input
 * and renders the returned decision.
 */

import { useActionState, useState } from 'react'
import {
  PROPOSAL_TYPE_LABELS,
  EQUIPMENT_FINANCING_LABELS,
  type ProposalType,
  type EquipmentFinancing,
} from '@/lib/growth-proposals'
import { runProposalAnalysis } from '@/app/growth/actions'
import { saveProposal } from '@/app/growth/proposal-store'
import type { AnalysisResult, ProposalDraft } from '@/app/growth/proposal-types'
import { ProposalDecisionView } from '@/components/growth/proposal-decision'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

const PROPOSAL_TYPES = Object.keys(PROPOSAL_TYPE_LABELS) as ProposalType[]
const FINANCING_TYPES = Object.keys(EQUIPMENT_FINANCING_LABELS) as EquipmentFinancing[]

type FormState = { result: AnalysisResult | null; draft: ProposalDraft | null }

export function ProposalAnalyzer({ activeModeKey }: { activeModeKey: string }) {
  const [type, setTypeState] = useStickyType()

  const [state, formAction, pending] = useActionState(
    async (_prev: FormState, formData: FormData): Promise<FormState> => {
      const draft = formDataToDraft(formData, type, activeModeKey)
      const result = await runProposalAnalysis(draft)
      // Keep the exact draft that produced this verdict so "Save" persists the same
      // input the owner just saw analysed — not a re-read of fields they may edit next.
      return { result, draft }
    },
    { result: null, draft: null },
  )

  return (
    <section
      aria-labelledby="proposal-analyzer-heading"
      className="rounded-xl border border-border bg-card p-5 sm:p-6"
    >
      <header className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 id="proposal-analyzer-heading" className="text-lg font-semibold text-foreground">
            Test a specific investment
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground text-pretty">
            Describe something you are actually considering. You will get a straight
            answer — judged against the same limits and the same cash as everything
            above, plus what would have to change if it does not fit.
          </p>
        </div>
        <a
          href="/growth/proposals"
          className="shrink-0 text-sm font-medium text-primary underline underline-offset-2"
        >
          Saved proposals
        </a>
      </header>

      <form action={formAction} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="proposal-type">What is it?</Label>
            {/* Native select on purpose: it drives which fields render below, and a
                controlled native element keeps that reactive without extra state
                machinery. */}
            <select
              id="proposal-type"
              name="type"
              value={type}
              onChange={(e) => setTypeState(e.target.value as ProposalType)}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {PROPOSAL_TYPES.map((t) => (
                <option key={t} value={t}>
                  {PROPOSAL_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="proposal-name">Give it a name (optional)</Label>
            <Input id="proposal-name" name="name" placeholder={PROPOSAL_TYPE_LABELS[type]} />
          </div>
        </div>

        <TypeFields type={type} />

        <div className="flex flex-col gap-1.5 border-t border-border pt-4">
          <Label htmlFor="assumed-margin">
            Your gross margin, if you know it (optional)
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="assumed-margin"
              name="assumedMarginPct"
              inputMode="decimal"
              placeholder="e.g. 35"
              className="max-w-32"
            />
            <span className="text-sm text-muted-foreground">%</span>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground text-pretty">
            Leave this blank and the return is shown as required extra sales across a
            range of margins. Enter a margin only if you trust it — it is treated as
            your assumption, never as fact.
          </p>
        </div>

        <div>
          <Button type="submit" disabled={pending}>
            {pending ? 'Working through it…' : 'Get the answer'}
          </Button>
        </div>
      </form>

      {state.result && !state.result.ok ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-foreground"
        >
          {state.result.error}
        </p>
      ) : null}

      {state.result && state.result.ok ? (
        <div className="mt-6 flex flex-col gap-4">
          <ProposalDecisionView
            decision={state.result.decision}
            modeLabel={state.result.modeLabel}
            confidencePct={state.result.confidencePct}
          />
          {state.draft ? <SaveProposalControl draft={state.draft} /> : null}
        </div>
      ) : null}
    </section>
  )
}

/** Save the just-analysed proposal. Kept OUTSIDE the analyze form so submitting it
 *  never re-triggers the analysis, and it persists the exact draft that was scored. */
function SaveProposalControl({ draft }: { draft: ProposalDraft }) {
  const [state, setState] = useState<
    { status: 'idle' } | { status: 'saving' } | { status: 'saved' } | { status: 'error'; msg: string }
  >({ status: 'idle' })

  async function onSave() {
    setState({ status: 'saving' })
    const res = await saveProposal(draft)
    if (res.ok) setState({ status: 'saved' })
    else setState({ status: 'error', msg: res.error })
  }

  if (state.status === 'saved') {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/40 p-3">
        <p className="text-sm text-foreground">
          Saved. It will re-check itself against your cash whenever you open it.
        </p>
        <a href="/growth/proposals" className="text-sm font-medium text-primary underline">
          See saved proposals
        </a>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
      <Button type="button" variant="outline" onClick={onSave} disabled={state.status === 'saving'}>
        {state.status === 'saving' ? 'Saving…' : 'Save this proposal'}
      </Button>
      <p className="text-sm text-muted-foreground text-pretty">
        Save it to track how the answer changes as your cash moves.
      </p>
      {state.status === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {state.msg}
        </p>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function useStickyType(): [ProposalType, (t: ProposalType) => void] {
  const [type, setType] = useState<ProposalType>('marketing_agency')
  return [type, setType]
}

function formDataToDraft(
  formData: FormData,
  type: ProposalType,
  modeKey: string,
): ProposalDraft {
  const fields: Record<string, string> = {}
  for (const [key, value] of formData.entries()) {
    if (key === 'type' || key === 'name' || key === 'assumedMarginPct') continue
    if (typeof value === 'string') fields[key] = value
  }
  return {
    type,
    name: String(formData.get('name') ?? ''),
    modeKey,
    assumedMarginPct: String(formData.get('assumedMarginPct') ?? ''),
    fields,
  }
}

/** Money input with a leading $ and a label. */
function MoneyField({
  name,
  label,
  hint,
  required,
}: {
  name: string
  label: string
  hint?: string
  required?: boolean
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={name}>
        {label}
        {required ? <span className="text-muted-foreground"> *</span> : null}
      </Label>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">$</span>
        <Input id={name} name={name} inputMode="decimal" placeholder="0" />
      </div>
      {hint ? (
        <p className="text-xs leading-relaxed text-muted-foreground text-pretty">{hint}</p>
      ) : null}
    </div>
  )
}

function NumberField({
  name,
  label,
  hint,
  suffix,
}: {
  name: string
  label: string
  hint?: string
  suffix?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input id={name} name={name} inputMode="decimal" placeholder="0" className="max-w-40" />
        {suffix ? <span className="text-sm text-muted-foreground">{suffix}</span> : null}
      </div>
      {hint ? (
        <p className="text-xs leading-relaxed text-muted-foreground text-pretty">{hint}</p>
      ) : null}
    </div>
  )
}

/** The type-specific fields. Kept in one place so the form and the action agree on
    field names — the action reads exactly these keys. */
function TypeFields({ type }: { type: ProposalType }) {
  switch (type) {
    case 'marketing_agency':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <MoneyField name="monthlyRetainer" label="Monthly retainer" required />
          <MoneyField name="setupFee" label="One-off setup fee" />
        </div>
      )
    case 'marketing_campaign':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <MoneyField name="monthlyAmount" label="Monthly ad spend" required />
          <NumberField
            name="durationMonths"
            label="How many months?"
            suffix="months"
            hint="Leave blank if it is ongoing."
          />
        </div>
      )
    case 'equipment':
      return <EquipmentFields />
    case 'employee_hire':
      return (
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <MoneyField name="hourlyWage" label="Hourly wage" hint="Fill this OR annual salary." />
            <NumberField name="hoursPerWeek" label="Hours per week" suffix="hrs" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <MoneyField name="annualSalary" label="Annual salary" hint="Use instead of hourly." />
            <NumberField
              name="employerBurdenPct"
              label="Employer burden"
              suffix="%"
              hint="Payroll taxes, workers' comp, unemployment on top of pay. This is required — the true cost is never the wage alone."
            />
          </div>
          <MoneyField name="oneTimeSetup" label="Onboarding / equipment (one-off)" />
        </div>
      )
    case 'inventory':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <MoneyField name="amount" label="Purchase amount" required />
        </div>
      )
  }
}

function EquipmentFields() {
  const [financing, setFinancing] = useState<EquipmentFinancing>('cash')
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <MoneyField name="price" label="Purchase price" required />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="financing">How are you paying?</Label>
          <select
            id="financing"
            name="financing"
            value={financing}
            onChange={(e) => setFinancing(e.target.value as EquipmentFinancing)}
            className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {FINANCING_TYPES.map((t) => (
              <option key={t} value={t}>
                {EQUIPMENT_FINANCING_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Only the fields that matter for the chosen financing. Cash and card need
          nothing more than the price; the financed structures need the terms. */}
      {(financing === 'down_and_finance' ||
        financing === 'full_finance' ||
        financing === 'lease') && (
        <div className="grid gap-4 sm:grid-cols-2">
          {financing === 'down_and_finance' && (
            <MoneyField name="downPayment" label="Down payment" />
          )}
          <MoneyField name="monthlyPayment" label="Monthly payment" required />
          <NumberField name="termMonths" label="Term" suffix="months" />
          <MoneyField
            name="balloonPayment"
            label="Balloon payment at end"
            hint="A lump sum owed at the end of the term, if any."
          />
        </div>
      )}
    </div>
  )
}

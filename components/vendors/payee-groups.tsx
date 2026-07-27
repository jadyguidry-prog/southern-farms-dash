'use client'

import { useMemo, useState, useTransition } from 'react'
import {
  Search,
  ChevronDown,
  ChevronRight,
  Store,
  Plus,
  RefreshCw,
  Layers,
  HelpCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatCurrency } from '@/lib/data'
import {
  GENERIC_CLASSIFICATIONS,
  GENERIC_CLASSIFICATION_LABELS,
  ruleTextForGroup,
  type GenericClassification,
  type PayeeGroup,
} from '@/lib/transaction-groups'
import {
  applyGroupAction,
  classifyGenericGroup,
  rematchUnreviewed,
} from '@/app/vendors/transactions/actions'

type VendorOption = { id: string; name: string }

/** A staged change awaiting confirmation, summarized for the owner. */
type PendingChange = {
  title: string
  description: string
  facts: Array<{ label: string; value: string }>
  run: () => Promise<{ ok: boolean; error?: string }>
}

function formatDate(value: string) {
  if (!value) return '—'
  const d = new Date(`${value}T00:00:00`)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: '2-digit',
  })
}

/** Turn a normalized payee key into something closer to a real vendor name. */
function titleCase(text: string) {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export function PayeeGroups({
  payeeGroups,
  genericGroups,
  totals,
  vendors,
  categories,
  vendorNames,
}: {
  payeeGroups: PayeeGroup[]
  genericGroups: PayeeGroup[]
  totals: { groups: number; transactions: number; spend: number }
  vendors: VendorOption[]
  categories: string[]
  vendorNames: Record<string, string>
}) {
  const [search, setSearch] = useState('')
  const [visible, setVisible] = useState(25)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const filteredPayees = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return payeeGroups
    return payeeGroups.filter(
      (g) =>
        g.payee.toLowerCase().includes(q) ||
        g.key.toLowerCase().includes(q) ||
        g.exampleDescriptions.some((d) => d.toLowerCase().includes(q)),
    )
  }, [payeeGroups, search])

  const shown = filteredPayees.slice(0, visible)

  function runChange(change: PendingChange) {
    setError(null)
    setNotice(null)
    startTransition(async () => {
      const result = await change.run()
      if (!result.ok) setError(result.error ?? 'Something went wrong.')
      else {
        setNotice(`${change.title} applied.`)
        setExpanded(null)
      }
      setPendingChange(null)
    })
  }

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryTile
          icon={<Layers className="size-4" aria-hidden="true" />}
          label="Payee groups"
          value={String(payeeGroups.length + genericGroups.length)}
          hint={`${totals.transactions.toLocaleString()} transactions awaiting review`}
        />
        <SummaryTile
          label="Unassigned spend"
          value={formatCurrency(totals.spend)}
          hint="Counts toward no vendor until assigned"
        />
        <SummaryTile
          label="No payee on statement"
          value={String(
            genericGroups.reduce((sum, g) => sum + g.count, 0),
          )}
          hint="Checks, deposits, transfers"
        />
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">
          {notice}
        </p>
      ) : null}

      <Card>
        <CardHeader className="gap-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Review by payee</CardTitle>
              <CardDescription>
                One decision per payee applies to every matching transaction.
                Highest spend first.
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() =>
                setPendingChange({
                  title: 'Re-run matching',
                  description:
                    'Re-checks every transaction still awaiting review against the current vendor rules. Decisions you have already made are not touched.',
                  facts: [
                    {
                      label: 'Transactions scanned',
                      value: totals.transactions.toLocaleString(),
                    },
                  ],
                  run: async () => {
                    const r = await rematchUnreviewed()
                    if (r.ok) {
                      setNotice(
                        `Matched ${r.matched ?? 0} of ${r.scanned ?? 0} transactions.`,
                      )
                    }
                    return r
                  },
                })
              }
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              Re-run matching
            </Button>
          </div>

          <div className="relative">
            <Search
              className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setVisible(25)
              }}
              placeholder="Search payees"
              className="pl-9"
              aria-label="Search payees"
            />
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-2">
          {shown.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {payeeGroups.length === 0
                ? 'Nothing awaiting review. Import a statement to get started.'
                : 'No payees match that search.'}
            </p>
          ) : (
            shown.map((group) => (
              <PayeeGroupRow
                key={group.key}
                group={group}
                vendors={vendors}
                categories={categories}
                vendorNames={vendorNames}
                open={expanded === group.key}
                disabled={pending}
                onToggle={() =>
                  setExpanded(expanded === group.key ? null : group.key)
                }
                onStage={setPendingChange}
              />
            ))
          )}

          {filteredPayees.length > shown.length ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setVisible(visible + 25)}
            >
              Show more ({filteredPayees.length - shown.length} remaining)
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {genericGroups.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HelpCircle className="size-4" aria-hidden="true" />
              Generic / no payee
            </CardTitle>
            <CardDescription>
              Your bank did not record who was paid on these lines, so they
              cannot be matched to a vendor automatically. Classify them so the
              spend math stays correct — transfers and card payments must not
              count as vendor spend.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {genericGroups.map((group) => (
              <GenericGroupRow
                key={group.key}
                group={group}
                open={expanded === group.key}
                disabled={pending}
                onToggle={() =>
                  setExpanded(expanded === group.key ? null : group.key)
                }
                onStage={setPendingChange}
              />
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Dialog
        open={pendingChange !== null}
        onOpenChange={(open) => {
          if (!open) setPendingChange(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pendingChange?.title}</DialogTitle>
            <DialogDescription>{pendingChange?.description}</DialogDescription>
          </DialogHeader>

          <dl className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm">
            {(pendingChange?.facts ?? []).map((f) => (
              <div key={f.label} className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{f.label}</dt>
                <dd className="font-medium tabular-nums">{f.value}</dd>
              </div>
            ))}
          </dl>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPendingChange(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={pending}
              onClick={() => pendingChange && runChange(pendingChange)}
            >
              {pending ? 'Applying…' : 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function SummaryTile({
  icon,
  label,
  value,
  hint,
}: {
  icon?: React.ReactNode
  label: string
  value: string
  hint: string
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        {icon}
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

function GroupSummaryLine({ group }: { group: PayeeGroup }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span>
        {group.count} {group.count === 1 ? 'transaction' : 'transactions'}
      </span>
      <span aria-hidden="true">·</span>
      <span>
        {formatDate(group.firstDate)} – {formatDate(group.lastDate)}
      </span>
      {group.statuses.includes('needs_review') ? (
        <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">
          Needs review
        </Badge>
      ) : null}
    </div>
  )
}

function PayeeGroupRow({
  group,
  vendors,
  categories,
  vendorNames,
  open,
  disabled,
  onToggle,
  onStage,
}: {
  group: PayeeGroup
  vendors: VendorOption[]
  categories: string[]
  vendorNames: Record<string, string>
  open: boolean
  disabled: boolean
  onToggle: () => void
  onStage: (change: PendingChange) => void
}) {
  const suggestedName = group.suggestedVendorId
    ? (vendorNames[group.suggestedVendorId] ?? '')
    : ''

  const [mode, setMode] = useState<'existing' | 'new'>(
    group.suggestedVendorId ? 'existing' : 'new',
  )
  const [vendorId, setVendorId] = useState(group.suggestedVendorId ?? '')
  const [newName, setNewName] = useState(titleCase(group.key))
  const [category, setCategory] = useState(group.suggestedCategory)
  const [createRule, setCreateRule] = useState(true)

  const ruleText = ruleTextForGroup(group)

  function stageAssign() {
    const chosenVendorName =
      mode === 'existing'
        ? (vendors.find((v) => v.id === vendorId)?.name ?? '')
        : newName.trim()

    const facts = [
      { label: 'Payee group', value: group.payee },
      { label: 'Transactions affected', value: String(group.count) },
      { label: 'Spend affected', value: formatCurrency(group.totalSpend) },
      {
        label: mode === 'existing' ? 'Assign to vendor' : 'Create vendor',
        value: chosenVendorName || '—',
      },
    ]
    if (category.trim()) {
      facts.push({ label: 'Category', value: category.trim() })
    }
    if (createRule && ruleText) {
      facts.push({ label: 'Match rule to create', value: `contains "${ruleText}"` })
    }

    onStage({
      title:
        mode === 'existing'
          ? `Assign ${group.count} transactions`
          : `Create vendor and assign ${group.count} transactions`,
      description:
        mode === 'new'
          ? 'A new vendor will be added to your directory and every transaction in this group will be assigned to it. If a vendor with this name already exists it is reused instead of duplicated.'
          : 'Every transaction in this group will be assigned to this vendor and marked reviewed.',
      facts,
      run: () =>
        applyGroupAction({
          transactionIds: group.transactionIds,
          vendorId: mode === 'existing' ? vendorId : undefined,
          newVendorName: mode === 'new' ? newName.trim() : undefined,
          category: category.trim(),
          createRule: createRule && Boolean(ruleText),
          ruleText: ruleText ?? undefined,
        }),
    })
  }

  const canSubmit =
    mode === 'existing' ? Boolean(vendorId) : newName.trim().length > 1

  return (
    <div className="rounded-lg border border-border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-3 p-3 text-left hover:bg-muted/50"
      >
        <div className="flex min-w-0 items-start gap-2">
          {open ? (
            <ChevronDown
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          ) : (
            <ChevronRight
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          )}
          <div className="min-w-0">
            <p className="truncate font-medium">{titleCase(group.payee)}</p>
            <GroupSummaryLine group={group} />
            {suggestedName ? (
              <p className="mt-1 flex items-center gap-1 text-xs text-primary">
                <Store className="size-3" aria-hidden="true" />
                Suggested: {suggestedName}
              </p>
            ) : null}
          </div>
        </div>
        <p className="shrink-0 text-right font-semibold tabular-nums">
          {formatCurrency(group.totalSpend)}
        </p>
      </button>

      {open ? (
        <div className="flex flex-col gap-4 border-t border-border p-3">
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              Example statement lines
            </p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {group.exampleDescriptions.map((d) => (
                <li key={d} className="truncate font-mono text-xs">
                  {d}
                </li>
              ))}
            </ul>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant={mode === 'existing' ? 'default' : 'outline'}
              onClick={() => setMode('existing')}
            >
              <Store className="size-4" aria-hidden="true" />
              Existing vendor
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === 'new' ? 'default' : 'outline'}
              onClick={() => setMode('new')}
            >
              <Plus className="size-4" aria-hidden="true" />
              New vendor
            </Button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {mode === 'existing' ? (
              <div>
                <Label htmlFor={`vendor-${group.key}`}>Vendor</Label>
                <Select
                  value={vendorId}
                  onValueChange={(v) => setVendorId(v ?? '')}
                >
                  <SelectTrigger id={`vendor-${group.key}`} className="mt-1.5">
                    <SelectValue placeholder="Choose a vendor" />
                  </SelectTrigger>
                  <SelectContent>
                    {vendors.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div>
                <Label htmlFor={`newvendor-${group.key}`}>New vendor name</Label>
                <Input
                  id={`newvendor-${group.key}`}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="mt-1.5"
                  placeholder="Vendor name"
                />
              </div>
            )}

            <div>
              <Label htmlFor={`category-${group.key}`}>Category</Label>
              <Input
                id={`category-${group.key}`}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="mt-1.5"
                placeholder="Optional"
                list={`categories-${group.key}`}
              />
              <datalist id={`categories-${group.key}`}>
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
          </div>

          {ruleText ? (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={createRule}
                onCheckedChange={(v) => setCreateRule(v === true)}
                className="mt-0.5"
              />
              <span>
                Remember this payee
                <span className="block text-xs text-muted-foreground">
                  Creates a rule matching {'"'}
                  {ruleText}
                  {'"'} so future imports assign this vendor automatically.
                </span>
              </span>
            </label>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={disabled || !canSubmit}
              onClick={stageAssign}
            >
              Review changes
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                onStage({
                  title: 'Exclude from vendor spend',
                  description:
                    'These transactions stay in the ledger for your records but stop counting toward any vendor total.',
                  facts: [
                    { label: 'Payee group', value: group.payee },
                    { label: 'Transactions affected', value: String(group.count) },
                    {
                      label: 'Spend removed',
                      value: formatCurrency(group.totalSpend),
                    },
                  ],
                  run: () =>
                    classifyGenericGroup(group.transactionIds, 'excluded'),
                })
              }
            >
              Exclude
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function GenericGroupRow({
  group,
  open,
  disabled,
  onToggle,
  onStage,
}: {
  group: PayeeGroup
  open: boolean
  disabled: boolean
  onToggle: () => void
  onStage: (change: PendingChange) => void
}) {
  const [classification, setClassification] =
    useState<GenericClassification>('needs_review')

  return (
    <div className="rounded-lg border border-border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start justify-between gap-3 p-3 text-left hover:bg-muted/50"
      >
        <div className="flex min-w-0 items-start gap-2">
          {open ? (
            <ChevronDown
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          ) : (
            <ChevronRight
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          )}
          <div className="min-w-0">
            <p className="truncate font-medium">{titleCase(group.payee)}</p>
            <GroupSummaryLine group={group} />
          </div>
        </div>
        <p className="shrink-0 text-right font-semibold tabular-nums">
          {formatCurrency(group.totalAmount)}
        </p>
      </button>

      {open ? (
        <div className="flex flex-col gap-3 border-t border-border p-3">
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              Example statement lines
            </p>
            <ul className="mt-1 flex flex-col gap-0.5">
              {group.exampleDescriptions.map((d) => (
                <li key={d} className="truncate font-mono text-xs">
                  {d}
                </li>
              ))}
            </ul>
          </div>

          <div className="max-w-sm">
            <Label htmlFor={`class-${group.key}`}>Classify as</Label>
            <Select
              value={classification}
              onValueChange={(v) =>
                setClassification(v as GenericClassification)
              }
            >
              <SelectTrigger id={`class-${group.key}`} className="mt-1.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GENERIC_CLASSIFICATIONS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {GENERIC_CLASSIFICATION_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Button
              type="button"
              disabled={disabled}
              onClick={() =>
                onStage({
                  title: GENERIC_CLASSIFICATION_LABELS[classification],
                  description:
                    'Applies to every transaction in this group. Nothing is deleted — the rows stay in your ledger and can be reclassified later.',
                  facts: [
                    { label: 'Group', value: group.payee },
                    { label: 'Transactions affected', value: String(group.count) },
                    {
                      label: 'Dollars affected',
                      value: formatCurrency(group.totalAmount),
                    },
                    {
                      label: 'Classification',
                      value: GENERIC_CLASSIFICATION_LABELS[classification],
                    },
                  ],
                  run: () =>
                    classifyGenericGroup(group.transactionIds, classification),
                })
              }
            >
              Review changes
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

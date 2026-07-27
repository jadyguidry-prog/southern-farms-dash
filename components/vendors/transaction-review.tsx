'use client'

import { useMemo, useState, useTransition } from 'react'
import {
  Search,
  Store,
  CheckCheck,
  AlertTriangle,
  EyeOff,
  Trash2,
  Tag,
  RefreshCw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatCurrency } from '@/lib/data'
import { TRANSACTION_TYPE_LABELS, type TransactionType } from '@/lib/transactions'
import type { TransactionRow } from '@/lib/transaction-queries'
import {
  assignVendor,
  setReviewStatus,
  setTransactionCategory,
  deleteTransactions,
} from '@/app/vendors/transactions/actions'

type VendorOption = { id: string; name: string }

type Counts = {
  total: number
  unreviewed: number
  needsReview: number
  matched: number
  excluded: number
  unmatched: number
}

const STATUS_STYLES: Record<string, string> = {
  unreviewed: 'bg-muted text-muted-foreground',
  matched: 'bg-primary/10 text-primary',
  needs_review: 'bg-amber-100 text-amber-800',
  excluded: 'bg-muted text-muted-foreground line-through',
}

const STATUS_LABELS: Record<string, string> = {
  unreviewed: 'Unreviewed',
  matched: 'Matched',
  needs_review: 'Needs review',
  excluded: 'Excluded',
}

function formatDate(value: string) {
  if (!value) return '—'
  const d = new Date(`${value}T00:00:00`)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
}

export function TransactionReview({
  transactions,
  vendors,
  counts,
  categories,
  initialVendorId,
}: {
  transactions: TransactionRow[]
  vendors: VendorOption[]
  counts: Counts
  categories: string[]
  initialVendorId?: string
}) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [vendorFilter, setVendorFilter] = useState<string>(initialVendorId ?? 'all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkVendor, setBulkVendor] = useState<string>('')
  const [bulkCategory, setBulkCategory] = useState<string>('')
  const [learn, setLearn] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return transactions.filter((t) => {
      if (statusFilter !== 'all' && t.reviewStatus !== statusFilter) return false
      if (vendorFilter === 'unmatched' && t.vendorId) return false
      if (vendorFilter !== 'all' && vendorFilter !== 'unmatched' && t.vendorId !== vendorFilter)
        return false
      if (!q) return true
      return (
        t.description.toLowerCase().includes(q) ||
        t.vendorName.toLowerCase().includes(q) ||
        t.accountName.toLowerCase().includes(q)
      )
    })
  }, [transactions, search, statusFilter, vendorFilter])

  const allVisibleSelected =
    filtered.length > 0 && filtered.every((t) => selected.has(t.id))

  function toggleAll() {
    setSelected((prev) => {
      if (filtered.every((t) => prev.has(t.id))) {
        const next = new Set(prev)
        filtered.forEach((t) => next.delete(t.id))
        return next
      }
      const next = new Set(prev)
      filtered.forEach((t) => next.add(t.id))
      return next
    })
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectedIds = useMemo(() => [...selected], [selected])

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null)
    startTransition(async () => {
      const res = await fn()
      if (!res.ok) setError(res.error ?? 'Something went wrong.')
      else setSelected(new Set())
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatChip label="Total" value={counts.total} />
        <StatChip label="Unreviewed" value={counts.unreviewed} />
        <StatChip label="Needs review" value={counts.needsReview} />
        <StatChip label="Matched" value={counts.matched} />
        <StatChip label="Unmatched" value={counts.unmatched} />
        <StatChip label="Excluded" value={counts.excluded} />
      </div>

      <Card>
        <CardHeader className="gap-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <CardTitle className="text-base">Transactions</CardTitle>
            <div className="relative w-full lg:max-w-xs">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search description, vendor, account"
                className="h-11 pl-9"
                aria-label="Search transactions"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? 'all')}>
              <SelectTrigger className="h-11 w-full sm:w-44" aria-label="Filter by status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="unreviewed">Unreviewed</SelectItem>
                <SelectItem value="needs_review">Needs review</SelectItem>
                <SelectItem value="matched">Matched</SelectItem>
                <SelectItem value="excluded">Excluded</SelectItem>
              </SelectContent>
            </Select>
            <Select value={vendorFilter} onValueChange={(v) => setVendorFilter(v ?? 'all')}>
              <SelectTrigger className="h-11 w-full sm:w-56" aria-label="Filter by vendor">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All vendors</SelectItem>
                <SelectItem value="unmatched">Unmatched only</SelectItem>
                {vendors.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {error && (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          )}

          {selectedIds.length > 0 && (
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-3">
              <p className="text-sm font-medium">
                {selectedIds.length} selected
              </p>
              <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
                <div className="flex items-center gap-2">
                  <Select value={bulkVendor} onValueChange={(v) => setBulkVendor(v ?? '')}>
                    <SelectTrigger className="h-11 w-full sm:w-52" aria-label="Assign vendor">
                      <SelectValue placeholder="Assign vendor…" />
                    </SelectTrigger>
                    <SelectContent>
                      {vendors.map((v) => (
                        <SelectItem key={v.id} value={v.id}>
                          {v.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    className="h-11"
                    disabled={pending || !bulkVendor}
                    onClick={() =>
                      run(() => assignVendor(selectedIds, bulkVendor, learn))
                    }
                  >
                    <Store className="size-4" aria-hidden="true" />
                    Assign
                  </Button>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={learn}
                    onCheckedChange={(v) => setLearn(Boolean(v))}
                  />
                  Remember this match for next time
                </label>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <div className="flex items-center gap-2">
                  <Select value={bulkCategory} onValueChange={(v) => setBulkCategory(v ?? '')}>
                    <SelectTrigger className="h-11 w-full sm:w-52" aria-label="Set category">
                      <SelectValue placeholder="Set category…" />
                    </SelectTrigger>
                    <SelectContent>
                      {categories.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11"
                    disabled={pending || !bulkCategory}
                    onClick={() =>
                      run(() => setTransactionCategory(selectedIds, bulkCategory))
                    }
                  >
                    <Tag className="size-4" aria-hidden="true" />
                    Apply
                  </Button>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11"
                    disabled={pending}
                    onClick={() => run(() => setReviewStatus(selectedIds, 'matched'))}
                  >
                    <CheckCheck className="size-4" aria-hidden="true" />
                    Mark reviewed
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11"
                    disabled={pending}
                    onClick={() => run(() => setReviewStatus(selectedIds, 'needs_review'))}
                  >
                    <AlertTriangle className="size-4" aria-hidden="true" />
                    Needs review
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11"
                    disabled={pending}
                    onClick={() => run(() => setReviewStatus(selectedIds, 'excluded'))}
                  >
                    <EyeOff className="size-4" aria-hidden="true" />
                    Exclude
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 text-destructive hover:text-destructive"
                    disabled={pending}
                    onClick={() => run(() => deleteTransactions(selectedIds))}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          )}

          {filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <RefreshCw className="size-8 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm font-medium">No transactions match these filters</p>
              <p className="text-sm text-muted-foreground">
                Import a bank or card statement to get started, or adjust the filters above.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allVisibleSelected}
                        onCheckedChange={toggleAll}
                        aria-label="Select all visible transactions"
                      />
                    </TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Vendor</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((t) => (
                    <TableRow key={t.id} data-state={selected.has(t.id) ? 'selected' : undefined}>
                      <TableCell>
                        <Checkbox
                          checked={selected.has(t.id)}
                          onCheckedChange={() => toggleOne(t.id)}
                          aria-label={`Select transaction ${t.description}`}
                        />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {formatDate(t.transactionDate)}
                      </TableCell>
                      <TableCell className="max-w-[22rem]">
                        <p className="truncate text-sm font-medium" title={t.description}>
                          {t.description}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {t.accountName || 'Unknown account'}
                          {t.expenseCategory ? ` · ${t.expenseCategory}` : ''}
                        </p>
                      </TableCell>
                      <TableCell className="text-sm">
                        {t.vendorName ? (
                          t.vendorName
                        ) : (
                          <span className="text-muted-foreground">Unmatched</span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {TRANSACTION_TYPE_LABELS[t.transactionType as TransactionType] ??
                          t.transactionType}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right font-medium tabular-nums">
                        {formatCurrency(t.amount)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={STATUS_STYLES[t.reviewStatus] ?? ''}
                        >
                          {STATUS_LABELS[t.reviewStatus] ?? t.reviewStatus}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function StatChip({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
    </div>
  )
}

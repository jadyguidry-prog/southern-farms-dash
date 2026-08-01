'use client'

import { useMemo, useState, useTransition } from 'react'
import { Search, Store, Sparkles, FolderOpen } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatCurrency } from '@/lib/data'
import { categorizeTransactions } from '@/app/category-review/actions'
import type { UncategorizedPayeeGroup } from '@/lib/uncategorized-payees'

/** Month key (yyyy-mm) rendered as "Mar 2026" without a date library. */
function monthLabel(key: string): string {
  const [y, m] = key.split('-')
  const index = Number(m) - 1
  const names = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ]
  return names[index] ? `${names[index]} ${y}` : key
}

export function UncategorizedPayees({
  groups,
  summary,
  categoryOptions,
}: {
  groups: UncategorizedPayeeGroup[]
  summary: { payeeCount: number; transactionCount: number; total: number }
  categoryOptions: string[]
}) {
  const [pending, startTransition] = useTransition()
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // Category chosen per payee. Seeded from the payee's own established category
  // where one exists, so the common case is a single click.
  const [choice, setChoice] = useState<Record<string, string>>({})

  const visible = useMemo(() => {
    const q = query.trim().toUpperCase()
    if (!q) return groups
    return groups.filter((g) => g.payee.toUpperCase().includes(q))
  }, [groups, query])

  function file(group: UncategorizedPayeeGroup, category: string) {
    if (!category) {
      toast.error('Pick a category first', {
        description: `Choose where ${group.payee} should be filed.`,
      })
      return
    }
    setBusyKey(group.key)
    startTransition(async () => {
      const res = await categorizeTransactions({
        transactionIds: group.transactionIds,
        category,
        source: 'uncategorized_payee',
        payee: group.payee,
      })
      setBusyKey(null)
      if (res.ok) {
        toast.success(`Filed ${group.payee} as ${category}`, {
          description: `${res.updated ?? group.count} transaction${
            (res.updated ?? group.count) === 1 ? '' : 's'
          } updated. You can undo this from Recent changes.`,
        })
      } else {
        toast.error('Nothing was changed', { description: res.error })
      }
    })
  }

  if (groups.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
          <FolderOpen className="size-8 text-muted-foreground" aria-hidden />
          <p className="font-medium">Every payee has a category</p>
          <p className="max-w-md text-pretty text-sm leading-relaxed text-muted-foreground">
            No transaction with an identifiable payee is missing a spending
            category. Rows paid by check have no payee for any rule to read, so
            those are handled on Check Resolution instead.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
        These {summary.transactionCount} transactions have a real payee but no
        spending category, so they are missing from every category total, chart,
        and budget in the app. Filing one payee here applies to all of its rows at
        once. Every change is logged and can be undone.
      </p>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{summary.payeeCount} payees</Badge>
          <Badge variant="secondary">
            {summary.transactionCount} transactions
          </Badge>
          <Badge variant="outline">{formatCurrency(summary.total)} unfiled</Badge>
        </div>
        <div className="relative sm:w-64">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search payee"
            className="pl-8"
            aria-label="Search payees"
          />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {visible.map((group) => {
          const selected = choice[group.key] ?? group.siblingCategory?.category ?? ''
          const isBusy = pending && busyKey === group.key
          return (
            <Card key={group.key}>
              <CardContent className="flex flex-col gap-3 p-4">
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Store className="size-4 text-muted-foreground" aria-hidden />
                    <span className="font-medium">{group.payee}</span>
                    <Badge variant="outline">
                      {formatCurrency(group.total)}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {group.count} transaction{group.count === 1 ? '' : 's'} ·{' '}
                    {group.months.length === 1
                      ? monthLabel(group.months[0])
                      : `${monthLabel(group.months[0])} – ${monthLabel(
                          group.months[group.months.length - 1],
                        )}`}
                  </p>
                  {group.siblingCategory && (
                    <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                      <Sparkles className="size-3.5" aria-hidden />
                      You already file this payee as{' '}
                      <span className="font-medium text-foreground">
                        {group.siblingCategory.category}
                      </span>{' '}
                      on {group.siblingCategory.count} other row
                      {group.siblingCategory.count === 1 ? '' : 's'}
                    </p>
                  )}
                </div>

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Select
                    value={selected}
                    onValueChange={(v) =>
                      setChoice((prev) => ({ ...prev, [group.key]: v ?? '' }))
                    }
                  >
                    <SelectTrigger
                      className="sm:w-64"
                      aria-label={`Category for ${group.payee}`}
                    >
                      <SelectValue placeholder="Choose a category" />
                    </SelectTrigger>
                    <SelectContent>
                      {categoryOptions.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    onClick={() => file(group, selected)}
                    disabled={isBusy || !selected}
                    className="sm:w-auto"
                  >
                    {isBusy
                      ? 'Filing…'
                      : `File ${group.count} row${group.count === 1 ? '' : 's'}`}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {visible.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No payee matches “{query}”.
        </p>
      )}
    </div>
  )
}

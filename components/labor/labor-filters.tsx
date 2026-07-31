'use client'

import { useCallback, useTransition } from 'react'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const ALL = '__all__'

export type LaborFiltersProps = {
  employees: { id: string; name: string }[]
  jobTitles: string[]
  months: { key: string; label: string }[]
  current: {
    employee: string | null
    jobTitle: string | null
    from: string | null
    to: string | null
  }
}

/**
 * Filters written to the URL so the server component re-reads and re-aggregates.
 *
 * Filtering happens before aggregation on the server rather than hiding rows in
 * the browser, so the headline totals always describe exactly the rows shown.
 */
export function LaborFilters({
  employees,
  jobTitles,
  months,
  current,
}: LaborFiltersProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()
  // `useSearchParams` is typed as nullable, so read it through a stable string.
  const query = searchParams?.toString() ?? ''

  const setParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(query)
      if (value === ALL || value === '') params.delete(key)
      else params.set(key, value)
      startTransition(() => {
        router.replace(`${pathname}?${params.toString()}`, { scroll: false })
      })
    },
    [pathname, router, query],
  )

  const reset = useCallback(() => {
    startTransition(() => {
      router.replace(pathname, { scroll: false })
    })
  }, [pathname, router])

  const hasFilters =
    current.employee !== null ||
    current.jobTitle !== null ||
    current.from !== null ||
    current.to !== null

  return (
    <div
      className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end"
      data-pending={pending ? '' : undefined}
    >
      <div className="flex flex-1 flex-col gap-1.5 sm:min-w-48">
        <Label htmlFor="labor-employee" className="text-xs text-muted-foreground">
          Employee
        </Label>
        <Select
          value={current.employee ?? ALL}
          onValueChange={(v) => setParam('employee', v ?? ALL)}
        >
          <SelectTrigger id="labor-employee">
            <SelectValue placeholder="All employees" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All employees</SelectItem>
            {employees.map((e) => (
              <SelectItem key={e.id} value={e.id}>
                {e.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-1 flex-col gap-1.5 sm:min-w-44">
        <Label htmlFor="labor-job" className="text-xs text-muted-foreground">
          Job title
        </Label>
        <Select
          value={current.jobTitle ?? ALL}
          onValueChange={(v) => setParam('jobTitle', v ?? ALL)}
        >
          <SelectTrigger id="labor-job">
            <SelectValue placeholder="All job titles" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All job titles</SelectItem>
            {jobTitles.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-1 flex-col gap-1.5 sm:min-w-36">
        <Label htmlFor="labor-from" className="text-xs text-muted-foreground">
          From month
        </Label>
        <Select
          value={current.from ?? ALL}
          onValueChange={(v) => setParam('from', v ?? ALL)}
        >
          <SelectTrigger id="labor-from">
            <SelectValue placeholder="Earliest" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Earliest</SelectItem>
            {months.map((m) => (
              <SelectItem key={m.key} value={m.key}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-1 flex-col gap-1.5 sm:min-w-36">
        <Label htmlFor="labor-to" className="text-xs text-muted-foreground">
          To month
        </Label>
        <Select
          value={current.to ?? ALL}
          onValueChange={(v) => setParam('to', v ?? ALL)}
        >
          <SelectTrigger id="labor-to">
            <SelectValue placeholder="Latest" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Latest</SelectItem>
            {months.map((m) => (
              <SelectItem key={m.key} value={m.key}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {hasFilters && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={reset}
          className="self-start sm:self-auto"
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          Reset
        </Button>
      )}
    </div>
  )
}

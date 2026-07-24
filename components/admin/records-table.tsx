'use client'

import { useTransition } from 'react'
import { Trash2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { TableDef } from '@/lib/admin-config'
import { deleteRecord } from '@/app/admin/actions'
import { formatCurrency } from '@/lib/data'

function formatValue(value: unknown, format?: 'currency' | 'number' | 'percent') {
  if (value == null || value === '') return '—'
  if (format === 'currency') return formatCurrency(Number(value))
  if (format === 'number') return Number(value).toLocaleString()
  if (format === 'percent') return `${Number(value).toFixed(2)}%`
  return String(value)
}

export function RecordsTable({
  def,
  rows,
}: {
  def: TableDef
  rows: Record<string, unknown>[]
}) {
  const [isPending, startTransition] = useTransition()

  function onDelete(id: string) {
    startTransition(async () => {
      await deleteRecord(def.key, id)
    })
  }

  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No records yet. Add one above or import a CSV.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {def.displayColumns.map((col) => (
              <TableHead key={col.name}>{col.label}</TableHead>
            ))}
            <TableHead className="w-16 text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={String(row.id)}>
              {def.displayColumns.map((col) => (
                <TableCell key={col.name} className={col.format ? 'font-mono' : 'font-medium'}>
                  {formatValue(row[col.name], col.format)}
                </TableCell>
              ))}
              <TableCell className="text-right">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground hover:text-destructive"
                  onClick={() => onDelete(String(row.id))}
                  disabled={isPending}
                  aria-label="Delete record"
                >
                  {isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

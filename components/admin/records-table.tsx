'use client'

import { useState, useTransition } from 'react'
import { Trash2, Loader2, Pencil } from 'lucide-react'
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
import { EditRecordDialog } from '@/components/admin/edit-record-dialog'

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
  const [editingId, setEditingId] = useState<string | null>(null)
  // Which row's delete is running. A single shared `isPending` spun the icon on every
  // row at once, which reads as "the whole table is saving".
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Derived tables (sales_monthly) are recalculated from bank records, so an edit here
  // would be silently erased on the next recalculation. The panel already explains this
  // instead of offering an entry form; the same reasoning applies to editing a row.
  const canEdit = !def.managedElsewhere

  function onDelete(id: string) {
    setDeletingId(id)
    startTransition(async () => {
      await deleteRecord(def.key, id)
      setDeletingId(null)
    })
  }

  const editingRow = editingId ? rows.find((r) => String(r.id) === editingId) : undefined

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
            <TableHead className="w-24 text-right">Actions</TableHead>
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
                <div className="flex items-center justify-end gap-1">
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground hover:text-foreground"
                      onClick={() => setEditingId(String(row.id))}
                      disabled={isPending}
                      aria-label={`Edit record${
                        def.displayColumns[0]
                          ? `: ${formatValue(row[def.displayColumns[0].name])}`
                          : ''
                      }`}
                    >
                      <Pencil className="size-4" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground hover:text-destructive"
                    onClick={() => onDelete(String(row.id))}
                    disabled={isPending}
                    aria-label="Delete record"
                  >
                    {deletingId === String(row.id) ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {editingRow && (
        <EditRecordDialog
          // Remount per row so each dialog's defaultValue prefill reflects the row that
          // was actually clicked. Without the key, React reuses the mounted inputs and
          // the second row opened would show the first row's values — and saving would
          // write them.
          key={editingId}
          def={def}
          row={editingRow}
          open
          onOpenChange={(open) => {
            if (!open) setEditingId(null)
          }}
        />
      )}
    </div>
  )
}

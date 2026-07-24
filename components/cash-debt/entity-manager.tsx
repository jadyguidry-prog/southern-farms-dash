'use client'

import { useState, useTransition } from 'react'
import { Plus, Loader2, Pencil, Trash2, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { TableDef } from '@/lib/admin-config'
import { addRecord, updateRecord, deleteRecord, markPaid } from '@/app/admin/actions'
import { formatCurrency } from '@/lib/data'
import { cn } from '@/lib/utils'

export type Column = {
  name: string
  label: string
  format?: 'currency' | 'number' | 'percent' | 'date'
  badge?: boolean
  className?: string
}

function formatValue(value: unknown, format?: Column['format']) {
  if (value == null || value === '') return '—'
  if (format === 'currency') return formatCurrency(Number(value))
  if (format === 'number') return Number(value).toLocaleString()
  if (format === 'percent') return `${Number(value).toFixed(2)}%`
  if (format === 'date')
    return new Date(String(value)).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  return String(value)
}

function statusBadgeClass(status: string) {
  const s = status.toLowerCase()
  if (['paid', 'current', 'active', 'scheduled'].includes(s))
    return 'bg-primary/10 text-primary'
  if (['overdue', 'delinquent', 'watch'].includes(s))
    return 'bg-destructive/10 text-destructive'
  if (['partial', 'due soon'].includes(s)) return 'bg-chart-4/15 text-chart-4'
  return 'bg-secondary text-secondary-foreground'
}

function FieldControl({
  field,
  defaultValue,
  idPrefix,
}: {
  field: TableDef['fields'][number]
  defaultValue?: unknown
  idPrefix: string
}) {
  const id = `${idPrefix}-${field.name}`
  const dv = defaultValue == null ? '' : String(defaultValue)

  if (field.type === 'select') {
    return (
      <select
        id={id}
        name={field.name}
        required={field.required}
        defaultValue={dv}
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <option value="" disabled={field.required}>
          Select...
        </option>
        {field.options?.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    )
  }

  return (
    <Input
      id={id}
      name={field.name}
      type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
      step={field.type === 'number' ? 'any' : undefined}
      required={field.required}
      placeholder={field.placeholder}
      defaultValue={dv}
    />
  )
}

function RecordDialog({
  def,
  open,
  onOpenChange,
  editRow,
}: {
  def: TableDef
  open: boolean
  onOpenChange: (o: boolean) => void
  editRow: Record<string, unknown> | null
}) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const isEdit = editRow != null

  function onSubmit(formData: FormData) {
    setError(null)
    startTransition(async () => {
      const res = isEdit
        ? await updateRecord(def.key, String(editRow!.id), formData)
        : await addRecord(def.key, formData)
      if (res?.error) {
        setError(res.error)
      } else {
        onOpenChange(false)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? 'Edit' : 'Add'} {def.label.replace(/s$/, '')}
          </DialogTitle>
          <DialogDescription>{def.description}</DialogDescription>
        </DialogHeader>
        <form action={onSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {def.fields.map((field) => (
              <div key={field.name} className="space-y-1.5">
                <Label htmlFor={`${def.key}-${field.name}`}>
                  {field.label}
                  {field.required && <span className="text-destructive"> *</span>}
                </Label>
                <FieldControl
                  field={field}
                  idPrefix={def.key}
                  defaultValue={editRow?.[field.name]}
                />
              </div>
            ))}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={isPending}>
              {isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              {isEdit ? 'Save changes' : 'Add record'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function EntityManager({
  def,
  rows,
  columns,
  description,
  markPaidEnabled = false,
}: {
  def: TableDef
  rows: Record<string, unknown>[]
  columns: Column[]
  description?: string
  markPaidEnabled?: boolean
}) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editRow, setEditRow] = useState<Record<string, unknown> | null>(null)
  const [isPending, startTransition] = useTransition()

  function openAdd() {
    setEditRow(null)
    setDialogOpen(true)
  }
  function openEdit(row: Record<string, unknown>) {
    setEditRow(row)
    setDialogOpen(true)
  }
  function onDelete(id: string) {
    startTransition(async () => {
      await deleteRecord(def.key, id)
    })
  }
  function onMarkPaid(id: string) {
    startTransition(async () => {
      await markPaid(def.table as 'receivables' | 'cash_obligations', id)
    })
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-base">{def.label}</CardTitle>
          <CardDescription>{description ?? def.description}</CardDescription>
        </div>
        <Button size="sm" onClick={openAdd}>
          <Plus className="size-4" />
          Add
        </Button>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No records yet. Click &quot;Add&quot; to create one.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {columns.map((col) => (
                    <TableHead
                      key={col.name}
                      className={col.format && col.format !== 'date' ? 'text-right' : undefined}
                    >
                      {col.label}
                    </TableHead>
                  ))}
                  <TableHead className="w-28 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const status = String(row.status ?? '')
                  const isPaid = status.toLowerCase() === 'paid'
                  return (
                    <TableRow key={String(row.id)}>
                      {columns.map((col) => (
                        <TableCell
                          key={col.name}
                          className={cn(
                            col.format && col.format !== 'date'
                              ? 'text-right font-mono'
                              : 'font-medium',
                            col.className,
                          )}
                        >
                          {col.badge ? (
                            <Badge
                              variant="secondary"
                              className={statusBadgeClass(String(row[col.name] ?? ''))}
                            >
                              {formatValue(row[col.name])}
                            </Badge>
                          ) : (
                            formatValue(row[col.name], col.format)
                          )}
                        </TableCell>
                      ))}
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {markPaidEnabled && !isPaid && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 text-muted-foreground hover:text-primary"
                              onClick={() => onMarkPaid(String(row.id))}
                              disabled={isPending}
                              aria-label="Mark as paid"
                              title="Mark as paid"
                            >
                              <CheckCircle2 className="size-4" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-muted-foreground hover:text-foreground"
                            onClick={() => openEdit(row)}
                            aria-label="Edit record"
                            title="Edit"
                          >
                            <Pencil className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-muted-foreground hover:text-destructive"
                            onClick={() => onDelete(String(row.id))}
                            disabled={isPending}
                            aria-label="Delete record"
                            title="Delete"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
      <RecordDialog
        def={def}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editRow={editRow}
      />
    </Card>
  )
}

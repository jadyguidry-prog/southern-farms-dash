'use client'

import { useState, useTransition } from 'react'
import { Loader2, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { type TableDef, toInputValue, selectOptionsFor } from '@/lib/admin-config'
import { updateRecord } from '@/app/admin/actions'

/**
 * Edit an existing admin record.
 *
 * Every field in the table def is rendered, deliberately: `updateRecord` writes the full
 * field set on save, so a field omitted here would be submitted blank and NULL out a
 * column the owner never opened. Prefill goes through `toInputValue` for the same reason
 * — an unparsed date renders blank and would silently clear itself.
 */
export function EditRecordDialog({
  def,
  row,
  open,
  onOpenChange,
}: {
  def: TableDef
  row: Record<string, unknown>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function onSubmit(formData: FormData) {
    setError(null)
    startTransition(async () => {
      const res = await updateRecord(def.key, String(row.id), formData)
      if (res?.error) {
        setError(res.error)
      } else {
        onOpenChange(false)
      }
    })
  }

  // Prefer a human-readable identifier for the heading over a raw uuid.
  const titleField = def.displayColumns[0]?.name
  const titleValue = titleField ? toInputValue(row[titleField], 'text') : ''

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit {def.label.replace(/s$/, '')}</DialogTitle>
          <DialogDescription>
            {titleValue
              ? `Updating "${titleValue}". Changes apply everywhere this record is used.`
              : 'Changes apply everywhere this record is used.'}
          </DialogDescription>
        </DialogHeader>

        <form action={onSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {def.fields.map((field) => {
              const id = `edit-${def.key}-${field.name}`
              const current = toInputValue(row[field.name], field.type)
              return (
                <div key={field.name} className="space-y-1.5">
                  <Label htmlFor={id}>
                    {field.label}
                    {field.required && <span className="text-destructive"> *</span>}
                  </Label>
                  {field.type === 'select' ? (
                    <Select
                      name={field.name}
                      required={field.required}
                      defaultValue={current || undefined}
                    >
                      <SelectTrigger id={id} className="w-full">
                        <SelectValue placeholder="Select..." />
                      </SelectTrigger>
                      <SelectContent>
                        {selectOptionsFor(field, row[field.name]).map((opt) => (
                          <SelectItem key={opt} value={opt}>
                            {opt}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      id={id}
                      name={field.name}
                      type={
                        field.type === 'number'
                          ? 'number'
                          : field.type === 'date'
                            ? 'date'
                            : 'text'
                      }
                      step={field.type === 'number' ? 'any' : undefined}
                      required={field.required}
                      defaultValue={current}
                      placeholder={field.placeholder}
                    />
                  )}
                </div>
              )
            })}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

'use client'

import { useState, useTransition } from 'react'
import { Plus, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { TableDef } from '@/lib/admin-config'
import { addRecord } from '@/app/admin/actions'

export function RecordForm({ def }: { def: TableDef }) {
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [formKey, setFormKey] = useState(0)

  function onSubmit(formData: FormData) {
    setMessage(null)
    startTransition(async () => {
      const res = await addRecord(def.key, formData)
      if (res?.error) {
        setMessage({ type: 'err', text: res.error })
      } else {
        setMessage({ type: 'ok', text: res?.success ?? 'Saved.' })
        setFormKey((k) => k + 1) // reset form fields
      }
    })
  }

  return (
    <form key={formKey} action={onSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {def.fields.map((field) => (
          <div key={field.name} className="space-y-1.5">
            <Label htmlFor={`${def.key}-${field.name}`}>
              {field.label}
              {field.required && <span className="text-destructive"> *</span>}
            </Label>
            {field.type === 'select' ? (
              <Select name={field.name} required={field.required}>
                <SelectTrigger id={`${def.key}-${field.name}`} className="w-full">
                  <SelectValue placeholder="Select..." />
                </SelectTrigger>
                <SelectContent>
                  {field.options?.map((opt) => (
                    <SelectItem key={opt} value={opt}>
                      {opt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id={`${def.key}-${field.name}`}
                name={field.name}
                type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                step={field.type === 'number' ? 'any' : undefined}
                required={field.required}
                placeholder={field.placeholder}
              />
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={isPending}>
          {isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Plus className="size-4" />
          )}
          Add record
        </Button>
        {message && (
          <p
            className={
              message.type === 'ok'
                ? 'text-sm text-primary'
                : 'text-sm text-destructive'
            }
          >
            {message.text}
          </p>
        )}
      </div>
    </form>
  )
}

'use client'

import { useRef, useState, useTransition } from 'react'
import { Upload, Loader2, FileUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import type { TableDef } from '@/lib/admin-config'
import { importCsv } from '@/app/admin/actions'

export function CsvImport({ def }: { def: TableDef }) {
  const [isPending, startTransition] = useTransition()
  const [csv, setCsv] = useState('')
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const headerExample = def.fields.map((f) => f.name).join(',')

  function handleFile(file: File) {
    const reader = new FileReader()
    reader.onload = () => setCsv(String(reader.result ?? ''))
    reader.readAsText(file)
  }

  function onSubmit() {
    setMessage(null)
    const formData = new FormData()
    formData.set('csv', csv)
    startTransition(async () => {
      const res = await importCsv(def.key, formData)
      if (res?.error) {
        setMessage({ type: 'err', text: res.error })
      } else {
        setMessage({ type: 'ok', text: res?.success ?? 'Imported.' })
        setCsv('')
        if (fileRef.current) fileRef.current.value = ''
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/40 p-3">
        <p className="text-xs text-muted-foreground">
          Expected header row (column order can vary):
        </p>
        <code className="mt-1 block break-all font-mono text-xs text-foreground">
          {headerExample}
        </code>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${def.key}-file`}>Upload a .csv file</Label>
        <input
          ref={fileRef}
          id={`${def.key}-file`}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) handleFile(f)
          }}
          className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-sm file:font-medium file:text-secondary-foreground hover:file:bg-secondary/80"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${def.key}-csv`}>Or paste CSV data</Label>
        <textarea
          id={`${def.key}-csv`}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          rows={6}
          placeholder={`${headerExample}\n...`}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      <div className="flex items-center gap-3">
        <Button type="button" onClick={onSubmit} disabled={isPending || !csv.trim()}>
          {isPending ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          Import CSV
        </Button>
        {csv.trim() && !isPending && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <FileUp className="size-3" />
            {csv.split(/\r?\n/).filter((l) => l.trim()).length - 1} row(s) ready
          </span>
        )}
        {message && (
          <p className={message.type === 'ok' ? 'text-sm text-primary' : 'text-sm text-destructive'}>
            {message.text}
          </p>
        )}
      </div>
    </div>
  )
}

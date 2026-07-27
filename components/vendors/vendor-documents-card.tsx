'use client'

import { useState, useTransition } from 'react'
import { Plus, Loader2, Trash2, FileText, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { addVendorDocument, deleteVendorDocument } from '@/app/vendors/actions'

export type VendorDocument = {
  id: string
  documentName: string
  documentType: string
  fileUrl: string
  uploadedAt: string
}

const DOCUMENT_TYPES = [
  'W-9',
  'Contract',
  'Price List',
  'Certificate of Insurance',
  'License',
  'Invoice',
  'Other',
]

function formatDate(iso: string) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function VendorDocumentsCard({
  vendorId,
  documents,
}: {
  vendorId: string
  documents: VendorDocument[]
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [isDeleting, startDelete] = useTransition()

  function onSubmit(formData: FormData) {
    setError(null)
    startTransition(async () => {
      const res = await addVendorDocument(vendorId, formData)
      if (res?.error) setError(res.error)
      else setOpen(false)
    })
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-base">Documents</CardTitle>
          <CardDescription>
            W-9s, contracts, price lists, and licenses
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <Plus className="size-4" />
          Add
        </Button>
      </CardHeader>
      <CardContent>
        {documents.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground text-pretty">
            No documents recorded yet. Add a link to a W-9, contract, or price list to
            keep it with this vendor.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {documents.map((d) => (
              <li
                key={d.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-border p-3"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <FileText
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">
                      {d.documentName}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {[d.documentType, formatDate(d.uploadedAt)]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    {d.fileUrl && (
                      <a
                        href={d.fileUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-flex items-center gap-1.5 text-sm text-primary underline-offset-4 hover:underline"
                      >
                        Open
                        <ExternalLink className="size-3.5" aria-hidden="true" />
                      </a>
                    )}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                  disabled={isDeleting}
                  onClick={() =>
                    startDelete(async () => {
                      await deleteVendorDocument(vendorId, d.id)
                    })
                  }
                  aria-label={`Remove ${d.documentName}`}
                  title="Remove document"
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Document</DialogTitle>
            <DialogDescription>
              Record a document and where it lives. Only the name is required.
            </DialogDescription>
          </DialogHeader>
          <form action={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="document_name">
                Document Name<span className="text-destructive"> *</span>
              </Label>
              <Input
                id="document_name"
                name="document_name"
                required
                placeholder="2026 W-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="document_type">Type</Label>
              <select
                id="document_type"
                name="document_type"
                defaultValue=""
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">Select...</option>
                {DOCUMENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="file_url">Link</Label>
              <Input
                id="file_url"
                name="file_url"
                type="url"
                placeholder="https://drive.google.com/…"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="submit" disabled={isPending}>
                {isPending && <Loader2 className="size-4 animate-spin" />}
                Add document
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

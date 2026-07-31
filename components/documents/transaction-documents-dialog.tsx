'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Paperclip, Trash2, ExternalLink, FileText, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  uploadTransactionDocument,
  deleteTransactionDocument,
  getDocumentViewUrls,
} from '@/app/documents/actions'
import { fetchTransactionDocuments } from '@/app/documents/fetch-action'
import {
  DOCUMENT_KIND_LABELS,
  type DocumentKind,
  type TransactionDocument,
} from '@/lib/transaction-documents-shared'

const KIND_ORDER: DocumentKind[] = [
  'check_front',
  'check_back',
  'statement',
  'receipt',
  'other',
]

const ACCEPT_ATTR = 'image/png,image/jpeg,image/webp,image/heic,image/heif,application/pdf'

function isPdf(doc: TransactionDocument) {
  return (doc.mimeType ?? '').includes('pdf')
}

export function TransactionDocumentsDialog({
  transactionId,
  title,
  subtitle,
  count,
  maxUploadMb,
  triggerLabel,
}: {
  transactionId: string
  title: string
  subtitle?: string
  /** Attachment count from the page, used for the badge before the dialog opens. */
  count: number
  maxUploadMb: number
  triggerLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [kind, setKind] = useState<DocumentKind>('check_front')
  const [notes, setNotes] = useState('')
  const [documents, setDocuments] = useState<TransactionDocument[]>([])
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)

  const fileRef = useRef<HTMLInputElement>(null)

  /**
   * Load attachments and mint view links, on open and after each change.
   *
   * Both are deferred until the dialog is open: the list can render 60 rows, and
   * signed URLs expire, so fetching everything with the page would be wasted work
   * that also hands out links that die before they are clicked.
   */
  const load = useCallback(() => {
    setLoading(true)
    fetchTransactionDocuments(transactionId)
      .then(async (res) => {
        if (!res.ok || !res.documents) {
          if (res.error) toast.error(res.error)
          return
        }
        setDocuments(res.documents)

        const paths = res.documents.map((d) => d.storagePath)
        if (paths.length === 0) {
          setUrls({})
          return
        }
        const signed = await getDocumentViewUrls(paths)
        if (signed.ok && signed.urls) setUrls(signed.urls)
      })
      .finally(() => setLoading(false))
  }, [transactionId])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  function onUpload(formData: FormData) {
    formData.set('transactionId', transactionId)
    formData.set('kind', kind)
    formData.set('notes', notes)

    startTransition(async () => {
      const res = await uploadTransactionDocument(formData)
      if (res.ok) {
        toast.success('Scan attached.')
        setNotes('')
        if (fileRef.current) fileRef.current.value = ''
        load()
      } else {
        toast.error(res.error ?? 'Upload failed.')
      }
    })
  }

  function onDelete(id: string) {
    startTransition(async () => {
      const res = await deleteTransactionDocument(id)
      if (res.ok) {
        toast.success('Attachment removed.')
        load()
      } else {
        toast.error(res.error ?? 'Could not remove it.')
      }
    })
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="gap-1.5"
        onClick={() => setOpen(true)}
      >
        <Paperclip className="size-3.5" aria-hidden="true" />
        {triggerLabel ?? 'Scans'}
        {count > 0 ? (
          <Badge variant="secondary" className="ml-0.5 px-1.5 tabular-nums">
            {count}
          </Badge>
        ) : null}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-pretty">{title}</DialogTitle>
          <DialogDescription className="text-pretty">
            {subtitle
              ? subtitle
              : 'Attach the scanned check or statement page so the payee stays on file.'}
          </DialogDescription>
        </DialogHeader>

        <form action={onUpload} className="flex flex-col gap-4 rounded-lg border border-border p-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`file-${transactionId}`}>Image or PDF</Label>
            <Input
              ref={fileRef}
              id={`file-${transactionId}`}
              name="file"
              type="file"
              accept={ACCEPT_ATTR}
              required
            />
            <p className="text-xs text-muted-foreground">
              {`PNG, JPEG, WEBP, HEIC or PDF, up to ${maxUploadMb}MB. A phone photo of the check works.`}
            </p>
          </div>

          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor={`kind-${transactionId}`}>What is it?</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as DocumentKind)}>
                <SelectTrigger id={`kind-${transactionId}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KIND_ORDER.map((k) => (
                    <SelectItem key={k} value={k}>
                      {DOCUMENT_KIND_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor={`notes-${transactionId}`}>Payee or note (optional)</Label>
              <Input
                id={`notes-${transactionId}`}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Bayou Feed & Supply"
              />
            </div>
          </div>

          <Button type="submit" disabled={pending} className="self-start gap-1.5">
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Paperclip className="size-4" aria-hidden="true" />
            )}
            Attach scan
          </Button>
        </form>

        <section className="flex flex-col gap-2" aria-label="Attached documents">
          <h3 className="text-sm font-medium">
            {documents.length === 0
              ? 'Nothing attached yet'
              : `${documents.length} attached`}
          </h3>

          {documents.length === 0 ? (
            <p className="text-sm text-muted-foreground text-pretty">
              Look this check up in your bank portal, save the image, then attach it
              here so you never have to look it up twice.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {documents.map((doc) => {
                const url = urls[doc.storagePath]
                return (
                  <li
                    key={doc.id}
                    className="flex items-center gap-3 rounded-lg border border-border p-2"
                  >
                    <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
                      {loading ? (
                        <Loader2
                          className="size-4 animate-spin text-muted-foreground"
                          aria-hidden="true"
                        />
                      ) : url && !isPdf(doc) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={url}
                          alt={doc.notes ?? DOCUMENT_KIND_LABELS[doc.kind]}
                          className="size-full object-cover"
                        />
                      ) : (
                        <FileText
                          className="size-5 text-muted-foreground"
                          aria-hidden="true"
                        />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {DOCUMENT_KIND_LABELS[doc.kind]}
                        {doc.notes ? ` · ${doc.notes}` : ''}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {doc.fileName}
                        {doc.uploadedBy ? ` · ${doc.uploadedBy}` : ''}
                      </p>
                    </div>

                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <ExternalLink className="size-4" aria-hidden="true" />
                        <span className="sr-only">
                          {`Open ${doc.fileName} in a new tab`}
                        </span>
                      </a>
                    ) : null}

                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => onDelete(doc.id)}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                      <span className="sr-only">{`Remove ${doc.fileName}`}</span>
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
          </section>
        </DialogContent>
      </Dialog>
    </>
  )
}

'use client'

import { useState, useTransition } from 'react'
import { Plus, Loader2, Trash2, Mail, Phone } from 'lucide-react'
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
import { addVendorContact, deleteVendorContact } from '@/app/vendors/actions'

export type VendorContact = {
  id: string
  name: string
  title: string
  phone: string
  email: string
}

export function VendorContactsCard({
  vendorId,
  contacts,
}: {
  vendorId: string
  contacts: VendorContact[]
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [isDeleting, startDelete] = useTransition()

  function onSubmit(formData: FormData) {
    setError(null)
    startTransition(async () => {
      const res = await addVendorContact(vendorId, formData)
      if (res?.error) setError(res.error)
      else setOpen(false)
    })
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-base">Contacts</CardTitle>
          <CardDescription>
            People you deal with at this vendor
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <Plus className="size-4" />
          Add
        </Button>
      </CardHeader>
      <CardContent>
        {contacts.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground text-pretty">
            No contacts saved yet. Add the rep or account manager you normally reach
            out to.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {contacts.map((c) => (
              <li
                key={c.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-border p-3"
              >
                <div className="min-w-0">
                  <p className="font-medium text-foreground">{c.name}</p>
                  {c.title && (
                    <p className="text-xs text-muted-foreground">{c.title}</p>
                  )}
                  <div className="mt-1.5 flex flex-col gap-1 text-sm sm:flex-row sm:gap-4">
                    {c.phone && (
                      <a
                        href={`tel:${c.phone}`}
                        className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
                      >
                        <Phone className="size-3.5" aria-hidden="true" />
                        {c.phone}
                      </a>
                    )}
                    {c.email && (
                      <a
                        href={`mailto:${c.email}`}
                        className="inline-flex items-center gap-1.5 truncate text-muted-foreground hover:text-foreground"
                      >
                        <Mail className="size-3.5 shrink-0" aria-hidden="true" />
                        <span className="truncate">{c.email}</span>
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
                      await deleteVendorContact(vendorId, c.id)
                    })
                  }
                  aria-label={`Remove ${c.name}`}
                  title="Remove contact"
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
            <DialogTitle>Add Contact</DialogTitle>
            <DialogDescription>
              Only the contact name is required.
            </DialogDescription>
          </DialogHeader>
          <form action={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="contact_name">
                Name<span className="text-destructive"> *</span>
              </Label>
              <Input id="contact_name" name="contact_name" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contact_title">Title / Role</Label>
              <Input
                id="contact_title"
                name="contact_title"
                placeholder="Sales Rep"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="contact_phone">Phone</Label>
                <Input id="contact_phone" name="contact_phone" type="tel" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="contact_email">Email</Label>
                <Input id="contact_email" name="contact_email" type="email" />
              </div>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="submit" disabled={isPending}>
                {isPending && <Loader2 className="size-4 animate-spin" />}
                Add contact
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

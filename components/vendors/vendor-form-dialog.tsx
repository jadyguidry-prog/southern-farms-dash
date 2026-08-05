'use client'

import { useState, useTransition } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { createVendor, updateVendor } from '@/app/vendors/actions'
import type { DirectoryVendor } from '@/lib/queries'

export const VENDOR_TYPES = [
  'Supplier',
  'Service',
  'Retail',
  'Fuel',
  'Government',
  'Utility',
  'Other',
]

export const PAYMENT_TERMS = [
  'Due on Receipt',
  'Net 15',
  'Net 30',
  'Net 45',
  'Net 60',
  'Prepaid',
]

export const PAYMENT_METHODS = [
  'ACH',
  'Check',
  'Credit Card',
  'Debit Card',
  'Cash',
  'Auto-Draft',
]

const selectClass =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring'

function Field({
  label,
  htmlFor,
  children,
  required,
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
  required?: boolean
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>
        {label}
        {required && <span className="text-destructive"> *</span>}
      </Label>
      {children}
    </div>
  )
}

export function VendorFormDialog({
  open,
  onOpenChange,
  vendor,
  categories,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  /** Existing vendor to edit, or null to create a new one. */
  vendor: DirectoryVendor | null
  categories: string[]
}) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const isEdit = vendor != null

  function onSubmit(formData: FormData) {
    setError(null)
    startTransition(async () => {
      const res = isEdit
        ? await updateVendor(vendor.id, formData)
        : await createVendor(formData)
      if (res?.error) setError(res.error)
      else onOpenChange(false)
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The form itself scrolls (below) rather than this container, so the
          "Add vendor" button stays pinned in view. Previously the whole dialog
          scrolled and the button sat off-screen on a short window. */}
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Vendor' : 'Add Vendor'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Update this vendor’s details. Only the name is required.'
              : 'Only the vendor name is required — you can fill in the rest later.'}
          </DialogDescription>
        </DialogHeader>

        <form
          action={onSubmit}
          className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-5 overflow-hidden"
        >
          {/* Only the fields scroll; -mx-1/px-1 keeps focus rings from clipping. */}
          <div className="-mx-1 space-y-5 overflow-y-auto px-1">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Vendor Name" htmlFor="name" required>
              <Input
                id="name"
                name="name"
                required
                defaultValue={vendor?.name ?? ''}
                placeholder="Walton's Inc."
              />
            </Field>
            <Field label="Display Name" htmlFor="display_name">
              <Input
                id="display_name"
                name="display_name"
                defaultValue={vendor?.displayName ?? ''}
                placeholder="Walton's"
              />
            </Field>
            <Field label="Category" htmlFor="category">
              <Input
                id="category"
                name="category"
                list="vendor-category-options"
                defaultValue={vendor?.category ?? ''}
                placeholder="Processing Supplies"
              />
              <datalist id="vendor-category-options">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
            <Field label="Vendor Type" htmlFor="vendor_type">
              <select
                id="vendor_type"
                name="vendor_type"
                defaultValue={vendor?.vendorType ?? ''}
                className={selectClass}
              >
                <option value="">Select...</option>
                {VENDOR_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Status" htmlFor="vendor_status">
              <select
                id="vendor_status"
                name="vendor_status"
                defaultValue={vendor?.vendorStatus ?? 'Active'}
                className={selectClass}
              >
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
              </select>
            </Field>
            <Field label="Phone" htmlFor="phone">
              <Input
                id="phone"
                name="phone"
                type="tel"
                defaultValue={vendor?.phone ?? ''}
              />
            </Field>
            <Field label="Email" htmlFor="email">
              <Input
                id="email"
                name="email"
                type="email"
                defaultValue={vendor?.email ?? ''}
              />
            </Field>
            <Field label="Website" htmlFor="website">
              <Input
                id="website"
                name="website"
                defaultValue={vendor?.website ?? ''}
                placeholder="waltonsinc.com"
              />
            </Field>
            <Field label="Payment Terms" htmlFor="payment_terms">
              <select
                id="payment_terms"
                name="payment_terms"
                defaultValue={vendor?.paymentTerms ?? ''}
                className={selectClass}
              >
                <option value="">Select...</option>
                {PAYMENT_TERMS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Preferred Payment Method" htmlFor="preferred_payment_method">
              <select
                id="preferred_payment_method"
                name="preferred_payment_method"
                defaultValue={vendor?.preferredPaymentMethod ?? ''}
                className={selectClass}
              >
                <option value="">Select...</option>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Billing Address" htmlFor="billing_address">
              <textarea
                id="billing_address"
                name="billing_address"
                rows={2}
                defaultValue={vendor?.billingAddress ?? ''}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </Field>
            <Field label="Shipping Address" htmlFor="shipping_address">
              <textarea
                id="shipping_address"
                name="shipping_address"
                rows={2}
                defaultValue={vendor?.shippingAddress ?? ''}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </Field>
          </div>

          <Field label="Notes" htmlFor="notes">
            <textarea
              id="notes"
              name="notes"
              rows={3}
              defaultValue={vendor?.notes ?? ''}
              placeholder="Account numbers, delivery instructions, rep details…"
              className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </Field>

          <div className="flex flex-col gap-3 sm:flex-row sm:gap-6">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="hidden"
                name="recurring"
                value={vendor?.recurring ? 'true' : 'false'}
              />
              <input
                type="checkbox"
                defaultChecked={vendor?.recurring ?? false}
                onChange={(e) => {
                  const hidden = e.currentTarget
                    .previousElementSibling as HTMLInputElement | null
                  if (hidden) hidden.value = e.currentTarget.checked ? 'true' : 'false'
                }}
                className="size-4 rounded border-input"
              />
              Recurring vendor
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="hidden"
                name="requires_1099"
                value={vendor?.requires1099 ? 'true' : 'false'}
              />
              <input
                type="checkbox"
                defaultChecked={vendor?.requires1099 ?? false}
                onChange={(e) => {
                  const hidden = e.currentTarget
                    .previousElementSibling as HTMLInputElement | null
                  if (hidden) hidden.value = e.currentTarget.checked ? 'true' : 'false'
                }}
                className="size-4 rounded border-input"
              />
              Requires 1099
            </label>
          </div>

          </div>

          {/* Outside the scroll box on purpose: a submit error must not be
              scrolled out of view while the button is still visible. */}
          <div className="space-y-3">
            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <Button type="submit" disabled={isPending}>
                {isPending && <Loader2 className="size-4 animate-spin" />}
                {isEdit ? 'Save changes' : 'Add vendor'}
              </Button>
            </DialogFooter>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

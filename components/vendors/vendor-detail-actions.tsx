'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Pencil, Archive, ArchiveRestore, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { VendorFormDialog } from '@/components/vendors/vendor-form-dialog'
import { setVendorArchived, deleteVendor } from '@/app/vendors/actions'
import type { DirectoryVendor } from '@/lib/queries'

export function VendorDetailActions({
  vendor,
  categories,
}: {
  vendor: DirectoryVendor
  categories: string[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()

  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" onClick={() => setOpen(true)} className="h-10">
        <Pencil className="size-4" />
        Edit
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-10"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            await setVendorArchived(vendor.id, !vendor.archived)
          })
        }
      >
        {vendor.archived ? (
          <ArchiveRestore className="size-4" />
        ) : (
          <Archive className="size-4" />
        )}
        {vendor.archived ? 'Restore' : 'Archive'}
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-10 text-destructive hover:text-destructive"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            const res = await deleteVendor(vendor.id)
            if (!res?.error) router.push('/vendors')
          })
        }
      >
        <Trash2 className="size-4" />
        Remove
      </Button>

      <VendorFormDialog
        open={open}
        onOpenChange={setOpen}
        vendor={vendor}
        categories={categories}
      />
    </div>
  )
}

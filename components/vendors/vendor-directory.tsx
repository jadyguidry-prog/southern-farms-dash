'use client'

import { useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import {
  Plus,
  Search,
  Pencil,
  Archive,
  ArchiveRestore,
  Trash2,
  ChevronRight,
  RefreshCw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { VendorFormDialog } from '@/components/vendors/vendor-form-dialog'
import { setVendorArchived, deleteVendor } from '@/app/vendors/actions'
import type { DirectoryVendor } from '@/lib/queries'

const selectClass =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto'

type StatusFilter = 'Active' | 'Inactive' | 'Archived' | 'All'

export function VendorDirectory({ vendors }: { vendors: DirectoryVendor[] }) {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All')
  const [type, setType] = useState('All')
  const [status, setStatus] = useState<StatusFilter>('Active')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editVendor, setEditVendor] = useState<DirectoryVendor | null>(null)
  const [isPending, startTransition] = useTransition()

  const categories = useMemo(
    () =>
      Array.from(new Set(vendors.map((v) => v.category).filter(Boolean))).sort(),
    [vendors],
  )
  const types = useMemo(
    () => Array.from(new Set(vendors.map((v) => v.vendorType).filter(Boolean))).sort(),
    [vendors],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return vendors.filter((v) => {
      if (status === 'Archived' && !v.archived) return false
      if (status === 'Active' && (v.archived || v.vendorStatus !== 'Active')) return false
      if (status === 'Inactive' && (v.archived || v.vendorStatus !== 'Inactive'))
        return false
      if (category !== 'All' && v.category !== category) return false
      if (type !== 'All' && v.vendorType !== type) return false
      if (!q) return true
      return (
        v.name.toLowerCase().includes(q) ||
        v.displayName.toLowerCase().includes(q) ||
        v.category.toLowerCase().includes(q) ||
        v.vendorNumber.toLowerCase().includes(q) ||
        v.email.toLowerCase().includes(q) ||
        v.phone.toLowerCase().includes(q)
      )
    })
  }, [vendors, search, category, type, status])

  function openAdd() {
    setEditVendor(null)
    setDialogOpen(true)
  }
  function openEdit(v: DirectoryVendor) {
    setEditVendor(v)
    setDialogOpen(true)
  }
  function onArchive(v: DirectoryVendor) {
    startTransition(async () => {
      await setVendorArchived(v.id, !v.archived)
    })
  }
  function onDelete(v: DirectoryVendor) {
    startTransition(async () => {
      await deleteVendor(v.id)
    })
  }

  const hasFilters =
    search.trim() !== '' || category !== 'All' || type !== 'All' || status !== 'Active'

  function resetFilters() {
    setSearch('')
    setCategory('All')
    setType('All')
    setStatus('Active')
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div>
          <CardTitle className="text-base">Vendor Directory</CardTitle>
          <CardDescription>
            {filtered.length} of {vendors.length}{' '}
            {vendors.length === 1 ? 'vendor' : 'vendors'}
          </CardDescription>
        </div>
        <Button size="sm" onClick={openAdd} className="sm:shrink-0">
          <Plus className="size-4" />
          Add Vendor
        </Button>
      </CardHeader>

      <CardContent>
        {/* Filters */}
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search
              className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, category, email, phone…"
              className="pl-9"
              aria-label="Search vendors"
            />
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusFilter)}
              className={selectClass}
              aria-label="Filter by status"
            >
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
              <option value="Archived">Archived</option>
              <option value="All">All statuses</option>
            </select>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className={selectClass}
              aria-label="Filter by category"
            >
              <option value="All">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className={selectClass}
              aria-label="Filter by type"
            >
              <option value="All">All types</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            {hasFilters && (
              <Button variant="outline" size="sm" onClick={resetFilters} className="h-9">
                <RefreshCw className="size-4" />
                Reset
              </Button>
            )}
          </div>
        </div>

        {filtered.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground text-pretty">
            {vendors.length === 0
              ? 'No vendors yet. Click "Add Vendor" to create your first one.'
              : 'No vendors match these filters.'}
          </p>
        ) : (
          <>
            {/* Mobile: stacked cards */}
            <div className="flex flex-col gap-3 md:hidden">
              {filtered.map((v) => (
                <div
                  key={v.id}
                  className="rounded-lg border border-border bg-card p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link
                        href={`/vendors/${v.id}`}
                        className="font-medium text-foreground underline-offset-4 hover:underline"
                      >
                        {v.displayName}
                      </Link>
                      <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                        {v.vendorNumber || '—'}
                      </p>
                    </div>
                    <Badge
                      variant="secondary"
                      className={
                        v.archived
                          ? 'bg-secondary text-secondary-foreground'
                          : v.vendorStatus === 'Active'
                            ? 'bg-primary/10 text-primary'
                            : 'bg-chart-4/15 text-chart-4'
                      }
                    >
                      {v.archived ? 'Archived' : v.vendorStatus}
                    </Badge>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
                    <div className="min-w-0">
                      <dt className="text-xs text-muted-foreground">Category</dt>
                      <dd className="truncate text-sm font-medium">
                        {v.category || '—'}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs text-muted-foreground">Type</dt>
                      <dd className="truncate text-sm font-medium">
                        {v.vendorType || '—'}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs text-muted-foreground">Terms</dt>
                      <dd className="truncate text-sm font-medium">
                        {v.paymentTerms || '—'}
                      </dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-xs text-muted-foreground">Phone</dt>
                      <dd className="truncate text-sm font-medium">{v.phone || '—'}</dd>
                    </div>
                  </dl>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Link
                      href={`/vendors/${v.id}`}
                      className="inline-flex h-11 flex-1 min-w-[7rem] items-center justify-center gap-1.5 rounded-md border border-input bg-transparent px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      View
                      <ChevronRight className="size-4" aria-hidden="true" />
                    </Link>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-11 flex-1 min-w-[7rem]"
                      onClick={() => openEdit(v)}
                    >
                      <Pencil className="size-4" />
                      Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-11 flex-1 min-w-[7rem]"
                      onClick={() => onArchive(v)}
                      disabled={isPending}
                    >
                      {v.archived ? (
                        <ArchiveRestore className="size-4" />
                      ) : (
                        <Archive className="size-4" />
                      )}
                      {v.archived ? 'Restore' : 'Archive'}
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop: table */}
            <div className="hidden overflow-x-auto md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Vendor</TableHead>
                    <TableHead>Number</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Terms</TableHead>
                    <TableHead>Contact</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-32 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell className="font-medium">
                        <Link
                          href={`/vendors/${v.id}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {v.displayName}
                        </Link>
                        {v.recurring && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            Recurring
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-sm text-muted-foreground">
                        {v.vendorNumber || '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {v.category || '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {v.vendorType || '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {v.paymentTerms || '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {v.phone || v.email || '—'}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={
                            v.archived
                              ? 'bg-secondary text-secondary-foreground'
                              : v.vendorStatus === 'Active'
                                ? 'bg-primary/10 text-primary'
                                : 'bg-chart-4/15 text-chart-4'
                          }
                        >
                          {v.archived ? 'Archived' : v.vendorStatus}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-muted-foreground hover:text-foreground"
                            onClick={() => openEdit(v)}
                            aria-label={`Edit ${v.displayName}`}
                            title="Edit"
                          >
                            <Pencil className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-muted-foreground hover:text-foreground"
                            onClick={() => onArchive(v)}
                            disabled={isPending}
                            aria-label={
                              v.archived
                                ? `Restore ${v.displayName}`
                                : `Archive ${v.displayName}`
                            }
                            title={v.archived ? 'Restore' : 'Archive'}
                          >
                            {v.archived ? (
                              <ArchiveRestore className="size-4" />
                            ) : (
                              <Archive className="size-4" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-muted-foreground hover:text-destructive"
                            onClick={() => onDelete(v)}
                            disabled={isPending}
                            aria-label={`Remove ${v.displayName}`}
                            title="Remove"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>

      <VendorFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        vendor={editVendor}
        categories={categories}
      />
    </Card>
  )
}

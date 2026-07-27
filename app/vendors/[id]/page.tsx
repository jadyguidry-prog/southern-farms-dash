import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  ArrowLeft,
  Globe,
  Mail,
  Phone,
  CircleDollarSign,
  CalendarClock,
  RefreshCw,
  FileText,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { StatCard } from '@/components/stat-card'
import { VendorDetailActions } from '@/components/vendors/vendor-detail-actions'
import { VendorContactsCard } from '@/components/vendors/vendor-contacts-card'
import { VendorDocumentsCard } from '@/components/vendors/vendor-documents-card'
import { formatCurrency } from '@/lib/data'
import {
  getVendorDetail,
  getVendorDirectory,
  getVendorObligations,
} from '@/lib/queries'

function formatDate(iso: string) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/** A single label/value row in the General Info panel. */
function InfoRow({
  label,
  value,
  href,
  icon: Icon,
}: {
  label: string
  value: string
  href?: string
  icon?: typeof Mail
}) {
  const empty = !value
  return (
    <div className="flex flex-col gap-0.5 border-b border-border py-2.5 last:border-0 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="w-48 shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm text-foreground">
        {empty ? (
          <span className="text-muted-foreground">Not set</span>
        ) : href ? (
          <a
            href={href}
            target={href.startsWith('http') ? '_blank' : undefined}
            rel={href.startsWith('http') ? 'noopener noreferrer' : undefined}
            className="inline-flex items-center gap-1.5 text-primary underline-offset-4 hover:underline"
          >
            {Icon && <Icon className="size-3.5 shrink-0" aria-hidden="true" />}
            <span className="break-all">{value}</span>
          </a>
        ) : (
          <span className="whitespace-pre-line">{value}</span>
        )}
      </dd>
    </div>
  )
}

export default async function VendorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const detail = await getVendorDetail(id)
  if (!detail) notFound()

  const { vendor, contacts, documents } = detail
  const [directory, obligations] = await Promise.all([
    getVendorDirectory(),
    getVendorObligations([vendor.name, vendor.displayName]),
  ])

  const categories = Array.from(
    new Set(directory.map((v) => v.category).filter(Boolean)),
  ).sort()

  // All figures below come from records already entered — nothing is estimated.
  const scheduledMonthly = obligations
    .filter((o) => o.active !== false && o.status !== 'Paid')
    .reduce((s, o) => s + o.amount, 0)
  const nextDue = obligations
    .map((o) => o.nextDueDate || o.dueDate)
    .filter(Boolean)
    .sort()[0]

  const websiteHref = vendor.website
    ? vendor.website.startsWith('http')
      ? vendor.website
      : `https://${vendor.website}`
    : undefined

  return (
    <div className="mx-auto max-w-7xl">
      <Link
        href="/vendors"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Back to vendors
      </Link>

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-bold tracking-tight text-foreground text-balance">
              {vendor.displayName}
            </h2>
            <Badge
              variant="secondary"
              className={
                vendor.archived
                  ? 'bg-secondary text-secondary-foreground'
                  : vendor.vendorStatus === 'Active'
                    ? 'bg-primary/10 text-primary'
                    : 'bg-chart-4/15 text-chart-4'
              }
            >
              {vendor.archived ? 'Archived' : vendor.vendorStatus}
            </Badge>
            {vendor.recurring && (
              <Badge variant="secondary" className="bg-secondary text-secondary-foreground">
                Recurring
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {[vendor.vendorNumber, vendor.category, vendor.vendorType]
              .filter(Boolean)
              .join(' · ') || 'No category or type set yet'}
          </p>
        </div>
        <VendorDetailActions vendor={vendor} categories={categories} />
      </div>

      {/* Statistics — derived entirely from entered records. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Outstanding Balance"
          value={formatCurrency(vendor.balance)}
          icon={CircleDollarSign}
          hint={vendor.balance === 0 ? 'No balance recorded' : 'From payables'}
        />
        <StatCard
          label="Scheduled Monthly"
          value={formatCurrency(scheduledMonthly)}
          icon={RefreshCw}
          hint={
            obligations.length === 0
              ? 'No obligations linked yet'
              : `${obligations.length} linked ${obligations.length === 1 ? 'obligation' : 'obligations'}`
          }
        />
        <StatCard
          label="Next Payment Due"
          value={nextDue ? formatDate(nextDue) : '—'}
          icon={CalendarClock}
          hint={nextDue ? undefined : 'No due date on file'}
        />
        <StatCard
          label="Documents on File"
          value={String(documents.length)}
          icon={FileText}
          hint={`${contacts.length} ${contacts.length === 1 ? 'contact' : 'contacts'} saved`}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">General Information</CardTitle>
              <CardDescription>
                Blank fields simply haven&apos;t been filled in yet — use Edit to add
                them.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="flex flex-col">
                <InfoRow label="Legal Name" value={vendor.name} />
                <InfoRow label="Display Name" value={vendor.displayName} />
                <InfoRow label="Vendor Number" value={vendor.vendorNumber} />
                <InfoRow label="Category" value={vendor.category} />
                <InfoRow label="Vendor Type" value={vendor.vendorType} />
                <InfoRow
                  label="Phone"
                  value={vendor.phone}
                  href={vendor.phone ? `tel:${vendor.phone}` : undefined}
                  icon={Phone}
                />
                <InfoRow
                  label="Email"
                  value={vendor.email}
                  href={vendor.email ? `mailto:${vendor.email}` : undefined}
                  icon={Mail}
                />
                <InfoRow
                  label="Website"
                  value={vendor.website}
                  href={websiteHref}
                  icon={Globe}
                />
                <InfoRow label="Payment Terms" value={vendor.paymentTerms} />
                <InfoRow
                  label="Preferred Payment"
                  value={vendor.preferredPaymentMethod}
                />
                <InfoRow label="Billing Address" value={vendor.billingAddress} />
                <InfoRow label="Shipping Address" value={vendor.shippingAddress} />
                <InfoRow
                  label="Requires 1099"
                  value={vendor.requires1099 ? 'Yes' : 'No'}
                />
                <InfoRow label="Added" value={formatDate(vendor.createdAt)} />
              </dl>
            </CardContent>
          </Card>

          <Card className="mt-4">
            <CardHeader>
              <CardTitle className="text-base">Notes</CardTitle>
              <CardDescription>
                Account numbers, delivery instructions, and anything else worth
                remembering
              </CardDescription>
            </CardHeader>
            <CardContent>
              {vendor.notes ? (
                <p className="whitespace-pre-line text-sm leading-relaxed text-foreground">
                  {vendor.notes}
                </p>
              ) : (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  No notes yet. Use Edit to add some.
                </p>
              )}
            </CardContent>
          </Card>

          {obligations.length > 0 && (
            <Card className="mt-4">
              <CardHeader>
                <CardTitle className="text-base">Linked Obligations</CardTitle>
                <CardDescription>
                  Recurring cash obligations recorded against this vendor
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-3">
                  {obligations.map((o) => (
                    <li
                      key={o.id}
                      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg border border-border p-3"
                    >
                      <div className="min-w-0">
                        <p className="font-medium text-foreground">
                          {o.obligationName}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {[o.frequency, o.paymentMethod].filter(Boolean).join(' · ') ||
                            'One-time'}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-mono text-sm text-foreground">
                          {formatCurrency(o.amount)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatDate(o.nextDueDate || o.dueDate)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <VendorContactsCard vendorId={vendor.id} contacts={contacts} />
          <VendorDocumentsCard vendorId={vendor.id} documents={documents} />
        </div>
      </div>
    </div>
  )
}

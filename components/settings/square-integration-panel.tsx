'use client'

import { useState, useTransition } from 'react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import type { ActionResult } from '@/app/settings/square-actions'
import type { SquareDataCounts } from '@/lib/square-sync'

type SyncStateRow = {
  resource: string
  last_synced_through: string | null
  last_run_at: string | null
  last_success_at: string | null
  last_error: string | null
  status: string | null
  records_synced: number | null
}

type Props = {
  configured: boolean
  configReason: string | null
  environment: string | null
  syncState: SyncStateRow[]
  counts: SquareDataCounts
  onTest: () => Promise<ActionResult>
  onSync: (formData?: FormData) => Promise<ActionResult>
  onRebuild: () => Promise<ActionResult>
}

const RESOURCE_LABELS: Record<string, string> = {
  locations: 'Locations',
  catalog: 'Catalog (items & categories)',
  team: 'Team members',
  team_members: 'Team members',
  orders: 'Orders',
  payments: 'Payments',
  refunds: 'Refunds',
  rollups: 'Daily & monthly rollups',
}

const RESOURCE_ORDER = [
  'locations',
  'catalog',
  'team',
  'team_members',
  'orders',
  'payments',
  'refunds',
  'rollups',
]

function formatWhen(value: string | null): string {
  if (!value) return 'Never'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return 'Never'
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function SquareIntegrationPanel({
  configured,
  configReason,
  environment,
  syncState,
  counts,
  onTest,
  onSync,
  onRebuild,
}: Props) {
  const [result, setResult] = useState<ActionResult | null>(null)
  const [pendingLabel, setPendingLabel] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function run(label: string, action: () => Promise<ActionResult>) {
    setPendingLabel(label)
    setResult(null)
    startTransition(async () => {
      try {
        setResult(await action())
      } catch (err) {
        setResult({
          ok: false,
          message: err instanceof Error ? err.message : 'Unexpected error.',
        })
      } finally {
        setPendingLabel(null)
      }
    })
  }

  const rows = [...syncState].sort(
    (a, b) => RESOURCE_ORDER.indexOf(a.resource) - RESOURCE_ORDER.indexOf(b.resource),
  )
  const hasData = counts.orders > 0 || counts.salesDays > 0

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">Square Point of Sale</CardTitle>
            <CardDescription>
              Square is the authoritative source for sales. Bank deposits are used only
              for reconciliation.
            </CardDescription>
          </div>
          {configured ? (
            <Badge variant={environment === 'production' ? 'default' : 'secondary'}>
              {environment === 'production' ? 'Production' : 'Sandbox'}
            </Badge>
          ) : (
            <Badge variant="outline">Not connected</Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {!configured && (
          <div className="rounded-lg border border-dashed p-4">
            <p className="text-sm font-medium">Connect Square to start pulling sales</p>
            <p className="mt-1 text-sm text-muted-foreground">{configReason}</p>
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>
                In the Square Developer Dashboard, open your application and copy the
                access token.
              </li>
              <li>
                Add it as the <code className="font-mono text-xs">SQUARE_ACCESS_TOKEN</code>{' '}
                environment variable in Project Settings → Vars.
              </li>
              <li>
                Optionally set{' '}
                <code className="font-mono text-xs">SQUARE_ENVIRONMENT</code> to{' '}
                <code className="font-mono text-xs">sandbox</code> for testing.
              </li>
              <li>Return here and press Test connection.</li>
            </ol>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={() => run('test', onTest)}
          >
            {pendingLabel === 'test' ? 'Testing…' : 'Test connection'}
          </Button>
          <Button
            size="sm"
            disabled={isPending || !configured}
            onClick={() => run('sync', () => onSync())}
          >
            {pendingLabel === 'sync' ? 'Syncing…' : 'Sync now'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={isPending || !configured}
            onClick={() =>
              run('full', () => {
                const fd = new FormData()
                fd.set('mode', 'full')
                return onSync(fd)
              })
            }
          >
            {pendingLabel === 'full' ? 'Resyncing…' : 'Full resync'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={isPending || counts.orders === 0}
            onClick={() => run('rebuild', onRebuild)}
          >
            {pendingLabel === 'rebuild' ? 'Rebuilding…' : 'Rebuild totals'}
          </Button>
        </div>

        {result && (
          <div
            role="status"
            className={`rounded-lg border p-3 text-sm ${
              result.ok
                ? 'border-primary/30 bg-primary/5 text-foreground'
                : 'border-destructive/40 bg-destructive/5 text-foreground'
            }`}
          >
            <p className="font-medium">{result.message}</p>
            {result.detail && result.detail.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                {result.detail.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <Separator />

        <div>
          <p className="text-sm font-medium">Data pulled from Square</p>
          {hasData ? (
            <>
              <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {[
                  { label: 'Orders', value: counts.orders },
                  { label: 'Payments', value: counts.payments },
                  { label: 'Refunds', value: counts.refunds },
                  { label: 'Catalog objects', value: counts.catalogItems },
                  { label: 'Days with sales', value: counts.salesDays },
                ].map((s) => (
                  <div key={s.label} className="rounded-lg border p-3">
                    <dt className="text-xs text-muted-foreground">{s.label}</dt>
                    <dd className="mt-0.5 font-mono text-lg">
                      {s.value.toLocaleString()}
                    </dd>
                  </div>
                ))}
              </dl>
              {counts.earliestSale && counts.latestSale && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Covering {counts.earliestSale} through {counts.latestSale}.
                </p>
              )}
            </>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              No Square sales have been imported yet, so sales screens will show no
              Square figures. Nothing is estimated or filled in with sample data —
              connect Square and run a sync to populate them.
            </p>
          )}
        </div>

        <Separator />

        <div>
          <p className="text-sm font-medium">Sync status by resource</p>
          <ul className="mt-3 space-y-2">
            {rows.map((row) => (
              <li
                key={row.resource}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
              >
                <div className="min-w-0">
                  <p className="text-sm">
                    {RESOURCE_LABELS[row.resource] ?? row.resource}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Last success: {formatWhen(row.last_success_at)}
                    {row.records_synced ? ` · ${row.records_synced} records` : ''}
                  </p>
                  {row.last_error && (
                    <p className="mt-1 break-words text-xs text-destructive">
                      {row.last_error}
                    </p>
                  )}
                </div>
                <Badge
                  variant={
                    row.status === 'success'
                      ? 'default'
                      : row.status === 'error'
                        ? 'destructive'
                        : 'secondary'
                  }
                >
                  {row.status === 'never_run' ? 'never run' : (row.status ?? 'idle')}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  )
}

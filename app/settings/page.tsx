import { PageHeader } from '@/components/page-header'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { FinancialTargetsForm } from '@/components/settings/financial-targets-form'
import { SquareIntegrationPanel } from '@/components/settings/square-integration-panel'
import { PlaidIntegrationPanel } from '@/components/settings/plaid-integration-panel'
import { getBusinessSettings } from '@/lib/queries'
import { getSquareConfigState } from '@/lib/square-client'
import { getSyncState, getSquareDataCounts } from '@/lib/square-sync'
import {
  testConnectionAction,
  syncNowAction,
  rebuildRollupAction,
} from './square-actions'
import {
  getPlaidOverview,
  savePlaidAccountMapping,
  runPlaidSync,
  disconnectPlaidItem,
} from './plaid-actions'

/**
 * These rows previously rendered Switches that persisted nothing and reported states
 * nothing controlled — the vendor row showed "on" while promising exactly the reminders
 * the owner later had to ask for. A control that cannot change anything, describing a
 * feature that does not exist, is worse than an empty section.
 *
 * So: no fake switches. Each row states plainly whether the alert actually runs and where
 * it appears. `built: false` is spelled out rather than dressed up as a disabled toggle.
 */
const alertRows = [
  {
    id: 'cash',
    label: 'Low cash forecast alerts',
    desc: 'Warns when the projected balance nears your minimum reserve',
    built: true,
    where: 'Cash Flow page and AI Advisor',
  },
  {
    id: 'payroll',
    label: 'Payroll % threshold alerts',
    desc: 'Flags payroll running above your target ceiling',
    built: true,
    where: 'Dashboard and AI Advisor',
  },
  {
    id: 'vendor',
    label: 'Bill payment reminders',
    desc: 'Bills due within your reminder lead time, plus checks outstanding too long',
    built: true,
    where: 'Dashboard and AI Advisor',
  },
  {
    id: 'ar',
    label: 'Receivable aging alerts',
    desc: 'Would flag wholesale accounts trending slow',
    built: false,
    where: null,
  },
]

export default async function SettingsPage() {
  const squareConfig = getSquareConfigState()
  const [settings, syncState, counts, plaidOverview] = await Promise.all([
    getBusinessSettings(),
    getSyncState(),
    getSquareDataCounts(),
    getPlaidOverview(),
  ])

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Settings"
        description="Manage company details, financial targets, and alert preferences for the Operations Center."
      />

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Company Profile</CardTitle>
            <CardDescription>Details shown across the dashboard</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="company">Company Name</Label>
              <Input id="company" defaultValue="Southern Farms" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="division">Division</Label>
              <Input id="division" defaultValue="Specialty Meats" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="fy">Fiscal Year</Label>
              <Input id="fy" defaultValue="2026" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="currency">Reporting Currency</Label>
              <Input id="currency" defaultValue="USD ($)" />
            </div>
          </CardContent>
        </Card>

        <SquareIntegrationPanel
          configured={squareConfig.configured}
          configReason={squareConfig.configured ? null : squareConfig.reason}
          environment={squareConfig.configured ? squareConfig.environment : null}
          syncState={syncState}
          counts={counts}
          onTest={testConnectionAction}
          onSync={syncNowAction}
          onRebuild={rebuildRollupAction}
        />

        <PlaidIntegrationPanel
          overview={plaidOverview}
          onSaveMapping={savePlaidAccountMapping}
          onSync={runPlaidSync}
          onDisconnect={disconnectPlaidItem}
        />

        <FinancialTargetsForm values={settings} />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Alerts & Notifications</CardTitle>
            <CardDescription>
              What the AI Advisor watches for. Thresholds and lead times are set under
              Financial Targets above.
            </CardDescription>
          </CardHeader>
          <CardContent className="divide-y divide-border">
            {alertRows.map((t, i) => (
              <div
                key={t.id}
                className={`flex items-start justify-between gap-4 ${i === 0 ? 'pb-4' : 'py-4'} last:pb-0`}
              >
                <div className="min-w-0">
                  <p className="font-medium text-foreground">{t.label}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground text-pretty">
                    {t.desc}
                  </p>
                  {t.where ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">{t.where}</p>
                  ) : null}
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                    t.built
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {t.built ? 'Active' : 'Not built yet'}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>

      </div>
    </div>
  )
}

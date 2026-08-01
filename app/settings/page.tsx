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
import { Switch } from '@/components/ui/switch'
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

const alertToggles = [
  { id: 'cash', label: 'Low cash forecast alerts', desc: 'Warn when projected balance nears the minimum buffer', on: true },
  { id: 'payroll', label: 'Payroll % threshold alerts', desc: 'Notify when payroll exceeds the target ceiling', on: true },
  { id: 'vendor', label: 'Vendor payment reminders', desc: 'Remind before due dates and on overdue balances', on: true },
  { id: 'ar', label: 'Receivable aging alerts', desc: 'Flag wholesale accounts trending slow', on: false },
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

        <FinancialTargetsForm values={settings} />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Alerts & Notifications</CardTitle>
            <CardDescription>Choose what the AI Advisor should watch for</CardDescription>
          </CardHeader>
          <CardContent className="divide-y divide-border">
            {alertToggles.map((t, i) => (
              <div
                key={t.id}
                className={`flex items-center justify-between gap-4 ${i === 0 ? 'pb-4' : 'py-4'} last:pb-0`}
              >
                <div>
                  <Label htmlFor={t.id} className="font-medium">
                    {t.label}
                  </Label>
                  <p className="mt-0.5 text-sm text-muted-foreground">{t.desc}</p>
                </div>
                <Switch id={t.id} defaultChecked={t.on} />
              </div>
            ))}
          </CardContent>
        </Card>

      </div>
    </div>
  )
}

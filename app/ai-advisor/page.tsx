import {
  Sparkles,
  AlertTriangle,
  TrendingUp,
  Info,
  ArrowRight,
} from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { recommendations, type Recommendation } from '@/lib/data'

const severityMeta: Record<
  Recommendation['severity'],
  { label: string; badge: string; icon: typeof Info; accent: string }
> = {
  critical: {
    label: 'Action Required',
    badge: 'bg-destructive/10 text-destructive',
    icon: AlertTriangle,
    accent: 'border-l-destructive',
  },
  warning: {
    label: 'Monitor',
    badge: 'bg-chart-4/15 text-chart-4',
    icon: Info,
    accent: 'border-l-chart-4',
  },
  opportunity: {
    label: 'Opportunity',
    badge: 'bg-primary/10 text-primary',
    icon: TrendingUp,
    accent: 'border-l-primary',
  },
}

export default function AiAdvisorPage() {
  const critical = recommendations.filter((r) => r.severity === 'critical').length
  const warnings = recommendations.filter((r) => r.severity === 'warning').length
  const opps = recommendations.filter((r) => r.severity === 'opportunity').length

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="AI Advisor"
        description="Proactive insights generated from your live financial data — prioritized by impact."
      />

      {/* Summary banner */}
      <Card className="mb-6 border-primary/20 bg-primary text-primary-foreground">
        <CardContent className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary-foreground/15">
              <Sparkles className="size-5" aria-hidden="true" />
            </span>
            <div>
              <p className="font-semibold">Your books look strong overall.</p>
              <p className="mt-1 text-sm text-primary-foreground/80 text-pretty">
                {critical} item needs action, {warnings} to monitor, and {opps} growth
                opportunities identified this week.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {recommendations.map((rec) => {
          const meta = severityMeta[rec.severity]
          const Icon = meta.icon
          return (
            <Card key={rec.id} className={`border-l-4 ${meta.accent}`}>
              <CardHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary" className={meta.badge}>
                    <Icon className="mr-1 size-3" aria-hidden="true" />
                    {meta.label}
                  </Badge>
                  <Badge variant="outline">{rec.category}</Badge>
                </div>
                <CardTitle className="mt-1 text-lg text-balance">{rec.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <CardDescription className="text-sm leading-relaxed text-foreground/80">
                  {rec.detail}
                </CardDescription>
                <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Estimated impact
                    </p>
                    <p className="font-mono text-sm font-semibold text-foreground">{rec.impact}</p>
                  </div>
                  <Button variant="outline" size="sm">
                    Take action
                    <ArrowRight className="size-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <p className="mt-6 text-center text-xs text-muted-foreground">
        Recommendations are generated from mock financial data for demonstration purposes.
      </p>
    </div>
  )
}

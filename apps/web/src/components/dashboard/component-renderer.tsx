import type { DashboardComponent } from '@/hooks/use-dashboards'
import { KpiCard } from './kpi-card'
import { StatsGroup } from './stats-group'
import { DashboardChart } from './dashboard-chart'
import { AiInsightsCard } from './ai-insights-card'
import { DataTable } from './data-table'
import { LinksCard } from './links-card'

interface ComponentRendererProps {
  component: DashboardComponent
}

export function ComponentRenderer({ component }: ComponentRendererProps) {
  const { type, title, config, data } = component

  switch (type) {
    case 'kpi':
      return (
        <KpiCard
          title={title}
          config={config as Parameters<typeof KpiCard>[0]['config']}
          data={data as Parameters<typeof KpiCard>[0]['data']}
        />
      )

    case 'stats_group':
      return (
        <StatsGroup
          title={title}
          config={config as Parameters<typeof StatsGroup>[0]['config']}
          data={data as Parameters<typeof StatsGroup>[0]['data']}
        />
      )

    case 'chart':
      return (
        <DashboardChart
          title={title}
          config={config as Parameters<typeof DashboardChart>[0]['config']}
          data={data as Parameters<typeof DashboardChart>[0]['data']}
        />
      )

    case 'ai_insights':
      return (
        <AiInsightsCard
          title={title}
          lastInsight={component.lastInsight}
          lastInsightAt={component.lastInsightAt}
          prompt={component.prompt}
          sources={(data as Record<string, unknown> | null)?.sources as Parameters<typeof AiInsightsCard>[0]['sources']}
        />
      )

    case 'table':
      return (
        <DataTable
          title={title}
          config={config as Parameters<typeof DataTable>[0]['config']}
          data={data as Parameters<typeof DataTable>[0]['data']}
        />
      )

    case 'links':
      return (
        <LinksCard
          title={title}
          config={config as Parameters<typeof LinksCard>[0]['config']}
          data={data as Parameters<typeof LinksCard>[0]['data']}
        />
      )

    default:
      return (
        <div className="rounded-xl border border-dashed border-muted-foreground/30 p-4 text-sm text-muted-foreground">
          Unknown component type: {type}
        </div>
      )
  }
}

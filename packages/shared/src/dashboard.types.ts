// ── Dashboard Component Types ───────────────────────────────

export type ComponentType = 'kpi' | 'stats_group' | 'chart' | 'ai_insights' | 'table'

// ── KPI ─────────────────────────────────────────────────────

export interface KpiConfig {
  format?: string
  prefix?: string
  suffix?: string
  trendDirection?: 'up-good' | 'up-bad'
}

export interface KpiData {
  value: number | string
  label: string
  change?: number
  changeLabel?: string
}

// ── Chart ───────────────────────────────────────────────────

export interface ChartConfig {
  chartType: 'line' | 'bar' | 'pie' | 'area'
  xKey: string
  yKey: string | string[]
  colors?: string[]
}

export interface ChartData {
  series: Array<{
    name: string
    data: Array<Record<string, unknown>>
  }>
}

// ── Stats Group ─────────────────────────────────────────────

export interface StatsGroupConfig {
  columns?: number
}

export interface StatsGroupData {
  stats: Array<{
    label: string
    value: string | number
    change?: number
    changeLabel?: string
  }>
}

// ── Table ───────────────────────────────────────────────────

export interface TableConfig {
  columns: Array<{
    key: string
    label: string
    align?: 'left' | 'center' | 'right'
  }>
}

export interface TableData {
  rows: Array<Record<string, unknown>>
}

// ── AI Insights ─────────────────────────────────────────────

export interface AiInsightsConfig {
  style?: 'compact' | 'detailed'
}

// ── Dashboard ───────────────────────────────────────────────

export interface DashboardComponentSchema {
  id: string
  dashboardId: string
  type: ComponentType
  title: string | null
  config: Record<string, unknown>
  data: Record<string, unknown> | null
  previousData: Record<string, unknown> | null
  position: { x: number; y: number; w: number; h: number } | null
  order: number
  prompt: string | null
  script: string | null
  scriptLanguage: string | null
  notes: string | null
  lastInsight: string | null
  lastInsightAt: string | null
  createdAt: string
  updatedAt: string
}

export interface DashboardSchema {
  id: string
  workspaceId: string
  title: string
  description: string | null
  layout: { columns?: number; gap?: number } | null
  cronJobId: string | null
  lastRefreshAt: string | null
  createdAt: string
  updatedAt: string
  components: DashboardComponentSchema[]
}

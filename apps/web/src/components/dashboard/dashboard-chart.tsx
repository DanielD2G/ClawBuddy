import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { SourcesFooter, type Source } from './sources-footer'

const BRAND_COLOR = '#ff6b35'
const DEFAULT_COLORS = [
  '#ff6b35',
  '#3b82f6',
  '#22c55e',
  '#f59e0b',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#f43f5e',
]

interface DashboardChartProps {
  title?: string | null
  config: {
    chartType: 'line' | 'bar' | 'pie' | 'area'
    xKey: string
    yKey: string | string[]
    colors?: string[]
  }
  data: {
    series: Array<{
      name: string
      data: Array<Record<string, unknown>>
    }>
    sources?: Source[]
  } | null
}

export function DashboardChart({ title, config, data }: DashboardChartProps) {
  if (!data?.series?.length) {
    return (
      <Card className="h-full py-5 md:py-6">
        {title && (
          <CardHeader className="px-5 md:px-6">
            <CardTitle className="text-lg">{title}</CardTitle>
          </CardHeader>
        )}
        <CardContent className="px-5 md:px-6">
          <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
            No data available
          </div>
        </CardContent>
      </Card>
    )
  }

  const { chartType, xKey, yKey, colors = DEFAULT_COLORS } = config
  const yKeys = Array.isArray(yKey) ? yKey : [yKey]

  // For multi-series, merge all data points by xKey
  const mergedData = mergeSeriesData(data.series, xKey)

  return (
    <Card className="py-5 md:py-6">
      {title && (
        <CardHeader className="px-5 md:px-6">
          <CardTitle className="text-lg">{title}</CardTitle>
        </CardHeader>
      )}
      <CardContent className="px-5 md:px-6">
        <ResponsiveContainer width="100%" height={320}>
          {chartType === 'pie' ? (
            <PieChart>
              <Pie
                data={data.series[0]?.data ?? []}
                dataKey={yKeys[0]}
                nameKey={xKey}
                cx="50%"
                cy="50%"
                outerRadius={100}
                label={({ name, percent }) =>
                  `${name}: ${((percent ?? 0) * 100).toFixed(0)}%`
                }
              >
                {(data.series[0]?.data ?? []).map((_, i) => (
                  <Cell key={i} fill={colors[i % colors.length]} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          ) : chartType === 'bar' ? (
            <BarChart data={mergedData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey={xKey} className="text-xs" tick={{ fill: 'currentColor' }} />
              <YAxis className="text-xs" tick={{ fill: 'currentColor' }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '0.5rem',
                  fontSize: '0.75rem',
                }}
              />
              {yKeys.length > 1 && <Legend />}
              {yKeys.map((key, i) => (
                <Bar
                  key={key}
                  dataKey={data.series.length > 1 ? data.series[i]?.name ?? key : key}
                  fill={colors[i % colors.length]}
                  radius={[4, 4, 0, 0]}
                />
              ))}
            </BarChart>
          ) : chartType === 'area' ? (
            <AreaChart data={mergedData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey={xKey} className="text-xs" tick={{ fill: 'currentColor' }} />
              <YAxis className="text-xs" tick={{ fill: 'currentColor' }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '0.5rem',
                  fontSize: '0.75rem',
                }}
              />
              {yKeys.length > 1 && <Legend />}
              {yKeys.map((key, i) => (
                <Area
                  key={key}
                  type="monotone"
                  dataKey={data.series.length > 1 ? data.series[i]?.name ?? key : key}
                  stroke={colors[i % colors.length]}
                  fill={colors[i % colors.length]}
                  fillOpacity={0.15}
                />
              ))}
            </AreaChart>
          ) : (
            <LineChart data={mergedData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey={xKey} className="text-xs" tick={{ fill: 'currentColor' }} />
              <YAxis className="text-xs" tick={{ fill: 'currentColor' }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '0.5rem',
                  fontSize: '0.75rem',
                }}
              />
              {yKeys.length > 1 && <Legend />}
              {yKeys.map((key, i) => (
                <Line
                  key={key}
                  type="monotone"
                  dataKey={data.series.length > 1 ? data.series[i]?.name ?? key : key}
                  stroke={colors[i % colors.length]}
                  strokeWidth={2}
                  dot={{ r: 3, fill: colors[i % colors.length] }}
                />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
        <SourcesFooter sources={data?.sources} />
      </CardContent>
    </Card>
  )
}

/** Merge multiple series into a flat array keyed by xKey, with each series name as a column */
function mergeSeriesData(
  series: Array<{ name: string; data: Array<Record<string, unknown>> }>,
  xKey: string,
): Array<Record<string, unknown>> {
  if (series.length === 1) return series[0].data

  const map = new Map<string, Record<string, unknown>>()
  for (const s of series) {
    for (const row of s.data) {
      const key = String(row[xKey] ?? '')
      const existing = map.get(key) ?? { [xKey]: row[xKey] }
      existing[s.name] = row[Object.keys(row).find((k) => k !== xKey) ?? '']
      map.set(key, existing)
    }
  }
  return Array.from(map.values())
}

import { TrendingUp, TrendingDown } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { SourcesFooter, type Source } from './sources-footer'

interface StatsGroupProps {
  title?: string | null
  config: {
    columns?: number
  }
  data: {
    stats: Array<{
      label: string
      value: string | number
      change?: number
      changeLabel?: string
    }>
    sources?: Source[]
  } | null
}

export function StatsGroup({ title, config, data }: StatsGroupProps) {
  const stats = data?.stats ?? []
  const cols = config.columns ?? stats.length

  return (
    <Card className="h-full py-5 md:py-6">
      {title && (
        <CardHeader className="px-5 md:px-6">
          <CardTitle className="text-lg">{title}</CardTitle>
        </CardHeader>
      )}
      <CardContent className="px-5 md:px-6">
        <div
          className="grid gap-6"
          style={{ gridTemplateColumns: `repeat(${Math.min(cols, 6)}, minmax(0, 1fr))` }}
        >
          {stats.map((stat, i) => (
            <div key={i} className="flex flex-col gap-1">
              <p className="text-sm font-medium text-muted-foreground">{stat.label}</p>
              <p className="text-2xl font-bold tabular-nums">
                {typeof stat.value === 'number' ? stat.value.toLocaleString() : stat.value}
              </p>
              {stat.change !== undefined && stat.change !== 0 && (
                <div
                  className={cn(
                    'flex items-center gap-1 text-xs font-medium',
                    stat.change > 0
                      ? 'text-green-600 dark:text-green-400'
                      : 'text-red-600 dark:text-red-400',
                  )}
                >
                  {stat.change > 0 ? (
                    <TrendingUp className="size-3" />
                  ) : (
                    <TrendingDown className="size-3" />
                  )}
                  <span>
                    {stat.change > 0 ? '+' : ''}
                    {stat.change}%
                  </span>
                  {stat.changeLabel && (
                    <span className="text-muted-foreground font-normal">{stat.changeLabel}</span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        <SourcesFooter sources={data?.sources} />
      </CardContent>
    </Card>
  )
}

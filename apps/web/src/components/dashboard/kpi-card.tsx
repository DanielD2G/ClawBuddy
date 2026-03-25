import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { SourcesFooter, type Source } from './sources-footer'

interface KpiCardProps {
  title?: string | null
  config: {
    prefix?: string
    suffix?: string
    trendDirection?: 'up-good' | 'up-bad'
  }
  data: {
    value: number | string
    label: string
    change?: number
    changeLabel?: string
    sources?: Source[]
  } | null
}

export function KpiCard({ title, config, data }: KpiCardProps) {
  if (!data) {
    return (
      <Card className="h-full py-5 md:py-6">
        <CardContent className="flex flex-col gap-2 px-5 md:px-6">
          {title && <p className="text-sm font-medium text-muted-foreground">{title}</p>}
          <p className="text-3xl font-bold text-muted-foreground/40">--</p>
        </CardContent>
      </Card>
    )
  }

  const { prefix = '', suffix = '', trendDirection = 'up-good' } = config
  const change = data.change ?? 0
  const isPositive = change > 0
  const isNegative = change < 0
  const isGood = trendDirection === 'up-good' ? isPositive : isNegative
  const isBad = trendDirection === 'up-good' ? isNegative : isPositive

  return (
    <Card className="h-full py-5 md:py-6">
      <CardContent className="flex flex-col gap-2 px-5 md:px-6">
        <p className="text-sm font-medium text-muted-foreground">{title ?? data.label}</p>
        <p className="text-3xl font-bold tabular-nums">
          {prefix}
          {typeof data.value === 'number' ? data.value.toLocaleString() : data.value}
          {suffix}
        </p>
        {change !== 0 && (
          <div
            className={cn(
              'flex items-center gap-1.5 text-sm font-medium',
              isGood && 'text-green-600 dark:text-green-400',
              isBad && 'text-red-600 dark:text-red-400',
              !isGood && !isBad && 'text-muted-foreground',
            )}
          >
            {isPositive ? (
              <TrendingUp className="size-4" />
            ) : isNegative ? (
              <TrendingDown className="size-4" />
            ) : (
              <Minus className="size-4" />
            )}
            <span>
              {isPositive ? '+' : ''}
              {change}%
            </span>
            {data.changeLabel && (
              <span className="text-muted-foreground font-normal">{data.changeLabel}</span>
            )}
          </div>
        )}
        <SourcesFooter sources={data.sources} />
      </CardContent>
    </Card>
  )
}

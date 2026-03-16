import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { Coins, Trash2 } from 'lucide-react'

interface TokenUsageData {
  totals: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    requests: number
  }
  byProvider: Array<{
    provider: string
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }>
  byModel: Array<{
    model: string
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }>
  daily: Array<{
    date: string
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }>
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-center">
      <div className="text-lg font-semibold font-mono">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

export function TokenUsageCard() {
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['token-usage'],
    queryFn: () => apiClient.get<TokenUsageData>('/settings/token-usage'),
  })

  const resetMutation = useMutation({
    mutationFn: () => apiClient.delete('/settings/token-usage'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['token-usage'] }),
  })

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Coins className="size-5" />
              Token Usage
            </CardTitle>
            <CardDescription>Cumulative LLM token consumption.</CardDescription>
          </div>
          {data && data.totals.requests > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => resetMutation.mutate()}
              disabled={resetMutation.isPending}
            >
              <Trash2 className="size-3.5 mr-1" />
              Reset
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="text-sm text-muted-foreground">Loading...</div>
        )}

        {data && (
          <div className="space-y-5">
            {/* Totals */}
            <div className="grid grid-cols-3 gap-4">
              <StatBox label="Input Tokens" value={formatNumber(data.totals.inputTokens)} />
              <StatBox label="Output Tokens" value={formatNumber(data.totals.outputTokens)} />
              <StatBox label="Total Tokens" value={formatNumber(data.totals.totalTokens)} />
            </div>

            <div className="text-xs text-muted-foreground">
              {data.totals.requests.toLocaleString()} LLM requests total
            </div>

            {/* By Provider */}
            {data.byProvider.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2">By Provider</h4>
                <div className="space-y-1.5">
                  {data.byProvider.map((p) => (
                    <div key={p.provider} className="flex items-center justify-between text-sm">
                      <Badge variant="outline" className="text-xs capitalize">
                        {p.provider}
                      </Badge>
                      <span className="text-muted-foreground font-mono text-xs">
                        {formatNumber(p.inputTokens)} in / {formatNumber(p.outputTokens)} out
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* By Model */}
            {data.byModel.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2">By Model</h4>
                <div className="space-y-1.5">
                  {data.byModel.map((m) => (
                    <div key={m.model} className="flex items-center justify-between text-sm">
                      <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                        {m.model}
                      </code>
                      <span className="text-muted-foreground font-mono text-xs">
                        {formatNumber(m.totalTokens)} tokens
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Daily (last 7 days) */}
            {data.daily.length > 0 && (
              <div>
                <h4 className="text-sm font-medium mb-2">Last 7 Days</h4>
                <div className="space-y-1">
                  {data.daily.map((d) => {
                    const maxTokens = Math.max(...data.daily.map((x) => x.totalTokens), 1)
                    const pct = (d.totalTokens / maxTokens) * 100
                    return (
                      <div key={d.date} className="flex items-center gap-3 text-xs">
                        <span className="w-20 text-muted-foreground font-mono">{d.date.slice(5)}</span>
                        <div className="flex-1 h-4 bg-muted rounded overflow-hidden">
                          <div
                            className="h-full bg-brand rounded transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="w-16 text-right text-muted-foreground font-mono">
                          {formatNumber(d.totalTokens)}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {data.totals.requests === 0 && (
              <div className="text-sm text-muted-foreground text-center py-4">
                No token usage recorded yet.
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

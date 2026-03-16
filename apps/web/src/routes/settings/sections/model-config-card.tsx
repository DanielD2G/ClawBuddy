import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { Brain, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { DEFAULT_CONTEXT_LIMIT_TOKENS, DEFAULT_MAX_AGENT_ITERATIONS } from '@/constants'

interface ModelConfigData {
  provider: string
  models: {
    primary: string
    light: string
    title: string
    compact: string
  }
  useLightModel: boolean
  contextLimitTokens: number
  maxAgentIterations: number
  catalog: string[]
}

const MODEL_ROLES = [
  { key: 'primary' as const, label: 'Primary', description: 'Agent reasoning, tool decisions, complex responses' },
  { key: 'light' as const, label: 'Light', description: 'RAG answers, simple queries' },
  { key: 'title' as const, label: 'Title', description: 'Chat title generation' },
  { key: 'compact' as const, label: 'Compact', description: 'Context window compression' },
]

export function ModelConfigCard() {
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['model-config'],
    queryFn: () => apiClient.get<ModelConfigData>('/settings/models'),
  })

  const [models, setModels] = useState<Record<string, string>>({})
  const [useLightModel, setUseLightModel] = useState(true)
  const [contextLimitTokens, setContextLimitTokens] = useState(DEFAULT_CONTEXT_LIMIT_TOKENS)
  const [maxAgentIterations, setMaxAgentIterations] = useState(DEFAULT_MAX_AGENT_ITERATIONS)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    if (data) {
      setModels(data.models)
      setUseLightModel(data.useLightModel)
      setContextLimitTokens(data.contextLimitTokens)
      setMaxAgentIterations(data.maxAgentIterations)
      setDirty(false)
    }
  }, [data])

  const saveMutation = useMutation({
    mutationFn: () =>
      apiClient.patch('/settings/models', { ...models, useLightModel, contextLimitTokens, maxAgentIterations }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['model-config'] })
      setDirty(false)
    },
  })

  const handleModelChange = (key: string, value: string) => {
    setModels((prev) => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  const handleToggle = () => {
    setUseLightModel((prev) => !prev)
    setDirty(true)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Brain className="size-5" />
          AI Models
        </CardTitle>
        <CardDescription>
          Configure which models are used for each task.
          {data?.provider && (
            <Badge variant="outline" className="ml-2 text-xs capitalize">{data.provider}</Badge>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading && <div className="text-sm text-muted-foreground">Loading...</div>}

        {data && (
          <div className="space-y-5">
            {/* Light model toggle */}
            <div className="flex items-center justify-between gap-3 rounded-2xl border bg-muted/30 px-4 py-3">
              <div>
                <div className="text-sm font-medium">Use light model for simple tasks</div>
                <div className="text-xs text-muted-foreground">
                  Saves tokens and reduces latency for RAG and context compression
                </div>
              </div>
              <button
                type="button"
                onClick={handleToggle}
                className={cn(
                  'relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors',
                  useLightModel ? 'bg-brand' : 'bg-muted-foreground/30'
                )}
              >
                <span
                  className={cn(
                    'pointer-events-none inline-block size-5 rounded-full bg-white shadow-sm transition-transform',
                    useLightModel ? 'translate-x-[22px]' : 'translate-x-0.5'
                  )}
                  style={{ marginTop: '2px' }}
                />
              </button>
            </div>

            {/* Model selectors */}
            <div className="space-y-3">
              {MODEL_ROLES.map((role) => {
                const isDisabled = role.key === 'light' && !useLightModel
                return (
                  <div key={role.key} className={cn('flex flex-col gap-1.5', isDisabled && 'opacity-40')}>
                    <div>
                      <label className="text-sm font-medium">{role.label}</label>
                      <p className="text-xs text-muted-foreground">{role.description}</p>
                    </div>
                    <select
                      value={models[role.key] ?? ''}
                      onChange={(e) => handleModelChange(role.key, e.target.value)}
                      disabled={isDisabled}
                      className="h-8 w-full rounded-full border bg-background px-3 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                    >
                      {data.catalog.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                )
              })}
            </div>

            {/* Context limit */}
            <div className="flex flex-col gap-2 rounded-2xl border bg-muted/30 px-4 py-3">
              <div>
                <div className="text-sm font-medium">Context limit</div>
                <div className="text-xs text-muted-foreground">
                  Max tokens (K) before older messages are compressed into a summary
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <Input
                  type="number"
                  min={5}
                  max={200}
                  step={1}
                  value={Math.round(contextLimitTokens / 1000)}
                  onChange={(e) => {
                    setContextLimitTokens(Number(e.target.value) * 1000)
                    setDirty(true)
                  }}
                  className="w-20 h-8 text-xs font-mono text-right"
                />
                <span className="text-xs text-muted-foreground font-medium">K</span>
              </div>
            </div>

            {/* Max agent iterations */}
            <div className="flex flex-col gap-2 rounded-2xl border bg-muted/30 px-4 py-3">
              <div>
                <div className="text-sm font-medium">Max tool iterations</div>
                <div className="text-xs text-muted-foreground">
                  Maximum tool calls per chat turn before the agent stops
                </div>
              </div>
              <Input
                type="number"
                min={1}
                max={200}
                step={1}
                value={maxAgentIterations}
                onChange={(e) => {
                  setMaxAgentIterations(Number(e.target.value))
                  setDirty(true)
                }}
                className="w-20 h-8 text-xs font-mono text-right"
              />
            </div>

            {/* Save */}
            {dirty && (
              <Button
                size="sm"
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
              >
                {saveMutation.isPending && <Loader2 className="size-3.5 mr-1 animate-spin" />}
                Save changes
              </Button>
            )}

            {saveMutation.isError && (
              <p className="text-xs text-destructive">
                {(saveMutation.error as Error)?.message || 'Failed to save'}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

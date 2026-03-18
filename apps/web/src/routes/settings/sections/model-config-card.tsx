import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { Brain, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DEFAULT_CONTEXT_LIMIT_TOKENS,
  DEFAULT_MAX_AGENT_ITERATIONS,
  PROVIDER_LABELS,
} from '@/constants'

interface ModelConfigData {
  provider: string
  models: {
    primary: string
    medium: string
    light: string
    explore: string
    execute: string
    title: string
    compact: string
  }
  advancedModelConfig: boolean
  contextLimitTokens: number
  maxAgentIterations: number
  availableProviders: string[]
  catalogs: Record<string, string[]>
}

const SIMPLE_ROLES = [
  {
    key: 'primary' as const,
    label: 'Main',
    description: 'Primary agent reasoning and tool decisions',
  },
  {
    key: 'medium' as const,
    label: 'Medium',
    description: 'Execute sub-agent, RAG, context compression',
  },
  {
    key: 'light' as const,
    label: 'Light',
    description: 'Explore & analyze sub-agents, title generation',
  },
]

const ADVANCED_ROLES = [
  {
    key: 'primary' as const,
    label: 'Main',
    description: 'Primary agent reasoning and tool decisions',
  },
  {
    key: 'explore' as const,
    label: 'Explore',
    description: 'Explore sub-agent (search, read, browse)',
  },
  {
    key: 'execute' as const,
    label: 'Execute',
    description: 'Execute sub-agent (multi-step tasks)',
  },
  { key: 'title' as const, label: 'Title', description: 'Chat title generation' },
  { key: 'compact' as const, label: 'Compact', description: 'Context window compression' },
]

function inferProvider(modelId: string, availableProviders: string[]): string {
  if (
    modelId.startsWith('gpt-') ||
    modelId.startsWith('o1') ||
    modelId.startsWith('o3') ||
    modelId.startsWith('o4')
  )
    return 'openai'
  if (modelId.startsWith('gemini-')) return 'gemini'
  if (modelId.startsWith('claude-')) return 'claude'
  return availableProviders[0] ?? 'openai'
}

export function ModelConfigCard() {
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['model-config'],
    queryFn: () => apiClient.get<ModelConfigData>('/settings/models'),
  })

  const [models, setModels] = useState<Record<string, string>>({})
  const [roleProviders, setRoleProviders] = useState<Record<string, string>>({})
  const [advancedMode, setAdvancedMode] = useState(false)
  const [contextLimitTokens, setContextLimitTokens] = useState(DEFAULT_CONTEXT_LIMIT_TOKENS)
  const [maxAgentIterations, setMaxAgentIterations] = useState(DEFAULT_MAX_AGENT_ITERATIONS)
  const [dirty, setDirty] = useState(false)

  const roles = advancedMode ? ADVANCED_ROLES : SIMPLE_ROLES

  useEffect(() => {
    if (data) {
      setModels(data.models)
      const providers: Record<string, string> = {}
      for (const [key, modelId] of Object.entries(data.models)) {
        if (modelId) {
          providers[key] = inferProvider(modelId, data.availableProviders)
        }
      }
      setRoleProviders(providers)
      setAdvancedMode(data.advancedModelConfig)
      setContextLimitTokens(data.contextLimitTokens)
      setMaxAgentIterations(data.maxAgentIterations)
      setDirty(false)
    }
  }, [data])

  const saveMutation = useMutation({
    mutationFn: () =>
      apiClient.patch('/settings/models', {
        ...models,
        advancedModelConfig: advancedMode,
        contextLimitTokens,
        maxAgentIterations,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['model-config'] })
      setDirty(false)
    },
  })

  const handleProviderChange = (roleKey: string, provider: string) => {
    setRoleProviders((prev) => ({ ...prev, [roleKey]: provider }))
    const firstModel = data?.catalogs[provider]?.[0]
    if (firstModel) {
      setModels((prev) => ({ ...prev, [roleKey]: firstModel }))
    }
    setDirty(true)
  }

  const handleModelChange = (key: string, value: string) => {
    setModels((prev) => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  const handleToggle = () => {
    setAdvancedMode((prev) => !prev)
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
          Configure which provider and model are used for each task.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading && <div className="text-sm text-muted-foreground">Loading...</div>}

        {data && (
          <div className="space-y-5">
            {/* Advanced mode toggle */}
            <div className="flex items-center justify-between gap-3 rounded-2xl border bg-muted/30 px-4 py-3">
              <div>
                <div className="text-sm font-medium">Advanced model configuration</div>
                <div className="text-xs text-muted-foreground">
                  Customize which model is used for each task. When off, models are assigned
                  automatically from three tiers.
                </div>
              </div>
              <button
                type="button"
                onClick={handleToggle}
                className={cn(
                  'relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors',
                  advancedMode ? 'bg-brand' : 'bg-muted-foreground/30',
                )}
              >
                <span
                  className={cn(
                    'pointer-events-none inline-block size-5 rounded-full bg-white shadow-sm transition-transform',
                    advancedMode ? 'translate-x-[22px]' : 'translate-x-0.5',
                  )}
                  style={{ marginTop: '2px' }}
                />
              </button>
            </div>

            {/* Model selectors */}
            <div className="space-y-3">
              {roles.map((role) => {
                const currentProvider = roleProviders[role.key] ?? data.provider
                const providerModels = data.catalogs[currentProvider] ?? []

                return (
                  <div key={role.key} className="flex flex-col gap-1.5">
                    <div>
                      <label className="text-sm font-medium">{role.label}</label>
                      <p className="text-xs text-muted-foreground">{role.description}</p>
                    </div>
                    <div className="flex gap-2">
                      <select
                        value={currentProvider}
                        onChange={(e) => handleProviderChange(role.key, e.target.value)}
                        className="h-8 w-[140px] shrink-0 rounded-full border bg-background px-3 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                      >
                        {data.availableProviders.map((p) => (
                          <option key={p} value={p}>
                            {PROVIDER_LABELS[p] ?? p}
                          </option>
                        ))}
                      </select>
                      <select
                        value={models[role.key] ?? ''}
                        onChange={(e) => handleModelChange(role.key, e.target.value)}
                        className="h-8 w-full rounded-full border bg-background px-3 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                      >
                        {providerModels.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </div>
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

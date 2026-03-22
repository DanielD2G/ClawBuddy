import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { NumberInput } from '@/components/ui/number-input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSearchable,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { Brain, Check, ChevronsUpDown, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DEFAULT_CONTEXT_LIMIT_TOKENS,
  DEFAULT_MAX_AGENT_ITERATIONS,
  DEFAULT_SUB_AGENT_EXPLORE_MAX_ITERATIONS,
  DEFAULT_SUB_AGENT_ANALYZE_MAX_ITERATIONS,
  DEFAULT_SUB_AGENT_EXECUTE_MAX_ITERATIONS,
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
  subAgentExploreMaxIterations: number
  subAgentAnalyzeMaxIterations: number
  subAgentExecuteMaxIterations: number
  availableProviders: string[]
  catalogs: Record<string, string[]>
  roleProviders: Record<string, string>
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
  const [subAgentExploreMaxIterations, setSubAgentExploreMaxIterations] = useState(
    DEFAULT_SUB_AGENT_EXPLORE_MAX_ITERATIONS,
  )
  const [subAgentAnalyzeMaxIterations, setSubAgentAnalyzeMaxIterations] = useState(
    DEFAULT_SUB_AGENT_ANALYZE_MAX_ITERATIONS,
  )
  const [subAgentExecuteMaxIterations, setSubAgentExecuteMaxIterations] = useState(
    DEFAULT_SUB_AGENT_EXECUTE_MAX_ITERATIONS,
  )
  const [dirty, setDirty] = useState(false)

  const roles = advancedMode ? ADVANCED_ROLES : SIMPLE_ROLES

  useEffect(() => {
    if (data) {
      setModels(data.models)
      setRoleProviders(data.roleProviders)
      setAdvancedMode(data.advancedModelConfig)
      setContextLimitTokens(data.contextLimitTokens)
      setMaxAgentIterations(data.maxAgentIterations)
      setSubAgentExploreMaxIterations(data.subAgentExploreMaxIterations)
      setSubAgentAnalyzeMaxIterations(data.subAgentAnalyzeMaxIterations)
      setSubAgentExecuteMaxIterations(data.subAgentExecuteMaxIterations)
      setDirty(false)
    }
  }, [data])

  const saveMutation = useMutation({
    mutationFn: () =>
      apiClient.patch('/settings/models', {
        provider: roleProviders.primary,
        ...models,
        roleProviders,
        advancedModelConfig: advancedMode,
        contextLimitTokens,
        maxAgentIterations,
        subAgentExploreMaxIterations,
        subAgentAnalyzeMaxIterations,
        subAgentExecuteMaxIterations,
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
            <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3">
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
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button className="flex w-[140px] shrink-0 items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm hover:bg-muted/70 dark:bg-muted/20 dark:hover:bg-muted/40">
                            <span className="truncate">
                              {PROVIDER_LABELS[currentProvider] ?? currentProvider}
                            </span>
                            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          {data.availableProviders.map((p) => (
                            <DropdownMenuItem
                              key={p}
                              onClick={() => handleProviderChange(role.key, p)}
                              className="gap-2"
                            >
                              <span className="flex-1">{PROVIDER_LABELS[p] ?? p}</span>
                              {currentProvider === p && <Check className="size-3.5" />}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button className="flex w-full items-center justify-between rounded-lg border border-border/50 bg-transparent px-3 py-2 font-mono text-xs hover:bg-accent">
                            <span className="truncate">{models[role.key] || 'Select model'}</span>
                            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuSearchable placeholder="Search models...">
                          {providerModels.map((m) => (
                            <DropdownMenuItem
                              key={m}
                              onClick={() => handleModelChange(role.key, m)}
                              className="gap-2 font-mono text-xs"
                            >
                              <span className="flex-1 truncate">{m}</span>
                              {models[role.key] === m && <Check className="size-3.5" />}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuSearchable>
                      </DropdownMenu>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Limits */}
            <div className="rounded-lg border bg-muted/30 px-4 py-3 space-y-2.5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <span className="text-sm font-medium">Context limit</span>
                  <span className="text-xs text-muted-foreground ml-2">tokens before compression</span>
                </div>
                <NumberInput
                  value={Math.round(contextLimitTokens / 1000)}
                  onChange={(v) => {
                    setContextLimitTokens(v * 1000)
                    setDirty(true)
                  }}
                  min={5}
                  max={200}
                  suffix="K"
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <span className="text-sm font-medium">Max tool iterations</span>
                  <span className="text-xs text-muted-foreground ml-2">per chat turn</span>
                </div>
                <NumberInput
                  value={maxAgentIterations}
                  onChange={(v) => {
                    setMaxAgentIterations(v)
                    setDirty(true)
                  }}
                  min={1}
                  max={200}
                />
              </div>
              <div className="border-t border-border/50 pt-2.5">
                <div className="text-sm font-medium mb-1.5">Sub-agent iterations</div>
                <div className="flex items-center gap-3">
                  {(
                    [
                      {
                        key: 'explore',
                        label: 'Explore',
                        value: subAgentExploreMaxIterations,
                        setter: setSubAgentExploreMaxIterations,
                      },
                      {
                        key: 'analyze',
                        label: 'Analyze',
                        value: subAgentAnalyzeMaxIterations,
                        setter: setSubAgentAnalyzeMaxIterations,
                      },
                      {
                        key: 'execute',
                        label: 'Execute',
                        value: subAgentExecuteMaxIterations,
                        setter: setSubAgentExecuteMaxIterations,
                      },
                    ] as const
                  ).map(({ key, label, value, setter }) => (
                    <div key={key} className="flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">{label}</span>
                      <NumberInput
                        value={value}
                        onChange={(v) => {
                          setter(v)
                          setDirty(true)
                        }}
                        min={1}
                        max={200}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Save */}
            {dirty && (
              <Button
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
              >
                {saveMutation.isPending && <Loader2 className="size-4 mr-1 animate-spin" />}
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

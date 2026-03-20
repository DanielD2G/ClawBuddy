import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSearchable,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ChevronRight, ChevronLeft, ChevronsUpDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PROVIDER_LABELS, inferProvider } from '@/constants'
import type { ProvidersData } from '@/hooks/use-providers'

interface StepChatModelProps {
  providers: ProvidersData
  onUpdate: (data: Record<string, unknown>) => void
  isUpdating: boolean
  onBack: () => void
  onNext: () => void
}

const SIMPLE_TIERS = [
  { key: 'main', label: 'Main', description: 'Primary agent reasoning' },
  { key: 'medium', label: 'Medium', description: 'Execute sub-agent, RAG, compression' },
  { key: 'light', label: 'Light', description: 'Explore sub-agent, titles' },
]

const ADVANCED_ROLES = [
  { key: 'main', label: 'Main', description: 'Primary agent' },
  { key: 'explore', label: 'Explore', description: 'Search & browse sub-agent' },
  { key: 'execute', label: 'Execute', description: 'Multi-step sub-agent' },
  { key: 'title', label: 'Title', description: 'Chat title generation' },
  { key: 'compact', label: 'Compact', description: 'Context compression' },
]

const MODEL_FIELD_MAP: Record<string, string> = {
  main: 'llmModel',
  medium: 'mediumModel',
  light: 'lightModel',
  explore: 'exploreModel',
  execute: 'executeModel',
  title: 'titleModel',
  compact: 'compactModel',
}

export function StepChatModel({
  providers,
  onUpdate,
  isUpdating,
  onBack,
  onNext,
}: StepChatModelProps) {
  const [advancedMode, setAdvancedMode] = useState(providers.active.advancedModelConfig ?? false)
  const [models, setModels] = useState<Record<string, string>>({})
  const [roleProviders, setRoleProviders] = useState<Record<string, string>>({})

  const roles = advancedMode ? ADVANCED_ROLES : SIMPLE_TIERS
  const availableProviders = providers.available.llm

  // Initialize state from server data
  useEffect(() => {
    const active = providers.active
    const serverModels: Record<string, string> = {}
    const serverProviders: Record<string, string> = {}

    const entries: [string, string | null][] = [
      ['main', active.llmModel],
      ['medium', active.mediumModel],
      ['light', active.lightModel],
      ['explore', active.exploreModel],
      ['execute', active.executeModel],
      ['title', active.titleModel],
      ['compact', active.compactModel],
    ]

    for (const [key, modelId] of entries) {
      if (modelId) {
        serverModels[key] = modelId
        serverProviders[key] = inferProvider(modelId, availableProviders)
      }
    }

    // For keys without a saved model, default to main's provider
    const mainProvider = serverProviders.main ?? active.llm
    for (const role of [...SIMPLE_TIERS, ...ADVANCED_ROLES]) {
      if (!serverProviders[role.key]) {
        serverProviders[role.key] = mainProvider
      }
    }

    setModels(serverModels)
    setRoleProviders(serverProviders)
    setAdvancedMode(active.advancedModelConfig ?? false)
  }, [providers, availableProviders])

  const handleProviderChange = (roleKey: string, provider: string) => {
    setRoleProviders((prev) => ({ ...prev, [roleKey]: provider }))
    const firstModel = providers.models.llm[provider]?.[0]
    if (firstModel) {
      setModels((prev) => ({ ...prev, [roleKey]: firstModel }))
      const field = MODEL_FIELD_MAP[roleKey]
      if (field) onUpdate({ [field]: firstModel })
    }
  }

  const handleModelChange = (roleKey: string, modelId: string) => {
    setModels((prev) => ({ ...prev, [roleKey]: modelId }))
    const field = MODEL_FIELD_MAP[roleKey]
    if (field) onUpdate({ [field]: modelId })
  }

  const handleAdvancedToggle = () => {
    const next = !advancedMode
    setAdvancedMode(next)
    onUpdate({ advancedModelConfig: next })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Chat Models</CardTitle>
        <CardDescription>
          Choose the AI provider and models for each tier. You can change this later.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Advanced toggle */}
        <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted/30 px-3 py-2">
          <div>
            <div className="text-sm font-medium">Advanced</div>
            <div className="text-xs text-muted-foreground">Customize model per task</div>
          </div>
          <button
            type="button"
            onClick={handleAdvancedToggle}
            className={cn(
              'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors',
              advancedMode ? 'bg-brand' : 'bg-muted-foreground/30',
            )}
          >
            <span
              className={cn(
                'pointer-events-none inline-block size-4 rounded-full bg-white shadow-sm transition-transform',
                advancedMode ? 'translate-x-[18px]' : 'translate-x-0.5',
              )}
              style={{ marginTop: '2px' }}
            />
          </button>
        </div>

        {/* Model selectors per tier/role */}
        <div className="space-y-3">
          {roles.map((role) => {
            const currentProvider = roleProviders[role.key] ?? providers.active.llm
            const providerModels = providers.models.llm[currentProvider] ?? []
            const currentModel = models[role.key] ?? ''

            return (
              <div key={role.key} className="flex flex-col gap-1">
                <div className="flex items-baseline gap-2">
                  <label className="text-sm font-medium">{role.label}</label>
                  <span className="text-xs text-muted-foreground">{role.description}</span>
                </div>
                <div className="flex gap-2">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button disabled={isUpdating} className="flex w-[140px] shrink-0 items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm hover:bg-muted/70 dark:bg-muted/20 dark:hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50">
                        <span className="truncate">{PROVIDER_LABELS[currentProvider] ?? currentProvider}</span>
                        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      {availableProviders.map((p: string) => (
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
                      <button disabled={isUpdating} className="flex w-full items-center justify-between rounded-lg border border-border/50 bg-transparent px-3 py-2 font-mono text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50">
                        <span className="truncate">{currentModel || 'Default'}</span>
                        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuSearchable placeholder="Search models...">
                      {providerModels.map((m: string) => (
                        <DropdownMenuItem
                          key={m}
                          onClick={() => handleModelChange(role.key, m)}
                          className="gap-2 font-mono text-xs"
                        >
                          <span className="flex-1 truncate">{m}</span>
                          {currentModel === m && <Check className="size-3.5" />}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSearchable>
                  </DropdownMenu>
                </div>
              </div>
            )
          })}
        </div>

        <div className="flex justify-between mt-4">
          <Button variant="outline" onClick={onBack}>
            <ChevronLeft className="size-4 mr-1" />
            Back
          </Button>
          <Button onClick={onNext}>
            Next
            <ChevronRight className="size-4 ml-1" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

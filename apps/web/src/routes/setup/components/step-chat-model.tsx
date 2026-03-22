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
import { PROVIDER_LABELS } from '@/constants'
import type { ProvidersData } from '@/hooks/use-providers'

interface StepChatModelProps {
  providers: ProvidersData
  advancedMode: boolean
  models: Record<string, string>
  roleProviders: Record<string, string>
  onAdvancedModeChange: (advancedMode: boolean) => void
  onModelChange: (roleKey: string, modelId: string) => void
  onRoleProviderChange: (roleKey: string, provider: string) => void
  onBack: () => void
  onNext: () => void
}

const SIMPLE_TIERS = [
  { key: 'primary', label: 'Main', description: 'Primary agent reasoning' },
  { key: 'medium', label: 'Medium', description: 'Execute sub-agent, RAG, compression' },
  { key: 'light', label: 'Light', description: 'Explore sub-agent, titles' },
]

const ADVANCED_ROLES = [
  { key: 'primary', label: 'Main', description: 'Primary agent' },
  { key: 'explore', label: 'Explore', description: 'Search & browse sub-agent' },
  { key: 'execute', label: 'Execute', description: 'Multi-step sub-agent' },
  { key: 'title', label: 'Title', description: 'Chat title generation' },
  { key: 'compact', label: 'Compact', description: 'Context compression' },
]

export function StepChatModel({
  providers,
  advancedMode,
  models,
  roleProviders,
  onAdvancedModeChange,
  onModelChange,
  onRoleProviderChange,
  onBack,
  onNext,
}: StepChatModelProps) {
  const roles = advancedMode ? ADVANCED_ROLES : SIMPLE_TIERS
  const availableProviders = providers.available.llm
  const canContinue = roles.every((role) => Boolean(models[role.key]?.trim()))

  const handleProviderChange = (roleKey: string, provider: string) => {
    onRoleProviderChange(roleKey, provider)
    onModelChange(roleKey, '')
  }

  const handleModelChange = (roleKey: string, modelId: string) => {
    onModelChange(roleKey, modelId)
  }

  const handleAdvancedToggle = () => {
    onAdvancedModeChange(!advancedMode)
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold tracking-tight">Chat Models</h2>
        <p className="text-muted-foreground mt-1">
          Choose the AI provider and models for each tier. You can change this later.
        </p>
      </div>
      <div className="flex flex-col gap-4">
        {/* Advanced toggle */}
        <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2">
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
                      <button className="flex h-(--control) w-[140px] shrink-0 items-center justify-between rounded-md border border-border bg-muted/40 px-3 text-sm hover:bg-muted/70 dark:bg-muted/20 dark:hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50">
                        <span className="truncate">
                          {PROVIDER_LABELS[currentProvider] ?? currentProvider}
                        </span>
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
                      <button className="flex h-(--control) w-full items-center justify-between rounded-md border border-border/50 bg-transparent px-3 font-mono text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50">
                        <span className={cn('truncate', !currentModel && 'text-muted-foreground')}>
                          {currentModel || 'Select model'}
                        </span>
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

        <div className="flex justify-between mt-8 pt-6 border-t border-border/50">
          <Button variant="ghost" onClick={onBack}>
            <ChevronLeft className="size-4 mr-1" />
            Back
          </Button>
          <Button onClick={onNext} disabled={!canContinue}>
            Next
            <ChevronRight className="size-4 ml-1" />
          </Button>
        </div>
        {!canContinue && (
          <p className="text-center text-xs text-muted-foreground">
            Select a model for each visible role to continue.
          </p>
        )}
      </div>
    </div>
  )
}

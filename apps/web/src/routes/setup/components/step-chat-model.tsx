import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ChevronRight, ChevronLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PROVIDER_LABELS } from '@/constants'
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

export function StepChatModel({
  providers,
  onUpdate,
  isUpdating,
  onBack,
  onNext,
}: StepChatModelProps) {
  const [advancedMode, setAdvancedMode] = useState(false)
  const roles = advancedMode ? ADVANCED_ROLES : SIMPLE_TIERS

  const handleProviderChange = (value: string) => {
    const defaultModel = providers.models.llm[value]?.[0]
    onUpdate({ llm: value, llmModel: defaultModel })
  }

  const handleModelUpdate = (key: string, modelId: string) => {
    const fieldMap: Record<string, string> = {
      main: 'llmModel',
      medium: 'mediumModel',
      light: 'lightModel',
      explore: 'exploreModel',
      execute: 'executeModel',
      title: 'titleModel',
      compact: 'compactModel',
    }
    const field = fieldMap[key]
    if (field) onUpdate({ [field]: modelId })
  }

  const handleAdvancedToggle = () => {
    const next = !advancedMode
    setAdvancedMode(next)
    onUpdate({ advancedModelConfig: next })
  }

  const currentProvider = providers.active.llm
  const providerModels = providers.models.llm[currentProvider] ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle>Chat Models</CardTitle>
        <CardDescription>
          Choose the AI provider and models for each tier. You can change this later.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Provider selector */}
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium">Provider</label>
          <Select
            value={currentProvider}
            onValueChange={handleProviderChange}
            disabled={isUpdating}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {providers.available.llm.map((p: string) => (
                <SelectItem key={p} value={p}>
                  {PROVIDER_LABELS[p] ?? p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

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
          {roles.map((role) => (
            <div key={role.key} className="flex flex-col gap-1">
              <div className="flex items-baseline gap-2">
                <label className="text-sm font-medium">{role.label}</label>
                <span className="text-xs text-muted-foreground">{role.description}</span>
              </div>
              <Select
                value={role.key === 'main' ? (providers.active.llmModel ?? '') : ''}
                onValueChange={(value) => handleModelUpdate(role.key, value)}
                disabled={isUpdating}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Default" />
                </SelectTrigger>
                <SelectContent>
                  {providerModels.map((m: string) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
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

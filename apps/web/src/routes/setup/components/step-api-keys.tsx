import { Button } from '@/components/ui/button'
import { ChevronRight, ChevronLeft } from 'lucide-react'
import type { ProviderConnectionInfo, ProviderMetadata } from '@/hooks/use-settings-base'
import { ProviderConnectionRow } from '@/components/provider-connection-row'

interface StepApiKeysProps {
  providerMetadata: Record<string, ProviderMetadata>
  connections: Record<string, ProviderConnectionInfo>
  onSaveConnection: (provider: string, value: string) => void
  onRemoveConnection: (provider: string) => void
  isSaving: boolean
  isRemoving: boolean
  canContinue: boolean
  onBack: () => void
  onNext: () => void
}

export function StepApiKeys({
  providerMetadata,
  connections,
  onSaveConnection,
  onRemoveConnection,
  isSaving,
  isRemoving,
  canContinue,
  onBack,
  onNext,
}: StepApiKeysProps) {
  const providers = Object.entries(providerMetadata)

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold tracking-tight">Provider Connections</h2>
        <p className="text-muted-foreground mt-1">
          Configure at least one reachable embedding-capable provider to continue.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        {providers.map(([provider, metadata]) => (
          <ProviderConnectionRow
            key={provider}
            provider={provider}
            metadata={metadata}
            info={connections[provider]}
            onSave={(value) => onSaveConnection(provider, value)}
            onRemove={() => onRemoveConnection(provider)}
            isSaving={isSaving}
            isRemoving={isRemoving}
            basePath="/setup"
            variant="setup"
          />
        ))}
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
          <p className="text-xs text-muted-foreground text-center">
            Add a reachable embedding provider connection to continue
          </p>
        )}
      </div>
    </div>
  )
}

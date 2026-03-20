import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Check, ChevronRight, ChevronLeft, Trash2 } from 'lucide-react'
import type { ProviderConnectionInfo, ProviderMetadata } from '@/hooks/use-settings-base'

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
          <ApiKeyInput
            key={provider}
            provider={provider}
            metadata={metadata}
            info={connections[provider]}
            onSave={(value) => onSaveConnection(provider, value)}
            onRemove={() => onRemoveConnection(provider)}
            isSaving={isSaving}
            isRemoving={isRemoving}
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

function ApiKeyInput({
  provider,
  metadata,
  info,
  onSave,
  onRemove,
  isSaving,
  isRemoving,
}: {
  provider: string
  metadata: ProviderMetadata
  info: ProviderConnectionInfo
  onSave: (value: string) => void
  onRemove: () => void
  isSaving: boolean
  isRemoving: boolean
}) {
  const [value, setValue] = useState('')
  const [editing, setEditing] = useState(false)
  const isSet = !!info.source
  const placeholder =
    metadata.connectionType === 'baseUrl'
      ? `Enter ${metadata.label} base URL`
      : `Enter ${metadata.label} API key`

  if (isSet && !editing) {
    return (
      <div className="flex items-center justify-between rounded-md border p-3 gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{metadata.label}</span>
          <Badge variant="secondary" className="text-xs">
            {info.source === 'env' ? 'ENV' : provider === 'local' ? 'Configured URL' : 'Configured'}
          </Badge>
          {info.value && (
            <span className="text-xs text-muted-foreground font-mono">{info.value}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Check className="size-4 text-green-500" />
          {info.source !== 'env' && (
            <>
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                Update
              </Button>
              <Button size="icon" variant="ghost" onClick={onRemove} disabled={isRemoving}>
                <Trash2 className="size-4" />
              </Button>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <span className="text-sm font-medium">{metadata.label}</span>
      <div className="flex gap-2">
        <Input
          type={metadata.connectionType === 'apiKey' ? 'password' : 'text'}
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="flex-1 text-sm"
        />
        <Button
          size="sm"
          onClick={() => {
            onSave(value.trim())
            setValue('')
            setEditing(false)
          }}
          disabled={isSaving || !value.trim()}
        >
          Save
        </Button>
        {isSet && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setEditing(false)
              setValue('')
            }}
          >
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}

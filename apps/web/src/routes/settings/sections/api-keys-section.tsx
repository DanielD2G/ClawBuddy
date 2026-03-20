import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useAdminSettings } from '@/hooks/use-admin-settings'
import { Trash2, Eye, EyeOff } from 'lucide-react'
import type { ProviderConnectionInfo, ProviderMetadata } from '@/hooks/use-settings-base'

export function ApiKeysSection() {
  const {
    query: { data, isPending },
    setProviderConnection,
    removeProviderConnection,
  } = useAdminSettings()

  if (isPending) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Provider Connections</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">Loading...</div>
        </CardContent>
      </Card>
    )
  }

  if (!data) return null

  const { providers } = data

  return (
    <Card>
      <CardHeader>
        <CardTitle>Provider Connections</CardTitle>
        <CardDescription>
          Manage provider credentials and local base URLs. Environment values take priority over
          database values.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {Object.entries(providers.metadata).map(([provider, metadata]) => (
          <ApiKeyRow
            key={provider}
            metadata={metadata}
            info={providers.connections[provider]}
            onSave={(value) => setProviderConnection.mutate({ provider, value })}
            onRemove={() => removeProviderConnection.mutate(provider)}
            isSaving={setProviderConnection.isPending}
            isRemoving={removeProviderConnection.isPending}
          />
        ))}
      </CardContent>
    </Card>
  )
}

function ApiKeyRow({
  metadata,
  info,
  onSave,
  onRemove,
  isSaving,
  isRemoving,
}: {
  metadata: ProviderMetadata
  info: ProviderConnectionInfo
  onSave: (value: string) => void
  onRemove: () => void
  isSaving: boolean
  isRemoving: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [showValue, setShowValue] = useState(false)
  const placeholder =
    metadata.connectionType === 'baseUrl'
      ? `Enter ${metadata.label} base URL`
      : `Enter ${metadata.label} API key`

  const handleSave = () => {
    if (!value.trim()) return
    onSave(value.trim())
    setValue('')
    setEditing(false)
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3 md:p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{metadata.label}</span>
          {info.source === 'env' && (
            <Badge variant="secondary" className="text-xs">
              ENV
            </Badge>
          )}
          {info.source === 'db' && (
            <Badge variant="outline" className="text-xs">
              Database
            </Badge>
          )}
          {!info.source && (
            <Badge variant="destructive" className="text-xs">
              Not configured
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          {info.value && (
            <button
              onClick={() => setShowValue(!showValue)}
              className="p-1.5 text-muted-foreground hover:text-foreground rounded-md"
            >
              {showValue ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          )}
          {info.source === 'db' && (
            <button
              onClick={onRemove}
              disabled={isRemoving}
              className="p-1.5 text-muted-foreground hover:text-destructive rounded-md"
            >
              <Trash2 className="size-4" />
            </button>
          )}
        </div>
      </div>

      {info.value && showValue && (
        <p className="text-xs text-muted-foreground font-mono">{info.value}</p>
      )}

      {editing ? (
        <div className="flex gap-2">
          <Input
            type={metadata.connectionType === 'apiKey' ? 'password' : 'text'}
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="flex-1 text-sm"
          />
          <Button size="sm" onClick={handleSave} disabled={isSaving || !value.trim()}>
            Save
          </Button>
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
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="w-fit"
          onClick={() => setEditing(true)}
          disabled={info.source === 'env'}
        >
          {info.source === 'env'
            ? 'Set via environment'
            : info.source === 'db'
              ? 'Update'
              : 'Add connection'}
        </Button>
      )}
    </div>
  )
}

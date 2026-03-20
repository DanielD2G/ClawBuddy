import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useAdminSettings } from '@/hooks/use-admin-settings'
import { Trash2, Eye, EyeOff } from 'lucide-react'
import { PROVIDER_LABELS } from '@/constants'

export function ApiKeysSection() {
  const {
    query: { data, isPending },
    setApiKey,
    removeApiKey,
  } = useAdminSettings()

  if (isPending) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>API Keys</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">Loading...</div>
        </CardContent>
      </Card>
    )
  }

  if (!data) return null

  const { apiKeys } = data

  return (
    <Card>
      <CardHeader>
        <CardTitle>API Keys</CardTitle>
        <CardDescription>
          Manage API keys for each provider. Keys set in the environment take priority over database
          keys.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {['openai', 'gemini', 'claude'].map((provider) => (
          <ApiKeyRow
            key={provider}
            label={PROVIDER_LABELS[provider] ?? provider}
            info={apiKeys[provider]}
            onSave={(key) => setApiKey.mutate({ provider, key })}
            onRemove={() => removeApiKey.mutate(provider)}
            isSaving={setApiKey.isPending}
            isRemoving={removeApiKey.isPending}
          />
        ))}
      </CardContent>
    </Card>
  )
}

function ApiKeyRow({
  label,
  info,
  onSave,
  onRemove,
  isSaving,
  isRemoving,
}: {
  label: string
  info: { source: 'env' | 'db' | null; masked: string | null }
  onSave: (key: string) => void
  onRemove: () => void
  isSaving: boolean
  isRemoving: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [showMasked, setShowMasked] = useState(false)

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
          <span className="text-sm font-medium">{label}</span>
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
          {info.masked && (
            <button
              onClick={() => setShowMasked(!showMasked)}
              className="p-1.5 text-muted-foreground hover:text-foreground rounded-md"
            >
              {showMasked ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
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

      {info.masked && showMasked && (
        <p className="text-xs text-muted-foreground font-mono">{info.masked}</p>
      )}

      {editing ? (
        <div className="flex gap-2">
          <Input
            type="password"
            placeholder={`Enter ${label} API key`}
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
              ? 'Update key'
              : 'Add key'}
        </Button>
      )}
    </div>
  )
}

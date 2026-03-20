import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Eye, EyeOff, Check, Loader2, Pencil, Trash2, XCircle, Zap } from 'lucide-react'
import { apiClient } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import type { ProviderConnectionInfo, ProviderMetadata } from '@/hooks/use-settings-base'

interface ProviderConnectionTestResponse {
  valid: boolean
  reachable: boolean
  llmModels: string[]
  embeddingModels: string[]
  message?: string
}

interface ProviderConnectionRowProps {
  provider: string
  metadata: ProviderMetadata
  info: ProviderConnectionInfo
  onSave: (value: string) => void
  onRemove: () => void
  isSaving: boolean
  isRemoving: boolean
  basePath: string
  variant: 'settings' | 'setup'
}

export function ProviderConnectionRow({
  provider,
  metadata,
  info,
  onSave,
  onRemove,
  isSaving,
  isRemoving,
  basePath,
  variant,
}: ProviderConnectionRowProps) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [showValue, setShowValue] = useState(false)
  const isLocal = provider === 'local'
  const isConfigured = !!info.source
  const setupButtonSize = variant === 'setup' ? 'default' : 'sm'
  const setupActionButtonSize = variant === 'setup' ? 'default' : 'sm'
  const placeholder =
    metadata.connectionType === 'baseUrl'
      ? `Enter ${metadata.label} base URL`
      : `Enter ${metadata.label} API key`

  const testValue = useMemo(() => {
    const trimmedDraft = value.trim()
    if (trimmedDraft) return trimmedDraft
    if (isLocal && info.value && !(info.value.startsWith('****') && info.source !== 'env')) {
      return info.value
    }
    return undefined
  }, [info.source, info.value, isLocal, value])

  const testMutation = useMutation({
    mutationFn: () =>
      apiClient.post<ProviderConnectionTestResponse>(
        `${basePath}/provider-connections/${provider}/test`,
        testValue ? { value: testValue } : {},
      ),
  })

  const modelBadges = useMemo(() => {
    const result = testMutation.data
    if (!result) return []
    return [
      ...result.llmModels,
      ...result.embeddingModels.filter((m) => !result.llmModels.includes(m)),
    ]
  }, [testMutation.data])

  const handleSave = () => {
    const trimmed = value.trim()
    if (!trimmed) return
    onSave(trimmed)
    setValue('')
    setEditing(false)
  }

  const startEditing = () => {
    setEditing(true)
    setShowValue(false)
    setValue('')
    testMutation.reset()
  }

  const cancelEditing = () => {
    setEditing(false)
    setValue('')
    testMutation.reset()
  }

  const testButton =
    isLocal && (testValue || (info.source && info.value)) ? (
      <Button
        size={setupButtonSize}
        variant="outline"
        onClick={() => testMutation.mutate()}
        disabled={testMutation.isPending || isSaving}
      >
        {testMutation.isPending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Zap className="size-3.5" />
        )}
        Test Connection
      </Button>
    ) : null

  const statusBadges = (
    <>
      {info.source === 'env' && (
        <Badge variant="secondary" className="text-xs">
          ENV
        </Badge>
      )}
      {info.source === 'db' && (
        <Badge variant="outline" className="text-xs">
          {provider === 'local' ? 'Configured URL' : 'Database'}
        </Badge>
      )}
      {!info.source && (
        <Badge variant="destructive" className="text-xs">
          Not configured
        </Badge>
      )}
    </>
  )

  const testResult = testMutation.data
  const showEditor =
    info.source === 'env' || variant === 'setup'
      ? editing || !isConfigured || info.source === 'env'
      : editing

  return (
    <div
      className={
        variant === 'settings'
          ? 'flex flex-col gap-3 rounded-lg border p-3 md:p-4'
          : 'flex flex-col gap-2 rounded-md border p-3'
      }
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-medium">{metadata.label}</span>
          {statusBadges}
          {variant === 'setup' && isConfigured && <Check className="size-4 text-green-500" />}
        </div>
        <div className="flex items-center gap-1">
          {variant === 'settings' && info.value && (
            <button
              onClick={() => setShowValue(!showValue)}
              className="rounded-md p-1.5 text-muted-foreground hover:text-foreground"
            >
              {showValue ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          )}
          {isConfigured && info.source !== 'env' && (
            <>
              <button
                onClick={onRemove}
                disabled={isRemoving}
                className="rounded-md p-1.5 text-muted-foreground hover:text-destructive disabled:opacity-50"
              >
                <Trash2 className="size-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {info.value && showValue && variant === 'settings' && (
        <p className="text-xs font-mono text-muted-foreground">{info.value}</p>
      )}

      {variant === 'setup' && isConfigured && !editing && info.value && (
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs font-mono text-muted-foreground">{info.value}</span>
          {info.source !== 'env' && (
            <button
              type="button"
              onClick={startEditing}
              className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:text-foreground"
              aria-label={`Update ${metadata.label}`}
            >
              <Pencil className="size-4" />
            </button>
          )}
        </div>
      )}

      {showEditor && (
        <div className="flex flex-col gap-2">
          {info.source !== 'env' && (
            <div className="flex gap-2">
              <Input
                type={metadata.connectionType === 'apiKey' ? 'password' : 'text'}
                placeholder={placeholder}
                value={value}
                onChange={(e) => {
                  setValue(e.target.value)
                  if (testMutation.isSuccess || testMutation.isError) testMutation.reset()
                }}
                className="flex-1 text-sm"
              />
              <Button
                size={setupActionButtonSize}
                onClick={handleSave}
                disabled={isSaving || !value.trim()}
              >
                Save
              </Button>
              {isConfigured && (
                <Button size={setupActionButtonSize} variant="outline" onClick={cancelEditing}>
                  Cancel
                </Button>
              )}
            </div>
          )}

          {info.source === 'env' && (
            <p className="text-xs text-muted-foreground">
              This connection is managed via environment variables.
            </p>
          )}

          {testButton}
        </div>
      )}

      {variant === 'settings' && !editing && isConfigured && info.source !== 'env' && (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={startEditing}>
            Update
          </Button>
          {testButton}
        </div>
      )}

      {variant === 'settings' && !editing && !isConfigured && info.source !== 'env' && (
        <Button size="sm" variant="outline" className="w-fit" onClick={startEditing}>
          Add connection
        </Button>
      )}

      {variant === 'setup' && !editing && isConfigured && info.source !== 'env' && testButton}
      {variant === 'setup' && !editing && isConfigured && info.source === 'env' && testButton}

      {testMutation.isError && (
        <div className="inline-flex items-center gap-1 text-xs text-destructive">
          <XCircle className="size-3.5" />
          {testMutation.error instanceof Error
            ? testMutation.error.message
            : 'Connection test failed'}
        </div>
      )}

      {testResult && (
        <div className="space-y-2 rounded-md border bg-muted/30 px-3 py-2">
          <div className="flex items-center gap-2 text-xs">
            {testResult.valid ? (
              <Check className="size-3.5 text-green-600" />
            ) : (
              <XCircle className="size-3.5 text-destructive" />
            )}
            <span className={testResult.valid ? 'text-foreground' : 'text-destructive'}>
              {testResult.valid
                ? `Connection OK · ${testResult.llmModels.length} chat / ${testResult.embeddingModels.length} embedding`
                : testResult.message || 'Connection test failed'}
            </span>
          </div>
          {testResult.message && testResult.valid === false && (
            <p className="text-xs text-muted-foreground">{testResult.message}</p>
          )}
          {modelBadges.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {modelBadges.slice(0, 8).map((model) => (
                <Badge key={model} variant="outline" className="font-mono text-[11px]">
                  {model}
                </Badge>
              ))}
              {modelBadges.length > 8 && (
                <Badge variant="outline" className="text-[11px]">
                  +{modelBadges.length - 8} more
                </Badge>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

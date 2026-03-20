import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Check, ChevronRight, ChevronLeft, Loader2, Server } from 'lucide-react'
import { PROVIDER_LABELS } from '@/constants'

interface StepApiKeysProps {
  apiKeys: Record<string, { source: 'env' | 'db' | null; masked: string | null }>
  onSaveKey: (provider: string, key: string) => void
  onSaveLocalUrl: (baseUrl: string) => Promise<void>
  onTestLocal: (baseUrl: string) => Promise<{ reachable: boolean; models?: string[]; error?: string }>
  isSaving: boolean
  canContinue: boolean
  onBack: () => void
  onNext: () => void
}

export function StepApiKeys({
  apiKeys,
  onSaveKey,
  onSaveLocalUrl,
  onTestLocal,
  isSaving,
  canContinue,
  onBack,
  onNext,
}: StepApiKeysProps) {
  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold tracking-tight">API Keys</h2>
        <p className="text-muted-foreground mt-1">
          Add at least one API key for an embedding-capable provider (OpenAI or Gemini).
        </p>
      </div>
      <div className="flex flex-col gap-3">
        {['openai', 'gemini', 'claude'].map((provider) => (
          <ApiKeyInput
            key={provider}
            label={PROVIDER_LABELS[provider] ?? provider}
            info={apiKeys[provider]}
            onSave={(key) => onSaveKey(provider, key)}
            isSaving={isSaving}
          />
        ))}
        <LocalServerInput
          info={apiKeys.local}
          onSave={onSaveLocalUrl}
          onTest={onTestLocal}
          isSaving={isSaving}
        />
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
            Add an OpenAI or Gemini key to continue
          </p>
        )}
      </div>
    </div>
  )
}

function ApiKeyInput({
  label,
  info,
  onSave,
  isSaving,
}: {
  label: string
  info: { source: 'env' | 'db' | null; masked: string | null }
  onSave: (key: string) => void
  isSaving: boolean
}) {
  const [value, setValue] = useState('')
  const isSet = !!info.source

  if (isSet) {
    return (
      <div className="flex items-center justify-between rounded-md border p-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          <Badge variant="secondary" className="text-xs">
            {info.source === 'env' ? 'ENV' : 'Configured'}
          </Badge>
        </div>
        <Check className="size-4 text-green-500" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex gap-2">
        <Input
          type="password"
          placeholder={`Enter ${label} API key`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="flex-1 text-sm"
        />
        <Button
          size="sm"
          onClick={() => {
            onSave(value.trim())
            setValue('')
          }}
          disabled={isSaving || !value.trim()}
        >
          Save
        </Button>
      </div>
    </div>
  )
}

function LocalServerInput({
  info,
  onSave,
  onTest,
  isSaving,
}: {
  info?: { source: 'env' | 'db' | null; masked: string | null }
  onSave: (baseUrl: string) => Promise<void>
  onTest: (baseUrl: string) => Promise<{ reachable: boolean; models?: string[]; error?: string }>
  isSaving: boolean
}) {
  const [url, setUrl] = useState(info?.masked || 'http://localhost:1234')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{
    reachable: boolean
    models?: string[]
    error?: string
  } | null>(null)
  const isSet = !!info?.source

  const handleTest = async () => {
    setTesting(true)
    try {
      const result = await onTest(url.trim())
      setTestResult(result)
      if (result.reachable) {
        await onSave(url.trim())
      }
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <Server className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">Local Models</span>
        {isSet && (
          <Badge variant="secondary" className="text-xs">
            {info?.source === 'env' ? 'ENV' : 'Configured'}
          </Badge>
        )}
        {testResult?.reachable && <Check className="size-4 text-green-500" />}
      </div>
      <p className="text-xs text-muted-foreground">
        Connect to LM Studio, vLLM, or any OpenAI-compatible local server.
      </p>
      <div className="flex gap-2">
        <Input
          type="text"
          placeholder="http://localhost:1234"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value)
            setTestResult(null)
          }}
          className="flex-1 text-sm font-mono"
          disabled={info?.source === 'env'}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={handleTest}
          disabled={isSaving || testing || !url.trim() || info?.source === 'env'}
        >
          {testing && <Loader2 className="size-3.5 mr-1 animate-spin" />}
          Test
        </Button>
      </div>
      {testResult && !testResult.reachable && (
        <p className="text-xs text-destructive">
          Could not connect: {testResult.error || 'Unknown error'}
        </p>
      )}
      {testResult?.reachable && testResult.models && (
        <p className="text-xs text-green-600 dark:text-green-400">
          Connected — {testResult.models.length} model{testResult.models.length !== 1 ? 's' : ''} available
          {testResult.models.length > 0 && testResult.models.length <= 5 && (
            <span className="text-muted-foreground ml-1">
              ({testResult.models.join(', ')})
            </span>
          )}
        </p>
      )}
    </div>
  )
}

import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Check, ChevronRight, ChevronLeft } from 'lucide-react'
import { PROVIDER_LABELS } from '@/constants'

interface StepApiKeysProps {
  apiKeys: Record<string, { source: 'env' | 'db' | null; masked: string | null }>
  onSaveKey: (provider: string, key: string) => void
  isSaving: boolean
  canContinue: boolean
  onBack: () => void
  onNext: () => void
}

export function StepApiKeys({
  apiKeys,
  onSaveKey,
  isSaving,
  canContinue,
  onBack,
  onNext,
}: StepApiKeysProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>API Keys</CardTitle>
        <CardDescription>
          Add at least one API key for an embedding-capable provider (OpenAI or Gemini).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {['openai', 'gemini', 'claude'].map((provider) => (
          <ApiKeyInput
            key={provider}
            provider={provider}
            label={PROVIDER_LABELS[provider] ?? provider}
            info={apiKeys[provider]}
            onSave={(key) => onSaveKey(provider, key)}
            isSaving={isSaving}
          />
        ))}
        <div className="flex justify-between mt-4">
          <Button variant="outline" onClick={onBack}>
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
      </CardContent>
    </Card>
  )
}

function ApiKeyInput({
  provider,
  label,
  info,
  onSave,
  isSaving,
}: {
  provider: string
  label: string
  info: { source: 'env' | 'db' | null; masked: string | null }
  onSave: (key: string) => void
  isSaving: boolean
}) {
  const [value, setValue] = useState('')
  const isSet = !!info.source

  if (isSet) {
    return (
      <div className="flex items-center justify-between rounded-lg border p-3">
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
    <div className="flex flex-col gap-2 rounded-lg border p-3">
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
          onClick={() => { onSave(value.trim()); setValue('') }}
          disabled={isSaving || !value.trim()}
        >
          Save
        </Button>
      </div>
    </div>
  )
}

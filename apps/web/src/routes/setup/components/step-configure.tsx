import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import { ChevronLeft, Check, ChevronsUpDown, Eye, EyeOff } from 'lucide-react'
import type { ConfigFieldDefinition } from '@/types/capability-config'

interface StepConfigureProps {
  capsNeedingConfig: Array<{
    slug: string
    name: string
    configSchema: ConfigFieldDefinition[] | null
  }>
  configs: Record<string, Record<string, unknown>>
  onConfigChange: (slug: string, config: Record<string, unknown>) => void
  onBack: () => void
  onComplete: () => void
  isCompleting: boolean
}

export function StepConfigure({
  capsNeedingConfig,
  configs,
  onConfigChange,
  onBack,
  onComplete,
  isCompleting,
}: StepConfigureProps) {
  const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>({})

  // Pre-populate default values on mount
  useEffect(() => {
    for (const cap of capsNeedingConfig) {
      if (!cap.configSchema) continue
      const existing = configs[cap.slug] ?? {}
      const withDefaults = { ...existing }
      let changed = false
      for (const field of cap.configSchema) {
        if (field.default && withDefaults[field.key] == null) {
          withDefaults[field.key] = field.default
          changed = true
        }
      }
      if (changed) onConfigChange(cap.slug, withDefaults)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const togglePassword = (key: string) => {
    setShowPasswords((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const getFieldValue = (slug: string, key: string): string => {
    const val = configs[slug]?.[key]
    return val != null ? String(val) : ''
  }

  const setFieldValue = (slug: string, key: string, value: string) => {
    onConfigChange(slug, { ...(configs[slug] ?? {}), [key]: value })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Configure Credentials</CardTitle>
        <CardDescription>
          Enter credentials for the capabilities you selected. You can skip this and configure later
          in settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {capsNeedingConfig.map((cap) => (
          <div key={cap.slug} className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold">{cap.name}</h3>
            {cap.configSchema!.map((field) => {
              const fieldKey = `${cap.slug}.${field.key}`
              return (
                <div key={field.key} className="flex flex-col gap-1.5">
                  <label htmlFor={fieldKey} className="text-sm font-medium leading-none">
                    {field.label}
                    {field.required && <span className="ml-0.5 text-destructive">*</span>}
                  </label>
                  {field.description && (
                    <p className="text-xs text-muted-foreground">{field.description}</p>
                  )}
                  {field.type === 'select' && field.options ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="flex w-full items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm hover:bg-muted/70 dark:bg-muted/20 dark:hover:bg-muted/40">
                          <span>{field.options?.find((o) => o.value === getFieldValue(cap.slug, field.key))?.label || 'Select...'}</span>
                          <ChevronsUpDown className="size-4 text-muted-foreground" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        {field.options.map((opt) => (
                          <DropdownMenuItem
                            key={opt.value}
                            onClick={() => setFieldValue(cap.slug, field.key, opt.value)}
                            className="gap-2"
                          >
                            <span className="flex-1">{opt.label}</span>
                            {getFieldValue(cap.slug, field.key) === opt.value && <Check className="size-3.5" />}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : field.type === 'textarea' ? (
                    <textarea
                      id={fieldKey}
                      value={getFieldValue(cap.slug, field.key)}
                      onChange={(e) => setFieldValue(cap.slug, field.key, e.target.value)}
                      placeholder={field.placeholder}
                      rows={4}
                      className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-y"
                    />
                  ) : field.type === 'password' ? (
                    <div className="relative">
                      <Input
                        id={fieldKey}
                        type={showPasswords[fieldKey] ? 'text' : 'password'}
                        value={getFieldValue(cap.slug, field.key)}
                        onChange={(e) => setFieldValue(cap.slug, field.key, e.target.value)}
                        placeholder={field.placeholder}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute top-1/2 right-1 -translate-y-1/2 size-7"
                        onClick={() => togglePassword(fieldKey)}
                      >
                        {showPasswords[fieldKey] ? (
                          <EyeOff className="size-3.5" />
                        ) : (
                          <Eye className="size-3.5" />
                        )}
                      </Button>
                    </div>
                  ) : (
                    <Input
                      id={fieldKey}
                      type="text"
                      value={getFieldValue(cap.slug, field.key)}
                      onChange={(e) => setFieldValue(cap.slug, field.key, e.target.value)}
                      placeholder={field.placeholder}
                    />
                  )}
                </div>
              )
            })}
            {capsNeedingConfig.indexOf(cap) < capsNeedingConfig.length - 1 && (
              <div className="border-t mt-2" />
            )}
          </div>
        ))}
        <div className="flex justify-between mt-2">
          <Button variant="outline" onClick={onBack}>
            <ChevronLeft className="size-4 mr-1" />
            Back
          </Button>
          <Button
            onClick={onComplete}
            disabled={isCompleting}
            className="bg-brand text-brand-foreground hover:bg-brand/90"
          >
            {isCompleting ? <Spinner className="size-4 mr-1" /> : null}
            Complete Setup
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

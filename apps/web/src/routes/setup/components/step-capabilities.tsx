import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import { ChevronRight, ChevronLeft, Info } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { ALWAYS_ON_CAPABILITY_SLUGS, ONBOARDING_UNLOCKABLE_SLUGS } from '@/constants'
import type { ConfigFieldDefinition } from '@/types/capability-config'

const ALWAYS_ON_SLUGS = ALWAYS_ON_CAPABILITY_SLUGS

interface StepCapabilitiesProps {
  capabilities: Array<{ slug: string; name: string; description: string; category: string; configSchema: ConfigFieldDefinition[] | null }>
  selected: string[]
  googleOAuthConfigured: boolean
  onToggle: (slug: string) => void
  onBack: () => void
  onNext: () => void
  isCompleting: boolean
  hasConfigStep: boolean
  browserGridUrl: string
  onBrowserGridUrlChange: (url: string) => void
  browserGridFromEnv: boolean
}

export function StepCapabilities({
  capabilities,
  selected,
  googleOAuthConfigured,
  onToggle,
  onBack,
  onNext,
  isCompleting,
  hasConfigStep,
  browserGridUrl,
  onBrowserGridUrlChange,
  browserGridFromEnv,
}: StepCapabilitiesProps) {
  // Slugs that require Google OAuth env vars
  const OAUTH_GOOGLE_SLUGS = ['google-workspace']

  // Browser health detection
  const { data: browserHealth } = useQuery({
    queryKey: ['browser-health-check'],
    queryFn: () => apiClient.get<{ status: string }>('/browser/health').catch(() => ({ status: 'error' })),
    retry: false,
  })

  const [browserAutoDetected, setBrowserAutoDetected] = useState(false)

  useEffect(() => {
    if (browserHealth && !browserAutoDetected) {
      setBrowserAutoDetected(true)
      if (browserHealth.status === 'ok' || browserHealth.status === 'healthy') {
        if (!selected.includes('browser-automation')) {
          onToggle('browser-automation')
        }
      }
    }
  }, [browserHealth, browserAutoDetected]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Card>
      <CardHeader>
        <CardTitle>Capabilities</CardTitle>
        <CardDescription>
          Select which agent capabilities to enable. You can change these later in settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {capabilities.map((cap) => {
          const isSelected = selected.includes(cap.slug)
          const isAlwaysOn = ALWAYS_ON_SLUGS.includes(cap.slug)
          const isOAuthBlocked = OAUTH_GOOGLE_SLUGS.includes(cap.slug) && !googleOAuthConfigured
          const isUnlockable = ONBOARDING_UNLOCKABLE_SLUGS.includes(cap.slug)
          const isAutoEnabled = !isAlwaysOn && !isUnlockable && !isOAuthBlocked
          const isDisabled = isAlwaysOn || isOAuthBlocked || isAutoEnabled
          const isActive = isSelected || isAlwaysOn || isAutoEnabled

          return (
            <TooltipProvider key={cap.slug}>
              <div
                className={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${
                  isOAuthBlocked
                    ? 'opacity-50 cursor-not-allowed'
                    : isActive
                      ? 'border-brand bg-brand/5'
                      : 'hover:bg-muted/50 cursor-pointer'
                } ${isDisabled ? '' : 'cursor-pointer'}`}
                onClick={() => !isDisabled && onToggle(cap.slug)}
              >
                <input
                  type="checkbox"
                  checked={isActive && !isOAuthBlocked}
                  disabled={isDisabled}
                  onChange={() => {}}
                  className="size-4 rounded border-border accent-brand"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium">{cap.name}</div>
                  <div className="text-xs text-muted-foreground">{cap.description}</div>
                  {isSelected && cap.slug === 'browser-automation' && !browserGridFromEnv && (
                    <div className="mt-2 ml-7">
                      <Input
                        placeholder="http://localhost:9090"
                        value={browserGridUrl}
                        onChange={(e) => onBrowserGridUrlChange(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        className="text-sm"
                      />
                      <p className="text-xs text-muted-foreground mt-1">BrowserGrid server URL</p>
                    </div>
                  )}
                </div>
                {(isAlwaysOn || isAutoEnabled) && (
                  <Badge variant="secondary" className="text-[10px]">
                    Auto
                  </Badge>
                )}
                {isOAuthBlocked && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="size-4 text-muted-foreground shrink-0" />
                    </TooltipTrigger>
                    <TooltipContent side="left" className="max-w-[240px]">
                      <p className="text-xs">
                        Add <code className="bg-muted px-1 rounded">GOOGLE_CLIENT_ID</code> and{' '}
                        <code className="bg-muted px-1 rounded">GOOGLE_CLIENT_SECRET</code> to your environment to enable this capability.
                      </p>
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            </TooltipProvider>
          )
        })}
        <div className="flex justify-between mt-4">
          <Button variant="outline" onClick={onBack}>
            <ChevronLeft className="size-4 mr-1" />
            Back
          </Button>
          <Button
            onClick={onNext}
            disabled={isCompleting}
            className="bg-brand text-brand-foreground hover:bg-brand/90"
          >
            {isCompleting ? <Spinner className="size-4 mr-1" /> : null}
            {hasConfigStep ? (
              <>
                Next
                <ChevronRight className="size-4 ml-1" />
              </>
            ) : (
              'Complete Setup'
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

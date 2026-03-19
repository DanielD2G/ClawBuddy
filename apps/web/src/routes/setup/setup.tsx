import { useState, useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import {
  useSetupStatus,
  useSetupSettings,
  useCompleteSetup,
  useSetupCapabilities,
} from '@/hooks/use-setup'
import { useActiveWorkspace } from '@/providers/workspace-provider'
import { Spinner } from '@/components/ui/spinner'
import {
  Sparkles,
  Key,
  Brain,
  MessageSquare,
  FolderOpen,
  Puzzle,
  Container,
  ShieldCheck,
  Settings,
  Send,
} from 'lucide-react'
import { toast } from 'sonner'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { ALWAYS_ON_CAPABILITY_SLUGS, WORKSPACE_COLORS } from '@/constants'
import { hexToOklch } from '@/lib/color'

import { StepNav } from './components/step-nav'
import { StepWelcome } from './components/step-welcome'
import { StepApiKeys } from './components/step-api-keys'
import { StepEmbedding } from './components/step-embedding'
import { StepChatModel } from './components/step-chat-model'
import { StepWorkspace } from './components/step-workspace'
import { StepCapabilities } from './components/step-capabilities'
import { StepDockerImages } from './components/step-docker'
import { StepConfigure } from './components/step-configure'
import { StepPreflight } from './components/step-preflight'
import { StepChannels } from './components/step-channels'

const ALL_STEPS = [
  { label: 'Welcome', icon: Sparkles },
  { label: 'API Keys', icon: Key },
  { label: 'Embeddings', icon: Brain },
  { label: 'Chat', icon: MessageSquare },
  { label: 'Workspace', icon: FolderOpen },
  { label: 'Capabilities', icon: Puzzle },
  { label: 'Channels', icon: Send },
  { label: 'Docker', icon: Container },
  { label: 'Preflight', icon: ShieldCheck },
  { label: 'Configure', icon: Settings },
]

export function SetupPage() {
  const queryClient = useQueryClient()
  const { onboardingComplete, isLoading: statusLoading } = useSetupStatus()
  const [step, setStep] = useState(0)
  const [selectedCapabilities, setSelectedCapabilities] = useState<string[]>([
    ...ALWAYS_ON_CAPABILITY_SLUGS,
  ])
  const [capabilityConfigs, setCapabilityConfigs] = useState<
    Record<string, Record<string, unknown>>
  >({})
  const [workspaceName, setWorkspaceName] = useState('Default')
  const [workspaceColor, setWorkspaceColor] = useState(WORKSPACE_COLORS[0])
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [browserGridUrl, setBrowserGridUrl] = useState('http://localhost:9090')
  const [telegramEnabled, setTelegramEnabled] = useState(false)
  const [telegramToken, setTelegramToken] = useState('')
  const [telegramTokenTested, setTelegramTokenTested] = useState(false)
  const { setActiveWorkspace } = useActiveWorkspace()
  // Sync picked workspace color to CSS --brand variable in real time
  useEffect(() => {
    document.documentElement.style.setProperty('--brand', hexToOklch(workspaceColor))
  }, [workspaceColor])

  const {
    query: { data, isPending },
    updateProviders,
    setApiKey,
  } = useSetupSettings()
  const { data: capabilities } = useSetupCapabilities()
  const completeSetup = useCompleteSetup()

  // Check if Google OAuth credentials are configured via env vars
  const { data: googleOAuthConfig } = useQuery({
    queryKey: ['google-oauth-config'],
    queryFn: () => apiClient.get<{ configured: boolean }>('/setup/google-oauth'),
  })
  const googleOAuthConfigured = googleOAuthConfig?.configured ?? false

  const importMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      apiClient.post<{
        workspace: {
          name: string
          description: string | null
          color: string | null
          autoExecute: boolean
          settings: Record<string, unknown> | null
          permissions: { allow: string[] } | null
        }
        capabilities: Array<{
          slug: string
          enabled: boolean
          config: Record<string, unknown> | null
        }>
        channels: Array<{
          type: string
          name: string
          enabled: boolean
          config: Record<string, unknown>
        }>
        modelConfig: Record<string, unknown>
      }>('/setup/import', data),
  })

  const handleImport = async (data: Record<string, unknown>) => {
    try {
      const result = await importMutation.mutateAsync(data)
      // Pre-fill workspace settings
      if (result.workspace.name) setWorkspaceName(result.workspace.name)
      if (result.workspace.color) setWorkspaceColor(result.workspace.color)
      // Pre-fill capabilities
      const enabledSlugs = result.capabilities.filter((c) => c.enabled).map((c) => c.slug)
      setSelectedCapabilities((prev) => [...new Set([...prev, ...enabledSlugs])])
      // Pre-fill capability configs
      const configs: Record<string, Record<string, unknown>> = {}
      for (const cap of result.capabilities) {
        if (cap.config) configs[cap.slug] = cap.config
      }
      setCapabilityConfigs((prev) => ({ ...prev, ...configs }))
      // Pre-fill Telegram
      const telegramChannel = result.channels.find((ch) => ch.type === 'telegram')
      if (telegramChannel?.config?.botToken) {
        setTelegramEnabled(true)
        setTelegramToken(telegramChannel.config.botToken as string)
      }
      // Pre-fill timezone
      if (result.modelConfig.timezone) {
        setTimezone(result.modelConfig.timezone as string)
      }
      // Invalidate setup-settings so Embeddings/Chat steps fetch updated model config
      await queryClient.invalidateQueries({ queryKey: ['setup-settings'] })
      toast.success('Configuration imported — review each step and enter your API keys')
      setStep(1) // Go to API Keys step
    } catch {
      toast.error('Failed to import — check that the file is a valid workspace export')
    }
  }

  // Redirect if setup already done
  if (!statusLoading && onboardingComplete === true) {
    return <Navigate to="/" replace />
  }

  if (statusLoading || isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Spinner className="text-brand" />
      </div>
    )
  }

  if (!data) return null

  const { providers, apiKeys, browserGridFromEnv } = data
  const hasEmbeddingKey = providers.available.embedding.length > 0

  // Capabilities that need config and are selected (exclude OAuth capabilities — configured post-setup via OAuth flow)
  const OAUTH_CAPABILITY_SLUGS = ['google-workspace']
  const capsNeedingConfig = (capabilities ?? []).filter(
    (c) =>
      selectedCapabilities.includes(c.slug) &&
      c.configSchema &&
      c.configSchema.length > 0 &&
      !OAUTH_CAPABILITY_SLUGS.includes(c.slug),
  )
  const hasConfigStep = capsNeedingConfig.length > 0

  // Show Configure step only when needed (Docker step is always shown)
  const visibleSteps = hasConfigStep ? ALL_STEPS : ALL_STEPS.filter((s) => s.label !== 'Configure')

  const handleComplete = async () => {
    try {
      const configs = { ...capabilityConfigs }
      if (selectedCapabilities.includes('browser-automation') && browserGridUrl) {
        configs['browser-automation'] = {
          ...configs['browser-automation'],
          BROWSER_GRID_URL: browserGridUrl,
        }
      }
      const result = await completeSetup.mutateAsync({
        capabilities: selectedCapabilities,
        capabilityConfigs: configs,
        workspaceName,
        workspaceColor,
        timezone,
        ...(telegramEnabled && telegramToken.trim()
          ? { telegramBotToken: telegramToken.trim(), telegramTokenTested }
          : {}),
      })
      if (result.workspace) {
        setActiveWorkspace(result.workspace)
      }
      toast.success('Setup complete!')
      // Full reload so workspace color and all fresh state are applied
      window.location.href = '/'
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Setup failed')
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-lg px-4 py-8">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2 mb-2">
            <span className="size-2.5 rounded-full bg-brand" />
            <span className="text-lg font-semibold tracking-tight">ClawBuddy</span>
          </div>
          <p className="text-sm text-muted-foreground">Initial setup</p>
        </div>

        <StepNav visibleSteps={visibleSteps} currentStep={step} />

        {/* Steps */}
        {step === 0 && (
          <StepWelcome
            onNext={() => setStep(1)}
            onImport={handleImport}
            isImporting={importMutation.isPending}
          />
        )}
        {step === 1 && (
          <StepApiKeys
            apiKeys={apiKeys}
            onSaveKey={(provider, key) => setApiKey.mutate({ provider, key })}
            isSaving={setApiKey.isPending}
            canContinue={hasEmbeddingKey}
            onBack={() => setStep(0)}
            onNext={() => setStep(2)}
          />
        )}
        {step === 2 && (
          <StepEmbedding
            providers={providers}
            onUpdate={updateProviders.mutate}
            isUpdating={updateProviders.isPending}
            onBack={() => setStep(1)}
            onNext={() => setStep(3)}
          />
        )}
        {step === 3 && (
          <StepChatModel
            providers={providers}
            onUpdate={updateProviders.mutate}
            isUpdating={updateProviders.isPending}
            onBack={() => setStep(2)}
            onNext={() => setStep(4)}
          />
        )}
        {step === 4 && (
          <StepWorkspace
            name={workspaceName}
            color={workspaceColor}
            timezone={timezone}
            onNameChange={setWorkspaceName}
            onColorChange={setWorkspaceColor}
            onTimezoneChange={setTimezone}
            onBack={() => setStep(3)}
            onNext={() => setStep(5)}
          />
        )}
        {step === 5 && (
          <StepCapabilities
            capabilities={capabilities ?? []}
            selected={selectedCapabilities}
            googleOAuthConfigured={googleOAuthConfigured}
            onToggle={(slug) => {
              setSelectedCapabilities((prev) =>
                prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
              )
            }}
            onBack={() => setStep(4)}
            onNext={() => setStep(6)}
            isCompleting={false}
            hasConfigStep={true}
            browserGridUrl={browserGridUrl}
            onBrowserGridUrlChange={setBrowserGridUrl}
            browserGridFromEnv={browserGridFromEnv ?? false}
          />
        )}
        {step === 6 && (
          <StepChannels
            telegramEnabled={telegramEnabled}
            telegramToken={telegramToken}
            telegramTokenTested={telegramTokenTested}
            onTelegramEnabledChange={setTelegramEnabled}
            onTelegramTokenChange={(token) => {
              setTelegramToken(token)
              setTelegramTokenTested(false)
            }}
            onTokenTested={setTelegramTokenTested}
            onBack={() => setStep(5)}
            onNext={() => setStep(7)}
          />
        )}
        {step === 7 && (
          <StepDockerImages
            onBack={() => setStep(6)}
            onNext={() => setStep(8)}
            isCompleting={false}
            hasConfigStep={true}
          />
        )}
        {step === 8 && (
          <StepPreflight
            capabilities={selectedCapabilities}
            browserGridUrl={browserGridUrl}
            onBack={() => setStep(7)}
            onNext={() => {
              if (hasConfigStep) {
                setStep(9)
              } else {
                handleComplete()
              }
            }}
            isCompleting={!hasConfigStep && completeSetup.isPending}
            hasConfigStep={hasConfigStep}
          />
        )}
        {step === 9 && (
          <StepConfigure
            capsNeedingConfig={capsNeedingConfig}
            configs={capabilityConfigs}
            onConfigChange={(slug, config) => {
              setCapabilityConfigs((prev) => ({ ...prev, [slug]: config }))
            }}
            onBack={() => setStep(8)}
            onComplete={handleComplete}
            isCompleting={completeSetup.isPending}
          />
        )}
      </div>
    </div>
  )
}

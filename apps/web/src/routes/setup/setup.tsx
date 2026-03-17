import { useState, useEffect } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useSetupStatus, useSetupSettings, useCompleteSetup, useSetupCapabilities } from '@/hooks/use-setup'
import { useActiveWorkspace } from '@/providers/workspace-provider'
import { Spinner } from '@/components/ui/spinner'
import { Sparkles, Key, Brain, MessageSquare, FolderOpen, Puzzle, Container, ShieldCheck, Settings } from 'lucide-react'
import { toast } from 'sonner'
import { useQuery } from '@tanstack/react-query'
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

const ALL_STEPS = [
  { label: 'Welcome', icon: Sparkles },
  { label: 'API Keys', icon: Key },
  { label: 'Embeddings', icon: Brain },
  { label: 'Chat', icon: MessageSquare },
  { label: 'Workspace', icon: FolderOpen },
  { label: 'Capabilities', icon: Puzzle },
  { label: 'Docker', icon: Container },
  { label: 'Preflight', icon: ShieldCheck },
  { label: 'Configure', icon: Settings },
]

export function SetupPage() {
  const { onboardingComplete, isLoading: statusLoading } = useSetupStatus()
  const [step, setStep] = useState(0)
  const [selectedCapabilities, setSelectedCapabilities] = useState<string[]>([...ALWAYS_ON_CAPABILITY_SLUGS])
  const [capabilityConfigs, setCapabilityConfigs] = useState<Record<string, Record<string, unknown>>>({})
  const [workspaceName, setWorkspaceName] = useState('Default')
  const [workspaceColor, setWorkspaceColor] = useState(WORKSPACE_COLORS[0])
  const [browserGridUrl, setBrowserGridUrl] = useState('http://localhost:9090')
  const { setActiveWorkspace } = useActiveWorkspace()
  const navigate = useNavigate()
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
    (c) => selectedCapabilities.includes(c.slug) && c.configSchema && c.configSchema.length > 0 && !OAUTH_CAPABILITY_SLUGS.includes(c.slug),
  )
  const hasConfigStep = capsNeedingConfig.length > 0

  // Show Configure step only when needed (Docker step is always shown)
  const visibleSteps = hasConfigStep ? ALL_STEPS : ALL_STEPS.filter(s => s.label !== 'Configure')

  const handleComplete = async () => {
    try {
      const configs = { ...capabilityConfigs }
      if (selectedCapabilities.includes('browser-automation') && browserGridUrl) {
        configs['browser-automation'] = { ...configs['browser-automation'], BROWSER_GRID_URL: browserGridUrl }
      }
      const result = await completeSetup.mutateAsync({
        capabilities: selectedCapabilities,
        capabilityConfigs: configs,
        workspaceName,
        workspaceColor,
      })
      if (result.workspace) {
        setActiveWorkspace(result.workspace)
      }
      toast.success('Setup complete!')
      navigate('/')
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
            <span className="text-lg font-semibold tracking-tight">AgentBuddy</span>
          </div>
          <p className="text-sm text-muted-foreground">Initial setup</p>
        </div>

        <StepNav visibleSteps={visibleSteps} currentStep={step} />

        {/* Steps */}
        {step === 0 && <StepWelcome onNext={() => setStep(1)} />}
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
            onNameChange={setWorkspaceName}
            onColorChange={setWorkspaceColor}
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
          <StepDockerImages
            onBack={() => setStep(5)}
            onNext={() => setStep(7)}
            isCompleting={false}
            hasConfigStep={true}
          />
        )}
        {step === 7 && (
          <StepPreflight
            capabilities={selectedCapabilities}
            browserGridUrl={browserGridUrl}
            onBack={() => setStep(6)}
            onNext={() => {
              if (hasConfigStep) {
                setStep(8)
              } else {
                handleComplete()
              }
            }}
            isCompleting={!hasConfigStep && completeSetup.isPending}
            hasConfigStep={hasConfigStep}
          />
        )}
        {step === 8 && (
          <StepConfigure
            capsNeedingConfig={capsNeedingConfig}
            configs={capabilityConfigs}
            onConfigChange={(slug, config) => {
              setCapabilityConfigs((prev) => ({ ...prev, [slug]: config }))
            }}
            onBack={() => setStep(7)}
            onComplete={handleComplete}
            isCompleting={completeSetup.isPending}
          />
        )}
      </div>
    </div>
  )
}

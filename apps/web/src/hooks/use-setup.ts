import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import type { Workspace } from '@/hooks/use-workspaces'
import type { ConfigFieldDefinition } from '@/types/capability-config'

interface SetupStatus {
  onboardingComplete: boolean
}

export function useSetupStatus() {
  const query = useQuery({
    queryKey: ['setup-status'],
    queryFn: () => apiClient.get<SetupStatus>('/setup/status'),
  })

  return {
    onboardingComplete: query.data?.onboardingComplete ?? null,
    isLoading: query.isLoading,
  }
}

export function useCompleteSetup() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: {
      capabilities?: string[]
      capabilityConfigs?: Record<string, Record<string, unknown>>
      workspaceName?: string
      workspaceColor?: string
    }) =>
      apiClient.post<{ onboardingComplete: boolean; workspace?: Workspace }>('/setup/complete', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['setup-status'] })
    },
  })
}

export interface SetupCapability {
  slug: string
  name: string
  description: string
  category: string
  configSchema: ConfigFieldDefinition[] | null
}

export function useSetupCapabilities() {
  return useQuery({
    queryKey: ['setup-capabilities'],
    queryFn: () => apiClient.get<SetupCapability[]>('/setup/capabilities'),
  })
}

// Settings hook — uses public /setup/* endpoints (no auth required)
interface SetupSettingsData {
  providers: {
    active: {
      llm: string
      llmModel: string | null
      embedding: string
      embeddingModel: string | null
    }
    available: { llm: string[]; embedding: string[] }
    models: {
      llm: Record<string, string[]>
      embedding: Record<string, string[]>
    }
  }
  apiKeys: Record<string, { source: 'env' | 'db' | null; masked: string | null }>
}

export function useSetupSettings() {
  const queryClient = useQueryClient()
  const queryKey = ['setup-settings']

  const query = useQuery({
    queryKey,
    queryFn: () => apiClient.get<SetupSettingsData>('/setup/settings'),
  })

  const updateProviders = useMutation({
    mutationFn: (data: { llm?: string; llmModel?: string; embedding?: string; embeddingModel?: string }) =>
      apiClient.patch('/setup/settings', data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  })

  const setApiKey = useMutation({
    mutationFn: ({ provider, key }: { provider: string; key: string }) =>
      apiClient.put(`/setup/api-keys/${provider}`, { key }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  })

  return { query, updateProviders, setApiKey }
}

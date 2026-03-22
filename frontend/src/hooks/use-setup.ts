import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import type { Workspace } from '@/hooks/use-workspaces'
import type { ConfigFieldDefinition } from '@/types/capability-config'
import { createSettingsHook } from './use-settings-base'

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
      timezone?: string
      telegramBotToken?: string
      telegramTokenTested?: boolean
      // Chat model config
      llm?: string
      llmModel?: string | null
      mediumModel?: string | null
      lightModel?: string | null
      exploreModel?: string | null
      executeModel?: string | null
      titleModel?: string | null
      compactModel?: string | null
      advancedModelConfig?: boolean
      roleProviders?: Record<string, string>
    }) =>
      apiClient.post<{ onboardingComplete: boolean; workspace?: Workspace }>(
        '/setup/complete',
        data,
      ),
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
export const useSetupSettings = createSettingsHook({
  queryKey: 'setup-settings',
  basePath: '/setup',
})

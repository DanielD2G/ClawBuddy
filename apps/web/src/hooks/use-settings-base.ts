import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'

export interface ProviderMetadata {
  label: string
  connectionType: 'apiKey' | 'baseUrl'
  supports: {
    llm: boolean
    embedding: boolean
  }
}

export interface ProviderConnectionInfo {
  source: 'env' | 'db' | null
  value: string | null
}

export interface SettingsData {
  providers: {
    metadata: Record<string, ProviderMetadata>
    connections: Record<string, ProviderConnectionInfo>
    active: {
      llm: string
      llmModel: string | null
      mediumModel: string | null
      lightModel: string | null
      exploreModel: string | null
      executeModel: string | null
      titleModel: string | null
      compactModel: string | null
      advancedModelConfig: boolean
      roleProviders: Record<string, string>
      embedding: string
      embeddingModel: string | null
      localBaseUrl: string | null
    }
    available: { llm: string[]; embedding: string[] }
    models: {
      llm: Record<string, string[]>
      embedding: Record<string, string[]>
    }
  }
  onboardingComplete?: boolean
  browserGridFromEnv?: boolean
}

interface SettingsHookOptions {
  queryKey: string
  basePath: string
}

export function createSettingsHook(options: SettingsHookOptions) {
  return function useSettings() {
    const queryClient = useQueryClient()
    const queryKey = [options.queryKey]

    const query = useQuery({
      queryKey,
      queryFn: () => apiClient.get<SettingsData>(`${options.basePath}/settings`),
    })

    const updateProviders = useMutation({
      mutationFn: (data: {
        llm?: string
        llmModel?: string
        mediumModel?: string
        lightModel?: string
        exploreModel?: string
        executeModel?: string
        titleModel?: string
        compactModel?: string
        embedding?: string
        embeddingModel?: string
        advancedModelConfig?: boolean
        roleProviders?: Record<string, string>
      }) => apiClient.patch(`${options.basePath}/settings`, data),
      onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    })

    const setProviderConnection = useMutation({
      mutationFn: ({ provider, value }: { provider: string; value: string }) =>
        apiClient.put(`${options.basePath}/provider-connections/${provider}`, { value }),
      onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    })

    const removeProviderConnection = useMutation({
      mutationFn: (provider: string) =>
        apiClient.delete(`${options.basePath}/provider-connections/${provider}`),
      onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    })

    return { query, updateProviders, setProviderConnection, removeProviderConnection }
  }
}

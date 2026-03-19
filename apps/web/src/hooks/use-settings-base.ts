import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'

export interface SettingsData {
  providers: {
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
        embedding?: string
        embeddingModel?: string
      }) => apiClient.patch(`${options.basePath}/settings`, data),
      onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    })

    const setApiKey = useMutation({
      mutationFn: ({ provider, key }: { provider: string; key: string }) =>
        apiClient.put(`${options.basePath}/api-keys/${provider}`, { key }),
      onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    })

    const removeApiKey = useMutation({
      mutationFn: (provider: string) =>
        apiClient.delete(`${options.basePath}/api-keys/${provider}`),
      onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    })

    return { query, updateProviders, setApiKey, removeApiKey }
  }
}

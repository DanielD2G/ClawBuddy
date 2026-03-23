import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import type {
  ProviderConnectionInfo,
  ProviderConnectionsMutationResponse,
  ProviderMetadata,
} from './use-settings-base'

export interface ProvidersData {
  metadata: Record<string, ProviderMetadata>
  connections: Record<string, ProviderConnectionInfo>
  available: { llm: string[]; embedding: string[] }
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
  models: {
    llm: Record<string, string[]>
    embedding: Record<string, string[]>
  }
}

export function useGlobalProviders() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: () => apiClient.get<ProvidersData>('/global-settings/providers'),
  })
}

export function useSetGlobalProviderConnection() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ provider, value }: { provider: string; value: string }) =>
      apiClient.put<ProviderConnectionsMutationResponse>(
        `/global-settings/provider-connections/${provider}`,
        {
          value,
        },
      ),
    onSuccess: (data) => {
      queryClient.setQueryData<ProvidersData | undefined>(['providers'], (current) =>
        current
          ? {
              ...current,
              ...(data.providers ? data.providers : {}),
            }
          : current,
      )
      queryClient.invalidateQueries({ queryKey: ['providers'] })
      queryClient.invalidateQueries({ queryKey: ['model-config'] })
    },
  })
}

export function useRemoveGlobalProviderConnection() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (provider: string) =>
      apiClient.delete<ProviderConnectionsMutationResponse>(
        `/global-settings/provider-connections/${provider}`,
      ),
    onSuccess: (data) => {
      queryClient.setQueryData<ProvidersData | undefined>(['providers'], (current) =>
        current
          ? {
              ...current,
              ...(data.providers ? data.providers : {}),
            }
          : current,
      )
      queryClient.invalidateQueries({ queryKey: ['providers'] })
      queryClient.invalidateQueries({ queryKey: ['model-config'] })
    },
  })
}

export const useProviders = useGlobalProviders
export const useSetProviderConnection = useSetGlobalProviderConnection
export const useRemoveProviderConnection = useRemoveGlobalProviderConnection

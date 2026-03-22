import { useQuery } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import type { ProviderConnectionInfo, ProviderMetadata } from './use-settings-base'

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

export function useProviders() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: () => apiClient.get<ProvidersData>('/settings/providers'),
  })
}

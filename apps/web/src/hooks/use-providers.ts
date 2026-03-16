import { useQuery } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'

interface ProvidersData {
  available: { llm: string[]; embedding: string[] }
  active: {
    llm: string
    llmModel: string | null
    embedding: string
    embeddingModel: string | null
  }
}

export function useProviders() {
  return useQuery({
    queryKey: ['providers'],
    queryFn: () => apiClient.get<ProvidersData>('/settings/providers'),
  })
}

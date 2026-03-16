import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'

interface AdminSettingsData {
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
  onboardingComplete: boolean
}

export function useAdminSettings() {
  const queryClient = useQueryClient()
  const queryKey = ['admin-settings']

  const query = useQuery({
    queryKey,
    queryFn: () => apiClient.get<AdminSettingsData>('/admin/settings'),
  })

  const updateProviders = useMutation({
    mutationFn: (data: { llm?: string; llmModel?: string; embedding?: string; embeddingModel?: string }) =>
      apiClient.patch('/admin/settings', data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  })

  const setApiKey = useMutation({
    mutationFn: ({ provider, key }: { provider: string; key: string }) =>
      apiClient.put(`/admin/api-keys/${provider}`, { key }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  })

  const removeApiKey = useMutation({
    mutationFn: (provider: string) =>
      apiClient.delete(`/admin/api-keys/${provider}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  })

  return { query, updateProviders, setApiKey, removeApiKey }
}

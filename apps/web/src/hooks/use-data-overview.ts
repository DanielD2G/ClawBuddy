import { useQuery } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'

interface SettingsStats {
  workspaces: number
  documents: number
  conversations: number
}

interface SettingsWorkspace {
  id: string
  name: string
  description: string | null
  createdAt: string
  _count: {
    documents: number
    chatSessions: number
  }
}

interface SettingsDocument {
  id: string
  title: string
  status: string
  type: string
  chunkCount: number
  createdAt: string
  workspace: {
    id: string
    name: string
  }
}

interface SettingsConversation {
  id: string
  title: string | null
  createdAt: string
  workspace: {
    id: string
    name: string
  } | null
  _count: {
    messages: number
  }
}

interface PaginatedParams {
  page?: number
  limit?: number
  search?: string
}

function buildQuery(params: Record<string, string | number | undefined> | PaginatedParams) {
  const searchParams = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '') {
      searchParams.set(key, String(value))
    }
  })

  const query = searchParams.toString()
  return query ? `?${query}` : ''
}

export function useDataStats() {
  return useQuery({
    queryKey: ['data-stats'],
    queryFn: () => apiClient.get<SettingsStats>('/data/stats'),
  })
}

export function useDataWorkspaces(params: PaginatedParams = {}) {
  return useQuery({
    queryKey: ['data-workspaces', params],
    queryFn: () =>
      apiClient.get<{
        workspaces: SettingsWorkspace[]
        total: number
        page: number
        limit: number
      }>(`/data/workspaces${buildQuery(params)}`),
  })
}

export function useDataDocuments(params: PaginatedParams & { status?: string } = {}) {
  return useQuery({
    queryKey: ['data-documents', params],
    queryFn: () =>
      apiClient.get<{
        documents: SettingsDocument[]
        total: number
        page: number
        limit: number
      }>(`/data/documents${buildQuery(params)}`),
  })
}

export function useDataConversations(params: PaginatedParams = {}) {
  return useQuery({
    queryKey: ['data-conversations', params],
    queryFn: () =>
      apiClient.get<{
        conversations: SettingsConversation[]
        total: number
        page: number
        limit: number
      }>(`/data/conversations${buildQuery(params)}`),
  })
}

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { POLL_CRON_JOBS_MS } from '@/constants'

interface AdminStats {
  workspaces: number
  documents: number
  conversations: number
}

interface AdminWorkspace {
  id: string
  name: string
  description: string | null
  createdAt: string
  _count: { documents: number; chatSessions: number }
}

interface AdminDocument {
  id: string
  title: string
  status: string
  type: string
  chunkCount: number
  createdAt: string
  workspace: { id: string; name: string }
}

interface AdminConversation {
  id: string
  title: string | null
  createdAt: string
  workspace: { id: string; name: string }
  _count: { messages: number }
}

interface PaginatedParams {
  page?: number
  limit?: number
  search?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildQuery(params: any) {
  const parts: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') parts.push(`${key}=${encodeURIComponent(String(value))}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

export function useAdminStats() {
  return useQuery({
    queryKey: ['admin-stats'],
    queryFn: () => apiClient.get<AdminStats>('/admin/stats'),
  })
}

export function useAdminWorkspaces(params: PaginatedParams = {}) {
  return useQuery({
    queryKey: ['admin-workspaces', params],
    queryFn: () =>
      apiClient.get<{ workspaces: AdminWorkspace[]; total: number; page: number; limit: number }>(
        `/admin/workspaces${buildQuery(params)}`,
      ),
  })
}

export function useAdminDocuments(params: PaginatedParams & { status?: string } = {}) {
  return useQuery({
    queryKey: ['admin-documents', params],
    queryFn: () =>
      apiClient.get<{ documents: AdminDocument[]; total: number; page: number; limit: number }>(
        `/admin/documents${buildQuery(params)}`,
      ),
  })
}

export function useAdminConversations(params: PaginatedParams = {}) {
  return useQuery({
    queryKey: ['admin-conversations', params],
    queryFn: () =>
      apiClient.get<{ conversations: AdminConversation[]; total: number; page: number; limit: number }>(
        `/admin/conversations${buildQuery(params)}`,
      ),
  })
}

// ── Cron Jobs ─────────────────────────────────────

export interface AdminCronJob {
  id: string
  name: string
  description: string | null
  schedule: string
  type: string
  handler: string | null
  prompt: string | null
  workspaceId: string | null
  sessionId: string | null
  enabled: boolean
  builtin: boolean
  lastRunAt: string | null
  lastRunStatus: string | null
  lastRunError: string | null
  createdAt: string
  updatedAt: string
}

export function useAdminCronJobs() {
  return useQuery({
    queryKey: ['admin-cron-jobs'],
    queryFn: () => apiClient.get<AdminCronJob[]>('/admin/cron'),
    refetchInterval: POLL_CRON_JOBS_MS,
  })
}

export function useCreateCronJob() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { name: string; schedule: string; type: string; prompt?: string; description?: string }) =>
      apiClient.post('/admin/cron', data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-cron-jobs'] }),
  })
}

export function useUpdateCronJob() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; name?: string; schedule?: string; prompt?: string; description?: string }) =>
      apiClient.patch(`/admin/cron/${id}`, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-cron-jobs'] }),
  })
}

export function useDeleteCronJob() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/admin/cron/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-cron-jobs'] }),
  })
}

export function useToggleCronJob() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiClient.patch(`/admin/cron/${id}/toggle`, { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-cron-jobs'] }),
  })
}

export function useTriggerCronJob() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiClient.post(`/admin/cron/${id}/trigger`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-cron-jobs'] }),
  })
}

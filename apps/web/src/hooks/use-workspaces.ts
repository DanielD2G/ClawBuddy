import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { WorkspaceSettings } from '@agentbuddy/shared'
import { apiClient } from '@/lib/api-client'
import { useActiveWorkspace } from '@/providers/workspace-provider'
import { POLL_CONTAINER_STATUS_MS } from '@/constants'

export interface Workspace {
  id: string
  name: string
  description: string | null
  permissions: { allow?: string[] } | null
  color: string | null
  settings: WorkspaceSettings | null
  autoExecute: boolean
  containerId: string | null
  containerStatus: string
  createdAt: string
  updatedAt: string
}

export function useWorkspaces() {
  return useQuery({
    queryKey: ['workspaces'],
    queryFn: () => apiClient.get<Workspace[]>('/workspaces'),
  })
}

export function useWorkspace(id: string) {
  return useQuery({
    queryKey: ['workspaces', id],
    queryFn: () => apiClient.get<Workspace>(`/workspaces/${id}`),
    enabled: !!id,
  })
}

export function useCreateWorkspace() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { name: string; description?: string; color?: string }) =>
      apiClient.post<Workspace>('/workspaces', data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workspaces'] }),
  })
}

export function useUpdateWorkspace() {
  const queryClient = useQueryClient()
  const { activeWorkspace, setActiveWorkspace } = useActiveWorkspace()
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; name?: string; description?: string; color?: string; settings?: WorkspaceSettings; autoExecute?: boolean }) =>
      apiClient.patch<Workspace>(`/workspaces/${id}`, data),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ['workspaces'] })
      if (activeWorkspace && updated.id === activeWorkspace.id) {
        setActiveWorkspace(updated)
      }
    },
  })
}

export function useDeleteWorkspace() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/workspaces/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workspaces'] }),
  })
}

export function useWorkspaceContainerStatus(id: string) {
  return useQuery({
    queryKey: ['workspaces', id, 'container'],
    queryFn: () => apiClient.get<{ status: string; containerId: string | null }>(`/workspaces/${id}/container/status`),
    enabled: !!id,
    refetchInterval: POLL_CONTAINER_STATUS_MS,
  })
}

export function useStartWorkspaceContainer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiClient.post(`/workspaces/${id}/container/start`),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['workspaces', id, 'container'] })
      queryClient.invalidateQueries({ queryKey: ['workspaces', id] })
    },
  })
}

export function useStopWorkspaceContainer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiClient.post(`/workspaces/${id}/container/stop`),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['workspaces', id, 'container'] })
      queryClient.invalidateQueries({ queryKey: ['workspaces', id] })
    },
  })
}

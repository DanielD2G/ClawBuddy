import { useQuery } from '@tanstack/react-query'
import type { WorkspaceSettings } from '@agentbuddy/shared'
import { apiClient } from '@/lib/api-client'
import { useActiveWorkspace } from '@/providers/workspace-provider'
import { POLL_CONTAINER_STATUS_MS } from '@/constants'
import { createMutation, createMutationWithContext, createCustomMutation } from './create-mutation'

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

export const useCreateWorkspace = createMutation<
  Workspace,
  { name: string; description?: string; color?: string }
>('post', '/workspaces', [['workspaces']])

export const useUpdateWorkspace = createMutationWithContext<
  Workspace,
  {
    id: string
    name?: string
    description?: string
    color?: string
    settings?: WorkspaceSettings
    autoExecute?: boolean
  }
>(
  'patch',
  ({ id }) => `/workspaces/${id}`,
  [['workspaces']],
  () => {
    const { activeWorkspace, setActiveWorkspace } = useActiveWorkspace()
    return (updated) => {
      if (activeWorkspace && updated.id === activeWorkspace.id) {
        setActiveWorkspace(updated)
      }
    }
  },
)

export const useDeleteWorkspace = createMutation<unknown, string>(
  'delete',
  (id) => `/workspaces/${id}`,
  [['workspaces']],
)

export function useWorkspaceContainerStatus(id: string) {
  return useQuery({
    queryKey: ['workspaces', id, 'container'],
    queryFn: () =>
      apiClient.get<{ status: string; containerId: string | null }>(
        `/workspaces/${id}/container/status`,
      ),
    enabled: !!id,
    refetchInterval: POLL_CONTAINER_STATUS_MS,
  })
}

export const useStartWorkspaceContainer = createMutation<unknown, string>(
  'post',
  (id) => `/workspaces/${id}/container/start`,
  (_, id) => [
    ['workspaces', id, 'container'],
    ['workspaces', id],
  ],
)

export const useStopWorkspaceContainer = createMutation<unknown, string>(
  'post',
  (id) => `/workspaces/${id}/container/stop`,
  (_, id) => [
    ['workspaces', id, 'container'],
    ['workspaces', id],
  ],
)

export const useExportWorkspace = createCustomMutation<void, string>(
  async (id) => {
    const res = await fetch(`/api/workspaces/${id}/export`, { credentials: 'include' })
    if (!res.ok) throw new Error('Export failed')
    const json = await res.json()
    const exportData = json.data
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `workspace-export.json`
    a.click()
    URL.revokeObjectURL(url)
  },
)

export const useImportWorkspace = createMutation<
  { workspace: Workspace; skippedCapabilities: string[]; warnings: string[] },
  Record<string, unknown>
>('post', '/workspaces/import', [['workspaces']])

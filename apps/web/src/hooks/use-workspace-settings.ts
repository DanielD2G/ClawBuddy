import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { WorkspaceSettings } from '@clawbuddy/shared'
import type { Workspace } from '@/hooks/use-workspaces'
import { apiClient } from '@/lib/api-client'
import { useActiveWorkspace } from '@/providers/workspace-provider'

export interface WorkspaceSettingsData {
  id: string
  color: string | null
  settings: WorkspaceSettings | null
  autoExecute: boolean
  permissions: { allow?: string[] } | null
}

export function useWorkspaceSettings(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['workspace-settings', workspaceId],
    queryFn: () => apiClient.get<WorkspaceSettingsData>(`/workspaces/${workspaceId}/settings`),
    enabled: !!workspaceId,
  })
}

export function useUpdateWorkspaceSettings() {
  const queryClient = useQueryClient()
  const { activeWorkspace, setActiveWorkspace } = useActiveWorkspace()

  return useMutation({
    mutationFn: ({
      id,
      ...data
    }: {
      id: string
      color?: string
      settings?: WorkspaceSettings | null
      autoExecute?: boolean
      permissions?: { allow?: string[] } | null
    }) => apiClient.patch<WorkspaceSettingsData>(`/workspaces/${id}/settings`, data),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['workspace-settings', data.id] })
      queryClient.invalidateQueries({ queryKey: ['workspaces', data.id] })
      queryClient.invalidateQueries({ queryKey: ['workspaces'] })

      queryClient.setQueryData<Workspace | undefined>(['workspaces', data.id], (current) =>
        current
          ? {
              ...current,
              color: data.color,
              settings: data.settings,
              autoExecute: data.autoExecute,
              permissions: data.permissions,
            }
          : current,
      )

      queryClient.setQueryData<Workspace[] | undefined>(['workspaces'], (current) =>
        current?.map((workspace) =>
          workspace.id === data.id
            ? {
                ...workspace,
                color: data.color,
                settings: data.settings,
                autoExecute: data.autoExecute,
                permissions: data.permissions,
              }
            : workspace,
        ),
      )

      if (activeWorkspace?.id === data.id) {
        setActiveWorkspace({
          ...activeWorkspace,
          color: data.color,
          settings: data.settings,
          autoExecute: data.autoExecute,
          permissions: data.permissions,
        })
      }
    },
  })
}

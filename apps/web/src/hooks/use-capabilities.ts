import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import type { ConfigFieldDefinition } from '@/types/capability-config'

export interface Capability {
  id: string
  slug: string
  name: string
  description: string
  icon: string | null
  category: string
  version: string
  toolDefinitions: unknown
  systemPrompt: string
  dockerImage: string | null
  packages: string[]
  networkAccess: boolean
  builtin: boolean
  configSchema: ConfigFieldDefinition[] | null
  enabled: boolean
  config: Record<string, unknown> | null
  workspaceCapabilityId: string | null
}

export function useCapabilities() {
  return useQuery({
    queryKey: ['capabilities'],
    queryFn: () => apiClient.get<Capability[]>('/capabilities'),
  })
}

export function useWorkspaceCapabilities(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ['workspace-capabilities', workspaceId],
    queryFn: () => apiClient.get<Capability[]>(`/workspaces/${workspaceId}/capabilities`),
    enabled: !!workspaceId,
  })
}

export function useEnableCapability(workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: { slug: string; config?: Record<string, unknown> }) =>
      apiClient.post(`/workspaces/${workspaceId}/capabilities`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-capabilities', workspaceId] })
    },
  })
}

export function useDisableCapability(workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (capabilityId: string) =>
      apiClient.delete(`/workspaces/${workspaceId}/capabilities/${capabilityId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-capabilities', workspaceId] })
    },
  })
}

export function useUpdateCapabilityConfig(workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ capabilityId, config }: { capabilityId: string; config: Record<string, unknown> }) =>
      apiClient.patch(`/workspaces/${workspaceId}/capabilities/${capabilityId}`, { config }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-capabilities', workspaceId] })
    },
  })
}

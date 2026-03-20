import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { getSystemUpdatePollInterval, type SystemUpdateStateStatus } from '@/lib/system-update'

export interface ServiceReleaseMetadata {
  image: string
  version: string | null
  revision: string | null
  digest: string | null
}

export interface SystemUpdateRelease {
  version: string | null
  revision: string | null
  digest: string | null
  services: {
    api: ServiceReleaseMetadata
    web: ServiceReleaseMetadata
  }
}

export interface PersistedSystemUpdateState {
  status: SystemUpdateStateStatus
  message: string
  currentVersion: string | null
  targetVersion: string | null
  startedAt: string | null
  finishedAt: string | null
  lastCheckedAt: string | null
  error: string | null
}

export interface SystemUpdateStatusResponse {
  supported: boolean
  available: boolean
  current: SystemUpdateRelease | null
  latest: SystemUpdateRelease | null
  state: PersistedSystemUpdateState
  canUpdate: boolean
  reason: string | null
}

export function useSystemUpdateStatus() {
  return useQuery({
    queryKey: ['system-update'],
    queryFn: () => apiClient.get<SystemUpdateStatusResponse>('/admin/system/update'),
    refetchInterval: (query) =>
      getSystemUpdatePollInterval(query.state.data?.state.status ?? 'idle'),
  })
}

export function useStartSystemUpdate() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => apiClient.post<SystemUpdateStatusResponse>('/admin/system/update'),
    onSuccess: (data) => {
      queryClient.setQueryData<SystemUpdateStatusResponse>(['system-update'], data)
      queryClient.invalidateQueries({ queryKey: ['system-update'] })
    },
  })
}

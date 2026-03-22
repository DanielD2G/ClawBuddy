import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { POLL_UPDATE_CHECK_MS } from '@/constants'

export type UpdateStepStatus = 'pending' | 'running' | 'done' | 'error'
export type UpdateRunPhase =
  | 'pending'
  | 'pulling-images'
  | 'waiting-for-api'
  | 'deploying-web'
  | 'waiting-for-web'
  | 'completed'
  | 'failed'

export interface UpdateStepProgress {
  status: UpdateStepStatus
  progress: string
  error?: string
}

export interface UpdateOverview {
  supported: boolean
  supportReason: string | null
  currentVersion: string
  currentBuild: {
    version: string
    commitSha: string
    builtAt: string | null
  }
  latestRelease: {
    version: string
    name: string
    body: string
    url: string
    publishedAt: string
  } | null
  dismissedVersion: string | null
  activeRun: {
    id: string
    status: string
    phase: UpdateRunPhase
    currentVersion: string | null
    targetVersion: string
    targetReleaseName: string | null
    targetReleaseUrl: string | null
    targetPublishedAt: string | null
    targetReleaseNotes: string | null
    phaseMessage: string | null
    progress: {
      pullApi: UpdateStepProgress
      pullWeb: UpdateStepProgress
      apiDeploy: UpdateStepProgress
      webDeploy: UpdateStepProgress
      observed: {
        apiVersion: string | null
        apiUpdateState: string | null
        apiUpdateMessage: string | null
        webVersion: string | null
        webUpdateState: string | null
        webUpdateMessage: string | null
      }
    }
    error: string | null
    startedAt: string | null
    completedAt: string | null
    createdAt: string
    updatedAt: string
  } | null
  forceUpdate: boolean
}

export function hasAvailableUpdate(data: UpdateOverview | undefined | null) {
  if (!data?.supported || !data.latestRelease) return false
  if (data.activeRun) return false
  if (data.dismissedVersion === data.latestRelease.version) return false
  return data.currentVersion !== data.latestRelease.version
}

export function useUpdateOverview(refetchInterval: number | false = POLL_UPDATE_CHECK_MS) {
  return useQuery({
    queryKey: ['update-overview'],
    queryFn: () => apiClient.get<UpdateOverview>('/update'),
    refetchInterval,
  })
}

export function useCheckForUpdates() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiClient.post<UpdateOverview>('/update/check'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['update-overview'] })
    },
  })
}

export function useAcceptUpdate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiClient.post<UpdateOverview>('/update/accept', {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['update-overview'] })
    },
  })
}

export function useDeclineUpdate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiClient.post<UpdateOverview>('/update/decline', {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['update-overview'] })
    },
  })
}

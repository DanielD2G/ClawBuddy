import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { POLL_UPDATE_CHECK_MS, POLL_UPDATE_STATUS_MS } from '@/constants'

export type UpdateRunStage =
  | 'queued'
  | 'preparing'
  | 'pulling'
  | 'migrating'
  | 'deploying'
  | 'verifying'
  | 'succeeded'
  | 'rolled_back'
  | 'failed'

export type UpdateRunStatus = 'queued' | 'running' | 'succeeded' | 'rolled_back' | 'failed'
export type UpdateEventStatus = 'pending' | 'running' | 'done' | 'error'
export type UpdateDeliveryMode = 'integrated' | 'maintenance-required'

export interface UpdateEvent {
  id: string
  step: string
  status: UpdateEventStatus
  message: string
  details: Record<string, unknown> | null
  createdAt: string
}

export interface UpdateRun {
  id: string
  status: UpdateRunStatus
  stage: UpdateRunStage
  message: string | null
  currentVersion: string | null
  targetVersion: string
  targetReleaseName: string | null
  targetReleaseUrl: string | null
  targetPublishedAt: string | null
  targetReleaseNotes: string | null
  deliveryMode: UpdateDeliveryMode
  serviceRole: string
  manifest: {
    version: string
    appImage: string
    imageDigest: string | null
    migration: {
      mode: 'none' | 'prisma-db-push'
      rollbackSafe: boolean
    }
    deliveryMode: UpdateDeliveryMode
    minUpdaterVersion: string | null
    notesUrl: string | null
  } | null
  targetImage: string | null
  targetImageDigest: string | null
  observedVersion: string | null
  observedImage: string | null
  observedImageDigest: string | null
  rollbackReason: string | null
  error: string | null
  leaseOwner: string | null
  leaseExpiresAt: string | null
  heartbeatAt: string | null
  verificationDeadlineAt: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
  events: UpdateEvent[]
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
    manifest: UpdateRun['manifest']
  } | null
  dismissedVersion: string | null
  eligibility: {
    supported: boolean
    canUpdate: boolean
    reason: string | null
    deliveryMode: UpdateDeliveryMode
    minUpdaterVersion: string | null
  }
  currentRun: UpdateRun | null
  lastTerminalRun: UpdateRun | null
  forceUpdate: boolean
}

export function hasAvailableUpdate(data: UpdateOverview | undefined | null) {
  if (!data?.supported || !data.latestRelease) return false
  if (data.currentRun) return false
  if (data.dismissedVersion === data.latestRelease.version) return false
  return data.eligibility.canUpdate
}

export function useUpdateOverview() {
  return useQuery({
    queryKey: ['update-overview'],
    queryFn: () => apiClient.get<UpdateOverview>('/update'),
    refetchInterval: (query) =>
      query.state.data?.currentRun ? POLL_UPDATE_STATUS_MS : POLL_UPDATE_CHECK_MS,
  })
}

export function useUpdateRun(runId: string | null | undefined) {
  return useQuery({
    queryKey: ['update-run', runId],
    queryFn: () => apiClient.get<UpdateRun>(`/update/runs/${runId}`),
    enabled: !!runId,
    refetchInterval: (query) =>
      query.state.data && ['queued', 'running'].includes(query.state.data.status)
        ? POLL_UPDATE_STATUS_MS
        : false,
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

export function useCreateUpdateRun() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiClient.post<UpdateRun>('/update/runs', {}),
    onSuccess: (run) => {
      queryClient.invalidateQueries({ queryKey: ['update-overview'] })
      queryClient.setQueryData(['update-run', run.id], run)
    },
  })
}

export function useRetryUpdateRun() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (runId: string) => apiClient.post<UpdateRun>(`/update/runs/${runId}/retry`, {}),
    onSuccess: (run) => {
      queryClient.invalidateQueries({ queryKey: ['update-overview'] })
      queryClient.setQueryData(['update-run', run.id], run)
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

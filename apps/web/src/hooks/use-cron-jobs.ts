import { useQuery } from '@tanstack/react-query'
import { POLL_CRON_JOBS_MS } from '@/constants'
import { apiClient } from '@/lib/api-client'
import { createMutation } from './create-mutation'

export type CronScope = 'global' | 'workspace' | 'conversation'

export interface CronJob {
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
  scope: CronScope
  scopeLabel: string
  workspaceName: string | null
  conversationTitle: string | null
}

interface UseCronJobsOptions {
  workspaceId?: string
  includeGlobal?: boolean
  includeWorkspace?: boolean
  includeConversation?: boolean
}

function buildQuery(params: Record<string, string | boolean | undefined>) {
  const searchParams = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '') {
      searchParams.set(key, String(value))
    }
  })

  const query = searchParams.toString()
  return query ? `?${query}` : ''
}

export function useCronJobs(options: UseCronJobsOptions = {}) {
  return useQuery({
    queryKey: ['cron-jobs', options],
    queryFn: () =>
      apiClient.get<CronJob[]>(
        `/cron${buildQuery({
          workspaceId: options.workspaceId,
          includeGlobal: options.includeGlobal,
          includeWorkspace: options.includeWorkspace,
          includeConversation: options.includeConversation,
        })}`,
      ),
    refetchInterval: POLL_CRON_JOBS_MS,
  })
}

export const useCreateCronJob = createMutation<
  unknown,
  {
    name: string
    schedule: string
    type: string
    prompt?: string
    description?: string
    workspaceId?: string
  }
>('post', '/cron', [['cron-jobs']])

export const useUpdateCronJob = createMutation<
  unknown,
  { id: string; name?: string; schedule?: string; prompt?: string; description?: string }
>('patch', ({ id }) => `/cron/${id}`, [['cron-jobs']])

export const useDeleteCronJob = createMutation<unknown, string>('delete', (id) => `/cron/${id}`, [
  ['cron-jobs'],
])

export const useToggleCronJob = createMutation<unknown, { id: string; enabled: boolean }>(
  'patch',
  ({ id }) => `/cron/${id}/toggle`,
  [['cron-jobs']],
)

export const useTriggerCronJob = createMutation<unknown, string>(
  'post',
  (id) => `/cron/${id}/trigger`,
  [['cron-jobs']],
)

import { useQuery } from '@tanstack/react-query'
import { POLL_DASHBOARDS_MS } from '@/constants'
import { apiClient } from '@/lib/api-client'
import { createMutation } from './create-mutation'

// ── Types ───────────────────────────────────────────────────

export interface DashboardComponentSummary {
  id: string
  type: string
  title: string | null
  order: number
}

export interface DashboardListItem {
  id: string
  workspaceId: string
  title: string
  description: string | null
  layout: Record<string, unknown> | null
  cronJobId: string | null
  refreshStatus: 'idle' | 'refreshing' | 'error'
  lastRefreshAt: string | null
  createdAt: string
  updatedAt: string
  components: DashboardComponentSummary[]
}

export interface DashboardComponent {
  id: string
  dashboardId: string
  type: 'kpi' | 'stats_group' | 'chart' | 'ai_insights' | 'table' | 'links'
  title: string | null
  config: Record<string, unknown>
  data: Record<string, unknown> | null
  previousData: Record<string, unknown> | null
  position: { x: number; y: number; w: number; h: number } | null
  order: number
  prompt: string | null
  script: string | null
  scriptLanguage: string | null
  notes: string | null
  lastInsight: string | null
  lastInsightAt: string | null
  createdAt: string
  updatedAt: string
}

export interface Dashboard {
  id: string
  workspaceId: string
  sessionId: string | null
  title: string
  description: string | null
  layout: { columns?: number; gap?: number } | null
  cronJobId: string | null
  refreshStatus: 'idle' | 'refreshing' | 'error'
  lastRefreshAt: string | null
  createdAt: string
  updatedAt: string
  components: DashboardComponent[]
}

// ── Query hooks ─────────────────────────────────────────────

export function useDashboards(workspaceId?: string) {
  return useQuery({
    queryKey: ['dashboards', workspaceId],
    queryFn: () =>
      apiClient.get<DashboardListItem[]>(`/dashboards?workspaceId=${workspaceId}`),
    enabled: !!workspaceId,
    refetchInterval: (query) => {
      const data = query.state.data
      const anyRefreshing = data?.some((d) => d.refreshStatus === 'refreshing')
      return anyRefreshing ? 3000 : POLL_DASHBOARDS_MS
    },
  })
}

export function useDashboard(id: string) {
  return useQuery({
    queryKey: ['dashboard', id],
    queryFn: () => apiClient.get<Dashboard>(`/dashboards/${id}`),
    enabled: !!id,
    // Poll faster while refreshing
    refetchInterval: (query) => {
      const data = query.state.data
      return data?.refreshStatus === 'refreshing' ? 3000 : POLL_DASHBOARDS_MS
    },
  })
}

// ── Mutations ───────────────────────────────────────────────

export interface CreateDashboardPayload {
  workspaceId: string
  title: string
  description?: string
  cronSchedule?: string
  components: Array<{
    type: string
    title?: string
    prompt?: string
    config?: Record<string, unknown>
  }>
}

export const useCreateDashboard = createMutation<Dashboard, CreateDashboardPayload>(
  'post',
  () => '/dashboards',
  [['dashboards'], ['dashboard']],
)

export const useDeleteDashboard = createMutation<unknown, string>(
  'delete',
  (id) => `/dashboards/${id}`,
  [['dashboards'], ['dashboard']],
)

export const useRefreshDashboard = createMutation<unknown, string>(
  'post',
  (id) => `/dashboards/${id}/refresh`,
  [['dashboards'], ['dashboard']],
)

export const useDeleteDashboardComponent = createMutation<unknown, string>(
  'delete',
  (componentId) => `/dashboards/components/${componentId}`,
  [['dashboards'], ['dashboard']],
)

export const useUpdateDashboardComponent = createMutation<
  unknown,
  { componentId: string; title?: string; prompt?: string; config?: Record<string, unknown>; script?: string | null; scriptLanguage?: string | null; notes?: string | null }
>(
  'patch',
  (vars) => `/dashboards/components/${vars.componentId}`,
  [['dashboards'], ['dashboard']],
)

export const useAddDashboardComponent = createMutation<
  DashboardComponent,
  { dashboardId: string; type: string; title: string; prompt: string; config?: Record<string, unknown> }
>(
  'post',
  (vars) => `/dashboards/${vars.dashboardId}/components`,
  [['dashboards'], ['dashboard']],
)

export const useReorderDashboardComponents = createMutation<
  unknown,
  { dashboardId: string; componentIds: string[] }
>(
  'post',
  (vars) => `/dashboards/${vars.dashboardId}/reorder`,
  [['dashboards'], ['dashboard']],
)

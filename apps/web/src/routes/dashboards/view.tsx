import { useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, RefreshCw, Trash2, Clock, Loader2, MessageSquare, Pencil, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  useDashboard,
  useDeleteDashboard,
  useRefreshDashboard,
  useDeleteDashboardComponent,
  useUpdateDashboardComponent,
  useAddDashboardComponent,
  useReorderDashboardComponents,
} from '@/hooks/use-dashboards'
import { DashboardGrid } from '@/components/dashboard/dashboard-grid'
import { DashboardChatSheet } from '@/components/dashboard/dashboard-chat-sheet'
import { toast } from 'sonner'

export function DashboardViewPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const { data: dashboard, isLoading } = useDashboard(id ?? '')
  const deleteDashboard = useDeleteDashboard()
  const refreshDashboard = useRefreshDashboard()
  const deleteComponent = useDeleteDashboardComponent()
  const updateComponent = useUpdateDashboardComponent()
  const addComponent = useAddDashboardComponent()
  const reorderComponents = useReorderDashboardComponents()

  const handleDelete = () => {
    if (!dashboard || !confirm(`Delete dashboard "${dashboard.title}"?`)) return
    deleteDashboard.mutate(dashboard.id, {
      onSuccess: () => {
        toast.success('Dashboard deleted')
        navigate('/dashboards')
      },
      onError: () => toast.error('Failed to delete dashboard'),
    })
  }

  const handleRefresh = () => {
    if (!dashboard) return
    refreshDashboard.mutate(dashboard.id, {
      onSuccess: () => toast.success('Dashboard refresh triggered'),
      onError: (err) =>
        toast.error(err.message || 'Failed to trigger refresh'),
    })
  }

  const handleDeleteComponent = (componentId: string, title: string | null) => {
    if (!confirm(`Remove "${title ?? 'this component'}" from dashboard?`)) return
    deleteComponent.mutate(componentId, {
      onSuccess: () => toast.success('Component removed'),
      onError: () => toast.error('Failed to remove component'),
    })
  }

  const handleUpdateComponent = (componentId: string, updates: { title?: string; prompt?: string; script?: string | null; scriptLanguage?: string | null; notes?: string | null }) => {
    updateComponent.mutate(
      { componentId, ...updates },
      {
        onSuccess: () => toast.success('Component updated'),
        onError: () => toast.error('Failed to update component'),
      },
    )
  }

  const handleAddComponent = (comp: { type: string; title: string; prompt: string; config?: Record<string, unknown> }) => {
    if (!dashboard) return
    addComponent.mutate(
      { dashboardId: dashboard.id, ...comp },
      {
        onSuccess: () => toast.success('Component added'),
        onError: () => toast.error('Failed to add component'),
      },
    )
  }

  const handleMoveComponent = (componentId: string, direction: 'up' | 'down') => {
    if (!dashboard) return
    const ids = dashboard.components.map((c) => c.id)
    const idx = ids.indexOf(componentId)
    if (idx === -1) return
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1
    if (targetIdx < 0 || targetIdx >= ids.length) return
    // Swap
    ;[ids[idx], ids[targetIdx]] = [ids[targetIdx], ids[idx]]
    reorderComponents.mutate(
      { dashboardId: dashboard.id, componentIds: ids },
      {
        onError: () => toast.error('Failed to reorder'),
      },
    )
  }

  const handleReorder = (orderedIds: string[]) => {
    if (!dashboard) return
    reorderComponents.mutate(
      { dashboardId: dashboard.id, componentIds: orderedIds },
      {
        onError: () => toast.error('Failed to reorder'),
      },
    )
  }

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="size-6" />
      </div>
    )
  }

  if (!dashboard) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <p className="text-muted-foreground">Dashboard not found.</p>
        <Link to="/dashboards" className="mt-2 inline-block text-sm text-brand hover:underline">
          Back to dashboards
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-screen-2xl px-3 py-4 sm:px-4 sm:py-8">
      {/* Header */}
      <div className="mb-6 space-y-3">
        {/* Title row */}
        <div className="flex items-center gap-3">
          <Link
            to="/dashboards"
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold truncate">{dashboard.title}</h1>
            {dashboard.description && (
              <p className="text-sm text-muted-foreground truncate">{dashboard.description}</p>
            )}
          </div>
        </div>

        {/* Status + Actions row */}
        <div className="flex items-center justify-between gap-2">
          {/* Status badges */}
          <div className="flex flex-wrap items-center gap-1.5">
            {dashboard.refreshStatus === 'refreshing' && (
              <Badge variant="default" className="gap-1.5 animate-pulse bg-brand text-white text-xs">
                <Loader2 className="size-3 animate-spin" />
                Refreshing...
              </Badge>
            )}
            {dashboard.refreshStatus === 'error' && (
              <Badge variant="destructive" className="gap-1 text-xs">
                Refresh failed
              </Badge>
            )}
            {dashboard.cronJobId && dashboard.refreshStatus !== 'refreshing' && (
              <Badge variant="secondary" className="gap-1 text-xs">
                <RefreshCw className="size-3" />
                Auto
              </Badge>
            )}
            {dashboard.lastRefreshAt && dashboard.refreshStatus !== 'refreshing' && (
              <Badge variant="outline" className="gap-1 text-xs font-normal">
                <Clock className="size-3" />
                {new Date(dashboard.lastRefreshAt).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </Badge>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-0.5 shrink-0">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleRefresh}
              disabled={refreshDashboard.isPending || dashboard.refreshStatus === 'refreshing'}
              title="Refresh"
            >
              {refreshDashboard.isPending ? (
                <Spinner className="size-4" />
              ) : (
                <RefreshCw className="size-4" />
              )}
            </Button>
            <Button
              variant={editing ? 'default' : 'ghost'}
              size="icon-sm"
              onClick={() => setEditing((v) => !v)}
              title={editing ? 'Done editing' : 'Edit'}
            >
              {editing ? <X className="size-4" /> : <Pencil className="size-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setChatOpen(true)}
              title="Activity"
            >
              <MessageSquare className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={handleDelete}
              disabled={deleteDashboard.isPending}
              title="Delete"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Grid */}
      <DashboardGrid
        components={dashboard.components}
        columns={dashboard.layout?.columns ?? 3}
        gap={dashboard.layout?.gap ?? 4}
        editing={editing}
        onDeleteComponent={handleDeleteComponent}
        onMoveComponent={handleMoveComponent}
        onUpdateComponent={handleUpdateComponent}
        onAddComponent={handleAddComponent}
        onReorder={handleReorder}
      />

      {/* Activity / Chat Sheet */}
      <DashboardChatSheet
        open={chatOpen}
        onOpenChange={setChatOpen}
        sessionId={dashboard.sessionId ?? null}
        dashboardId={dashboard.id}
        dashboardTitle={dashboard.title}
      />
    </div>
  )
}

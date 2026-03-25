import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  LayoutDashboard,
  Clock,
  RefreshCw,
  Trash2,
  BarChart3,
  Target,
  TableIcon,
  Sparkles,
  Activity,
  Link2,
  Loader2,
  Plus,
} from 'lucide-react'
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardAction } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useDashboards, useDeleteDashboard } from '@/hooks/use-dashboards'
import { useActiveWorkspace } from '@/providers/workspace-provider'
import { Spinner } from '@/components/ui/spinner'
import { CreateDashboardDialog } from '@/components/dashboard/create-dashboard-dialog'
import { toast } from 'sonner'

const TYPE_ICONS: Record<string, typeof BarChart3> = {
  kpi: Target,
  chart: BarChart3,
  stats_group: Activity,
  table: TableIcon,
  ai_insights: Sparkles,
  links: Link2,
}

export function DashboardListPage() {
  const [createOpen, setCreateOpen] = useState(false)
  const { activeWorkspace } = useActiveWorkspace()
  const { data: dashboards, isLoading } = useDashboards(activeWorkspace?.id)
  const deleteDashboard = useDeleteDashboard()

  const handleDelete = (id: string, title: string) => {
    if (!confirm(`Delete dashboard "${title}"?`)) return
    deleteDashboard.mutate(id, {
      onSuccess: () => toast.success(`Dashboard "${title}" deleted`),
      onError: () => toast.error('Failed to delete dashboard'),
    })
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <LayoutDashboard className="size-6 text-brand" />
          <h1 className="text-2xl font-bold">Dashboards</h1>
        </div>
        <Button className="gap-1.5" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          New Dashboard
        </Button>
      </div>

      <CreateDashboardDialog open={createOpen} onOpenChange={setCreateOpen} />

      {isLoading ? (
        <div className="flex h-48 items-center justify-center">
          <Spinner className="size-6" />
        </div>
      ) : !dashboards?.length ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-muted-foreground/30 py-16">
          <LayoutDashboard className="size-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">No dashboards yet</p>
          <p className="max-w-sm text-center text-xs text-muted-foreground/70">
            Create one manually or ask the agent — for example:{' '}
            <em>"Create a dashboard showing my Google Ads and Meta Ads metrics"</em>
          </p>
          <Button variant="outline" className="gap-1.5" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            Create your first dashboard
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {dashboards.map((dashboard) => (
            <Link key={dashboard.id} to={`/dashboards/${dashboard.id}`} className="group">
              <Card className="h-full transition-shadow group-hover:ring-brand/30">
                <CardHeader>
                  <CardTitle className="truncate">{dashboard.title}</CardTitle>
                  {dashboard.description && (
                    <CardDescription className="line-clamp-2">
                      {dashboard.description}
                    </CardDescription>
                  )}
                  <CardAction>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground/50 hover:text-destructive"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        handleDelete(dashboard.id, dashboard.title)
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-1.5">
                    {dashboard.components.map((comp) => {
                      const Icon = TYPE_ICONS[comp.type] ?? BarChart3
                      return (
                        <Badge key={comp.id} variant="secondary" className="gap-1">
                          <Icon className="size-3" />
                          {comp.title ?? comp.type}
                        </Badge>
                      )
                    })}
                  </div>
                  <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
                    {dashboard.refreshStatus === 'refreshing' && (
                      <span className="flex items-center gap-1 text-brand font-medium">
                        <Loader2 className="size-3 animate-spin" />
                        Refreshing...
                      </span>
                    )}
                    {dashboard.cronJobId && dashboard.refreshStatus !== 'refreshing' && (
                      <span className="flex items-center gap-1">
                        <RefreshCw className="size-3" />
                        Auto-refresh
                      </span>
                    )}
                    {dashboard.lastRefreshAt && (
                      <span className="flex items-center gap-1">
                        <Clock className="size-3" />
                        {new Date(dashboard.lastRefreshAt).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

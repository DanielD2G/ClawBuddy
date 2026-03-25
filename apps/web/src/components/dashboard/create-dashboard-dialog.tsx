import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Plus,
  Trash2,
  Target,
  BarChart3,
  Activity,
  TableIcon,
  Sparkles,
  Link2,
  ChevronUp,
  ChevronDown,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { useCreateDashboard, type CreateDashboardPayload } from '@/hooks/use-dashboards'
import { useActiveWorkspace } from '@/providers/workspace-provider'
import { apiClient } from '@/lib/api-client'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

const COMPONENT_TYPES = [
  { value: 'kpi', label: 'KPI', icon: Target },
  { value: 'stats_group', label: 'Stats Group', icon: Activity },
  { value: 'chart', label: 'Chart', icon: BarChart3 },
  { value: 'table', label: 'Table', icon: TableIcon },
  { value: 'ai_insights', label: 'AI Insights', icon: Sparkles },
  { value: 'links', label: 'Links / News', icon: Link2 },
] as const

type ComponentType = (typeof COMPONENT_TYPES)[number]['value']

const CHART_TYPES = [
  { value: 'line', label: 'Line' },
  { value: 'bar', label: 'Bar' },
  { value: 'area', label: 'Area' },
  { value: 'pie', label: 'Pie' },
]

const CRON_PRESETS = [
  { value: '', label: 'Manual only' },
  { value: '0 */6 * * *', label: 'Every 6 hours' },
  { value: '0 9 * * *', label: 'Daily at 9 AM' },
  { value: '0 9 * * 1', label: 'Weekly (Monday 9 AM)' },
  { value: '0 9 1 * *', label: 'Monthly (1st at 9 AM)' },
]

const PROMPT_PLACEHOLDERS: Record<ComponentType, string> = {
  kpi: 'e.g. Fetch current monthly revenue from Google Analytics and show % change vs last month',
  stats_group:
    'e.g. Get website traffic metrics: total visits, unique visitors, bounce rate, avg session duration',
  chart: 'e.g. Show revenue trend for the last 12 months from our sales data',
  table: 'e.g. List the top 10 best-selling products with name, units sold, and revenue',
  ai_insights:
    'e.g. Analyze recent marketing performance across all channels and provide recommendations',
  links: 'e.g. Find the latest news articles about AI and machine learning in the tech industry',
}

interface ComponentDraft {
  id: string
  type: ComponentType
  title: string
  prompt: string
  chartType?: string
}

let draftIdCounter = 0

function createDraft(type: ComponentType = 'kpi'): ComponentDraft {
  return {
    id: `draft-${++draftIdCounter}`,
    type,
    title: '',
    prompt: '',
    chartType: type === 'chart' ? 'line' : undefined,
  }
}

interface CreateDashboardDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateDashboardDialog({ open, onOpenChange }: CreateDashboardDialogProps) {
  const navigate = useNavigate()
  const { activeWorkspace } = useActiveWorkspace()
  const createDashboard = useCreateDashboard()

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [cronSchedule, setCronSchedule] = useState('0 9 * * *')
  const [components, setComponents] = useState<ComponentDraft[]>([createDraft('kpi')])

  const resetForm = () => {
    setTitle('')
    setDescription('')
    setCronSchedule('0 9 * * *')
    setComponents([createDraft('kpi')])
  }

  const addComponent = () => {
    setComponents((prev) => [...prev, createDraft('kpi')])
  }

  const removeComponent = (id: string) => {
    setComponents((prev) => prev.filter((c) => c.id !== id))
  }

  const updateComponent = (id: string, updates: Partial<ComponentDraft>) => {
    setComponents((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c
        const updated = { ...c, ...updates }
        if (updates.type === 'chart' && !c.chartType) updated.chartType = 'line'
        if (updates.type && updates.type !== 'chart') updated.chartType = undefined
        return updated
      }),
    )
  }

  const moveComponent = (id: string, direction: 'up' | 'down') => {
    setComponents((prev) => {
      const idx = prev.findIndex((c) => c.id === id)
      if (idx === -1) return prev
      const target = direction === 'up' ? idx - 1 : idx + 1
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]
      ;[next[idx], next[target]] = [next[target], next[idx]]
      return next
    })
  }

  const handleSubmit = async () => {
    if (!activeWorkspace || !title.trim() || components.length === 0) return

    const validComponents = components.filter((c) => c.title.trim())
    if (validComponents.length === 0) {
      toast.error('Add at least one component with a name')
      return
    }

    const payload: CreateDashboardPayload = {
      workspaceId: activeWorkspace.id,
      title: title.trim(),
      description: description.trim() || undefined,
      cronSchedule: cronSchedule || undefined,
      components: validComponents.map((c) => {
        const comp: CreateDashboardPayload['components'][number] = {
          type: c.type,
          title: c.title.trim(),
          prompt: c.prompt.trim() || c.title.trim(),
        }

        if (c.type === 'chart') {
          comp.config = {
            chartType: c.chartType || 'line',
            xKey: 'x',
            yKey: 'y',
          }
        }

        return comp
      }),
    }

    createDashboard.mutate(payload, {
      onSuccess: async (dashboard) => {
        toast.success('Dashboard created!')
        onOpenChange(false)
        resetForm()

        // Trigger immediate refresh to populate data via the agent
        try {
          await apiClient.post(`/dashboards/${dashboard.id}/refresh`, {})
          toast.info('Populating dashboard data...')
        } catch {
          // Not critical — user can refresh manually
        }

        navigate(`/dashboards/${dashboard.id}`)
      },
      onError: () => toast.error('Failed to create dashboard'),
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Create Dashboard</DialogTitle>
          <DialogDescription>
            Define your components and what data each should show. The agent will populate them on
            refresh.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-5 py-1 pr-1">
          {/* Dashboard meta */}
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium text-foreground mb-1.5 block">
                Dashboard Title <span className="text-destructive">*</span>
              </label>
              <Input
                placeholder="e.g. Marketing Performance, Financial Overview"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-foreground mb-1.5 block">
                Description
              </label>
              <Input
                placeholder="Brief description of what this dashboard tracks"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-foreground mb-1.5 block">
                Auto-refresh Schedule
              </label>
              <select
                value={cronSchedule}
                onChange={(e) => setCronSchedule(e.target.value)}
                className="h-(--control) w-full rounded-md border border-input bg-transparent px-2.5 py-1 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
              >
                {CRON_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Components */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <label className="text-sm font-medium text-foreground">
                Components <span className="text-destructive">*</span>
              </label>
              <Button variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={addComponent}>
                <Plus className="size-3.5" />
                Add Component
              </Button>
            </div>

            <div className="space-y-3">
              {components.map((comp, idx) => {
                const typeInfo = COMPONENT_TYPES.find((t) => t.value === comp.type)!
                const Icon = typeInfo.icon
                return (
                  <div
                    key={comp.id}
                    className="rounded-lg border border-border bg-muted/30 p-3 space-y-2.5"
                  >
                    {/* Row 1: order controls + type selector + chart sub-type + delete */}
                    <div className="flex items-center gap-2">
                      <div className="flex flex-col">
                        <button
                          type="button"
                          onClick={() => moveComponent(comp.id, 'up')}
                          disabled={idx === 0}
                          className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors"
                        >
                          <ChevronUp className="size-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveComponent(comp.id, 'down')}
                          disabled={idx === components.length - 1}
                          className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-20 transition-colors"
                        >
                          <ChevronDown className="size-3" />
                        </button>
                      </div>

                      <Badge variant="secondary" className="gap-1 shrink-0">
                        <Icon className="size-3" />
                        <span className="text-xs font-medium">{idx + 1}</span>
                      </Badge>

                      <select
                        value={comp.type}
                        onChange={(e) =>
                          updateComponent(comp.id, { type: e.target.value as ComponentType })
                        }
                        className="h-7 rounded-md border border-input bg-transparent px-2 text-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                      >
                        {COMPONENT_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>

                      {comp.type === 'chart' && (
                        <select
                          value={comp.chartType || 'line'}
                          onChange={(e) => updateComponent(comp.id, { chartType: e.target.value })}
                          className="h-7 rounded-md border border-input bg-transparent px-2 text-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                        >
                          {CHART_TYPES.map((ct) => (
                            <option key={ct.value} value={ct.value}>
                              {ct.label}
                            </option>
                          ))}
                        </select>
                      )}

                      <div className="flex-1" />

                      <button
                        type="button"
                        onClick={() => removeComponent(comp.id)}
                        disabled={components.length === 1}
                        className={cn(
                          'p-1 rounded text-muted-foreground transition-colors hover:text-destructive',
                          components.length === 1 && 'opacity-30 pointer-events-none',
                        )}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>

                    {/* Row 2: Name */}
                    <div>
                      <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1 block">
                        Name
                      </label>
                      <Input
                        placeholder="Component name / title"
                        value={comp.title}
                        onChange={(e) => updateComponent(comp.id, { title: e.target.value })}
                        className="text-sm"
                      />
                    </div>

                    {/* Row 3: Prompt */}
                    <div>
                      <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-1 block">
                        Prompt
                      </label>
                      <textarea
                        placeholder={PROMPT_PLACEHOLDERS[comp.type]}
                        value={comp.prompt}
                        onChange={(e) => updateComponent(comp.id, { prompt: e.target.value })}
                        rows={2}
                        className="w-full rounded-md border border-input bg-transparent px-2.5 py-2 text-sm transition-colors outline-none resize-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={
              createDashboard.isPending || !title.trim() || !components.some((c) => c.title.trim())
            }
            className="gap-1.5"
          >
            {createDashboard.isPending ? (
              <>
                <Spinner className="size-3.5" />
                Creating...
              </>
            ) : (
              <>
                <Plus className="size-3.5" />
                Create Dashboard
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

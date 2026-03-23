import { Fragment, useState } from 'react'
import {
  useCronJobs,
  useCreateCronJob,
  useDeleteCronJob,
  useToggleCronJob,
  useTriggerCronJob,
  type CronJob,
} from '@/hooks/use-cron-jobs'
import { useActiveWorkspace } from '@/providers/workspace-provider'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Plus,
  Play,
  Trash2,
  CheckCircle,
  XCircle,
  Clock,
  ChevronsUpDown,
  Check,
} from 'lucide-react'

const SCOPE_ORDER = ['global', 'workspace', 'conversation'] as const

export function DataCronPage() {
  const { activeWorkspace, activeWorkspaceId } = useActiveWorkspace()
  const [createOpen, setCreateOpen] = useState(false)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <p className="text-muted-foreground">Manage scheduled tasks and recurring agent jobs.</p>
          <p className="text-xs text-muted-foreground">
            {activeWorkspace
              ? `Showing global jobs plus jobs for ${activeWorkspace.name}.`
              : 'Showing global jobs only. Select a workspace to create workspace cron jobs.'}
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} disabled={!activeWorkspaceId}>
          <Plus className="size-4 mr-1" />
          New Cron Job
        </Button>
      </div>

      <CronJobsTable />
      <CreateCronDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        workspaceId={activeWorkspaceId}
      />
    </div>
  )
}

function CronJobsTable() {
  const { activeWorkspaceId } = useActiveWorkspace()
  const { data: jobs, isLoading } = useCronJobs({
    workspaceId: activeWorkspaceId,
    includeGlobal: true,
    includeWorkspace: !!activeWorkspaceId,
    includeConversation: !!activeWorkspaceId,
  })
  const toggleMutation = useToggleCronJob()
  const triggerMutation = useTriggerCronJob()
  const deleteMutation = useDeleteCronJob()

  if (isLoading) {
    return <div className="text-muted-foreground">Loading cron jobs...</div>
  }

  if (!jobs || jobs.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground text-sm">
          No cron jobs configured. Create one to get started.
        </CardContent>
      </Card>
    )
  }

  const groupedJobs = SCOPE_ORDER.map((scope) => ({
    scope,
    jobs: jobs.filter((job) => job.scope === scope),
  })).filter((group) => group.jobs.length > 0)

  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Scope</TableHead>
            <TableHead>Schedule</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last Run</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {groupedJobs.map((group) => (
            <Fragment key={group.scope}>
              <TableRow key={`${group.scope}-label`}>
                <TableCell
                  colSpan={7}
                  className="bg-muted/30 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {group.scope === 'global'
                    ? 'Global'
                    : group.scope === 'workspace'
                      ? 'Workspace'
                      : 'Conversation'}
                </TableCell>
              </TableRow>
              {group.jobs.map((job) => (
                <CronJobRow
                  key={job.id}
                  job={job}
                  onToggle={(enabled) => toggleMutation.mutate({ id: job.id, enabled })}
                  onTrigger={() => triggerMutation.mutate(job.id)}
                  onDelete={() => deleteMutation.mutate(job.id)}
                  isToggling={toggleMutation.isPending}
                  isTriggering={triggerMutation.isPending}
                  isDeleting={deleteMutation.isPending}
                />
              ))}
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}

function CronJobRow({
  job,
  onToggle,
  onTrigger,
  onDelete,
  isToggling,
  isTriggering,
  isDeleting,
}: {
  job: CronJob
  onToggle: (enabled: boolean) => void
  onTrigger: () => void
  onDelete: () => void
  isToggling: boolean
  isTriggering: boolean
  isDeleting: boolean
}) {
  return (
    <TableRow>
      <TableCell>
        <div>
          <div className="font-medium text-sm">{job.name}</div>
          {job.description && (
            <div className="text-xs text-muted-foreground mt-0.5">{job.description}</div>
          )}
          {job.scope === 'workspace' && job.workspaceName && (
            <div className="text-xs text-muted-foreground mt-0.5">
              Workspace: {job.workspaceName}
            </div>
          )}
          {job.scope === 'conversation' && (
            <div className="text-xs text-muted-foreground mt-0.5">
              {job.workspaceName ? `${job.workspaceName} · ` : ''}
              {job.conversationTitle ?? 'Untitled conversation'}
            </div>
          )}
        </div>
      </TableCell>
      <TableCell>
        <Badge variant="outline" className="text-xs">
          {job.scopeLabel}
        </Badge>
      </TableCell>
      <TableCell>
        <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{job.schedule}</code>
      </TableCell>
      <TableCell>
        <Badge variant={job.type === 'internal' ? 'secondary' : 'outline'} className="text-xs">
          {job.type}
        </Badge>
        {job.builtin && (
          <Badge variant="secondary" className="text-[10px] ml-1">
            builtin
          </Badge>
        )}
      </TableCell>
      <TableCell>
        <Switch checked={job.enabled} onCheckedChange={onToggle} disabled={isToggling} />
      </TableCell>
      <TableCell>
        {job.lastRunAt ? (
          <div className="flex items-center gap-1.5 text-xs">
            {job.lastRunStatus === 'success' ? (
              <CheckCircle className="size-3.5 text-green-500" />
            ) : (
              <XCircle className="size-3.5 text-destructive" />
            )}
            <span className="text-muted-foreground">{formatRelativeTime(job.lastRunAt)}</span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">Never</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onTrigger}
            disabled={isTriggering}
            title="Run now"
          >
            <Play className="size-3.5" />
          </Button>
          {!job.builtin && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              disabled={isDeleting}
              title="Delete"
            >
              <Trash2 className="size-3.5 text-destructive" />
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}

function CreateCronDialog({
  open,
  onOpenChange,
  workspaceId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string | undefined
}) {
  const [name, setName] = useState('')
  const [schedule, setSchedule] = useState('')
  const [type, setType] = useState('agent')
  const [prompt, setPrompt] = useState('')

  const createMutation = useCreateCronJob()

  const handleSubmit = () => {
    if (!workspaceId) return

    createMutation.mutate(
      { name, schedule, type, prompt: type === 'agent' ? prompt : undefined, workspaceId },
      {
        onSuccess: () => {
          onOpenChange(false)
          setName('')
          setSchedule('')
          setType('agent')
          setPrompt('')
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="size-5" />
            New Cron Job
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Check API status"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Schedule (cron expression)</label>
            <Input
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
              placeholder="*/5 * * * *"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Examples: <code>*/5 * * * *</code> (every 5 min), <code>0 9 * * *</code> (daily 9am),{' '}
              <code>0 */2 * * *</code> (every 2 hours)
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">Type</label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex w-full items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm hover:bg-muted/70 dark:bg-muted/20 dark:hover:bg-muted/40">
                  <span>Agent</span>
                  <ChevronsUpDown className="size-4 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onClick={() => setType('agent')} className="gap-2">
                  <span className="flex-1">Agent</span>
                  {type === 'agent' && <Check className="size-3.5" />}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {type === 'agent' && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Prompt</label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="What should the agent do on each run?"
                rows={4}
                className="flex w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/50 resize-none"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!workspaceId || !name.trim() || !schedule.trim() || createMutation.isPending}
          >
            {createMutation.isPending ? 'Creating...' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now()
  const date = new Date(dateStr).getTime()
  const diffMs = now - date
  const diffMin = Math.floor(diffMs / 60000)

  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDays = Math.floor(diffHr / 24)
  return `${diffDays}d ago`
}

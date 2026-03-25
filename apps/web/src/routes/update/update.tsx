import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  GitBranch,
  Loader2,
  RefreshCw,
  Rocket,
  Wrench,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  hasAvailableUpdate,
  useCheckForUpdates,
  useCreateUpdateRun,
  useDeclineUpdate,
  useRetryUpdateRun,
  useUpdateOverview,
  type UpdateEvent,
  type UpdateRun,
} from '@/hooks/use-update'
import { webBuildInfo } from '@/lib/build-info'

function formatDate(value: string | null | undefined) {
  if (!value) return 'Unknown'
  return new Date(value).toLocaleString()
}

function summarizeReleaseNotes(notes: string | null | undefined) {
  if (!notes?.trim()) {
    return 'This release does not include notes yet. You can still open the release page for the full context.'
  }

  return notes
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, 14)
    .join('\n')
}

function statusBadgeVariant(run: UpdateRun | null) {
  if (!run) return 'outline' as const
  if (run.status === 'succeeded') return 'default' as const
  if (run.status === 'failed' || run.status === 'rolled_back') return 'destructive' as const
  return 'secondary' as const
}

function statusLabel(run: UpdateRun | null) {
  if (!run) return 'No run'
  if (run.status === 'succeeded') return 'Ready'
  if (run.status === 'rolled_back') return 'Rolled back'
  if (run.status === 'failed') return 'Failed'
  if (run.status === 'queued') return 'Queued'
  return 'Running'
}

function eventIcon(event: UpdateEvent) {
  if (event.status === 'done') return <CheckCircle2 className="size-4 text-green-600" />
  if (event.status === 'error') return <XCircle className="size-4 text-destructive" />
  if (event.status === 'running')
    return <Loader2 className="size-4 animate-spin text-muted-foreground" />
  return <Clock3 className="size-4 text-muted-foreground" />
}

function RunSummary({ run }: { run: UpdateRun }) {
  return (
    <Card
      className={
        run.status === 'failed' || run.status === 'rolled_back' ? 'border-destructive/50' : ''
      }
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              {run.status === 'succeeded' ? (
                <CheckCircle2 className="size-5 text-green-600" />
              ) : run.status === 'failed' || run.status === 'rolled_back' ? (
                <AlertTriangle className="size-5 text-destructive" />
              ) : (
                <Loader2 className="size-5 animate-spin" />
              )}
              {run.status === 'succeeded'
                ? `ClawBuddy ${run.targetVersion} is ready`
                : run.status === 'rolled_back'
                  ? `Update to ${run.targetVersion} rolled back`
                  : run.status === 'failed'
                    ? `Update to ${run.targetVersion} failed`
                    : `Updating to ${run.targetVersion}`}
            </CardTitle>
            <CardDescription>
              {run.message ?? 'Waiting for the durable updater controller.'}
            </CardDescription>
          </div>
          <Badge variant={statusBadgeVariant(run)}>{statusLabel(run)}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-md border p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Stage</p>
            <p className="mt-1 font-medium">{run.stage}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Observed version
            </p>
            <p className="mt-1 font-medium">{run.observedVersion ?? 'Waiting'}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Target image</p>
            <p className="mt-1 truncate text-sm">{run.targetImage ?? 'Unknown'}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Started</p>
            <p className="mt-1 font-medium">{formatDate(run.startedAt)}</p>
          </div>
        </div>

        {run.rollbackReason ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {run.rollbackReason}
          </div>
        ) : null}

        {run.error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {run.error}
          </div>
        ) : null}

        <div className="space-y-3">
          <p className="text-sm font-medium">Run timeline</p>
          {run.events.length > 0 ? (
            <div className="space-y-3">
              {run.events.map((event) => (
                <div key={event.id} className="rounded-md border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {eventIcon(event)}
                      <span>{event.step}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {formatDate(event.createdAt)}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">{event.message}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              The durable updater has not emitted timeline events yet.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export function UpdatePage() {
  const navigate = useNavigate()
  const overviewQuery = useUpdateOverview()
  const createRun = useCreateUpdateRun()
  const retryRun = useRetryUpdateRun()
  const declineUpdate = useDeclineUpdate()
  const checkForUpdates = useCheckForUpdates()

  const overview = overviewQuery.data
  const latestRelease = overview?.latestRelease ?? null
  const currentRun = overview?.currentRun ?? null
  const lastTerminalRun = overview?.lastTerminalRun ?? null
  const displayedRun = currentRun ?? lastTerminalRun

  async function handleCheckNow() {
    try {
      const next = await checkForUpdates.mutateAsync()
      toast.success(
        next.latestRelease ? `Latest release: ${next.latestRelease.version}` : 'No release found',
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to check for updates')
    }
  }

  async function handleStartUpdate() {
    try {
      const run = await createRun.mutateAsync()
      toast.success(`Queued update ${run.targetVersion}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to queue update')
    }
  }

  async function handleRetry() {
    if (!displayedRun) return

    try {
      const run = await retryRun.mutateAsync(displayedRun.id)
      toast.success(`Retry queued for ${run.targetVersion}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to retry update')
    }
  }

  async function handleDecline() {
    try {
      await declineUpdate.mutateAsync()
      toast.success('This version was dismissed from the global alert')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to dismiss this release')
    }
  }

  if (overviewQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!overview) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <Card className="w-full max-w-xl">
          <CardHeader>
            <CardTitle>Updater unavailable</CardTitle>
            <CardDescription>Could not load update status.</CardDescription>
          </CardHeader>
          <CardContent className="flex gap-3">
            <Button variant="outline" onClick={() => navigate('/settings/globals/general')}>
              <ArrowLeft className="mr-1 size-4" />
              Back to settings
            </Button>
            <Button onClick={() => overviewQuery.refetch()}>
              <RefreshCw className="mr-1 size-4" />
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const canStartIntegratedUpdate =
    hasAvailableUpdate(overview) && !createRun.isPending && !currentRun && !overview.forceUpdate
  const canRetry =
    !!displayedRun &&
    !currentRun &&
    (displayedRun.status === 'failed' || displayedRun.status === 'rolled_back') &&
    !retryRun.isPending

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-12">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="space-y-2">
            <Badge variant="outline">Current version: {overview.currentVersion}</Badge>
            <h1 className="text-3xl font-semibold tracking-tight">Update ClawBuddy</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              The updater page is now fully server-driven. Progress, retries, rollback reasons, and
              verification all come from the durable controller instead of browser-local state.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" onClick={() => navigate('/settings/globals/general')}>
              <ArrowLeft className="mr-1 size-4" />
              Back to settings
            </Button>
            <Button variant="outline" onClick={handleCheckNow} disabled={checkForUpdates.isPending}>
              <RefreshCw className="mr-1 size-4" />
              {checkForUpdates.isPending ? 'Checking...' : 'Check now'}
            </Button>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.15fr,0.85fr]">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <GitBranch className="size-5" />
                Latest release
              </CardTitle>
              <CardDescription>
                Review the latest stable release and its delivery mode.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md border p-4">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Installed</p>
                  <p className="mt-1 text-lg font-semibold">{overview.currentVersion}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Build {webBuildInfo.version} · Commit {webBuildInfo.commitSha.slice(0, 7)}
                  </p>
                </div>
                <div className="rounded-md border p-4">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Latest stable
                  </p>
                  <p className="mt-1 text-lg font-semibold">
                    {latestRelease?.version ?? 'Unavailable'}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {latestRelease
                      ? formatDate(latestRelease.publishedAt)
                      : 'GitHub lookup unavailable'}
                  </p>
                </div>
              </div>

              {latestRelease ? (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">{latestRelease.name}</Badge>
                    <Badge
                      variant={
                        latestRelease.manifest?.deliveryMode === 'maintenance-required'
                          ? 'destructive'
                          : 'secondary'
                      }
                    >
                      {latestRelease.manifest?.deliveryMode === 'maintenance-required'
                        ? 'Maintenance release'
                        : 'Integrated release'}
                    </Badge>
                    {latestRelease.manifest?.migration.mode === 'prisma-db-push' ? (
                      <Badge variant="outline">Explicit migration</Badge>
                    ) : null}
                  </div>

                  <div className="rounded-md border p-4">
                    <div className="prose prose-sm max-w-none dark:prose-invert prose-p:my-2 prose-li:my-1">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {summarizeReleaseNotes(latestRelease.body)}
                      </ReactMarkdown>
                    </div>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  GitHub release information is not available right now.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {overview.eligibility.deliveryMode === 'maintenance-required' ? (
                  <Wrench className="size-5" />
                ) : (
                  <Rocket className="size-5" />
                )}
                Delivery status
              </CardTitle>
              <CardDescription>
                Decide whether this release can be applied by the durable in-app updater.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {!overview.supported ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
                  {overview.supportReason ??
                    'Integrated updates are unavailable on this installation.'}
                </div>
              ) : overview.eligibility.reason ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
                  {overview.eligibility.reason}
                </div>
              ) : (
                <div className="rounded-md border border-green-500/40 bg-green-500/5 p-4 text-sm text-green-700 dark:text-green-400">
                  The durable updater can apply this release in-place.
                </div>
              )}

              {overview.dismissedVersion ? (
                <p className="text-xs text-muted-foreground">
                  Dismissed globally: {overview.dismissedVersion}
                </p>
              ) : null}

              <div className="flex flex-wrap gap-3">
                <Button onClick={handleStartUpdate} disabled={!canStartIntegratedUpdate}>
                  <Rocket className="mr-1 size-4" />
                  {createRun.isPending ? 'Queueing...' : 'Start integrated update'}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleDecline}
                  disabled={!latestRelease || declineUpdate.isPending || !!currentRun}
                >
                  {declineUpdate.isPending ? 'Saving...' : 'Decline for now'}
                </Button>
                <Button variant="outline" onClick={handleRetry} disabled={!canRetry}>
                  {retryRun.isPending ? 'Queueing retry...' : 'Retry last run'}
                </Button>
              </div>

              {latestRelease?.manifest?.minUpdaterVersion ? (
                <p className="text-xs text-muted-foreground">
                  Minimum updater version: {latestRelease.manifest.minUpdaterVersion}
                </p>
              ) : null}
            </CardContent>
          </Card>
        </div>

        {displayedRun ? <RunSummary run={displayedRun} /> : null}
      </div>
    </div>
  )
}

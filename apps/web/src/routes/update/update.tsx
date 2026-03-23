import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Loader2,
  RefreshCw,
  Rocket,
  Sparkles,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { apiClient } from '@/lib/api-client'
import { webBuildInfo } from '@/lib/build-info'
import { POLL_UPDATE_STATUS_MS } from '@/constants'
import {
  useAcceptUpdate,
  useCheckForUpdates,
  useDeclineUpdate,
  type UpdateOverview,
} from '@/hooks/use-update'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'

function summarizeReleaseNotes(notes: string | null | undefined) {
  if (!notes?.trim()) {
    return 'This release does not include notes yet. You can still open the GitHub release page for the full context.'
  }

  const lines = notes
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(0, 14)

  return lines.join('\n')
}

function formatDate(value: string | null | undefined) {
  if (!value) return 'Unknown'
  return new Date(value).toLocaleString()
}

function StepBadge({ status }: { status: 'pending' | 'running' | 'done' | 'error' }) {
  if (status === 'done') {
    return (
      <Badge variant="default">
        <CheckCircle2 className="mr-1 size-3" /> Done
      </Badge>
    )
  }

  if (status === 'running') {
    return (
      <Badge variant="secondary">
        <Loader2 className="mr-1 size-3 animate-spin" /> In progress
      </Badge>
    )
  }

  if (status === 'error') {
    return (
      <Badge variant="destructive">
        <XCircle className="mr-1 size-3" /> Error
      </Badge>
    )
  }

  return <Badge variant="secondary">Waiting</Badge>
}

function UpdateStepCard({
  title,
  description,
  status,
  icon: Icon,
  children,
}: {
  title: string
  description: string
  status: 'pending' | 'running' | 'done' | 'error'
  icon: typeof Sparkles
  children?: ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Icon className="size-5" />
              {title}
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <StepBadge status={status} />
        </div>
      </CardHeader>
      {children ? <CardContent>{children}</CardContent> : null}
    </Card>
  )
}

function ProgressLine({
  label,
  status,
  progress,
  error,
}: {
  label: string
  status: 'pending' | 'running' | 'done' | 'error'
  progress: string
  error?: string
}) {
  return (
    <div className="rounded-md border p-4 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        <StepBadge status={status} />
      </div>
      <p className="text-xs text-muted-foreground truncate">{progress}</p>
      {error ? <p className="text-xs text-destructive break-words">{error}</p> : null}
    </div>
  )
}

export function UpdatePage() {
  const navigate = useNavigate()
  const acceptUpdate = useAcceptUpdate()
  const declineUpdate = useDeclineUpdate()
  const checkForUpdates = useCheckForUpdates()
  const [overview, setOverview] = useState<UpdateOverview | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [rolloutTargetVersion, setRolloutTargetVersion] = useState<string | null>(null)

  const loadOverview = useCallback(async (silent = false) => {
    try {
      const next = await apiClient.get<UpdateOverview>('/update')
      setOverview(next)
      setRequestError(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load update status'
      setRequestError(message)
    } finally {
      if (!silent) {
        setIsLoading(false)
      }
    }
  }, [])

  const forceUpdate = overview?.forceUpdate ?? false
  const activeRun = overview?.activeRun ?? null
  const latestRelease = overview?.latestRelease ?? null
  const targetVersion =
    rolloutTargetVersion ?? activeRun?.targetVersion ?? latestRelease?.version ?? null
  const isRunning = !!activeRun && activeRun.status !== 'failed'
  const [forceModal, setForceModal] = useState(false)
  const [updateReady, setUpdateReady] = useState(false)
  const showModal = isRunning || updateReady || (forceUpdate && forceModal)

  useEffect(() => {
    void loadOverview(false)
  }, [loadOverview])

  useEffect(() => {
    const interval = window.setInterval(() => {
      void loadOverview(true)
    }, POLL_UPDATE_STATUS_MS)

    return () => window.clearInterval(interval)
  }, [loadOverview])

  useEffect(() => {
    if (activeRun?.targetVersion) {
      setRolloutTargetVersion(activeRun.targetVersion)
      return
    }

    if (overview?.currentVersion === rolloutTargetVersion) {
      setRolloutTargetVersion(null)
    }
  }, [activeRun?.targetVersion, overview?.currentVersion, rolloutTargetVersion])

  useEffect(() => {
    if (!targetVersion || (!activeRun && latestRelease?.version !== targetVersion)) {
      return
    }

    const shouldProbeApi =
      activeRun?.phase === 'waiting-for-api' ||
      activeRun?.phase === 'completed' ||
      (!!rolloutTargetVersion && overview?.currentVersion !== rolloutTargetVersion)

    if (!shouldProbeApi) {
      return
    }

    let cancelled = false
    const interval = window.setInterval(async () => {
      try {
        const res = await fetch(`/api/health?t=${Date.now()}`, {
          credentials: 'include',
          cache: 'no-store',
        })
        const payload = (await res.json()) as {
          data?: { version?: string; phase?: string; status?: string }
        }

        if (!cancelled && res.ok && payload.data?.version === targetVersion) {
          setUpdateReady(true)
        }
      } catch {
        // Keep polling while the service restarts.
      }
    }, POLL_UPDATE_STATUS_MS)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [
    activeRun,
    latestRelease?.version,
    overview?.currentVersion,
    rolloutTargetVersion,
    targetVersion,
  ])

  const releaseStatus = useMemo(() => {
    if (!overview?.supported) return 'error'
    if (!latestRelease) return 'pending'
    if (overview.currentVersion === latestRelease.version && !activeRun) return 'done'
    return 'done'
  }, [activeRun, latestRelease, overview?.currentVersion, overview?.supported])

  const decisionStatus = useMemo(() => {
    if (!overview?.supported) return 'error'
    if (activeRun && activeRun.status === 'failed') return 'error'
    if (activeRun) return 'done'
    if (latestRelease && overview.currentVersion !== latestRelease.version) return 'running'
    return 'done'
  }, [activeRun, latestRelease, overview?.currentVersion, overview?.supported])

  async function handleCheckNow() {
    try {
      const next = await checkForUpdates.mutateAsync()
      setOverview(next)
      toast.success(
        next.latestRelease ? `Latest release: ${next.latestRelease.version}` : 'No release found',
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to check for updates')
    }
  }

  async function handleAccept() {
    try {
      const next = await acceptUpdate.mutateAsync()
      setOverview(next)
      if (next.activeRun?.targetVersion) {
        setRolloutTargetVersion(next.activeRun.targetVersion)
      }
      toast.success('Update started')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to start the update')
    }
  }

  async function handleDecline() {
    try {
      const next = await declineUpdate.mutateAsync()
      setOverview(next)
      toast.success('This version was dismissed from the global alert')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to dismiss this release')
    }
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Spinner className="text-brand" />
      </div>
    )
  }

  if (!overview) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <Card className="w-full max-w-xl">
          <CardHeader>
            <CardTitle>Updater unavailable</CardTitle>
            <CardDescription>{requestError ?? 'Could not load update status.'}</CardDescription>
          </CardHeader>
          <CardContent className="flex gap-3">
            <Button variant="outline" onClick={() => navigate('/settings/globals/general')}>
              <ArrowLeft className="mr-1 size-4" />
              Back to settings
            </Button>
            <Button onClick={() => void loadOverview(false)}>
              <RefreshCw className="mr-1 size-4" />
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-12">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="space-y-2">
            <Badge variant="outline">Current version: {overview.currentVersion}</Badge>
            <h1 className="text-3xl font-semibold tracking-tight">Update ClawBuddy</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              This page stays focused on the rollout itself so it can keep tracking progress while
              the service restarts and the new build comes online.
            </p>
          </div>
          <div className="flex gap-3">
            <Button variant="outline" onClick={() => navigate('/settings/globals/general')}>
              <ArrowLeft className="mr-1 size-4" />
              Back to settings
            </Button>
            <Button variant="outline" onClick={handleCheckNow} disabled={checkForUpdates.isPending}>
              <RefreshCw className="mr-1 size-4" />
              {checkForUpdates.isPending ? 'Checking...' : 'Check now'}
            </Button>
            {forceUpdate && (
              <Button variant="outline" onClick={() => setForceModal(true)}>
                <Rocket className="mr-1 size-4" />
                Preview modal
              </Button>
            )}
          </div>
        </div>

        {!overview.supported ? (
          <Card className="border-destructive/50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="size-5 text-destructive" />
                Integrated updates are unavailable here
              </CardTitle>
              <CardDescription>
                {overview.supportReason ??
                  'This environment is not a managed ClawBuddy Swarm install.'}
              </CardDescription>
            </CardHeader>
          </Card>
        ) : null}

        <div className="grid gap-4 xl:grid-cols-[1.1fr,0.9fr]">
          <UpdateStepCard
            title="Check New Version"
            description="Review the latest stable GitHub release before starting."
            icon={Sparkles}
            status={releaseStatus}
          >
            <div className="space-y-4">
              <div className="flex flex-col gap-3 rounded-md border p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Installed</p>
                  <p className="text-lg font-semibold">{overview.currentVersion}</p>
                </div>
                <ChevronRight className="hidden size-5 text-muted-foreground sm:block" />
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Latest release
                  </p>
                  <p className="text-lg font-semibold">{latestRelease?.version ?? 'Unavailable'}</p>
                  <p className="text-xs text-muted-foreground">
                    {latestRelease
                      ? formatDate(latestRelease.publishedAt)
                      : 'GitHub release lookup failed'}
                  </p>
                </div>
              </div>

              {latestRelease ? (
                <div className="space-y-3">
                  <div className="rounded-md border p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">{latestRelease.name}</p>
                        <p className="text-xs text-muted-foreground">{latestRelease.url}</p>
                      </div>
                      <Badge variant="outline">Stable channel</Badge>
                    </div>
                    <div className="prose prose-sm max-w-none dark:prose-invert prose-p:my-2 prose-li:my-1">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {summarizeReleaseNotes(latestRelease.body)}
                      </ReactMarkdown>
                    </div>
                  </div>
                  {overview.currentVersion === latestRelease.version && !activeRun ? (
                    <p className="text-sm text-muted-foreground">
                      This instance is already on the latest stable release.
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  GitHub release information is not available right now. You can retry the check
                  from this page or from Settings.
                </p>
              )}
            </div>
          </UpdateStepCard>

          <UpdateStepCard
            title="Accept or Decline"
            description="Start the rollout or dismiss this release from the global toast."
            icon={Rocket}
            status={decisionStatus}
          >
            <div className="space-y-4">
              <div className="rounded-md border p-4">
                <p className="text-sm text-muted-foreground">
                  Build: {webBuildInfo.version} · Commit {webBuildInfo.commitSha.slice(0, 7)}
                </p>
                {overview.dismissedVersion ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Dismissed globally: {overview.dismissedVersion}
                  </p>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-3">
                <Button
                  onClick={handleAccept}
                  disabled={
                    !latestRelease ||
                    !overview.supported ||
                    acceptUpdate.isPending ||
                    (!!activeRun && activeRun.status !== 'failed') ||
                    overview.currentVersion === latestRelease.version
                  }
                >
                  <Rocket className="mr-1 size-4" />
                  {acceptUpdate.isPending ? 'Starting...' : 'Accept update'}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleDecline}
                  disabled={
                    !latestRelease ||
                    declineUpdate.isPending ||
                    (!!activeRun && activeRun.status !== 'failed')
                  }
                >
                  {declineUpdate.isPending ? 'Saving...' : 'Decline for now'}
                </Button>
              </div>

              {activeRun ? (
                <p className="text-sm text-muted-foreground">
                  Active rollout: {activeRun.targetVersion}. This page will keep polling until the
                  updated service reports the target version.
                </p>
              ) : null}
            </div>
          </UpdateStepCard>
        </div>

        {activeRun?.error ? (
          <Card className="border-destructive/50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="size-5 text-destructive" />
                Update failed
              </CardTitle>
              <CardDescription>{activeRun.error}</CardDescription>
            </CardHeader>
          </Card>
        ) : null}

        <Dialog
          open={showModal}
          onOpenChange={(open) => {
            if (!isRunning && !updateReady) setForceModal(open)
          }}
        >
          <DialogContent
            showCloseButton={forceUpdate && !isRunning && !updateReady}
            onEscapeKeyDown={(e) => {
              if (isRunning || updateReady) e.preventDefault()
            }}
            onPointerDownOutside={(e) => {
              if (isRunning || updateReady) e.preventDefault()
            }}
            onInteractOutside={(e) => {
              if (isRunning || updateReady) e.preventDefault()
            }}
            className="sm:max-w-lg max-h-[85vh] overflow-y-auto"
          >
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {updateReady ? (
                  <CheckCircle2 className="size-5 text-green-500" />
                ) : (
                  <Loader2 className="size-5 animate-spin" />
                )}
                {updateReady
                  ? `ClawBuddy ${targetVersion} is ready`
                  : `Updating to ${activeRun?.targetVersion ?? latestRelease?.version ?? 'vX.X.X'}`}
              </DialogTitle>
              <DialogDescription>
                {updateReady
                  ? 'The new version has been deployed successfully. Reload to start using it.'
                  : `${activeRun?.phaseMessage ?? 'Preparing update'}. Please wait while the update completes.`}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              <ProgressLine
                label="Pull release image"
                {...(activeRun?.progress.pullApi ?? {
                  status: forceUpdate ? 'done' : 'pending',
                  progress: forceUpdate ? 'Release image ready (v0.1.8)' : 'Waiting',
                })}
              />
              <ProgressLine
                label="Deploy unified service"
                {...(activeRun?.progress.apiDeploy ?? {
                  status: forceUpdate ? (updateReady ? 'done' : 'running') : 'pending',
                  progress: updateReady
                    ? `ClawBuddy ${targetVersion} is deployed`
                    : forceUpdate
                      ? 'Waiting for the service to restart'
                      : 'Waiting for the image pull',
                })}
              />
            </div>

            {updateReady ? (
              <Button className="w-full" onClick={() => (window.location.href = '/')}>
                <RefreshCw className="mr-1 size-4" />
                Reload and go to home
              </Button>
            ) : requestError ? (
              <p className="text-xs text-muted-foreground">
                {requestError} — the rollout may still be progressing while the API restarts.
              </p>
            ) : null}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}

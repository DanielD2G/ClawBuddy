import { useNavigate } from 'react-router-dom'
import { RefreshCw, Rocket, GitBranch } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useCheckForUpdates, useUpdateOverview } from '@/hooks/use-update'

function formatDate(value: string | null | undefined) {
  if (!value) return 'Unknown'
  return new Date(value).toLocaleString()
}

export function UpdateCard() {
  const navigate = useNavigate()
  const { data } = useUpdateOverview(false)
  const checkForUpdates = useCheckForUpdates()

  async function handleCheckNow() {
    try {
      const next = await checkForUpdates.mutateAsync()
      toast.success(
        next.latestRelease
          ? `Latest stable release: ${next.latestRelease.version}`
          : 'No stable release is available right now',
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to check for updates')
    }
  }

  const latest = data?.latestRelease ?? null
  const hasUpdate = !!latest && data?.currentVersion !== latest.version

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Rocket className="size-5" />
              Updates
            </CardTitle>
            <CardDescription>
              Track the installed version and jump into the standalone rollout page.
            </CardDescription>
          </div>
          <Badge variant={hasUpdate ? 'default' : 'outline'}>
            {hasUpdate ? 'Update available' : 'Stable channel'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border bg-muted/30 p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Installed</p>
            <p className="mt-1 text-lg font-semibold">{data?.currentVersion ?? 'Loading...'}</p>
          </div>
          <div className="rounded-md border bg-muted/30 p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Latest stable</p>
            <p className="mt-1 text-lg font-semibold">{latest?.version ?? 'Unavailable'}</p>
            {latest ? (
              <p className="mt-1 text-xs text-muted-foreground">{formatDate(latest.publishedAt)}</p>
            ) : null}
          </div>
        </div>

        {!data?.supported ? (
          <div className="rounded-md border border-destructive/40 p-3 text-sm text-muted-foreground">
            Integrated updates are unavailable here.
            {data?.supportReason ? ` ${data.supportReason}` : ''}
          </div>
        ) : null}

        {latest?.name ? (
          <div className="rounded-md border p-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <GitBranch className="size-4" />
              {latest.name}
            </p>
            <p className="mt-1 max-h-16 overflow-hidden text-xs text-muted-foreground">
              {latest.body?.trim() || 'Open the update page to review the release notes.'}
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <Button variant="outline" onClick={handleCheckNow} disabled={checkForUpdates.isPending}>
            <RefreshCw className="mr-1 size-4" />
            {checkForUpdates.isPending ? 'Checking...' : 'Check now'}
          </Button>
          <Button onClick={() => navigate('/update')} disabled={(!hasUpdate || !data?.supported) && !data?.forceUpdate}>
            <Rocket className="mr-1 size-4" />
            Open updater
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

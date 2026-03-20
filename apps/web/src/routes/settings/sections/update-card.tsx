import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useUpdateCheck, useCurrentVersion } from '@/hooks/use-update'
import { RefreshCw, CheckCircle2, ArrowUpCircle } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

export function UpdateCard() {
  const queryClient = useQueryClient()
  const { data: versionData } = useCurrentVersion()
  const { data: updateData, isFetching, dataUpdatedAt } = useUpdateCheck()

  const handleManualCheck = async () => {
    try {
      await queryClient.refetchQueries({ queryKey: ['update-check'] })
    } catch {
      toast.error('Could not check for updates. Check your internet connection.')
    }
  }

  const lastChecked = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString()
    : null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="tracking-tight">Software Update</CardTitle>
        <CardDescription>
          Current version:{' '}
          <span className="font-mono font-medium text-foreground">
            v{versionData?.currentVersion ?? '0.0.0'}
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {updateData?.updateAvailable ? (
          <div className="flex items-center gap-3 rounded-md border border-emerald-500/20 bg-emerald-500/5 p-3">
            <ArrowUpCircle className="size-4 text-emerald-500 shrink-0" />
            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium">
                Version{' '}
                <span className="font-mono font-semibold">v{updateData.latestVersion}</span>{' '}
                is available
              </span>
            </div>
          </div>
        ) : updateData && !updateData.updateAvailable ? (
          <div className="flex items-center gap-3 rounded-md border border-emerald-500/20 bg-emerald-500/5 p-3">
            <CheckCircle2 className="size-4 text-emerald-500 shrink-0" />
            <span className="text-sm text-muted-foreground">
              You are running the latest version.
            </span>
          </div>
        ) : null}

        <div className="flex items-center justify-between pt-2 border-t border-border/50">
          <span className="text-xs text-muted-foreground">
            {lastChecked ? `Last checked: ${lastChecked}` : 'Not checked yet'}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={handleManualCheck}
            disabled={isFetching}
          >
            {isFetching ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RefreshCw data-icon="inline-start" />
            )}
            Check for updates
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

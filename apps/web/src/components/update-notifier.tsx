import { useEffect, useRef, useState, useCallback } from 'react'
import { toast } from 'sonner'
import { useUpdateCheck } from '@/hooks/use-update'
import { apiClient } from '@/lib/api-client'
import {
  UPDATE_HEALTH_POLL_MS,
  UPDATE_INITIAL_DELAY_MS,
  UPDATE_TIMEOUT_MS,
} from '@/constants'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ArrowUpCircle, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react'

type UpdateStage = 'confirm' | 'updating' | 'waiting' | 'complete' | 'error'

export function UpdateNotifier() {
  const { data: updateData } = useUpdateCheck()
  const toastShownRef = useRef(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [stage, setStage] = useState<UpdateStage>('confirm')
  const [errorMessage, setErrorMessage] = useState('')
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Show a one-time toast when an update is first detected
  useEffect(() => {
    if (updateData?.updateAvailable && !toastShownRef.current) {
      toastShownRef.current = true
      toast.info(`ClawBuddy v${updateData.latestVersion} is available`, {
        duration: 10_000,
        action: {
          label: 'View details',
          onClick: () => setDialogOpen(true),
        },
      })
    }
  }, [updateData?.updateAvailable, updateData?.latestVersion])

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current)
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  const cleanup = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  const startHealthPolling = useCallback(
    (targetVersion: string) => {
      const startTime = Date.now()

      pollingRef.current = setInterval(async () => {
        if (Date.now() - startTime > UPDATE_TIMEOUT_MS) {
          cleanup()
          setErrorMessage(
            'Update timed out. The server may still be updating. Try refreshing the page in a few moments, or run `bash bootstrap.sh --update` manually.',
          )
          setStage('error')
          return
        }

        try {
          const res = await fetch('/api/health')
          if (res.ok) {
            const json = (await res.json()) as {
              success: boolean
              data: { status: string; version: string }
            }
            if (json.data?.version === targetVersion) {
              cleanup()
              setStage('complete')
              setTimeout(() => window.location.reload(), 2000)
            }
          }
        } catch {
          // Connection refused — server is restarting, keep polling
        }
      }, UPDATE_HEALTH_POLL_MS)
    },
    [cleanup],
  )

  const handleUpdate = useCallback(async () => {
    if (!updateData?.latestVersion) return

    const targetVersion = updateData.latestVersion
    setStage('updating')

    try {
      await apiClient.post('/admin/update/apply', { version: targetVersion })
    } catch {
      // Server might have started updating already — continue to polling
    }

    setStage('waiting')
    timeoutRef.current = setTimeout(() => {
      startHealthPolling(targetVersion)
    }, UPDATE_INITIAL_DELAY_MS)
  }, [updateData?.latestVersion, startHealthPolling])

  const handleRetry = useCallback(() => {
    cleanup()
    setErrorMessage('')
    handleUpdate()
  }, [cleanup, handleUpdate])

  const handleClose = useCallback(() => {
    if (stage === 'confirm' || stage === 'error') {
      cleanup()
      setDialogOpen(false)
      setStage('confirm')
      setErrorMessage('')
    }
  }, [stage, cleanup])

  if (!updateData?.updateAvailable) return null

  return (
    <Dialog open={dialogOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent
        showCloseButton={stage === 'confirm' || stage === 'error'}
        className="sm:max-w-md"
        onInteractOutside={(e) => {
          if (stage !== 'confirm' && stage !== 'error') e.preventDefault()
        }}
        onEscapeKeyDown={(e) => {
          if (stage !== 'confirm' && stage !== 'error') e.preventDefault()
        }}
      >
        {/* ── Confirm ──────────────────────────────── */}
        {stage === 'confirm' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-lg tracking-tight">
                <ArrowUpCircle className="size-5 text-brand" />
                Update Available
              </DialogTitle>
              <DialogDescription>
                A new version of ClawBuddy is ready to install.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3">
              {/* Version comparison */}
              <div className="flex items-center gap-3 rounded-md border p-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    Current
                  </span>
                  <span className="font-mono text-sm font-medium">
                    v{updateData.currentVersion}
                  </span>
                </div>
                <div className="flex-1 border-t border-dashed border-border/60" />
                <div className="flex flex-col items-end gap-0.5">
                  <span className="text-[10px] uppercase tracking-widest text-brand">
                    New
                  </span>
                  <span className="font-mono text-sm font-semibold">
                    v{updateData.latestVersion}
                  </span>
                </div>
              </div>

              {/* Release notes */}
              {updateData.releaseNotes && (
                <div className="max-h-40 overflow-y-auto rounded-md border bg-muted/30 p-3">
                  <p className="mb-1 text-[10px] uppercase tracking-widest text-muted-foreground">
                    Release Notes
                  </p>
                  <p className="whitespace-pre-wrap text-xs text-muted-foreground leading-relaxed">
                    {updateData.releaseNotes}
                  </p>
                </div>
              )}

              {/* Warning */}
              <div className="flex items-start gap-2.5 rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                <p className="text-xs text-amber-700 dark:text-amber-300 leading-relaxed">
                  The application will restart during the update. Active sessions will be
                  briefly interrupted. This usually takes less than 30 seconds.
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                onClick={handleUpdate}
                className="bg-brand text-brand-foreground hover:bg-brand/90"
              >
                Update now
              </Button>
            </DialogFooter>
          </>
        )}

        {/* ── Updating ─────────────────────────────── */}
        {stage === 'updating' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-lg tracking-tight">
                <Spinner className="size-5 text-brand" />
                Updating...
              </DialogTitle>
              <DialogDescription>
                Pulling new images and updating services. Please wait.
              </DialogDescription>
            </DialogHeader>
            <UpdateProgress progress={30} label="Downloading update..." />
          </>
        )}

        {/* ── Waiting ──────────────────────────────── */}
        {stage === 'waiting' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-lg tracking-tight">
                <Spinner className="size-5 text-brand" />
                Restarting...
              </DialogTitle>
              <DialogDescription>
                Waiting for the server to come back online with the new version.
              </DialogDescription>
            </DialogHeader>
            <UpdateProgress progress={70} label="Waiting for server..." />
          </>
        )}

        {/* ── Complete ─────────────────────────────── */}
        {stage === 'complete' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-lg tracking-tight">
                <CheckCircle2 className="size-5 text-emerald-500" />
                Update Complete
              </DialogTitle>
              <DialogDescription>
                ClawBuddy has been updated to v{updateData.latestVersion}. The page will
                reload automatically.
              </DialogDescription>
            </DialogHeader>
            <UpdateProgress progress={100} label="Reloading..." />
          </>
        )}

        {/* ── Error ────────────────────────────────── */}
        {stage === 'error' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-lg tracking-tight">
                <XCircle className="size-5 text-destructive" />
                Update Failed
              </DialogTitle>
              <DialogDescription>{errorMessage}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={handleClose}>
                Close
              </Button>
              <Button
                onClick={handleRetry}
                className="bg-brand text-brand-foreground hover:bg-brand/90"
              >
                Retry
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ── Progress indicator ─────────────────────────────
// Matches the setup step-nav progress bar style

function UpdateProgress({ progress, label }: { progress: number; label: string }) {
  return (
    <div className="flex flex-col gap-2 py-4">
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-brand transition-all duration-500 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground text-center">{label}</span>
    </div>
  )
}

import { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { ChevronRight, ChevronLeft, Container, CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { apiClient } from '@/lib/api-client'
import { POLL_DOCKER_IMAGES_MS } from '@/constants'

interface ImageTaskState {
  status: 'idle' | 'pulling' | 'done' | 'error'
  progress: string
  error?: string
}

function ImageRow({ label, state }: { label: string; state: ImageTaskState }) {
  const isDone = state.status === 'done'
  const isPulling = state.status === 'pulling'
  const isError = state.status === 'error'

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Container className="size-4" />
          <span className="text-sm font-medium">{label}</span>
        </div>
        {isDone && <Badge variant="default"><CheckCircle2 className="mr-1 size-3" /> Ready</Badge>}
        {isPulling && <Badge variant="secondary"><Loader2 className="mr-1 size-3 animate-spin" /> Building</Badge>}
        {isError && <Badge variant="destructive"><XCircle className="mr-1 size-3" /> Error</Badge>}
        {state.status === 'idle' && <Badge variant="secondary">Waiting</Badge>}
      </div>

      {isPulling && (
        <div className="space-y-1">
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div className="h-full bg-brand rounded-full animate-pulse" style={{ width: '60%' }} />
          </div>
          <p className="text-xs text-muted-foreground truncate">{state.progress}</p>
        </div>
      )}

      {isDone && (
        <p className="text-xs text-muted-foreground">{state.progress}</p>
      )}

      {isError && (
        <p className="text-xs text-destructive">{state.error}</p>
      )}
    </div>
  )
}

interface StepDockerImagesProps {
  onBack: () => void
  onNext: () => void
  isCompleting: boolean
  hasConfigStep: boolean
}

export function StepDockerImages({
  onBack,
  onNext,
  isCompleting,
  hasConfigStep,
}: StepDockerImagesProps) {
  const [images, setImages] = useState<{
    status: string
    sandbox: ImageTaskState
  }>({
    status: 'idle',
    sandbox: { status: 'idle', progress: '' },
  })

  const startPull = async () => {
    try {
      const res = await apiClient.post<{
        status: string
        sandbox: ImageTaskState
      }>('/setup/pull-images', {})
      setImages({ status: res.status, sandbox: res.sandbox })
    } catch {
      setImages({
        status: 'error',
        sandbox: { status: 'error', progress: '', error: 'Failed to connect to Docker' },
      })
    }
  }

  // Poll for status while pulling
  useEffect(() => {
    if (images.status !== 'pulling' && images.status !== 'idle') return
    if (images.status === 'idle' && images.sandbox.status === 'idle') return

    const interval = setInterval(async () => {
      try {
        const res = await apiClient.get<{
          status: string
          sandbox: ImageTaskState
        }>('/setup/pull-images/status')
        setImages({ status: res.status, sandbox: res.sandbox })
        if (res.status === 'done' || res.status === 'error') {
          clearInterval(interval)
        }
      } catch {
        // Ignore poll errors
      }
    }, POLL_DOCKER_IMAGES_MS)

    return () => clearInterval(interval)
  }, [images.status, images.sandbox.status])

  // Auto-start on mount
  useEffect(() => {
    startPull()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const hasError = images.sandbox.status === 'error'

  return (
    <Card>
      <CardHeader>
        <CardTitle>Docker Images</CardTitle>
        <CardDescription>
          Preparing Docker images so everything is ready when you start.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ImageRow label="Sandbox Base" state={images.sandbox} />

        {hasError && (
          <Button variant="outline" size="sm" onClick={startPull}>
            Retry
          </Button>
        )}

        <p className="text-xs text-muted-foreground">
          You can skip this step — images will be pulled on first use.
        </p>

        <div className="flex justify-between mt-2">
          <Button variant="outline" onClick={onBack}>
            <ChevronLeft className="size-4 mr-1" />
            Back
          </Button>
          <Button
            onClick={onNext}
            disabled={isCompleting}
            className="bg-brand text-brand-foreground hover:bg-brand/90"
          >
            {isCompleting ? <Spinner className="size-4 mr-1" /> : null}
            {hasConfigStep ? (
              <>
                Next
                <ChevronRight className="size-4 ml-1" />
              </>
            ) : (
              'Complete Setup'
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

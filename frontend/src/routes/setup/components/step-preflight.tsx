import { useState, useEffect } from 'react'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  ChevronRight,
  ChevronLeft,
  CheckCircle2,
  XCircle,
  MinusCircle,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import { apiClient } from '@/lib/api-client'

interface CheckResult {
  name: string
  status: 'pass' | 'fail' | 'skip'
  message: string
  durationMs: number
}

interface PreflightResponse {
  checks: CheckResult[]
  allPassed: boolean
}

const statusIcon = {
  pass: <CheckCircle2 className="size-4 text-emerald-500 shrink-0" />,
  fail: <XCircle className="size-4 text-destructive shrink-0" />,
  skip: <MinusCircle className="size-4 text-muted-foreground shrink-0" />,
}

const statusBg = {
  pass: 'border-emerald-500/20 bg-emerald-500/5',
  fail: 'border-destructive/20 bg-destructive/5',
  skip: 'border-muted bg-muted/30',
}

interface StepPreflightProps {
  capabilities: string[]
  browserGridUrl: string
  onBack: () => void
  onNext: () => void
  isCompleting: boolean
  hasConfigStep: boolean
}

export function StepPreflight({
  capabilities,
  browserGridUrl,
  onBack,
  onNext,
  isCompleting,
  hasConfigStep,
}: StepPreflightProps) {
  const [result, setResult] = useState<PreflightResponse | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const runChecks = async () => {
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const res = await apiClient.post<PreflightResponse>('/setup/preflight', {
        capabilities,
        browserGridUrl,
      })
      setResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preflight check failed')
    } finally {
      setRunning(false)
    }
  }

  useEffect(() => {
    runChecks()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const failCount = result?.checks.filter((c) => c.status === 'fail').length ?? 0

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <ShieldCheck className="size-5" />
          Preflight Check
        </h2>
        <p className="text-muted-foreground mt-1">
          Verifying that all services are configured correctly before completing setup.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        {running && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Running checks...
          </div>
        )}

        {error && !result && (
          <div className="rounded-md border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">
            {error}
          </div>
        )}

        {result && (
          <>
            <div className="space-y-1.5">
              {result.checks.map((check) => (
                <div
                  key={check.name}
                  className={`flex items-start gap-3 rounded-md border p-3 ${statusBg[check.status]}`}
                >
                  <div className="mt-0.5">{statusIcon[check.status]}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">{check.name}</span>
                      {check.durationMs > 0 && (
                        <span className="text-[10px] tabular-nums text-muted-foreground shrink-0">
                          {check.durationMs}ms
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 break-words">
                      {check.message}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {result.allPassed && (
              <p className="text-sm text-emerald-600 font-medium text-center mt-1">
                All checks passed
              </p>
            )}

            {failCount > 0 && (
              <div className="flex items-center justify-between">
                <p className="text-sm text-destructive font-medium">
                  {failCount} check{failCount > 1 ? 's' : ''} failed
                </p>
                <Button variant="outline" size="sm" onClick={runChecks} disabled={running}>
                  <RefreshCw className={`size-3 mr-1.5 ${running ? 'animate-spin' : ''}`} />
                  Re-run
                </Button>
              </div>
            )}
          </>
        )}

        <div className="flex justify-between mt-8 pt-6 border-t border-border/50">
          <Button variant="ghost" onClick={onBack}>
            <ChevronLeft className="size-4 mr-1" />
            Back
          </Button>
          <Button
            onClick={onNext}
            disabled={isCompleting || running}
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
      </div>
    </div>
  )
}

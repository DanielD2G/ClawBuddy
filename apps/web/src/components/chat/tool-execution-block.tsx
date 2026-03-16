import { useState } from 'react'
import { ChevronDown, ChevronRight, CheckCircle2, XCircle, Loader2, Download, FileText } from 'lucide-react'
import { CODE_PREVIEW_MAX_LEN } from '@/constants'

export interface ToolExecution {
  id?: string
  toolName: string
  capabilitySlug?: string
  input: Record<string, unknown>
  output?: string | null
  error?: string | null
  exitCode?: number | null
  durationMs?: number | null
  screenshot?: string | null
  status?: string
}

interface ToolExecutionBlockProps {
  execution: ToolExecution
}

const STATUS_CONFIG = {
  completed: { icon: CheckCircle2, color: 'text-green-500', label: 'Completed' },
  failed: { icon: XCircle, color: 'text-red-500', label: 'Failed' },
  running: { icon: Loader2, color: 'text-blue-500 animate-spin', label: 'Running' },
  pending: { icon: Loader2, color: 'text-muted-foreground animate-spin', label: 'Pending' },
} as const

export function ToolExecutionBlock({ execution }: ToolExecutionBlockProps) {
  const [expanded, setExpanded] = useState(false)

  const status = execution.status ?? (execution.error ? 'failed' : 'completed')
  const config = STATUS_CONFIG[status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.completed
  const StatusIcon = config.icon

  const inputPreview = getInputPreview(execution)
  const fileDownload = parseFileDownload(execution)

  return (
    <div className="rounded-lg border bg-muted/30 text-sm my-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left hover:bg-muted/50 transition-colors rounded-lg min-w-0"
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary whitespace-nowrap">
          {formatCapabilityName(execution.capabilitySlug)}
        </span>
        {inputPreview && (
          <span className="font-mono text-muted-foreground text-xs truncate min-w-0">
            {inputPreview}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {execution.durationMs != null && (
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {execution.durationMs < 1000
                ? `${execution.durationMs}ms`
                : `${(execution.durationMs / 1000).toFixed(1)}s`}
            </span>
          )}
          <StatusIcon className={`size-3.5 ${config.color}`} />
        </span>
      </button>

      {/* Inline screenshot preview */}
      {execution.screenshot && !expanded && (
        <div className="px-3 pb-2">
          <img
            src={execution.screenshot}
            alt={execution.output || 'Screenshot'}
            className="rounded border max-w-full max-h-48 object-contain"
          />
        </div>
      )}

      {/* Inline download button for generate_file */}
      {fileDownload && !expanded && (
        <div className="px-3 pb-2">
          <a
            href={fileDownload.downloadUrl}
            download={fileDownload.filename}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors"
          >
            <Download className="size-3.5" />
            {fileDownload.filename}
          </a>
        </div>
      )}

      {/* Inline save confirmation for save_document */}
      {execution.toolName === 'save_document' && execution.output && !execution.error && !expanded && (
        <div className="px-3 pb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <FileText className="size-3.5" />
          {execution.output}
        </div>
      )}

      {expanded && (
        <div className="border-t px-3 py-2 space-y-2">
          {/* Input */}
          <div>
            <span className="text-xs font-medium text-muted-foreground">Input</span>
            <pre className="mt-1 rounded bg-muted p-2 text-xs overflow-x-auto whitespace-pre-wrap">
              {JSON.stringify(execution.input, null, 2)}
            </pre>
          </div>

          {/* Screenshot */}
          {execution.screenshot && (
            <div>
              <span className="text-xs font-medium text-muted-foreground">Screenshot</span>
              <img
                src={execution.screenshot}
                alt={execution.output || 'Screenshot'}
                className="mt-1 rounded border max-w-full max-h-96 object-contain"
              />
            </div>
          )}

          {/* Download button */}
          {fileDownload && (
            <div>
              <a
                href={fileDownload.downloadUrl}
                download={fileDownload.filename}
                className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors"
              >
                <Download className="size-3.5" />
                Download {fileDownload.filename}
              </a>
            </div>
          )}

          {/* Output */}
          {execution.output && !fileDownload && !execution.screenshot && (
            <div>
              <span className="text-xs font-medium text-muted-foreground">Output</span>
              <pre className="mt-1 rounded bg-muted p-2 text-xs overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto">
                {execution.output}
              </pre>
            </div>
          )}

          {/* Output description when screenshot is present */}
          {execution.output && execution.screenshot && (
            <div>
              <span className="text-xs font-medium text-muted-foreground">Description</span>
              <p className="mt-1 text-xs text-muted-foreground">{execution.output}</p>
            </div>
          )}

          {/* Error */}
          {execution.error && (
            <div>
              <span className="text-xs font-medium text-red-500">Error</span>
              <pre className="mt-1 rounded bg-red-500/10 p-2 text-xs text-red-600 dark:text-red-400 overflow-x-auto whitespace-pre-wrap">
                {execution.error}
              </pre>
            </div>
          )}

          {/* Exit code */}
          {execution.exitCode != null && (
            <div className="text-xs text-muted-foreground">
              Exit code: <span className={execution.exitCode === 0 ? 'text-green-500' : 'text-red-500'}>{execution.exitCode}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function formatCapabilityName(slug?: string): string {
  if (!slug) return 'Tool'
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function getInputPreview(execution: ToolExecution): string {
  const args = execution.input
  if (args.command) return String(args.command)
  if (args.code) return String(args.code).slice(0, CODE_PREVIEW_MAX_LEN) + (String(args.code).length > CODE_PREVIEW_MAX_LEN ? '...' : '')
  if (args.query) return String(args.query)
  if (args.path) return String(args.path)
  if (args.filename) return String(args.filename)
  if (args.title) return String(args.title)
  return ''
}

function parseFileDownload(execution: ToolExecution): { filename: string; downloadUrl: string } | null {
  if (execution.toolName !== 'generate_file' || !execution.output) return null
  try {
    const parsed = JSON.parse(execution.output)
    if (parsed.filename && parsed.downloadUrl) return parsed
  } catch { /* not JSON */ }
  return null
}

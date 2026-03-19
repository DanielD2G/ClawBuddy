import { useState } from 'react'
import { ChevronDown, ChevronRight, ShieldAlert } from 'lucide-react'
import type { PendingApproval } from '@/hooks/use-chat'
import { CODE_PREVIEW_MAX_LEN, formatToolDisplayName } from '@/constants'

function formatCapabilityName(slug?: string): string {
  if (!slug) return 'Tool'
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

interface ToolApprovalBlockProps {
  approval: PendingApproval
}

export function ToolApprovalBlock({ approval }: ToolApprovalBlockProps) {
  const [expanded, setExpanded] = useState(false)

  const isSubAgent = approval.toolName === 'delegate_task' && approval.subAgentToolNames
  const inputPreview = isSubAgent
    ? String(approval.input.task ?? '').slice(0, CODE_PREVIEW_MAX_LEN) +
      (String(approval.input.task ?? '').length > CODE_PREVIEW_MAX_LEN ? '...' : '')
    : getInputPreview(approval)

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 text-sm my-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-amber-500/10 transition-colors rounded-lg"
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <ShieldAlert className="size-3.5 shrink-0 text-amber-500" />
        {isSubAgent ? (
          <>
            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
              Sub-Agent
            </span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground/70">
              {approval.subAgentRole}
            </span>
          </>
        ) : (
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
            {formatCapabilityName(approval.capabilitySlug)}
          </span>
        )}
        {inputPreview && (
          <span className="font-mono text-muted-foreground text-xs truncate max-w-[300px]">
            {inputPreview}
          </span>
        )}
        <span className="ml-auto text-xs text-amber-600 dark:text-amber-400 shrink-0">
          Awaiting approval
        </span>
      </button>

      {expanded && (
        <div className="border-t border-amber-500/20 px-3 py-2 space-y-2">
          {isSubAgent ? (
            <>
              {approval.subAgentDescription && (
                <p className="text-xs text-muted-foreground">{approval.subAgentDescription}</p>
              )}
              <div>
                <span className="text-xs font-medium text-muted-foreground">Task</span>
                <p className="mt-0.5 text-xs text-foreground">
                  {String(approval.input.task ?? '')}
                </p>
              </div>
              <div>
                <span className="text-xs font-medium text-muted-foreground">
                  Tools this sub-agent can use ({approval.subAgentToolNames!.length})
                </span>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {approval.subAgentToolNames!.map((tool) => (
                    <span
                      key={tool}
                      className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground/80"
                    >
                      {formatToolDisplayName(tool)}
                    </span>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <>
              <span className="text-xs font-medium text-muted-foreground">Input</span>
              <pre className="mt-1 rounded bg-muted p-2 text-xs overflow-x-auto whitespace-pre-wrap">
                {JSON.stringify(approval.input, null, 2)}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function getInputPreview(approval: PendingApproval): string {
  const args = approval.input
  if (args.command) return String(args.command)
  if (args.code)
    return (
      String(args.code).slice(0, CODE_PREVIEW_MAX_LEN) +
      (String(args.code).length > CODE_PREVIEW_MAX_LEN ? '...' : '')
    )
  if (args.query) return String(args.query)
  if (args.path) return String(args.path)
  return ''
}

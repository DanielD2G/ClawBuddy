import { useState, type RefObject } from 'react'
import { ChevronDown, ChevronRight, CheckCircle2, XCircle, Loader2, Bot } from 'lucide-react'
import type { SubAgentData, SubAgentRole } from '@/hooks/use-chat'
import { ToolExecutionBlock } from './tool-execution-block'

interface SubAgentBlockProps {
  subAgent: SubAgentData
  expandedToolsRef?: RefObject<Set<string>>
}

const ROLE_COLORS: Record<SubAgentRole, { badge: string }> = {
  explore: { badge: 'bg-blue-500/10 text-blue-600 dark:text-blue-400' },
  analyze: { badge: 'bg-purple-500/10 text-purple-600 dark:text-purple-400' },
  execute: { badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
}

const DEFAULT_COLORS = { badge: 'bg-gray-500/10 text-gray-600 dark:text-gray-400' }

export function SubAgentBlock({ subAgent, expandedToolsRef }: SubAgentBlockProps) {
  const subAgentKey = subAgent.id ?? subAgent.task
  const [expanded, setExpanded] = useState(() => {
    if (expandedToolsRef?.current && subAgentKey) return expandedToolsRef.current.has(subAgentKey)
    return subAgent.status === 'running'
  })

  const toggleExpanded = () => {
    setExpanded((prev) => {
      const next = !prev
      if (expandedToolsRef?.current && subAgentKey) {
        if (next) expandedToolsRef.current.add(subAgentKey)
        else expandedToolsRef.current.delete(subAgentKey)
      }
      return next
    })
  }

  const colors = ROLE_COLORS[subAgent.role] ?? DEFAULT_COLORS
  const isRunning = subAgent.status === 'running'
  const isFailed = subAgent.status === 'failed'

  const totalDuration =
    subAgent.durationMs ?? subAgent.tools.reduce((sum, t) => sum + (t.durationMs ?? 0), 0)

  return (
    <div className="rounded-lg border bg-muted/20 text-sm my-2">
      {/* Header */}
      <button
        type="button"
        onClick={toggleExpanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/30 transition-colors rounded-t-lg min-w-0"
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}

        {isRunning ? (
          <Loader2 className="size-3.5 shrink-0 text-blue-500 animate-spin" />
        ) : isFailed ? (
          <XCircle className="size-3.5 shrink-0 text-red-500" />
        ) : (
          <CheckCircle2 className="size-3.5 shrink-0 text-green-500" />
        )}

        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium capitalize ${colors.badge}`}
        >
          <Bot className="size-3 inline-block mr-1 -mt-0.5" />
          {subAgent.role}
        </span>

        <span className="text-xs text-muted-foreground truncate min-w-0">{subAgent.task}</span>

        <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {subAgent.tools.length > 0 && (
            <span>
              {subAgent.tools.length} tool{subAgent.tools.length !== 1 ? 's' : ''}
            </span>
          )}
          {totalDuration > 0 && (
            <span>
              {totalDuration < 1000
                ? `${totalDuration}ms`
                : `${(totalDuration / 1000).toFixed(1)}s`}
            </span>
          )}
        </span>
      </button>

      {/* Body: internal tools + summary */}
      {expanded && (
        <div className="px-3 pb-2 space-y-1">
          {subAgent.tools.map((tool, i) => (
            <ToolExecutionBlock
              key={tool.id ?? tool.toolCallId ?? `sub-tool-${i}`}
              execution={tool}
              toolKey={tool.id ?? tool.toolCallId ?? `sub-tool-${i}`}
              expandedToolsRef={expandedToolsRef}
            />
          ))}

          {subAgent.summary && (
            <div className="rounded bg-muted/40 px-3 py-2 text-xs text-muted-foreground mt-1 overflow-hidden break-words">
              <span className="font-medium">Summary:</span>{' '}
              {subAgent.summary
                .replace(/!\[[^\]]*\]\(data:image\/[^\)]+\)/g, '[image]')
                .replace(/(?:\/9j\/|iVBOR)[A-Za-z0-9+/=]{100,}/g, '[image]')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

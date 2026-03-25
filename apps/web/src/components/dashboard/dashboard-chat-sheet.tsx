import { useEffect, useRef, useState, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { POLL_MESSAGES_MS } from '@/constants'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Sparkles, User, Bot, Terminal, Send } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  toolExecutions?: Array<{
    toolName: string
    output?: string | null
    error?: string | null
    durationMs?: number | null
  }>
  createdAt: string
}

interface DashboardChatSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string | null
  dashboardId: string
  dashboardTitle: string
}

function useSessionMessages(sessionId: string | null) {
  return useQuery({
    queryKey: ['dashboard-chat', sessionId],
    queryFn: () =>
      apiClient.get<{
        messages: Message[]
        agentStatus: string
      }>(`/chat/sessions/${sessionId}/messages`),
    enabled: !!sessionId,
    refetchInterval: (query) => {
      const data = query.state.data
      if (data?.agentStatus === 'running') return 2000
      return POLL_MESSAGES_MS
    },
  })
}

export function DashboardChatSheet({
  open,
  onOpenChange,
  sessionId,
  dashboardId,
  dashboardTitle,
}: DashboardChatSheetProps) {
  const queryClient = useQueryClient()
  const { data, isLoading } = useSessionMessages(open ? sessionId : null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [input, setInput] = useState('')
  const [isSending, setIsSending] = useState(false)

  const messages = data?.messages ?? []
  const isRunning = data?.agentStatus === 'running'

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (open && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages.length, open])

  const handleSend = useCallback(async () => {
    const content = input.trim()
    if (!content || isSending) return

    setInput('')
    setIsSending(true)

    try {
      const res = await fetch(`/api/dashboards/${dashboardId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content }),
      })

      if (!res.ok) throw new Error('Failed to send message')

      // Read SSE stream to completion — we don't render it live,
      // the polling query picks up new messages automatically.
      // But we need to consume the stream so the server finishes.
      const reader = res.body?.getReader()
      if (reader) {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done } = await reader.read()
          if (done) break
        }
      }
    } catch (err) {
      console.error('Dashboard chat error:', err)
    } finally {
      setIsSending(false)
      // Refresh messages + dashboard data
      queryClient.invalidateQueries({ queryKey: ['dashboard-chat'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    }
  }, [input, isSending, dashboardId, queryClient])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="!w-full sm:!w-[28rem] sm:!max-w-lg flex flex-col p-0">
        <SheetHeader className="px-4 py-3 border-b shrink-0">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4 text-brand" />
            {dashboardTitle} — Activity
          </SheetTitle>
          <SheetDescription className="text-xs">
            Agent runs, refreshes, and creation logs for this dashboard.
          </SheetDescription>
          {(isRunning || isSending) && (
            <Badge variant="default" className="w-fit gap-1.5 animate-pulse bg-brand text-white text-xs">
              <Spinner className="size-3" />
              Agent running...
            </Badge>
          )}
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 min-h-0">
          {!sessionId && messages.length === 0 && !isSending && (
            <p className="text-sm text-muted-foreground text-center py-8">
              No activity yet. Send a message or refresh the dashboard.
            </p>
          )}

          {sessionId && isLoading && (
            <div className="flex justify-center py-8">
              <Spinner className="size-5" />
            </div>
          )}

          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}

          <div ref={bottomRef} />
        </div>

        {/* Input area */}
        <div className="shrink-0 border-t px-3 py-2 sm:px-4 sm:py-3 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about this dashboard..."
              disabled={isSending}
              rows={1}
              className={cn(
                'flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm',
                'placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-brand',
                'min-h-[38px] max-h-[120px]',
                'disabled:opacity-50',
              )}
              onInput={(e) => {
                const target = e.target as HTMLTextAreaElement
                target.style.height = 'auto'
                target.style.height = `${Math.min(target.scrollHeight, 120)}px`
              }}
            />
            <Button
              size="sm"
              onClick={handleSend}
              disabled={!input.trim() || isSending}
              className="shrink-0 h-[38px] px-3"
            >
              {isSending ? (
                <Spinner className="size-4" />
              ) : (
                <Send className="size-4" />
              )}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user'

  // Cron messages start with [Cron: ...] — show them differently
  const isCronMessage = isUser && message.content.startsWith('[Cron')
  const cronLabel = isCronMessage
    ? message.content.match(/^\[Cron:\s*([^\]]+)\]/)?.[1] ?? 'Cron'
    : null

  // Dashboard context messages — hide the injected context, show only the user request
  const isDashboardContext = isUser && message.content.startsWith('[Dashboard context')
  const userRequest = isDashboardContext
    ? message.content.match(/User request:\s*([\s\S]*)$/)?.[1]?.trim() ?? message.content
    : null

  return (
    <div
      className={cn(
        'flex gap-2.5',
        isUser ? 'flex-row-reverse' : 'flex-row',
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-full',
          isUser ? 'bg-muted' : 'bg-brand/10',
        )}
      >
        {isUser ? (
          isCronMessage ? (
            <Terminal className="size-3.5 text-muted-foreground" />
          ) : (
            <User className="size-3.5 text-muted-foreground" />
          )
        ) : (
          <Bot className="size-3.5 text-brand" />
        )}
      </div>

      {/* Content */}
      <div
        className={cn(
          'flex flex-col gap-1.5 max-w-[85%] min-w-0',
          isUser ? 'items-end' : 'items-start',
        )}
      >
        {/* Cron label */}
        {cronLabel && (
          <Badge variant="secondary" className="text-[10px] uppercase tracking-wider">
            {cronLabel}
          </Badge>
        )}

        {/* Tool executions */}
        {message.toolExecutions?.map((te, i) => (
          <div
            key={i}
            className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs w-full"
          >
            <div className="flex items-center gap-1.5 mb-1">
              <Terminal className="size-3 text-muted-foreground" />
              <span className="font-mono font-medium text-foreground/80">{te.toolName}</span>
              {te.durationMs != null && (
                <span className="text-muted-foreground">
                  {te.durationMs < 1000
                    ? `${te.durationMs}ms`
                    : `${(te.durationMs / 1000).toFixed(1)}s`}
                </span>
              )}
            </div>
            {te.output && (
              <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap line-clamp-4 mt-1">
                {te.output}
              </pre>
            )}
            {te.error && (
              <pre className="text-[11px] text-red-500 whitespace-pre-wrap line-clamp-3 mt-1">
                {te.error}
              </pre>
            )}
          </div>
        ))}

        {/* Text content */}
        {message.content && !isCronMessage && (
          <div
            className={cn(
              'rounded-xl px-3 py-2 text-sm',
              isUser
                ? 'bg-brand text-white'
                : 'bg-muted/50 text-foreground',
            )}
          >
            {isUser ? (
              <p className="whitespace-pre-wrap">{isDashboardContext ? userRequest : message.content}</p>
            ) : (
              <div className="prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {message.content}
                </ReactMarkdown>
              </div>
            )}
          </div>
        )}

        {/* Cron prompt — collapsed */}
        {isCronMessage && (
          <details className="w-full">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors">
              Show refresh prompt
            </summary>
            <pre className="mt-1 rounded-lg border bg-muted/30 p-2 text-[11px] text-muted-foreground whitespace-pre-wrap max-h-40 overflow-auto">
              {message.content.replace(/^\[Cron:\s*[^\]]+\]\s*/, '')}
            </pre>
          </details>
        )}

        {/* Timestamp */}
        <span className="text-[10px] text-muted-foreground/50">
          {new Date(message.createdAt).toLocaleString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            month: 'short',
            day: 'numeric',
          })}
        </span>
      </div>
    </div>
  )
}

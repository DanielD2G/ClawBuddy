import type { MutableRefObject } from 'react'
import { Loader2, Paperclip, Timer, RotateCcw } from 'lucide-react'
import type { ContentBlock, ChatMessage, PendingApproval } from '@/hooks/use-chat'
import { ToolApprovalBlock } from '@/components/chat/tool-approval-block'
import { ContentBlockRenderer } from './content-block-renderer'
import { SourcesList } from './sources-list'

/** Build ordered content blocks -- uses live contentBlocks if available, falls back to legacy layout for DB-loaded messages */
function getContentBlocks(msg: ChatMessage): ContentBlock[] {
  if (msg.contentBlocks?.length) return msg.contentBlocks
  const blocks: ContentBlock[] = []
  if (msg.toolExecutions?.length) {
    for (const te of msg.toolExecutions) blocks.push({ type: 'tool', tool: te })
  }
  if (msg.content) blocks.push({ type: 'text', text: msg.content })
  return blocks
}

function hasVisibleTextContent(msg: ChatMessage): boolean {
  return getContentBlocks(msg).some(
    (block) => block.type === 'text' && block.text.trim().length > 0,
  )
}

function getSourceSignature(msg: ChatMessage | null): string {
  if (!msg?.sources?.length) return ''

  const seen = new Set<string>()
  return msg.sources
    .filter((source) => {
      const key = `${source.workspaceId ?? ''}:${source.documentId}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((source) => `${source.workspaceId ?? ''}:${source.documentId}`)
    .join('|')
}

export function MessageList({
  messages,
  isPending,
  thinkingMessage,
  pendingApprovals,
  retryLastMessage,
  expandedToolsRef,
}: {
  messages: ChatMessage[]
  isPending: boolean
  thinkingMessage: string | null
  pendingApprovals: PendingApproval[]
  retryLastMessage: () => void
  expandedToolsRef: MutableRefObject<Set<string>>
}) {
  return (
    <div className="flex flex-col">
      {messages.map((msg, idx) => {
        const prevMsg = idx > 0 ? messages[idx - 1] : null
        const nextMsg = idx < messages.length - 1 ? messages[idx + 1] : null
        const isConsecutiveAssistant = msg.role === 'assistant' && prevMsg?.role === 'assistant'
        const shouldRenderSources =
          msg.role === 'assistant' &&
          Boolean(msg.sources?.length) &&
          hasVisibleTextContent(msg) &&
          !(
            nextMsg?.role === 'assistant' && getSourceSignature(nextMsg) === getSourceSignature(msg)
          )

        const isCronMessage = msg.role === 'user' && msg.content.startsWith('[Cron:')
        const cronName = isCronMessage
          ? (msg.content.match(/^\[Cron:\s*([^\]]+)\]/)?.[1] ?? 'Cron')
          : null

        return (
          <article key={msg.id} className={isConsecutiveAssistant ? '' : idx > 0 ? 'mt-4' : ''}>
            {isCronMessage ? (
              <div className="flex items-center gap-3 py-1">
                <div className="h-px flex-1 bg-border/60" />
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-3 py-1 text-[11px] font-medium text-muted-foreground">
                  <Timer className="size-3" />
                  {cronName}
                  <span className="text-muted-foreground/60">
                    {new Date(msg.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </span>
                <div className="h-px flex-1 bg-border/60" />
              </div>
            ) : msg.role === 'user' ? (
              <div className="flex justify-end">
                <div className="max-w-[85%] min-w-0">
                  <div className="rounded-xl bg-muted/80 px-5 py-3 text-[15px] text-foreground break-words [overflow-wrap:anywhere]">
                    {msg.content}
                  </div>
                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap justify-end gap-1.5">
                      {msg.attachments.map((att) => (
                        <a
                          key={att.storageKey ?? att.url}
                          href={att.url}
                          download={att.name}
                          className="inline-flex items-center gap-1.5 rounded-lg border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors"
                        >
                          <Paperclip className="size-3" />
                          {att.name}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="max-w-none text-[15px] leading-relaxed text-foreground">
                <ContentBlockRenderer
                  blocks={getContentBlocks(msg)}
                  msg={msg}
                  expandedToolsRef={expandedToolsRef}
                />

                {msg.isError && !isPending && (
                  <button
                    onClick={retryLastMessage}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                  >
                    <RotateCcw className="size-3" />
                    Retry
                  </button>
                )}

                {shouldRenderSources && <SourcesList sources={msg.sources!} />}
              </div>
            )}
          </article>
        )
      })}

      {/* Pending approvals */}
      {pendingApprovals.length > 0 && (
        <div>
          {pendingApprovals.map((approval) => (
            <ToolApprovalBlock key={approval.approvalId} approval={approval} />
          ))}
        </div>
      )}

      {/* Thinking indicator */}
      {thinkingMessage && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-1">
          <Loader2 className="size-4 animate-spin" />
          {thinkingMessage}
        </div>
      )}

      {/* Fallback loading dots (only if thinking message is empty but still loading) */}
      {isPending && !thinkingMessage && pendingApprovals.length === 0 && (
        <div className="flex items-center gap-1.5 py-2">
          <span className="size-2 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:0ms]" />
          <span className="size-2 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:150ms]" />
          <span className="size-2 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:300ms]" />
        </div>
      )}
    </div>
  )
}

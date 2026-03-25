import { useState, useEffect, useRef } from 'react'
import { useParams, useLocation, useNavigate, Link } from 'react-router-dom'
import { useActiveWorkspace } from '@/providers/workspace-provider'
import { useQueryClient, useQuery } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import {
  Send,
  Square,
  ArrowDown,
  FileText,
  Loader2,
  Paperclip,
  X,
  Download,
  Timer,
  RotateCcw,
} from 'lucide-react'
import { useChat } from '@/hooks/use-chat'
import type { ChatAttachment, ContentBlock, ChatMessage } from '@/hooks/use-chat'
import { useChatSessions, type ChatSession } from '@/hooks/use-chat-sessions'
import { useWorkspaceCapabilities } from '@/hooks/use-capabilities'
import { useDocuments } from '@/hooks/use-documents'
import { useFolders } from '@/hooks/use-folders'
import { MentionInput } from '@/components/chat/mention-input'
import { ChatAttachMenu } from '@/components/chat/chat-attach-menu'
import { ToolExecutionBlock } from '@/components/chat/tool-execution-block'
import { SubAgentBlock } from '@/components/chat/sub-agent-block'
import { ToolApprovalBlock } from '@/components/chat/tool-approval-block'
import { ApprovalInputBar } from '@/components/chat/approval-input-bar'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { parseRichBlocks } from '@/lib/rich-block-parser'
import { richBlockRenderers } from '@/components/chat/rich-blocks'
import { DEFAULT_CONTEXT_LIMIT_TOKENS, MODEL_CONFIG_STALE_TIME_MS } from '@/constants'

/** Build ordered content blocks — uses live contentBlocks if available, falls back to legacy layout for DB-loaded messages */
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

export function ChatPage() {
  const { sessionId } = useParams<{ sessionId?: string }>()
  const { activeWorkspaceId: workspaceId } = useActiveWorkspace()
  const { data: allCapabilities = [] } = useWorkspaceCapabilities(workspaceId)
  const enabledCapabilities = allCapabilities.filter((c) => c.enabled !== false)
  const { data: allDocuments = [] } = useDocuments(workspaceId ?? '')
  const readyDocuments = allDocuments.filter((d) => d.status === 'READY')
  const { data: allFolders = [] } = useFolders(workspaceId ?? '')
  const { data: allDocsForMenu = [] } = useQuery({
    queryKey: ['all-documents'],
    queryFn: () =>
      apiClient.get<
        Array<{
          id: string
          title: string
          workspaceId: string
          status: string
          workspace?: { name: string }
        }>
      >('/documents'),
  })
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const loadedSessionId = useRef<string | null>(null)
  const navigatedRef = useRef(false)

  const {
    messages,
    isPending,
    thinkingMessage,
    pendingApprovals,
    sendMessage,
    abortAgent,
    approveToolCall,
    retryLastMessage,
    loadSession,
    clearMessages,
    isCompressing,
  } = useChat(workspaceId ?? '', (sid) => {
    // Navigate to session URL immediately when session is created
    if (!sessionId && !navigatedRef.current) {
      navigatedRef.current = true
      loadedSessionId.current = sid // prevent loadSession from overwriting streaming state
      navigate(`/chat/${sid}`, { replace: true })
    }
  })

  const [input, setInput] = useState('')
  const [focused, setFocused] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<ChatAttachment[]>([])
  const [mentionedDocIds, setMentionedDocIds] = useState<string[]>([])
  const sentInitial = useRef(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [showScrollDown, setShowScrollDown] = useState(false)
  const expandedToolsRef = useRef<Set<string>>(new Set())

  // Get current session token usage from sessions list
  const { data: sessions } = useChatSessions()
  const currentSession = sessionId ? sessions?.find((s) => s.id === sessionId) : null
  const contextTokens = currentSession?.lastInputTokens
  const { data: modelConfig } = useQuery({
    queryKey: ['model-config'],
    queryFn: () => apiClient.get<{ contextLimitTokens?: number }>('/global-settings/models'),
    staleTime: MODEL_CONFIG_STALE_TIME_MS,
  })
  const contextLimit = modelConfig?.contextLimitTokens ?? DEFAULT_CONTEXT_LIMIT_TOKENS
  const rawContextPct = contextTokens
    ? Math.min(Math.round((contextTokens / contextLimit) * 100), 100)
    : null
  // Cache last known value so the counter doesn't flicker during query refetches
  const lastContextPct = useRef<number | null>(null)
  if (rawContextPct != null) lastContextPct.current = rawContextPct
  const contextPct = rawContextPct ?? lastContextPct.current

  // Load existing session messages when sessionId changes
  useEffect(() => {
    if (sessionId && sessionId !== loadedSessionId.current) {
      loadedSessionId.current = sessionId
      loadSession(sessionId)
      // Mark as read — optimistically clear unread badge without refetching (avoids reordering)
      fetch(`/api/chat/sessions/${sessionId}/read`, {
        method: 'POST',
        credentials: 'include',
      }).catch(() => {})
      queryClient.setQueryData<ChatSession[]>(['chat-sessions'], (old) =>
        old?.map((s) => (s.id === sessionId ? { ...s, unreadCount: 0 } : s)),
      )
    } else if (!sessionId && loadedSessionId.current) {
      // Navigated to /chat (new chat)
      loadedSessionId.current = null
      navigatedRef.current = false
      clearMessages()
    }
  }, [sessionId, loadSession, clearMessages, queryClient])

  // Auto-send initial message from landing page
  useEffect(() => {
    const state = location.state as { initialMessage?: string; documentIds?: string[] } | null
    if (state?.initialMessage && !sentInitial.current) {
      sentInitial.current = true
      sendMessage(state.initialMessage, state.documentIds)
    }
  }, [location.state, sendMessage])

  // Auto-scroll on new messages — only when user is already at the bottom
  useEffect(() => {
    if (!showScrollDown) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, isPending, thinkingMessage, pendingApprovals, showScrollDown])

  const handleScroll = () => {
    const el = scrollContainerRef.current
    if (!el) return
    setShowScrollDown(el.scrollHeight - el.scrollTop - el.clientHeight > 100)
  }

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  const removePendingFile = (idx: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  const handleSend = () => {
    if ((!input.trim() && !pendingFiles.length) || isPending) return
    const docIds = mentionedDocIds.length > 0 ? mentionedDocIds : undefined
    sendMessage(input, docIds, pendingFiles.length ? pendingFiles : undefined)
    setInput('')
    setPendingFiles([])
    setMentionedDocIds([])
  }

  return (
    <div className="absolute inset-0 flex flex-col">
      {/* Top fade */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col">
        <div className="h-2 w-full bg-background" />
        <div className="h-16 w-full bg-gradient-to-b from-background to-transparent" />
      </div>
      {/* Messages */}
      <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 pt-16 pb-36">
          <div className="flex flex-col">
            {messages.map((msg, idx) => {
              const prevMsg = idx > 0 ? messages[idx - 1] : null
              const nextMsg = idx < messages.length - 1 ? messages[idx + 1] : null
              const isConsecutiveAssistant =
                msg.role === 'assistant' && prevMsg?.role === 'assistant'
              const shouldRenderSources =
                msg.role === 'assistant' &&
                Boolean(msg.sources?.length) &&
                hasVisibleTextContent(msg) &&
                !(
                  nextMsg?.role === 'assistant' &&
                  getSourceSignature(nextMsg) === getSourceSignature(msg)
                )

              const isCronMessage = msg.role === 'user' && msg.content.startsWith('[Cron:')
              const cronName = isCronMessage
                ? (msg.content.match(/^\[Cron:\s*([^\]]+)\]/)?.[1] ?? 'Cron')
                : null

              return (
                <article
                  key={msg.id}
                  className={isConsecutiveAssistant ? '' : idx > 0 ? 'mt-4' : ''}
                >
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
                      {/* Render content blocks in order (interleaved tool executions + text) */}
                      {getContentBlocks(msg).map((block, i) =>
                        block.type === 'sub_agent' ? (
                          <div key={block.subAgent.id ?? `sub-agent-${i}`} className="mb-2">
                            <SubAgentBlock
                              subAgent={block.subAgent}
                              expandedToolsRef={expandedToolsRef}
                            />
                          </div>
                        ) : block.type === 'tool' &&
                          block.tool.toolName !== 'search_documents' &&
                          block.tool.toolName !== 'delegate_task' ? (
                          <div
                            key={block.tool.id ?? block.tool.toolCallId ?? `tool-${i}`}
                            className="mb-2"
                          >
                            <ToolExecutionBlock
                              execution={block.tool}
                              toolKey={
                                block.tool.id ?? block.tool.toolCallId ?? `${msg.id}-tool-${i}`
                              }
                              expandedToolsRef={expandedToolsRef}
                            />
                          </div>
                        ) : block.type === 'text' && block.text.trim() ? (
                          <div key={`text-${i}`}>
                            {block.text.startsWith('Action skipped') ? (
                              <div className="flex items-center gap-2 rounded-lg border border-muted bg-muted/30 px-3 py-2 text-sm text-muted-foreground mb-2">
                                <X className="size-3.5 shrink-0" />
                                {block.text}
                              </div>
                            ) : (
                              <div className={msg.isError ? 'text-destructive' : 'chat-markdown'}>
                                {msg.isError ? (
                                  <p>{block.text}</p>
                                ) : (
                                  parseRichBlocks(block.text).map((segment, j) => {
                                    if (segment.type === 'text') {
                                      return (
                                        <ReactMarkdown key={`md-${j}`} remarkPlugins={[remarkGfm]}>
                                          {segment.text}
                                        </ReactMarkdown>
                                      )
                                    }
                                    const Renderer = richBlockRenderers[segment.type]
                                    return Renderer ? (
                                      <Renderer key={`rich-${j}`} {...segment} />
                                    ) : null
                                  })
                                )}
                              </div>
                            )}
                          </div>
                        ) : null,
                      )}

                      {msg.isError && !isPending && (
                        <button
                          onClick={retryLastMessage}
                          className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                        >
                          <RotateCcw className="size-3" />
                          Retry
                        </button>
                      )}

                      {/* File attachments from assistant (generated files) */}
                      {msg.attachments && msg.attachments.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {msg.attachments.map((att) => (
                            <a
                              key={att.storageKey ?? att.url}
                              href={att.url}
                              download={att.name}
                              className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors"
                            >
                              <Download className="size-3.5" />
                              {att.name}
                            </a>
                          ))}
                        </div>
                      )}

                      {shouldRenderSources &&
                        (() => {
                          const seen = new Set<string>()
                          const unique = (msg.sources ?? []).filter((s) => {
                            const key = s.documentTitle
                            if (seen.has(key)) return false
                            seen.add(key)
                            return true
                          })
                          return (
                            <div className="mt-3 flex flex-wrap gap-1.5">
                              {unique.map((s) => (
                                <Link
                                  key={s.documentId}
                                  to={
                                    s.workspaceId
                                      ? `/workspaces/${s.workspaceId}/documents/${s.documentId}`
                                      : '#'
                                  }
                                  className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground no-underline hover:bg-muted/80 hover:text-foreground transition-colors"
                                >
                                  <FileText className="size-3" />
                                  {s.documentTitle}
                                </Link>
                              ))}
                            </div>
                          )
                        })()}
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

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col items-center">
        {/* Scroll-to-bottom */}
        {showScrollDown && (
          <button
            onClick={scrollToBottom}
            aria-label="Scroll to bottom"
            className="pointer-events-auto -mb-4 flex size-8 items-center justify-center rounded-full border bg-background shadow-md transition-colors hover:bg-muted"
          >
            <ArrowDown className="size-4" />
          </button>
        )}
        <div className="h-10 w-full bg-gradient-to-t from-background to-transparent" />
        <div className="w-full bg-background px-4 pb-6">
          <div className="pointer-events-auto mx-auto w-full max-w-3xl">
            {pendingApprovals.length > 0 ? (
              <ApprovalInputBar approvals={pendingApprovals} onDecision={approveToolCall} />
            ) : (
              <>
                {/* Pending file attachments */}
                {pendingFiles.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {pendingFiles.map((f, i) => (
                      <span
                        key={f.storageKey ?? f.url}
                        className="inline-flex items-center gap-1.5 rounded-lg border bg-muted/50 px-2.5 py-1 text-xs"
                      >
                        <Paperclip className="size-3 text-muted-foreground" />
                        {f.name}
                        <button
                          type="button"
                          onClick={() => removePendingFile(i)}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <X className="size-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    handleSend()
                  }}
                >
                  <div
                    className={`
                    flex flex-col rounded-3xl border border-border/40 bg-background px-5 py-3 shadow-2xl
                    transition-all duration-200
                    ${focused ? 'shadow-[0_-8px_40px_rgba(0,0,0,0.25)]' : ''}
                  `}
                  >
                    <MentionInput
                      value={input}
                      onChange={setInput}
                      onFocus={() => setFocused(true)}
                      onBlur={() => setFocused(false)}
                      disabled={isPending || isCompressing}
                      placeholder="Ask anything — use / for tools, @ for files"
                      onDocumentMentionsChange={setMentionedDocIds}
                      capabilities={enabledCapabilities}
                      documents={readyDocuments}
                      folders={allFolders}
                    />

                    <div className="flex items-center gap-1 mt-2">
                      <ChatAttachMenu
                        onSelectFile={(title) => setInput((v) => `${v}@${title} `)}
                        onSelectTool={(slug) => setInput((v) => `${v}/${slug} `)}
                        capabilities={enabledCapabilities}
                        documents={allDocsForMenu}
                      />

                      <div className="flex-1" />

                      {/* Context usage circle */}
                      {contextPct != null && contextPct > 0 && (
                        <div className="relative group shrink-0">
                          <div className="flex size-8 items-center justify-center rounded-full bg-muted/60 cursor-default">
                            {isCompressing ? (
                              <Loader2 className="size-4 animate-spin text-brand" />
                            ) : (
                              <>
                                <svg className="size-6 -rotate-90" viewBox="0 0 36 36">
                                  <circle
                                    cx="18"
                                    cy="18"
                                    r="15"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2.5"
                                    className="text-muted-foreground/15"
                                  />
                                  <circle
                                    cx="18"
                                    cy="18"
                                    r="15"
                                    fill="none"
                                    strokeWidth="2.5"
                                    strokeLinecap="round"
                                    strokeDasharray={`${contextPct * 0.9425} 94.25`}
                                    className={
                                      contextPct >= 80
                                        ? 'text-destructive'
                                        : contextPct >= 50
                                          ? 'text-yellow-500'
                                          : 'text-brand'
                                    }
                                    stroke="currentColor"
                                  />
                                </svg>
                                <span className="absolute inset-0 flex items-center justify-center text-[8px] font-semibold tabular-nums text-muted-foreground">
                                  {contextPct}
                                </span>
                              </>
                            )}
                          </div>
                          {/* Hover tooltip */}
                          <div className="absolute bottom-full right-0 mb-2 hidden group-hover:block z-50">
                            <div className="rounded-lg border bg-popover px-3.5 py-2.5 text-xs text-popover-foreground shadow-lg whitespace-nowrap">
                              <p className="font-medium mb-1">Context window:</p>
                              {isCompressing ? (
                                <p className="text-brand">Compressing conversation...</p>
                              ) : (
                                <>
                                  <p className="tabular-nums">
                                    {contextPct}% used ({100 - contextPct}% left)
                                  </p>
                                  <p className="tabular-nums text-muted-foreground">
                                    {contextTokens != null
                                      ? `${Math.round(contextTokens / 1000)}k`
                                      : '0'}{' '}
                                    / {Math.round(contextLimit / 1000)}k tokens
                                  </p>
                                  <p className="text-muted-foreground mt-1.5">
                                    Auto-compacts when full
                                  </p>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      )}

                      {isPending ? (
                        <button
                          type="button"
                          onClick={abortAgent}
                          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand text-brand-foreground shadow-md transition-all duration-200 hover:opacity-90"
                          title="Stop generation"
                        >
                          <Square className="size-3.5" strokeWidth={2.5} />
                        </button>
                      ) : (
                        <button
                          type="submit"
                          disabled={(!input.trim() && !pendingFiles.length) || isCompressing}
                          className={`
                          flex size-8 shrink-0 items-center justify-center rounded-full
                          transition-all duration-200
                          ${
                            (input.trim() || pendingFiles.length) && !isCompressing
                              ? 'bg-brand text-brand-foreground shadow-md hover:opacity-90'
                              : 'bg-muted-foreground/20 text-muted-foreground/50 cursor-not-allowed'
                          }
                        `}
                        >
                          <Send className="size-4" strokeWidth={2} />
                        </button>
                      )}
                    </div>
                  </div>
                </form>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

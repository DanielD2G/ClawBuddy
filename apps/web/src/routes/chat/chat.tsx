import { useState, useEffect, useRef } from 'react'
import { useParams, useLocation, useNavigate } from 'react-router-dom'
import { useActiveWorkspace } from '@/providers/workspace-provider'
import { useQueryClient, useQuery } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { Send, Square, ArrowDown, Loader2, Paperclip, X } from 'lucide-react'
import { useChat } from '@/hooks/use-chat'
import type { ChatAttachment } from '@/hooks/use-chat'
import { useChatSessions, type ChatSession } from '@/hooks/use-chat-sessions'
import { useWorkspaceCapabilities } from '@/hooks/use-capabilities'
import { useDocuments } from '@/hooks/use-documents'
import { useFolders } from '@/hooks/use-folders'
import { MentionInput } from '@/components/chat/mention-input'
import { ChatAttachMenu } from '@/components/chat/chat-attach-menu'
import { ApprovalInputBar } from '@/components/chat/approval-input-bar'
import { MessageList } from './components/message-list'
import { DEFAULT_CONTEXT_LIMIT_TOKENS, MODEL_CONFIG_STALE_TIME_MS } from '@/constants'

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
      // Mark as read -- optimistically clear unread badge without refetching (avoids reordering)
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

  // Auto-scroll on new messages -- only when user is already at the bottom
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
          <MessageList
            messages={messages}
            isPending={isPending}
            thinkingMessage={thinkingMessage}
            pendingApprovals={pendingApprovals}
            retryLastMessage={retryLastMessage}
            expandedToolsRef={expandedToolsRef}
          />

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
                      placeholder="Ask anything..."
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

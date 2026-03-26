import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import type { ChatSession } from '@/hooks/use-chat-sessions'
import { POLL_MESSAGES_MS, POLL_ACTIVE_SESSION_MS } from '@/constants'
import { uid, mapPendingApprovals, normalizeChatMessages } from './use-chat-helpers'
import { readSSEStream } from './use-chat-sse'
import type { SSECallbacks } from './use-chat-sse'
import type { ChatMessage, ChatAttachment, PendingApproval } from './use-chat-types'

// Re-export types so existing consumers don't need to change their imports
export type {
  ToolExecutionData,
  ChatAttachment,
  SubAgentRole,
  SubAgentData,
  ContentBlock,
  ChatMessage,
  PendingApproval,
} from './use-chat-types'

export function useChat(workspaceId: string, onSessionCreated?: (sessionId: string) => void) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isPending, setIsPending] = useState(false)
  const [isCompressing, setIsCompressing] = useState(false)
  const [thinkingMessage, setThinkingMessage] = useState<string | null>(null)
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([])
  const messagesRef = useRef<ChatMessage[]>([])
  const sessionIdRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const streamingRef = useRef(false)
  const onSessionCreatedRef = useRef(onSessionCreated)
  onSessionCreatedRef.current = onSessionCreated
  const queryClient = useQueryClient()

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  const sseCallbacks: SSECallbacks = useMemo(
    () => ({
      setMessages,
      setIsPending,
      setThinkingMessage,
      setPendingApprovals,
      setIsCompressing,
      invalidateContainer: () =>
        queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'container'] }),
    }),
    [queryClient, workspaceId],
  )

  const fetchSessionSnapshot = useCallback(async (sessionId: string) => {
    return apiClient.get<{
      messages: ChatMessage[]
      agentStatus: string
      pendingApprovals: Array<{
        id: string
        toolName: string
        capabilitySlug: string
        input: Record<string, unknown>
      }>
    }>(`/chat/sessions/${sessionId}/messages`)
  }, [])

  const applySessionSnapshot = useCallback(
    (snapshot: {
      messages: ChatMessage[]
      agentStatus: string
      pendingApprovals: Array<{
        id: string
        toolName: string
        capabilitySlug: string
        input: Record<string, unknown>
      }>
    }) => {
      setMessages(normalizeChatMessages(snapshot?.messages ?? []))
      setPendingApprovals(mapPendingApprovals(snapshot?.pendingApprovals))

      if (snapshot?.agentStatus === 'running') {
        setIsPending(true)
        setThinkingMessage('Processing...')
        return
      }

      setIsPending(false)
      setThinkingMessage(null)
    },
    [],
  )

  const loadSession = useCallback(
    async (sessionId: string) => {
      // Abort any in-flight SSE stream from the previous session
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = null
      }
      sessionIdRef.current = sessionId
      try {
        const data = await fetchSessionSnapshot(sessionId)
        applySessionSnapshot(data)
      } catch (error) {
        console.error('Failed to load session:', error)
        setIsPending(false)
        setThinkingMessage(null)
      }
    },
    [applySessionSnapshot, fetchSessionSnapshot],
  )

  const sendMessage = useCallback(
    async (content: string, documentIds?: string[], attachments?: ChatAttachment[]) => {
      const userMessage: ChatMessage = {
        id: uid(),
        role: 'user',
        content,
        attachments,
        createdAt: new Date().toISOString(),
      }

      setMessages((prev) => [...prev, userMessage])
      setIsPending(true)
      setThinkingMessage('Processing...')
      setPendingApprovals([])

      const assistantId = uid()
      setMessages((prev) => [
        ...prev,
        {
          id: assistantId,
          role: 'assistant',
          content: '',
          toolExecutions: [],
          contentBlocks: [],
          createdAt: new Date().toISOString(),
        },
      ])

      let shouldSyncSnapshot = false
      let appliedSnapshot = false

      try {
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller

        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          signal: controller.signal,
          body: JSON.stringify({
            content,
            workspaceId,
            sessionId: sessionIdRef.current,
            documentIds,
            ...(attachments?.length ? { attachments } : {}),
          }),
        })

        if (!res.ok) throw new Error('Chat request failed')

        shouldSyncSnapshot = true
        streamingRef.current = true
        await readSSEStream(
          res,
          assistantId,
          sseCallbacks,
          (sid) => {
            if (sid && !sessionIdRef.current) {
              sessionIdRef.current = sid
              onSessionCreatedRef.current?.(sid)
              // Refresh sidebar immediately so new session appears (even if stream is aborted later)
              queryClient.invalidateQueries({ queryKey: ['chat-sessions'] })
            } else if (sid) {
              sessionIdRef.current = sid
            }
          },
          controller.signal,
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        console.error('Chat error:', error)
        setMessages((prev) =>
          prev.map((msg) => {
            if (msg.id !== assistantId) return msg
            return {
              ...msg,
              content: 'Sorry, something went wrong. Please try again.',
              isError: true,
            }
          }),
        )
      } finally {
        streamingRef.current = false
        const finalSessionId = sessionIdRef.current
        if (shouldSyncSnapshot && finalSessionId) {
          try {
            const snapshot = await fetchSessionSnapshot(finalSessionId)
            applySessionSnapshot(snapshot)
            appliedSnapshot = true
          } catch (error) {
            console.error('Failed to refresh session after stream:', error)
          }
        }
        if (!appliedSnapshot) {
          setIsPending(false)
          setThinkingMessage(null)
        }
      }
    },
    [workspaceId, queryClient, sseCallbacks, fetchSessionSnapshot, applySessionSnapshot],
  )

  const abortAgent = useCallback(async () => {
    const sid = sessionIdRef.current
    if (!sid) return

    // Abort the SSE stream
    abortRef.current?.abort()
    abortRef.current = null

    // Call the backend abort endpoint
    try {
      await apiClient.post(`/chat/sessions/${sid}/abort`)
    } catch {
      // best effort
    }

    // Reset UI state
    streamingRef.current = false
    setIsPending(false)
    setThinkingMessage(null)
    setPendingApprovals([])

    // Refresh messages from server
    try {
      const snapshot = await fetchSessionSnapshot(sid)
      applySessionSnapshot(snapshot)
    } catch {
      // ignore
    }
  }, [applySessionSnapshot, fetchSessionSnapshot])

  const getLatestAssistantMessageId = useCallback(() => {
    for (let i = messagesRef.current.length - 1; i >= 0; i--) {
      if (messagesRef.current[i].role === 'assistant') {
        return messagesRef.current[i].id
      }
    }
    return null
  }, [])

  const approveToolCall = useCallback(
    async (
      approvalId: string,
      decision: 'approved' | 'denied',
      allowRule?: string,
      scope?: 'session' | 'workspace',
    ) => {
      const sessionId = sessionIdRef.current
      if (!sessionId) return

      // Remove from pending
      setPendingApprovals((prev) => prev.filter((a) => a.approvalId !== approvalId))

      try {
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller

        const res = await fetch(`/api/chat/sessions/${sessionId}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          signal: controller.signal,
          body: JSON.stringify({ approvalId, decision, allowRule, scope }),
        })

        if (!res.ok) throw new Error('Approval request failed')

        const contentType = res.headers.get('content-type') ?? ''

        // If response is SSE (all approvals decided, agent resumed)
        if (contentType.includes('text/event-stream')) {
          setIsPending(true)

          // Reuse the existing assistant message so streamed tool blocks
          // append to the same message instead of creating a duplicate.
          let assistantId = getLatestAssistantMessageId()
          if (!assistantId) {
            const newAssistantId = uid()
            assistantId = newAssistantId
            setMessages((prev) => [
              ...prev,
              {
                id: newAssistantId,
                role: 'assistant',
                content: '',
                toolExecutions: [],
                contentBlocks: [],
                createdAt: new Date().toISOString(),
              },
            ])
          }

          let appliedSnapshot = false
          try {
            streamingRef.current = true
            await readSSEStream(res, assistantId, sseCallbacks, undefined, controller.signal)
          } finally {
            streamingRef.current = false
            // Always fetch the final snapshot to ensure consistent state,
            // even if the stream ended without a 'done' event (error, abort, etc.)
            const finalSessionId = sessionIdRef.current
            if (finalSessionId) {
              try {
                const snapshot = await fetchSessionSnapshot(finalSessionId)
                applySessionSnapshot(snapshot)
                appliedSnapshot = true
              } catch (snapshotErr) {
                console.error('Failed to refresh session after approval stream:', snapshotErr)
              }
            }
            if (!appliedSnapshot) {
              setIsPending(false)
              setThinkingMessage(null)
            }
          }
        }
        // Otherwise it's JSON (still waiting for more approvals)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        console.error('Approval error:', error)
      }
    },
    [applySessionSnapshot, sseCallbacks, fetchSessionSnapshot, getLatestAssistantMessageId],
  )

  // Poll for messages — aggressive (1.5s) when agent running but disconnected, normal (10s) otherwise
  useEffect(() => {
    const pollInterval =
      isPending && !streamingRef.current ? POLL_ACTIVE_SESSION_MS : POLL_MESSAGES_MS
    const interval = setInterval(async () => {
      const sid = sessionIdRef.current
      if (!sid) return
      // Skip polling if we're actively streaming SSE for this session
      if (streamingRef.current) return
      try {
        const data = await apiClient.get<{
          messages: ChatMessage[]
          agentStatus: string
          pendingApprovals: Array<{
            id: string
            toolName: string
            capabilitySlug: string
            input: Record<string, unknown>
          }>
        }>(`/chat/sessions/${sid}/messages`)
        const msgs = normalizeChatMessages(data?.messages ?? [])
        if (msgs && msgs.length > 0) {
          setMessages((prev) => {
            if (msgs.length > prev.length) {
              // Mark as read — optimistically clear badge without refetching (avoids sidebar reordering)
              apiClient.fireAndForget('POST', `/chat/sessions/${sid}/read`)
              queryClient.setQueryData<ChatSession[]>(['chat-sessions'], (old) =>
                old?.map((s) => (s.id === sid ? { ...s, unreadCount: 0 } : s)),
              )
              return msgs
            }
            // Also detect content/tool updates on existing messages
            const lastNew = msgs[msgs.length - 1]
            const lastOld = prev[prev.length - 1]
            if (lastNew && lastOld) {
              if ((lastNew.content?.length ?? 0) > (lastOld.content?.length ?? 0)) return msgs
              if ((lastNew.toolExecutions?.length ?? 0) !== (lastOld.toolExecutions?.length ?? 0))
                return msgs
            }
            return prev
          })
        }

        // Agent is awaiting approval — restore pending approvals and stop pending indicator
        if (data?.agentStatus === 'awaiting_approval') {
          const mapped = mapPendingApprovals(data.pendingApprovals)
          setPendingApprovals((prev) => {
            // Only update if the approvals actually changed
            if (
              prev.length === mapped.length &&
              prev.every((p, i) => p.approvalId === mapped[i]?.approvalId)
            )
              return prev
            return mapped
          })
          if (isPending) {
            setIsPending(false)
            setThinkingMessage(null)
          }
          if (msgs && msgs.length > 0) setMessages(msgs)
        }

        // Agent finished — load final messages and stop showing pending
        if (data?.agentStatus === 'idle' && isPending) {
          if (msgs && msgs.length > 0) setMessages(msgs)
          setIsPending(false)
          setThinkingMessage(null)
          setPendingApprovals([])
          queryClient.invalidateQueries({ queryKey: ['chat-sessions'] })
        }
      } catch {
        // ignore polling errors
      }
    }, pollInterval)
    return () => clearInterval(interval)
  }, [isPending, queryClient])

  const clearMessages = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setMessages([])
    sessionIdRef.current = null
    setPendingApprovals([])
    setThinkingMessage(null)
  }, [])

  const getSessionId = useCallback(() => sessionIdRef.current, [])

  const retryLastMessage = useCallback(() => {
    // Extract retry info outside of the state updater to avoid
    // double-firing in React StrictMode (updaters run twice in dev)
    const prev = messages
    const errorIdx = prev.findLastIndex((m) => m.role === 'assistant' && m.isError)
    if (errorIdx < 0) return

    let userIdx = errorIdx - 1
    while (userIdx >= 0 && prev[userIdx].role !== 'user') userIdx--
    if (userIdx < 0) return

    const userContent = prev[userIdx].content
    const userAttachments = prev[userIdx].attachments

    // Remove both the user message and error assistant message
    setMessages(prev.filter((_, i) => i !== userIdx && i !== errorIdx))

    // Re-send after state update
    setTimeout(() => sendMessage(userContent, undefined, userAttachments), 0)
  }, [messages, sendMessage])

  return {
    messages,
    isPending,
    isCompressing,
    thinkingMessage,
    pendingApprovals,
    sendMessage,
    abortAgent,
    approveToolCall,
    retryLastMessage,
    clearMessages,
    loadSession,
    getSessionId,
  }
}

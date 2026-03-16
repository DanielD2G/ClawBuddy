import { useState, useCallback, useRef, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import type { ChatSession } from '@/hooks/use-chat-sessions'
import { POLL_MESSAGES_MS } from '@/constants'

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36)

export interface ToolExecutionData {
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

export interface ChatAttachment {
  name: string
  size?: number
  type?: string
  storageKey?: string
  url: string
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool'; tool: ToolExecutionData }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources?: { documentId: string; documentTitle: string; workspaceId?: string; chunkId: string; chunkIndex: number }[]
  toolExecutions?: ToolExecutionData[]
  contentBlocks?: ContentBlock[]
  attachments?: ChatAttachment[]
  isError?: boolean
  createdAt: string
}

export interface PendingApproval {
  approvalId: string
  toolName: string
  capabilitySlug: string
  input: Record<string, unknown>
}

function parseSSEEvents(buffer: string): { events: Array<{ event: string; data: string }>; remaining: string } {
  const events: Array<{ event: string; data: string }> = []
  const lines = buffer.split('\n')
  let currentEvent = ''
  let currentData = ''
  let remaining = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7)
    } else if (line.startsWith('data: ')) {
      currentData = line.slice(6)
    } else if (line === '' && currentEvent && currentData) {
      events.push({ event: currentEvent, data: currentData })
      currentEvent = ''
      currentData = ''
    } else if (line === '' && !currentEvent && !currentData) {
      // Empty line between events, skip
    } else {
      // Incomplete data — preserve for next chunk
      remaining = lines.slice(i).join('\n')
      break
    }
  }

  // If we have partial event data at the end
  if (currentEvent || currentData) {
    const partialLines: string[] = []
    if (currentEvent) partialLines.push(`event: ${currentEvent}`)
    if (currentData) partialLines.push(`data: ${currentData}`)
    remaining = partialLines.join('\n') + (remaining ? '\n' + remaining : '')
  }

  return { events, remaining }
}

export function useChat(workspaceId: string, onSessionCreated?: (sessionId: string) => void) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isPending, setIsPending] = useState(false)
  const [isCompressing, setIsCompressing] = useState(false)
  const [thinkingMessage, setThinkingMessage] = useState<string | null>(null)
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([])
  const sessionIdRef = useRef<string | null>(null)
  const onSessionCreatedRef = useRef(onSessionCreated)
  onSessionCreatedRef.current = onSessionCreated
  const queryClient = useQueryClient()

  const loadSession = useCallback(async (sessionId: string) => {
    sessionIdRef.current = sessionId
    try {
      const data = await apiClient.get<{
        messages: ChatMessage[]
        agentStatus: string
        pendingApprovals: Array<{ id: string; toolName: string; capabilitySlug: string; input: Record<string, unknown> }>
      }>(`/chat/sessions/${sessionId}/messages`)
      setMessages(data?.messages ?? [])
      // Restore pending approvals if agent is paused awaiting approval
      if (data?.pendingApprovals?.length) {
        setPendingApprovals(data.pendingApprovals.map((a) => ({
          approvalId: a.id,
          toolName: a.toolName,
          capabilitySlug: a.capabilitySlug,
          input: a.input,
        })))
      } else {
        setPendingApprovals([])
      }
    } catch (error) {
      console.error('Failed to load session:', error)
    }
  }, [])

  const processSSEStream = useCallback(async (
    res: Response,
    assistantId: string,
    onSessionId?: (id: string) => void,
  ) => {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const { events, remaining } = parseSSEEvents(buffer)
      buffer = remaining

      for (const { event, data } of events) {
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(data)
        } catch {
          continue
        }

        switch (event) {
          case 'session':
            onSessionId?.(parsed.sessionId as string)
            break

          case 'thinking':
            setThinkingMessage(parsed.message as string)
            break

          case 'tool_start': {
            setThinkingMessage(null)
            // Sandbox is now running — refresh container status in sidebar
            queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'container'] })
            const toolData: ToolExecutionData = {
              toolName: parsed.toolName as string,
              capabilitySlug: parsed.capabilitySlug as string,
              input: parsed.input as Record<string, unknown>,
              status: 'running',
            }
            setMessages((prev) =>
              prev.map((msg) => {
                if (msg.id !== assistantId) return msg
                return {
                  ...msg,
                  toolExecutions: [...(msg.toolExecutions ?? []), toolData],
                  contentBlocks: [...(msg.contentBlocks ?? []), { type: 'tool' as const, tool: toolData }],
                }
              }),
            )
            break
          }

          case 'tool_result': {
            const updatedTool = {
              output: (parsed.output as string) ?? null,
              error: (parsed.error as string) ?? null,
              exitCode: (parsed.exitCode as number) ?? null,
              durationMs: (parsed.durationMs as number) ?? null,
              screenshot: (parsed.screenshot as string) ?? null,
              status: parsed.error ? 'failed' : 'completed',
            }
            setMessages((prev) =>
              prev.map((msg) => {
                if (msg.id !== assistantId) return msg
                return {
                  ...msg,
                  toolExecutions: (msg.toolExecutions ?? []).map((te) => {
                    if (te.toolName !== parsed.toolName || te.status !== 'running') return te
                    return { ...te, ...updatedTool }
                  }),
                  contentBlocks: (msg.contentBlocks ?? []).map((block) => {
                    if (block.type !== 'tool' || block.tool.toolName !== parsed.toolName || block.tool.status !== 'running') return block
                    return { ...block, tool: { ...block.tool, ...updatedTool } }
                  }),
                }
              }),
            )
            break
          }

          case 'approval_required':
            setPendingApprovals((prev) => [
              ...prev,
              {
                approvalId: parsed.approvalId as string,
                toolName: parsed.toolName as string,
                capabilitySlug: parsed.capabilitySlug as string,
                input: parsed.input as Record<string, unknown>,
              },
            ])
            setThinkingMessage(null)
            break

          case 'content':
            setThinkingMessage(null)
            setMessages((prev) =>
              prev.map((msg) => {
                if (msg.id !== assistantId) return msg
                const blocks = [...(msg.contentBlocks ?? [])]
                const lastBlock = blocks[blocks.length - 1]
                if (lastBlock && lastBlock.type === 'text') {
                  blocks[blocks.length - 1] = { type: 'text', text: lastBlock.text + (parsed.text as string) }
                } else {
                  blocks.push({ type: 'text', text: parsed.text as string })
                }
                return { ...msg, content: msg.content + (parsed.text as string), contentBlocks: blocks }
              }),
            )
            break

          case 'sources':
            setMessages((prev) =>
              prev.map((msg) => {
                if (msg.id !== assistantId) return msg
                return { ...msg, sources: parsed.sources as ChatMessage['sources'] }
              }),
            )
            break

          case 'compressing':
            if (parsed.status === 'start') {
              setIsCompressing(true)
              setThinkingMessage('Compressing conversation history...')
            } else {
              setIsCompressing(false)
              if (parsed.status === 'done') {
                setThinkingMessage(`Summarized ${parsed.summarizedCount} older messages to save tokens`)
              } else {
                setThinkingMessage(null)
              }
            }
            break

          case 'context_compressed':
            setThinkingMessage(`Summarized ${parsed.summarizedCount} older messages to save tokens`)
            break

          case 'done':
            setThinkingMessage(null)
            setIsCompressing(false)
            if (parsed.sessionId) {
              onSessionId?.(parsed.sessionId as string)
            }
            break

          case 'awaiting_approval':
            setThinkingMessage(null)
            break

          case 'error':
            setThinkingMessage(null)
            setMessages((prev) =>
              prev.map((msg) => {
                if (msg.id !== assistantId) return msg
                return { ...msg, content: msg.content || `Error: ${parsed.message}`, isError: true }
              }),
            )
            break
        }
      }
    }
  }, [])

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

      const isNewSession = !sessionIdRef.current

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

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            content,
            workspaceId,
            sessionId: sessionIdRef.current,
            documentIds,
            ...(attachments?.length ? { attachments } : {}),
          }),
        })

        if (!res.ok) throw new Error('Chat request failed')

        await processSSEStream(res, assistantId, (sid) => {
          if (sid && !sessionIdRef.current) {
            sessionIdRef.current = sid
            onSessionCreatedRef.current?.(sid)
          } else if (sid) {
            sessionIdRef.current = sid
          }
        })

        // Refresh sidebar chat list when a new session was created
        if (isNewSession) {
          queryClient.invalidateQueries({ queryKey: ['chat-sessions'] })
        }
      } catch (error) {
        console.error('Chat error:', error)
        setMessages((prev) =>
          prev.map((msg) => {
            if (msg.id !== assistantId) return msg
            return { ...msg, content: 'Sorry, something went wrong. Please try again.', isError: true }
          }),
        )
      } finally {
        setIsPending(false)
        setThinkingMessage(null)
      }
    },
    [workspaceId, queryClient, processSSEStream],
  )

  const approveToolCall = useCallback(
    async (approvalId: string, decision: 'approved' | 'denied', allowRule?: string, scope?: 'session' | 'global') => {
      const sessionId = sessionIdRef.current
      if (!sessionId) return

      // Remove from pending
      setPendingApprovals((prev) => prev.filter((a) => a.approvalId !== approvalId))

      try {
        const res = await fetch(`/api/chat/sessions/${sessionId}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ approvalId, decision, allowRule, scope }),
        })

        if (!res.ok) throw new Error('Approval request failed')

        const contentType = res.headers.get('content-type') ?? ''

        // If response is SSE (all approvals decided, agent resumed)
        if (contentType.includes('text/event-stream')) {
          setIsPending(true)

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

          await processSSEStream(res, assistantId)
          setIsPending(false)
          setThinkingMessage(null)
        }
        // Otherwise it's JSON (still waiting for more approvals)
      } catch (error) {
        console.error('Approval error:', error)
      }
    },
    [processSSEStream],
  )

  // Poll for new messages every 10s when not streaming (picks up cron-added messages)
  useEffect(() => {
    const interval = setInterval(async () => {
      const sid = sessionIdRef.current
      if (!sid || isPending) return
      try {
        const data = await apiClient.get<{ messages: ChatMessage[]; agentStatus: string; pendingApprovals: unknown[] }>(`/chat/sessions/${sid}/messages`)
        const msgs = data?.messages
        if (msgs && msgs.length > 0) {
          setMessages((prev) => {
            if (msgs.length > prev.length) {
              // Mark as read — optimistically clear badge without refetching (avoids sidebar reordering)
              fetch(`/api/chat/sessions/${sid}/read`, { method: 'POST', credentials: 'include' })
                .catch(() => {})
              queryClient.setQueryData<ChatSession[]>(['chat-sessions'], (old) =>
                old?.map((s) => s.id === sid ? { ...s, unreadCount: 0 } : s),
              )
              return msgs
            }
            return prev
          })
        }
      } catch {
        // ignore polling errors
      }
    }, POLL_MESSAGES_MS)
    return () => clearInterval(interval)
  }, [isPending])

  const clearMessages = useCallback(() => {
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
    approveToolCall,
    retryLastMessage,
    clearMessages,
    loadSession,
    getSessionId,
  }
}

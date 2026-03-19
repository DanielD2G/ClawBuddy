import { useState, useCallback, useRef, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import type { ChatSession } from '@/hooks/use-chat-sessions'
import { POLL_MESSAGES_MS, POLL_ACTIVE_SESSION_MS } from '@/constants'

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36)

export interface ToolExecutionData {
  id?: string
  toolCallId?: string
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

export type SubAgentRole = 'explore' | 'analyze' | 'execute'

export interface SubAgentData {
  id?: string
  role: SubAgentRole
  task: string
  tools: ToolExecutionData[]
  summary?: string
  status: string
  durationMs?: number
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool'; tool: ToolExecutionData }
  | { type: 'sub_agent'; subAgent: SubAgentData }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources?: {
    documentId: string
    documentTitle: string
    workspaceId?: string
    chunkId: string
    chunkIndex: number
  }[]
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
  subAgentRole?: string
  subAgentDescription?: string
  subAgentToolNames?: string[]
}

function mapPendingApprovals(
  approvals: Array<{ id: string; toolName: string; capabilitySlug: string; input: Record<string, unknown> }> | undefined,
): PendingApproval[] {
  return (approvals ?? []).map((a) => ({
    approvalId: a.id,
    toolName: a.toolName,
    capabilitySlug: a.capabilitySlug,
    input: a.input,
  }))
}

function findSubAgentBlockIndex(blocks: ContentBlock[], subAgentId?: string): number {
  if (subAgentId) {
    const matchedIndex = blocks.findIndex(
      (block) => block.type === 'sub_agent' && block.subAgent.id === subAgentId,
    )
    if (matchedIndex >= 0) return matchedIndex
  }

  return blocks.findLastIndex(
    (block) => block.type === 'sub_agent' && block.subAgent.status === 'running',
  )
}

function matchesToolExecution(
  tool: ToolExecutionData,
  toolName: string,
  toolCallId?: string,
): boolean {
  if (toolCallId) return tool.toolCallId === toolCallId
  return tool.toolName === toolName && tool.status === 'running'
}

function parseSSEEvents(buffer: string): {
  events: Array<{ event: string; data: string }>
  remaining: string
} {
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
  const abortRef = useRef<AbortController | null>(null)
  const streamingRef = useRef(false)
  const onSessionCreatedRef = useRef(onSessionCreated)
  onSessionCreatedRef.current = onSessionCreated
  const queryClient = useQueryClient()

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

  const loadSession = useCallback(async (sessionId: string) => {
    // Abort any in-flight SSE stream from the previous session
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    setIsPending(false)
    setThinkingMessage(null)
    sessionIdRef.current = sessionId
    try {
      const data = await fetchSessionSnapshot(sessionId)
      setMessages(data?.messages ?? [])
      // If agent is still processing, show pending state and poll for updates
      if (data?.agentStatus === 'running') {
        setIsPending(true)
        setThinkingMessage('Processing...')
      }
      // Restore pending approvals if agent is paused awaiting approval
      setPendingApprovals(mapPendingApprovals(data?.pendingApprovals))
    } catch (error) {
      console.error('Failed to load session:', error)
    }
  }, [fetchSessionSnapshot])

  const processSSEStream = useCallback(
    async (
      res: Response,
      assistantId: string,
      onSessionId?: (id: string) => void,
      signal?: AbortSignal,
    ) => {
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let receivedDone = false

      while (true) {
        if (signal?.aborted) break
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

          const updateAssistant = (updater: (msg: ChatMessage) => ChatMessage) => {
            setMessages((prev) => prev.map((msg) => (msg.id === assistantId ? updater(msg) : msg)))
          }

          switch (event) {
            case 'session':
              onSessionId?.(parsed.sessionId as string)
              break

            case 'thinking':
              setThinkingMessage(parsed.message as string)
              break

            case 'sub_agent_start': {
              setThinkingMessage(null)
              const subAgentBlock: SubAgentData = {
                id: parsed.subAgentId as string | undefined,
                role: parsed.role as SubAgentRole,
                task: parsed.task as string,
                tools: [],
                status: 'running',
              }
              updateAssistant((msg) => ({
                ...msg,
                contentBlocks: [
                  ...(msg.contentBlocks ?? []),
                  { type: 'sub_agent' as const, subAgent: subAgentBlock },
                ],
              }))
              break
            }

            case 'sub_agent_done': {
              updateAssistant((msg) => {
                const blocks = [...(msg.contentBlocks ?? [])]
                const idx = findSubAgentBlockIndex(blocks, parsed.subAgentId as string | undefined)
                if (idx >= 0) {
                  const block = blocks[idx] as ContentBlock & { type: 'sub_agent' }
                  blocks[idx] = {
                    ...block,
                    subAgent: {
                      ...block.subAgent,
                      status: 'completed',
                      summary: parsed.summary as string,
                    },
                  }
                }
                return { ...msg, contentBlocks: blocks }
              })
              break
            }

            case 'tool_start': {
              setThinkingMessage(null)
              queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'container'] })
              const toolData: ToolExecutionData = {
                toolCallId: parsed.toolCallId as string | undefined,
                toolName: parsed.toolName as string,
                capabilitySlug: parsed.capabilitySlug as string,
                input: parsed.input as Record<string, unknown>,
                status: 'running',
              }
              if (parsed.subAgent) {
                updateAssistant((msg) => {
                  const blocks = [...(msg.contentBlocks ?? [])]
                  const idx = findSubAgentBlockIndex(
                    blocks,
                    parsed.subAgentId as string | undefined,
                  )
                  if (idx >= 0) {
                    const block = blocks[idx] as ContentBlock & { type: 'sub_agent' }
                    blocks[idx] = {
                      ...block,
                      subAgent: { ...block.subAgent, tools: [...block.subAgent.tools, toolData] },
                    }
                  }
                  return { ...msg, contentBlocks: blocks }
                })
              } else {
                updateAssistant((msg) => ({
                  ...msg,
                  toolExecutions: [...(msg.toolExecutions ?? []), toolData],
                  contentBlocks: [
                    ...(msg.contentBlocks ?? []),
                    { type: 'tool' as const, tool: toolData },
                  ],
                }))
              }
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
              if (parsed.subAgent) {
                updateAssistant((msg) => {
                  const blocks = [...(msg.contentBlocks ?? [])]
                  const idx = findSubAgentBlockIndex(
                    blocks,
                    parsed.subAgentId as string | undefined,
                  )
                  if (idx >= 0) {
                    const block = blocks[idx] as ContentBlock & { type: 'sub_agent' }
                    blocks[idx] = {
                      ...block,
                      subAgent: {
                        ...block.subAgent,
                        tools: block.subAgent.tools.map((t) => {
                          if (
                            !matchesToolExecution(
                              t,
                              parsed.toolName as string,
                              parsed.toolCallId as string | undefined,
                            )
                          ) {
                            return t
                          }
                          return { ...t, ...updatedTool }
                        }),
                      },
                    }
                  }
                  return { ...msg, contentBlocks: blocks }
                })
              } else {
                updateAssistant((msg) => ({
                  ...msg,
                  toolExecutions: (msg.toolExecutions ?? []).map((te) => {
                    if (
                      !matchesToolExecution(
                        te,
                        parsed.toolName as string,
                        parsed.toolCallId as string | undefined,
                      )
                    ) {
                      return te
                    }
                    return { ...te, ...updatedTool }
                  }),
                  contentBlocks: (msg.contentBlocks ?? []).map((block) => {
                    if (
                      block.type !== 'tool' ||
                      !matchesToolExecution(
                        block.tool,
                        parsed.toolName as string,
                        parsed.toolCallId as string | undefined,
                      )
                    ) {
                      return block
                    }
                    return { ...block, tool: { ...block.tool, ...updatedTool } }
                  }),
                }))
              }
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
                  subAgentRole: parsed.subAgentRole as string | undefined,
                  subAgentDescription: parsed.subAgentDescription as string | undefined,
                  subAgentToolNames: parsed.subAgentToolNames as string[] | undefined,
                },
              ])
              setThinkingMessage(null)
              break

            case 'content':
              setThinkingMessage(null)
              updateAssistant((msg) => {
                const blocks = [...(msg.contentBlocks ?? [])]
                const lastBlock = blocks[blocks.length - 1]
                if (lastBlock && lastBlock.type === 'text') {
                  blocks[blocks.length - 1] = {
                    type: 'text',
                    text: lastBlock.text + (parsed.text as string),
                  }
                } else {
                  blocks.push({ type: 'text', text: parsed.text as string })
                }
                return {
                  ...msg,
                  content: msg.content + (parsed.text as string),
                  contentBlocks: blocks,
                }
              })
              break

            case 'sources':
              updateAssistant((msg) => ({
                ...msg,
                sources: parsed.sources as ChatMessage['sources'],
              }))
              break

            case 'compressing':
              if (parsed.status === 'start') {
                setIsCompressing(true)
                setThinkingMessage('Compressing conversation history...')
              } else {
                setIsCompressing(false)
                if (parsed.status === 'done') {
                  setThinkingMessage(
                    `Summarized ${parsed.summarizedCount} older messages to save tokens`,
                  )
                } else {
                  setThinkingMessage(null)
                }
              }
              break

            case 'context_compressed':
              setThinkingMessage(
                `Summarized ${parsed.summarizedCount} older messages to save tokens`,
              )
              break

            case 'done':
              receivedDone = true
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
              updateAssistant((msg) => ({
                ...msg,
                content: msg.content || `Error: ${parsed.message}`,
                isError: true,
              }))
              break
          }
        }
      }
      return { receivedDone }
    },
    [],
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

        streamingRef.current = true
        const streamResult = await processSSEStream(
          res,
          assistantId,
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

        const finalSessionId = sessionIdRef.current
        if (finalSessionId && streamResult.receivedDone) {
          try {
            const snapshot = await fetchSessionSnapshot(finalSessionId)
            setMessages(snapshot?.messages ?? [])
            setPendingApprovals(mapPendingApprovals(snapshot?.pendingApprovals))
          } catch (error) {
            console.error('Failed to refresh session after stream:', error)
          }
        }
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
        setIsPending(false)
        setThinkingMessage(null)
      }
    },
    [workspaceId, queryClient, processSSEStream, fetchSessionSnapshot],
  )

  const approveToolCall = useCallback(
    async (
      approvalId: string,
      decision: 'approved' | 'denied',
      allowRule?: string,
      scope?: 'session' | 'global',
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

          streamingRef.current = true
          const approvalStreamResult = await processSSEStream(res, assistantId, undefined, controller.signal)
          const finalSessionId = sessionIdRef.current
          if (finalSessionId && approvalStreamResult.receivedDone) {
            try {
              const snapshot = await fetchSessionSnapshot(finalSessionId)
              setMessages(snapshot?.messages ?? [])
              setPendingApprovals(mapPendingApprovals(snapshot?.pendingApprovals))
            } catch (error) {
              console.error('Failed to refresh session after approval stream:', error)
            }
          }
          streamingRef.current = false
          setIsPending(false)
          setThinkingMessage(null)
        }
        // Otherwise it's JSON (still waiting for more approvals)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        console.error('Approval error:', error)
      }
    },
    [processSSEStream, fetchSessionSnapshot],
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
          pendingApprovals: unknown[]
        }>(`/chat/sessions/${sid}/messages`)
        const msgs = data?.messages
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
        // Agent finished — load final messages and stop showing pending
        if (data?.agentStatus === 'idle' && isPending) {
          if (msgs && msgs.length > 0) setMessages(msgs)
          setIsPending(false)
          setThinkingMessage(null)
          queryClient.invalidateQueries({ queryKey: ['chat-sessions'] })
        }
      } catch {
        // ignore polling errors
      }
    }, pollInterval)
    return () => clearInterval(interval)
  }, [isPending])

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
    approveToolCall,
    retryLastMessage,
    clearMessages,
    loadSession,
    getSessionId,
  }
}

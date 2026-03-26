import type {
  ChatMessage,
  ContentBlock,
  PendingApproval,
  SubAgentData,
  SubAgentRole,
  ToolExecutionData,
} from './use-chat-types'
import { findSubAgentBlockIndex, matchesToolExecution, parseSSEEvents } from './use-chat-helpers'

export interface SSECallbacks {
  setMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void
  setIsPending: (val: boolean) => void
  setThinkingMessage: (msg: string | null) => void
  setPendingApprovals: (
    updater: PendingApproval[] | ((prev: PendingApproval[]) => PendingApproval[]),
  ) => void
  setIsCompressing: (val: boolean) => void
  invalidateContainer: () => void
}

function makeUpdateAssistant(setMessages: SSECallbacks['setMessages'], assistantId: string) {
  return (updater: (msg: ChatMessage) => ChatMessage) => {
    setMessages((prev) => {
      const existing = prev.find((msg) => msg.id === assistantId)
      if (!existing) {
        return [
          ...prev,
          updater({
            id: assistantId,
            role: 'assistant',
            content: '',
            toolExecutions: [],
            contentBlocks: [],
            createdAt: new Date().toISOString(),
          }),
        ]
      }
      return prev.map((msg) => (msg.id === assistantId ? updater(msg) : msg))
    })
  }
}

export function handleSSEEvent(
  event: string,
  parsed: Record<string, unknown>,
  assistantId: string,
  callbacks: SSECallbacks,
  onSessionId?: (id: string) => void,
): { receivedDone: boolean } {
  const updateAssistant = makeUpdateAssistant(callbacks.setMessages, assistantId)

  switch (event) {
    case 'session':
      onSessionId?.(parsed.sessionId as string)
      break

    case 'thinking':
      callbacks.setThinkingMessage(parsed.message as string)
      break

    case 'sub_agent_start': {
      callbacks.setThinkingMessage(null)
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
      callbacks.setThinkingMessage(null)
      callbacks.invalidateContainer()
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
          const idx = findSubAgentBlockIndex(blocks, parsed.subAgentId as string | undefined)
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
          contentBlocks: [...(msg.contentBlocks ?? []), { type: 'tool' as const, tool: toolData }],
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
          const idx = findSubAgentBlockIndex(blocks, parsed.subAgentId as string | undefined)
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
      callbacks.setPendingApprovals((prev) => [
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
      callbacks.setThinkingMessage(null)
      break

    case 'content':
      callbacks.setThinkingMessage(null)
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
        callbacks.setIsCompressing(true)
        callbacks.setThinkingMessage('Compressing conversation history...')
      } else {
        callbacks.setIsCompressing(false)
        if (parsed.status === 'done') {
          callbacks.setThinkingMessage(
            `Summarized ${parsed.summarizedCount} older messages to save tokens`,
          )
        } else {
          callbacks.setThinkingMessage(null)
        }
      }
      break

    case 'context_compressed':
      callbacks.setThinkingMessage(
        `Summarized ${parsed.summarizedCount} older messages to save tokens`,
      )
      break

    case 'done':
      callbacks.setThinkingMessage(null)
      callbacks.setIsCompressing(false)
      if (parsed.sessionId) {
        onSessionId?.(parsed.sessionId as string)
      }
      return { receivedDone: true }

    case 'aborted':
      callbacks.setIsPending(false)
      callbacks.setThinkingMessage(null)
      callbacks.setPendingApprovals([])
      break

    case 'awaiting_approval':
      callbacks.setThinkingMessage(null)
      break

    case 'error':
      callbacks.setThinkingMessage(null)
      updateAssistant((msg) => ({
        ...msg,
        content: msg.content || `Error: ${parsed.message}`,
        isError: true,
      }))
      break
  }

  return { receivedDone: false }
}

export async function readSSEStream(
  res: Response,
  assistantId: string,
  callbacks: SSECallbacks,
  onSessionId?: (id: string) => void,
  signal?: AbortSignal,
): Promise<{ receivedDone: boolean }> {
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

      const result = handleSSEEvent(event, parsed, assistantId, callbacks, onSessionId)
      if (result.receivedDone) receivedDone = true
    }
  }
  return { receivedDone }
}

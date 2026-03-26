import type {
  ChatMessage,
  ContentBlock,
  PendingApproval,
  ToolExecutionData,
} from './use-chat-types'

export const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36)

export function mapPendingApprovals(
  approvals:
    | Array<{
        id: string
        toolName: string
        capabilitySlug: string
        input: Record<string, unknown>
      }>
    | undefined,
): PendingApproval[] {
  return (approvals ?? []).map((a) => ({
    approvalId: a.id,
    toolName: a.toolName,
    capabilitySlug: a.capabilitySlug,
    input: a.input,
  }))
}

export function findSubAgentBlockIndex(blocks: ContentBlock[], subAgentId?: string): number {
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

export function matchesToolExecution(
  tool: ToolExecutionData,
  toolName: string,
  toolCallId?: string,
): boolean {
  if (toolCallId) return tool.toolCallId === toolCallId
  return tool.toolName === toolName && tool.status === 'running'
}

export function parseSSEEvents(buffer: string): {
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

function isPersistedAssistantErrorMessage(message: ChatMessage): boolean {
  return message.role === 'assistant' && message.content.trim().startsWith('Error:')
}

export function normalizeChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    isError: message.isError || isPersistedAssistantErrorMessage(message),
  }))
}

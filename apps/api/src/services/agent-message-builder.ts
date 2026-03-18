import type { ChatMessage } from '../providers/llm.interface.js'
import { getTextContent } from '../providers/llm.interface.js'

interface BuildConversationMessagesArgs {
  systemPrompt: string
  summary?: string | null
  recentMessages: Array<Pick<ChatMessage, 'role' | 'content'>>
  currentUserContent: string
  historyIncludesCurrentUserMessage?: boolean
}

/**
 * Build the LLM conversation history while avoiding duplicate injection of the
 * current user message when it was already persisted before loading history.
 */
export function buildConversationMessages({
  systemPrompt,
  summary,
  recentMessages,
  currentUserContent,
  historyIncludesCurrentUserMessage = false,
}: BuildConversationMessagesArgs): ChatMessage[] {
  const rawMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(summary
      ? [
          { role: 'user' as const, content: `[Previous conversation summary]\n${summary}` },
          { role: 'assistant' as const, content: 'Understood, I have context from our earlier conversation.' },
        ]
      : []),
    ...recentMessages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    ...(!historyIncludesCurrentUserMessage
      ? [{ role: 'user' as const, content: currentUserContent }]
      : []),
  ]

  // Gemini rejects consecutive same-role user/assistant messages, so merge them.
  const messages: ChatMessage[] = []
  for (const message of rawMessages) {
    const previous = messages[messages.length - 1]
    if (
      previous
      && previous.role === message.role
      && (message.role === 'user' || message.role === 'assistant')
    ) {
      ;(previous as { content: string }).content += '\n\n' + getTextContent(message.content)
      continue
    }
    messages.push({ ...message })
  }

  return messages
}

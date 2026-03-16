import { createCompactLLM } from '../providers/index.js'
import type { ChatMessage } from '../providers/llm.interface.js'
import { recordTokenUsage } from './agent.service.js'
import {
  DEFAULT_MAX_CONTEXT_TOKENS,
  RECENT_MESSAGES_TO_KEEP,
  MIN_MESSAGES_FOR_COMPRESSION,
  TOKEN_ESTIMATION_DIVISOR,
  COMPRESSION_PREVIEW_LEN,
  COMPRESSION_TEMPERATURE,
  COMPRESSION_MAX_TOKENS,
} from '../constants.js'

interface HistoryMessage {
  id: string
  role: string
  content: string
  toolCalls?: unknown
  createdAt: Date
}

interface CompressionResult {
  summary: string | null
  recentMessages: HistoryMessage[]
  compressed: boolean
  lastSummarizedMessageId: string | null
}

function estimateTokens(messages: Array<{ content: string }>): number {
  return messages.reduce((sum, m) => sum + Math.ceil(m.content.length / TOKEN_ESTIMATION_DIVISOR), 0)
}

/**
 * Find split index that keeps at least `keepCount` messages at the end,
 * without splitting a tool-call group (assistant w/ toolCalls + subsequent tool messages).
 */
function findSafeSplitIndex(
  messages: HistoryMessage[],
  keepCount: number,
): number {
  let splitIdx = messages.length - keepCount
  if (splitIdx <= 0) return 0

  // Walk backward if we're inside a tool-call group
  while (splitIdx > 0) {
    const msg = messages[splitIdx]
    if (msg.role === 'tool') {
      splitIdx--
    } else {
      break
    }
  }

  return splitIdx
}

export async function compressContext(
  history: HistoryMessage[],
  existingSummary: string | null,
  existingSummaryUpTo: string | null,
  lastInputTokens: number | null,
  sessionId?: string,
  maxContextTokens?: number,
): Promise<CompressionResult> {
  const limit = maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS

  // Not enough messages to bother
  if (history.length < MIN_MESSAGES_FOR_COMPRESSION) {
    return { summary: existingSummary, recentMessages: history, compressed: false, lastSummarizedMessageId: null }
  }

  const estimatedTokens = estimateTokens(history)
  const overThreshold = estimatedTokens > limit || (lastInputTokens != null && lastInputTokens > limit)

  if (!overThreshold) {
    return { summary: existingSummary, recentMessages: history, compressed: false, lastSummarizedMessageId: null }
  }

  // Try to find a split point, reducing kept messages if needed for large conversations
  let splitIdx = findSafeSplitIndex(history, RECENT_MESSAGES_TO_KEEP)
  if (splitIdx <= 0 && overThreshold) {
    for (let keep = Math.min(history.length - 2, RECENT_MESSAGES_TO_KEEP); keep >= 2; keep--) {
      splitIdx = findSafeSplitIndex(history, keep)
      if (splitIdx > 0) break
    }
  }
  if (splitIdx <= 0) {
    return { summary: existingSummary, recentMessages: history, compressed: false, lastSummarizedMessageId: null }
  }

  const olderMessages = history.slice(0, splitIdx)
  const recentMessages = history.slice(splitIdx)
  const lastSummarizedMessageId = olderMessages[olderMessages.length - 1].id

  // Check if we already summarized up to this point
  if (existingSummaryUpTo === lastSummarizedMessageId && existingSummary) {
    return { summary: existingSummary, recentMessages, compressed: false, lastSummarizedMessageId }
  }

  // Find only new messages to summarize (after the cursor)
  let messagesToSummarize = olderMessages
  if (existingSummaryUpTo) {
    const cursorIdx = olderMessages.findIndex((m) => m.id === existingSummaryUpTo)
    if (cursorIdx >= 0) {
      messagesToSummarize = olderMessages.slice(cursorIdx + 1)
    }
  }

  if (messagesToSummarize.length === 0 && existingSummary) {
    return { summary: existingSummary, recentMessages, compressed: false, lastSummarizedMessageId }
  }

  // Build summarization prompt
  const formattedMessages = messagesToSummarize
    .map((m) => `[${m.role}]: ${m.content.slice(0, COMPRESSION_PREVIEW_LEN)}`)
    .join('\n')

  const summaryPrompt = [
    'Summarize this conversation history concisely. Preserve:',
    '- Key facts, decisions, and conclusions',
    '- File names, paths, and technical details discussed',
    '- Tool actions taken and their outcomes',
    '- User preferences or instructions established',
    '',
    'Be factual and dense. No filler.',
    '',
    ...(existingSummary
      ? [`Previous summary to extend:\n${existingSummary}\n`]
      : []),
    `New messages:\n${formattedMessages}`,
  ].join('\n')

  try {
    const llm = await createCompactLLM()
    const response = await llm.chatWithTools(
      [
        { role: 'system', content: 'You are a conversation summarizer. Output only the summary.' },
        { role: 'user', content: summaryPrompt },
      ] as ChatMessage[],
      { temperature: COMPRESSION_TEMPERATURE, maxTokens: COMPRESSION_MAX_TOKENS },
    )

    if (sessionId) {
      recordTokenUsage(response.usage, sessionId, llm.providerId, llm.modelId)
    }

    const summary = response.content?.trim() || existingSummary

    console.log(`[Context] Compressed ${messagesToSummarize.length} messages, keeping ${recentMessages.length} recent`)

    return { summary, recentMessages, compressed: true, lastSummarizedMessageId }
  } catch (err) {
    console.error('[Context] Compression failed, using full history:', err)
    return { summary: existingSummary, recentMessages: history, compressed: false, lastSummarizedMessageId: null }
  }
}

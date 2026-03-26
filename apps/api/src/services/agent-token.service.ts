import { prisma } from '../lib/prisma.js'
import type { TokenUsage } from '../providers/llm.interface.js'
import { logger } from '../lib/logger.js'
import { TOOL_ARG_SIZE_LIMIT } from '../constants.js'

/** Tools exempt from the argument size guard (they have proper alternatives like sourcePath) */
const SIZE_GUARD_EXEMPT = new Set(['generate_file', 'save_document', 'search_documents'])

/**
 * Check if a tool call's arguments exceed the size limit.
 * Returns a rejection message if too large, null otherwise.
 */
export function checkToolArgSize(toolCall: {
  name: string
  arguments: Record<string, unknown>
}): string | null {
  if (SIZE_GUARD_EXEMPT.has(toolCall.name)) return null
  const commandArg =
    toolCall.arguments?.command ?? toolCall.arguments?.code ?? toolCall.arguments?.content
  if (typeof commandArg !== 'string' || commandArg.length <= TOOL_ARG_SIZE_LIMIT) return null

  const sizeKB = Math.round(commandArg.length / 1000)
  return (
    `[BLOCKED] ${toolCall.name} contains ${sizeKB}KB inline data (limit: 10KB). ` +
    `Reference files instead of embedding data:\n` +
    `1. Previous outputs are saved in /workspace/.outputs/ — read from there\n` +
    `2. Write a script that processes the file (e.g. cat /workspace/.outputs/<id>.txt | jq ...)\n` +
    `3. For generate_file, use sourcePath to reference the sandbox file\n\n` +
    `Command was NOT executed. Rewrite to reference files.`
  )
}

export async function recordTokenUsage(
  usage: TokenUsage | undefined,
  sessionId: string,
  provider: string,
  model: string,
  options?: {
    updateSessionContext?: boolean
  },
) {
  if (!usage) return
  try {
    const date = new Date().toISOString().slice(0, 10)
    const writes: Promise<unknown>[] = [
      prisma.tokenUsage.create({
        data: {
          provider,
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          sessionId,
          date,
        },
      }),
    ]
    if (options?.updateSessionContext !== false) {
      writes.push(
        prisma.chatSession.update({
          where: { id: sessionId },
          data: { lastInputTokens: usage.inputTokens },
        }),
      )
    }
    await Promise.all(writes)
  } catch (err) {
    logger.error('[Agent] Failed to record token usage', err, { sessionId })
  }
}

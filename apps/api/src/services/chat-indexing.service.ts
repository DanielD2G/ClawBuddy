import { prisma } from '../lib/prisma.js'
import { qdrant } from '../lib/qdrant.js'
import { QDRANT_COLLECTION_NAME } from '@agentbuddy/shared'
import { embeddingService } from './embedding.service.js'
import { CHAT_RAG_MIN_MESSAGES_FOR_INDEXING, CHAT_RAG_SEARCH_LIMIT, EMBEDDING_BATCH_SIZE } from '../constants.js'

interface ChatTurn {
  messageIds: string[]
  content: string
  turnIndex: number
}

/**
 * Groups chat messages into user+assistant turns for semantic indexing.
 * Skips tool/system messages — they're noise for retrieval.
 */
function groupIntoTurns(
  messages: Array<{ id: string; role: string; content: string }>,
): ChatTurn[] {
  const turns: ChatTurn[] = []
  let turnIndex = 0

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role !== 'user') continue

    const ids = [msg.id]
    let content = `User: ${msg.content}`

    // Collect following assistant messages (skip tool messages in between)
    for (let j = i + 1; j < messages.length; j++) {
      const next = messages[j]
      if (next.role === 'assistant') {
        ids.push(next.id)
        content += `\nAssistant: ${next.content}`
        break
      }
      if (next.role === 'user') break
      // skip tool/system messages
    }

    turns.push({ messageIds: ids, content, turnIndex: turnIndex++ })
  }

  return turns
}

export const chatIndexingService = {
  /**
   * Index compressed chat messages into Qdrant for semantic retrieval.
   * Called after context compression to make old messages searchable.
   */
  async indexChatMessages(sessionId: string): Promise<void> {
    const session = await prisma.chatSession.findUnique({
      where: { id: sessionId },
      select: { chatIndexedUpTo: true, contextSummaryUpTo: true },
    })
    if (!session?.contextSummaryUpTo) return

    // Fetch messages that were compressed but not yet indexed
    const whereClause: Record<string, unknown> = {
      sessionId,
      role: { in: ['user', 'assistant'] },
    }

    // Only get messages after the last indexed point
    if (session.chatIndexedUpTo) {
      const cursor = await prisma.chatMessage.findUnique({
        where: { id: session.chatIndexedUpTo },
        select: { createdAt: true },
      })
      if (cursor) {
        whereClause.createdAt = { gt: cursor.createdAt }
      }
    }

    // Only index up to the compression cursor (don't index recent messages)
    const summaryCursor = await prisma.chatMessage.findUnique({
      where: { id: session.contextSummaryUpTo },
      select: { createdAt: true },
    })
    if (summaryCursor) {
      whereClause.createdAt = {
        ...(whereClause.createdAt as Record<string, unknown> || {}),
        lte: summaryCursor.createdAt,
      }
    }

    const messages = await prisma.chatMessage.findMany({
      where: whereClause,
      orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, content: true },
    })

    if (messages.length < CHAT_RAG_MIN_MESSAGES_FOR_INDEXING) return

    const turns = groupIntoTurns(messages)
    if (turns.length === 0) return

    // Embed in batches
    const allTexts = turns.map((t) => t.content)
    const allVectors: number[][] = []

    for (let i = 0; i < allTexts.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = allTexts.slice(i, i + EMBEDDING_BATCH_SIZE)
      const vectors = await embeddingService.embedBatch(batch)
      allVectors.push(...vectors)
    }

    // Upsert into Qdrant
    const points = turns.map((turn, idx) => ({
      id: crypto.randomUUID(),
      vector: allVectors[idx],
      payload: {
        sessionId,
        messageIds: turn.messageIds,
        turnIndex: turn.turnIndex,
        content: turn.content,
        type: 'chat_message' as const,
      },
    }))

    await qdrant.upsert(QDRANT_COLLECTION_NAME, { points })

    // Update cursor to the last message we indexed
    const lastMessageId = messages[messages.length - 1].id
    await prisma.chatSession.update({
      where: { id: sessionId },
      data: { chatIndexedUpTo: lastMessageId },
    })

    console.log(`[ChatRAG] Indexed ${turns.length} turns for session ${sessionId}`)
  },

  /**
   * Remove all chat RAG vectors for a session (cleanup on delete).
   */
  async deleteChatIndex(sessionId: string): Promise<void> {
    try {
      await qdrant.delete(QDRANT_COLLECTION_NAME, {
        filter: {
          must: [
            { key: 'sessionId', match: { value: sessionId } },
            { key: 'type', match: { value: 'chat_message' } },
          ],
        },
      })
      console.log(`[ChatRAG] Cleaned up index for session ${sessionId}`)
    } catch (err) {
      // Collection may not exist yet — that's fine
      console.warn('[ChatRAG] Cleanup warning:', err)
    }
  },

  /**
   * Search past conversation turns by semantic similarity.
   * Returns the text content of the most relevant turns.
   */
  async searchChatHistory(
    sessionId: string,
    query: string,
    limit = CHAT_RAG_SEARCH_LIMIT,
  ): Promise<Array<{ content: string; score: number }>> {
    const queryVector = await embeddingService.embed(query)

    const results = await qdrant.search(QDRANT_COLLECTION_NAME, {
      vector: queryVector,
      limit,
      filter: {
        must: [
          { key: 'sessionId', match: { value: sessionId } },
          { key: 'type', match: { value: 'chat_message' } },
        ],
      },
      with_payload: true,
    })

    return results
      .filter((r) => r.payload?.content)
      .map((r) => ({
        content: r.payload!.content as string,
        score: r.score,
      }))
  },
}

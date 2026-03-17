import { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { createLLMProvider, createLightLLM, createTitleLLM } from '../providers/index.js'
import { recordTokenUsage } from './agent.service.js'
import { settingsService } from './settings.service.js'
import { embeddingService } from './embedding.service.js'
import { searchService } from './search.service.js'
import { agentService } from './agent.service.js'
import { capabilityService } from './capability.service.js'
import type { SSEEmit } from '../lib/sse.js'
import {
  CHAT_TITLE_MAX_LEN,
  TITLE_TEMPERATURE,
  TITLE_MAX_TOKENS,
  SEARCH_RESULTS_LIMIT,
} from '../constants.js'



export const chatService = {
  async createSession(data: { workspaceId: string; title?: string }) {
    return prisma.chatSession.create({ data })
  },

  async listSessions() {
    const sessions = await prisma.chatSession.findMany({
      orderBy: { lastMessageAt: 'desc' },
    })
    const sessionIds = sessions.map((s) => s.id)
    if (sessionIds.length === 0) return []

    // Build per-session unread thresholds for a single batched query
    const thresholds = sessions.map((s) => ({
      id: s.id,
      since: s.lastReadAt ?? s.updatedAt,
    }))

    const [unreadRows, sandboxCounts] = await Promise.all([
      prisma.$queryRaw<Array<{ sessionId: string; count: bigint }>>`
        SELECT m."sessionId", COUNT(*)::bigint AS count
        FROM "ChatMessage" m
        JOIN (VALUES ${Prisma.join(
          thresholds.map((t) => Prisma.sql`(${t.id}::text, ${t.since}::timestamp)`),
        )}) AS t(id, since)
        ON m."sessionId" = t.id AND m."createdAt" > t.since
        WHERE m."sessionId" IN (${Prisma.join(sessionIds)})
        GROUP BY m."sessionId"
      `,
      prisma.sandboxSession.groupBy({
        by: ['chatSessionId'],
        where: { chatSessionId: { in: sessionIds }, status: 'running' },
        _count: { id: true },
      }),
    ])

    const unreadMap = new Map(unreadRows.map((r) => [r.sessionId, Number(r.count)]))
    const sandboxMap = new Map(sandboxCounts.map((c) => [c.chatSessionId, c._count.id]))

    return sessions.map((s) => ({
      ...s,
      unreadCount: unreadMap.get(s.id) ?? 0,
      activeSandbox: (sandboxMap.get(s.id) ?? 0) > 0,
    }))
  },

  async markAsRead(sessionId: string) {
    // Use raw query to avoid @updatedAt auto-updating, which would reorder the session list
    return prisma.$executeRaw`UPDATE "ChatSession" SET "lastReadAt" = NOW() WHERE "id" = ${sessionId}`
  },

  async getSession(sessionId: string) {
    return prisma.chatSession.findUnique({
      where: { id: sessionId },
    })
  },

  async deleteSession(sessionId: string) {
    return prisma.chatSession.delete({ where: { id: sessionId } })
  },

  async getMessages(sessionId: string) {
    const messages = await prisma.chatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      include: {
        toolExecutions: {
          select: {
            id: true,
            toolName: true,
            capabilitySlug: true,
            input: true,
            output: true,
            screenshot: true,
            error: true,
            exitCode: true,
            durationMs: true,
            status: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    })

    // Reconstruct content blocks and apply toolCalls fallback
    return messages.map((msg) => {
      let toolExecs = msg.toolExecutions

      // Fallback: if a message has toolCalls JSON but no linked toolExecutions, use the JSON data
      if (toolExecs.length === 0 && msg.toolCalls && Array.isArray(msg.toolCalls)) {
        toolExecs = (msg.toolCalls as Array<Record<string, unknown>>).map((tc, i) => ({
          id: `${msg.id}-tc-${i}`,
          toolName: String(tc.name ?? ''),
          capabilitySlug: String(tc.capability ?? ''),
          input: tc.input ?? {},
          output: tc.output != null ? String(tc.output) : null,
          error: tc.error != null ? String(tc.error) : null,
          exitCode: tc.exitCode != null ? Number(tc.exitCode) : null,
          durationMs: tc.durationMs != null ? Number(tc.durationMs) : null,
          status: tc.error ? 'failed' : 'completed',
        }))
      }

      // Reconstruct ordered contentBlocks from stored layout + tool execution data
      const storedBlocks = msg.contentBlocks as Array<{ type: string; text?: string; toolIndex?: number }> | null
      let contentBlocks: Array<{ type: 'text'; text: string } | { type: 'tool'; tool: typeof toolExecs[number] }> | undefined
      if (storedBlocks?.length) {
        contentBlocks = storedBlocks.map((block) => {
          if (block.type === 'tool' && block.toolIndex != null && toolExecs[block.toolIndex]) {
            return { type: 'tool' as const, tool: toolExecs[block.toolIndex] }
          }
          return { type: 'text' as const, text: block.text ?? '' }
        })
      }

      return { ...msg, toolExecutions: toolExecs, ...(contentBlocks ? { contentBlocks } : {}) }
    })
  },

  async sendMessage(sessionId: string, content: string, emit: SSEEmit, documentIds?: string[], mentionedSlugs?: string[], attachments?: { name: string; size: number; type: string; storageKey: string; url: string }[]) {
    const session = await prisma.chatSession.findUniqueOrThrow({
      where: { id: sessionId },
    })

    // Store user message (with attachments if any) and bump lastMessageAt for sidebar ordering
    await Promise.all([
      prisma.chatMessage.create({
        data: {
          sessionId,
          role: 'user',
          content,
          ...(attachments?.length ? { attachments } : {}),
        },
      }),
      prisma.$executeRaw`UPDATE "ChatSession" SET "lastMessageAt" = NOW() WHERE "id" = ${sessionId}`,
    ])

    // Check workspace-scoped capabilities
    const capabilities = await capabilityService.getEnabledCapabilitiesForWorkspace(session.workspaceId!)
    const hasNonDocCapabilities = capabilities.some((c) => c.slug !== 'document-search')

    const hasMentions = mentionedSlugs?.length && mentionedSlugs.length > 0

    const debugAgent = process.env.DEBUG_AGENT === '1' || process.env.DEBUG === '1'
    if (debugAgent) {
      console.debug('[Chat] sendMessage routing', {
        sessionId,
        workspaceId: session.workspaceId,
        hasNonDocCapabilities,
        hasMentions,
        mentionedSlugs,
        capabilitySlugs: capabilities.map((c) => c.slug),
        willUseAgent: hasNonDocCapabilities || hasMentions,
      })
    }

    if (hasNonDocCapabilities || hasMentions) {
      return this._sendWithAgentLoop(session, sessionId, content, emit, mentionedSlugs)
    }

    // Use classic RAG flow for document-search-only workspaces
    return this._sendWithRAG(session, sessionId, content, emit, documentIds)
  },

  /**
   * Agent loop path: tool-calling with capabilities.
   */
  async _sendWithAgentLoop(
    session: { id: string; workspaceId: string | null; title: string | null },
    sessionId: string,
    content: string,
    emit: SSEEmit,
    mentionedSlugs?: string[],
  ) {
    try {
      await prisma.chatSession.update({
        where: { id: sessionId },
        data: { agentStatus: 'running' },
      })

      // Auto-title immediately (fire-and-forget, don't wait for agent loop)
      this._autoTitle(session, sessionId, content)

      const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: session.workspaceId! }, select: { autoExecute: true } })

      // Agent loop now saves ChatMessages per-iteration directly — no tracking wrapper needed
      const result = await agentService.runAgentLoop(sessionId, content, session.workspaceId!, emit, {
        autoApprove: workspace.autoExecute,
        mentionedSlugs,
      })

      await prisma.chatSession.update({
        where: { id: sessionId },
        data: { agentStatus: 'idle' },
      })

      emit('done', { messageId: result.lastMessageId, sessionId })
    } catch (err) {
      console.error('[ChatService] Agent loop error:', err)

      await prisma.chatSession.update({
        where: { id: sessionId },
        data: { agentStatus: 'idle' },
      }).catch(() => {})

      const errorMsg = err instanceof Error ? err.message : 'An unexpected error occurred'
      emit('error', { message: errorMsg })
      emit('done', { sessionId })
    }
  },

  /**
   * Classic RAG path (backward compatible).
   */
  async _sendWithRAG(
    session: { id: string; workspaceId: string | null; title: string | null },
    sessionId: string,
    content: string,
    emit: SSEEmit,
    documentIds?: string[],
  ) {
    emit('thinking', { message: 'Searching documents...' })

    // Auto-title immediately (fire-and-forget)
    this._autoTitle(session, sessionId, content)

    const useLightModel = await settingsService.getUseLightModel()
    const llm = useLightModel ? await createLightLLM() : await createLLMProvider()

    const queryVector = await embeddingService.embed(content)

    let searchResults = await searchService.search(queryVector, {
      limit: SEARCH_RESULTS_LIMIT,
      workspaceId: session.workspaceId ?? undefined,
      documentIds,
    })

    if (!searchResults.length) {
      searchResults = await searchService.search(queryVector, {
        limit: SEARCH_RESULTS_LIMIT,
        documentIds,
      })
    }

    const chunkIds = searchResults
      .map((r) => (r.payload as Record<string, unknown>)?.chunkId as string)
      .filter(Boolean)

    let chunks = chunkIds.length
      ? await prisma.documentChunk.findMany({
          where: { id: { in: chunkIds } },
          include: { document: { select: { title: true, id: true } } },
        })
      : []

    if (!chunks.length && searchResults.length) {
      const qdrantIds = searchResults.map((r) => r.id as string).filter(Boolean)
      chunks = await prisma.documentChunk.findMany({
        where: { qdrantId: { in: qdrantIds } },
        include: { document: { select: { title: true, id: true } } },
      })
    }

    const contextText = chunks
      .map((c) => `[Source: ${c.document.title}]\n${c.content}`)
      .join('\n\n---\n\n')

    const systemPrompt = contextText
      ? `You are a helpful document assistant. Answer the user's question using ONLY the context provided below. If the context does not contain enough information, say so.\n\nContext:\n${contextText}`
      : 'You are a helpful document assistant. No relevant documents were found for this query. Let the user know and try to help based on general knowledge.'

    emit('thinking', { message: 'Generating response...' })

    const llmResponse = await llm.chatWithTools([
      { role: 'system', content: systemPrompt },
      { role: 'user', content },
    ])
    const response = llmResponse.content

    recordTokenUsage(llmResponse.usage, sessionId, llm.providerId, llm.modelId)

    const seen = new Set<string>()
    const sources: { documentId: string; documentTitle: string; workspaceId: string; chunkId: string; chunkIndex: number }[] = []
    for (const c of chunks) {
      if (!seen.has(c.document.id)) {
        seen.add(c.document.id)
        sources.push({
          documentId: c.document.id,
          documentTitle: c.document.title,
          workspaceId: session.workspaceId ?? '',
          chunkId: c.id,
          chunkIndex: c.chunkIndex,
        })
      }
    }

    emit('content', { text: response })

    if (sources.length) {
      emit('sources', { sources })
    }

    const assistantMessage = await prisma.chatMessage.create({
      data: {
        sessionId,
        role: 'assistant',
        content: response,
        sources: sources.length ? sources : undefined,
      },
    })

    emit('done', { messageId: assistantMessage.id, sessionId })
  },

  /**
   * Auto-generate title for first message (fire-and-forget).
   */
  _autoTitle(
    session: { title: string | null },
    sessionId: string,
    content: string,
  ) {
    if (session.title) return // Already titled, nothing to do

    createTitleLLM()
      .then(async (titleLLM) => {
        const response = await titleLLM.chatWithTools(
          [
            {
              role: 'system',
              content:
                'Generate a short title (max 50 chars) for a chat conversation that starts with the following user message. Reply with ONLY the title, no quotes or punctuation wrapping it.',
            },
            { role: 'user', content },
          ],
          { temperature: TITLE_TEMPERATURE, maxTokens: TITLE_MAX_TOKENS },
        )
        recordTokenUsage(response.usage, sessionId, titleLLM.providerId, titleLLM.modelId)
        return response.content
      })
      .then((title) => {
        const trimmed = title.trim().slice(0, CHAT_TITLE_MAX_LEN)
        // Use raw query to avoid @updatedAt triggering sidebar reorder
        return prisma.$executeRaw`UPDATE "ChatSession" SET "title" = ${trimmed} WHERE "id" = ${sessionId}`
      })
      .catch(() => {
        const fallback = content.slice(0, CHAT_TITLE_MAX_LEN) + (content.length > CHAT_TITLE_MAX_LEN ? '...' : '')
        prisma.$executeRaw`UPDATE "ChatSession" SET "title" = ${fallback} WHERE "id" = ${sessionId}`.catch(() => {})
      })
  },
}

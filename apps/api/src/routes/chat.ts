import { Hono } from 'hono'
import { chatService } from '../services/chat.service.js'
import { agentService } from '../services/agent.service.js'
import { mentionParserService } from '../services/mention-parser.service.js'
import { createSSEStream } from '../lib/sse.js'
import { prisma } from '../lib/prisma.js'
import { storageService } from '../services/storage.service.js'
import { MAX_FILE_UPLOAD_BYTES } from '../constants.js'

const app = new Hono()

app.post('/chat', async (c) => {
  try {
    const body = await c.req.json()
    const { content } = body
    let { sessionId } = body

    if (!content) {
      return c.json({ success: false, error: 'content is required' }, 400)
    }

    if (!sessionId) {
      if (!body.workspaceId) {
        return c.json({ success: false, error: 'workspaceId is required for new sessions' }, 400)
      }
      const session = await chatService.createSession({
        workspaceId: body.workspaceId,
      })
      sessionId = session.id
    }

    const { cleanedContent, mentionedSlugs } = mentionParserService.parse(content)

    const currentSessionId = sessionId
    const attachments = body.attachments ?? undefined
    return createSSEStream(async (emit) => {
      emit('session', { sessionId: currentSessionId })
      await chatService.sendMessage(
        currentSessionId,
        cleanedContent || content,
        emit,
        body.documentIds,
        mentionedSlugs,
        attachments,
      )
    })
  } catch (error) {
    return c.json({ success: false, error: 'Chat failed' }, 500)
  }
})

app.post('/chat/sessions/:sessionId/approve', async (c) => {
  try {
    const { sessionId } = c.req.param()
    const body = await c.req.json()
    const { approvalId, decision, allowRule, scope } = body as {
      approvalId: string
      decision: 'approved' | 'denied'
      allowRule?: string
      scope?: 'session' | 'global'
    }

    if (!approvalId || !['approved', 'denied'].includes(decision)) {
      return c.json({ success: false, error: 'approvalId and decision (approved/denied) are required' }, 400)
    }

    const session = await chatService.getSession(sessionId)
    if (!session) {
      return c.json({ success: false, error: 'Session not found' }, 404)
    }

    await prisma.toolApproval.update({
      where: { id: approvalId },
      data: { status: decision, decidedAt: new Date() },
    })

    // Save allow rule if provided
    if (decision === 'approved' && allowRule && scope) {
      if (scope === 'global') {
        const settings = await prisma.globalSettings.findUnique({ where: { id: 'singleton' } })
        const existing = (settings?.autoApproveRules as string[]) ?? []
        if (!existing.includes(allowRule)) {
          await prisma.globalSettings.upsert({
            where: { id: 'singleton' },
            create: { id: 'singleton', autoApproveRules: [...existing, allowRule] },
            update: { autoApproveRules: [...existing, allowRule] },
          })
        }
      } else if (scope === 'session') {
        const existing = (session.sessionAllowRules as string[]) ?? []
        if (!existing.includes(allowRule)) {
          await prisma.chatSession.update({
            where: { id: sessionId },
            data: { sessionAllowRules: [...existing, allowRule] },
          })
        }
      }
    }

    const pendingApprovals = await prisma.toolApproval.findMany({
      where: { chatSessionId: sessionId, status: 'pending' },
    })

    if (pendingApprovals.length > 0) {
      return c.json({ success: true, data: { status: 'waiting', pendingCount: pendingApprovals.length } })
    }

    return createSSEStream(async (emit) => {
      // Track content block ordering for persistence
      const orderedBlocks: Array<{ type: 'text'; text: string } | { type: 'tool'; toolIndex: number }> = []
      let toolCounter = 0
      const trackingEmit: typeof emit = (event, data) => {
        if (event === 'content' && (data as { text?: string }).text) {
          const text = (data as { text: string }).text
          const last = orderedBlocks[orderedBlocks.length - 1]
          if (last && last.type === 'text') {
            last.text += text
          } else {
            orderedBlocks.push({ type: 'text', text })
          }
        } else if (event === 'tool_start') {
          orderedBlocks.push({ type: 'tool', toolIndex: toolCounter++ })
        }
        emit(event, data)
      }

      const result = await agentService.resumeAgentLoop(sessionId, trackingEmit)

      if (result.content) {
        const generatedFiles = result.toolExecutions
          .filter((te) => te.toolName === 'generate_file' && te.output && !te.error)
          .map((te) => {
            try {
              const parsed = JSON.parse(te.output!)
              if (parsed.filename && parsed.downloadUrl) {
                return { name: parsed.filename, url: parsed.downloadUrl, type: 'generated', size: 0 }
              }
            } catch { /* not JSON */ }
            return null
          })
          .filter(Boolean)

        const assistantMessage = await prisma.chatMessage.create({
          data: {
            sessionId,
            role: 'assistant',
            content: result.content,
            toolCalls: result.toolExecutions.length
              ? (JSON.parse(JSON.stringify(result.toolExecutions.map((te: { toolName: string; capabilitySlug: string; input: unknown; output?: string; error?: string; exitCode?: number; durationMs?: number }) => ({
                  name: te.toolName,
                  capability: te.capabilitySlug,
                  input: te.input,
                  output: te.output,
                  error: te.error,
                  exitCode: te.exitCode,
                  durationMs: te.durationMs,
                })))) as import('@prisma/client').Prisma.InputJsonValue)
              : undefined,
            ...(orderedBlocks.length ? { contentBlocks: orderedBlocks as unknown as import('@prisma/client').Prisma.InputJsonValue } : {}),
            ...(generatedFiles.length ? { attachments: generatedFiles } : {}),
          },
        })

        // Link tool executions to the message
        if (result.toolExecutions.length) {
          const recentExecutions = await prisma.toolExecution.findMany({
            where: {
              chatMessageId: null,
              createdAt: { gte: new Date(Date.now() - 120_000) },
            },
            orderBy: { createdAt: 'desc' },
            take: result.toolExecutions.length,
          })
          if (recentExecutions.length) {
            await prisma.toolExecution.updateMany({
              where: { id: { in: recentExecutions.map((e) => e.id) } },
              data: { chatMessageId: assistantMessage.id },
            })
          }
        }

        emit('done', { messageId: assistantMessage.id, sessionId })
      }

      const sessionData = await prisma.chatSession.findUnique({
        where: { id: sessionId },
        select: { title: true },
      })
      if (!sessionData?.title) {
        const firstMessage = await prisma.chatMessage.findFirst({
          where: { sessionId, role: 'user' },
          orderBy: { createdAt: 'asc' },
        })
        if (firstMessage) {
          chatService._autoTitle({ title: null }, sessionId, firstMessage.content)
        }
      }
    })
  } catch (error) {
    return c.json({ success: false, error: 'Approval failed' }, 500)
  }
})

// ── File upload for chat attachments ─────────────────────

app.post('/chat/upload', async (c) => {
  try {
    const formData = await c.req.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return c.json({ success: false, error: 'No file provided' }, 400)
    }

    if (file.size > MAX_FILE_UPLOAD_BYTES) {
      return c.json({ success: false, error: 'File too large (max 20MB)' }, 400)
    }

    const key = `chat-attachments/${Date.now()}-${file.name}`
    const buffer = Buffer.from(await file.arrayBuffer())
    await storageService.upload(key, buffer, file.type || 'application/octet-stream')

    return c.json({
      success: true,
      data: {
        name: file.name,
        size: file.size,
        type: file.type,
        storageKey: key,
        url: `/api/files/${key}`,
      },
    })
  } catch (error) {
    return c.json({ success: false, error: 'Upload failed' }, 500)
  }
})

app.get('/chat/sessions', async (c) => {
  try {
    const sessions = await chatService.listSessions()
    return c.json({ success: true, data: sessions })
  } catch (error) {
    return c.json({ success: false, error: 'Failed to list sessions' }, 500)
  }
})

app.post('/chat/sessions', async (c) => {
  try {
    const body = await c.req.json()
    if (!body.workspaceId) {
      return c.json({ success: false, error: 'workspaceId is required' }, 400)
    }
    const session = await chatService.createSession({
      workspaceId: body.workspaceId,
      title: body.title,
    })
    return c.json({ success: true, data: session }, 201)
  } catch (error) {
    return c.json({ success: false, error: 'Failed to create session' }, 500)
  }
})

app.delete('/chat/sessions/:sessionId', async (c) => {
  try {
    const { sessionId } = c.req.param()
    await chatService.deleteSession(sessionId)
    return c.json({ success: true, data: { id: sessionId } })
  } catch (error) {
    return c.json({ success: false, error: 'Failed to delete session' }, 500)
  }
})

app.get('/chat/sessions/:sessionId/messages', async (c) => {
  try {
    const { sessionId } = c.req.param()
    const messages = await chatService.getMessages(sessionId)

    // Include pending approval state so the UI can restore after reload
    const session = await prisma.chatSession.findUnique({
      where: { id: sessionId },
      select: { agentStatus: true },
    })

    let pendingApprovals: Array<{ id: string; toolName: string; capabilitySlug: string; input: unknown }> = []
    if (session?.agentStatus === 'awaiting_approval') {
      pendingApprovals = await prisma.toolApproval.findMany({
        where: { chatSessionId: sessionId, status: 'pending' },
        select: { id: true, toolName: true, capabilitySlug: true, input: true },
      })
    }

    return c.json({
      success: true,
      data: {
        messages,
        agentStatus: session?.agentStatus ?? 'idle',
        pendingApprovals,
      },
    })
  } catch (error) {
    return c.json({ success: false, error: 'Failed to get messages' }, 500)
  }
})

app.post('/chat/sessions/:sessionId/read', async (c) => {
  try {
    const { sessionId } = c.req.param()
    await chatService.markAsRead(sessionId)
    return c.json({ success: true })
  } catch (error) {
    return c.json({ success: false, error: 'Failed to mark as read' }, 500)
  }
})

export default app

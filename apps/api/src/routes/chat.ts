import { Hono } from 'hono'
import { chatService } from '../services/chat.service.js'
import { agentService } from '../services/agent.service.js'
import { mentionParserService } from '../services/mention-parser.service.js'
import { createSSEStream } from '../lib/sse.js'
import { prisma } from '../lib/prisma.js'
import { storageService } from '../services/storage.service.js'
import { MAX_FILE_UPLOAD_BYTES } from '../constants.js'
import { sanitizeFileName } from '../lib/sanitize.js'
import { secretRedactionService } from '../services/secret-redaction.service.js'

const app = new Hono()

app.post('/chat', async (c) => {
  const body = await c.req.json()
  const { content } = body
  let { sessionId } = body
  let { workspaceId } = body

  if (!content) {
    return c.json({ success: false, error: 'content is required' }, 400)
  }

  if (!sessionId) {
    if (!workspaceId) {
      return c.json({ success: false, error: 'workspaceId is required for new sessions' }, 400)
    }
    const session = await chatService.createSession({
      workspaceId,
    })
    sessionId = session.id
  } else if (!workspaceId) {
    const session = await chatService.getSession(sessionId)
    workspaceId = session?.workspaceId ?? undefined
  }

  const { cleanedContent, mentionedSlugs } = mentionParserService.parse(content)

  const currentSessionId = sessionId
  const attachments = body.attachments ?? undefined
  const inventory = await secretRedactionService.buildSecretInventory(workspaceId)
  return createSSEStream(async (emit) => {
    const redactedEmit = secretRedactionService.createRedactedEmit(emit, inventory)
    redactedEmit('session', { sessionId: currentSessionId })
    await chatService.sendMessage(
      currentSessionId,
      cleanedContent || content,
      redactedEmit,
      { documentIds: body.documentIds, mentionedSlugs, attachments, inventory },
    )
  })
})

app.post('/chat/sessions/:sessionId/approve', async (c) => {
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

  const inventory = await secretRedactionService.buildSecretInventory(session.workspaceId)
  return createSSEStream(async (emit) => {
    const redactedEmit = secretRedactionService.createRedactedEmit(emit, inventory)
    // Agent loop now saves ChatMessages per-iteration directly
    const result = await agentService.resumeAgentLoop(sessionId, redactedEmit, inventory)

    redactedEmit('done', { messageId: result.lastMessageId, sessionId })

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
})

// ── File upload for chat attachments ─────────────────────

app.post('/chat/upload', async (c) => {
  const formData = await c.req.formData()
  const file = formData.get('file') as File | null

  if (!file) {
    return c.json({ success: false, error: 'No file provided' }, 400)
  }

  if (file.size > MAX_FILE_UPLOAD_BYTES) {
    return c.json({ success: false, error: 'File too large (max 20MB)' }, 400)
  }

  const key = `chat-attachments/${Date.now()}-${sanitizeFileName(file.name)}`
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
})

app.get('/chat/sessions', async (c) => {
  const sessions = await chatService.listSessions()
  return c.json({ success: true, data: sessions })
})

app.post('/chat/sessions', async (c) => {
  const body = await c.req.json()
  if (!body.workspaceId) {
    return c.json({ success: false, error: 'workspaceId is required' }, 400)
  }
  const session = await chatService.createSession({
    workspaceId: body.workspaceId,
    title: body.title,
  })
  return c.json({ success: true, data: session }, 201)
})

app.delete('/chat/sessions/:sessionId', async (c) => {
  const { sessionId } = c.req.param()
  await chatService.deleteSession(sessionId)
  return c.json({ success: true, data: { id: sessionId } })
})

app.get('/chat/sessions/:sessionId/messages', async (c) => {
  const { sessionId } = c.req.param()
  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: { agentStatus: true },
  })
  const messages = await chatService.getMessages(sessionId)

  // Include pending approval state so the UI can restore after reload
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
})

app.post('/chat/sessions/:sessionId/read', async (c) => {
  const { sessionId } = c.req.param()
  await chatService.markAsRead(sessionId)
  return c.json({ success: true })
})

export default app

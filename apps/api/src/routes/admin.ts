import { Hono } from 'hono'
import { settingsService } from '../services/settings.service.js'
import { buildModelCatalogs, invalidateModelCache } from '../services/model-discovery.service.js'
import { prisma } from '../lib/prisma.js'
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '../constants.js'

const app = new Hono()

// ── Stats ────────────────────────────────────────────────

app.get('/admin/stats', async (c) => {
  const [workspaces, documents, conversations] = await Promise.all([
    prisma.workspace.count(),
    prisma.document.count(),
    prisma.chatSession.count(),
  ])
  return c.json({ success: true, data: { workspaces, documents, conversations } })
})

// ── Workspaces ───────────────────────────────────────────

app.get('/admin/workspaces', async (c) => {
  const page = Math.max(1, Number(c.req.query('page') ?? 1))
  const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, Number(c.req.query('limit') ?? DEFAULT_PAGE_LIMIT)))
  const search = c.req.query('search') ?? ''

  const where = search
    ? { name: { contains: search, mode: 'insensitive' as const } }
    : {}

  const [workspaces, total] = await Promise.all([
    prisma.workspace.findMany({
      where,
      select: {
        id: true,
        name: true,
        description: true,
        createdAt: true,
        _count: { select: { documents: true, chatSessions: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.workspace.count({ where }),
  ])

  return c.json({ success: true, data: { workspaces, total, page, limit } })
})

// ── Documents ────────────────────────────────────────────

app.get('/admin/documents', async (c) => {
  const page = Math.max(1, Number(c.req.query('page') ?? 1))
  const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, Number(c.req.query('limit') ?? DEFAULT_PAGE_LIMIT)))
  const search = c.req.query('search') ?? ''
  const status = c.req.query('status') ?? ''

  const where: Record<string, unknown> = {}
  if (search) where.title = { contains: search, mode: 'insensitive' }
  if (status) where.status = status

  const [documents, total] = await Promise.all([
    prisma.document.findMany({
      where,
      select: {
        id: true,
        title: true,
        status: true,
        type: true,
        chunkCount: true,
        createdAt: true,
        workspace: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.document.count({ where }),
  ])

  return c.json({ success: true, data: { documents, total, page, limit } })
})

// ── Conversations ────────────────────────────────────────

app.get('/admin/conversations', async (c) => {
  const page = Math.max(1, Number(c.req.query('page') ?? 1))
  const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, Number(c.req.query('limit') ?? DEFAULT_PAGE_LIMIT)))
  const search = c.req.query('search') ?? ''

  const where = search
    ? { title: { contains: search, mode: 'insensitive' as const } }
    : {}

  const [conversations, total] = await Promise.all([
    prisma.chatSession.findMany({
      where,
      select: {
        id: true,
        title: true,
        createdAt: true,
        workspace: { select: { id: true, name: true } },
        _count: { select: { messages: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.chatSession.count({ where }),
  ])

  return c.json({ success: true, data: { conversations, total, page, limit } })
})

// ── Settings ─────────────────────────────────────────────

app.get('/admin/settings', async (c) => {
  const settings = await settingsService.get()
  const available = await settingsService.getAvailableProviders()
  const apiKeys = await settingsService.getMaskedKeys()

  const models = await buildModelCatalogs(available)

  return c.json({
    success: true,
    data: {
      providers: {
        active: {
          llm: settings.aiProvider,
          llmModel: settings.aiModel,
          embedding: settings.embeddingProvider,
          embeddingModel: settings.embeddingModel,
        },
        available,
        models,
      },
      apiKeys,
      onboardingComplete: settings.onboardingComplete,
    },
  })
})

app.patch('/admin/settings', async (c) => {
  const body = await c.req.json()
  const settings = await settingsService.update({
    aiProvider: body.llm,
    aiModel: body.llmModel,
    embeddingProvider: body.embedding,
    embeddingModel: body.embeddingModel,
  })
  return c.json({
    success: true,
    data: {
      active: {
        llm: settings.aiProvider,
        llmModel: settings.aiModel,
        embedding: settings.embeddingProvider,
        embeddingModel: settings.embeddingModel,
      },
    },
  })
})

app.put('/admin/api-keys/:provider', async (c) => {
  const { provider } = c.req.param()
  const { key } = await c.req.json()
  if (!key || typeof key !== 'string') {
    return c.json({ success: false, error: 'key is required' }, 400)
  }
  await settingsService.setApiKey(provider, key)
  invalidateModelCache(provider)
  const apiKeys = await settingsService.getMaskedKeys()
  return c.json({ success: true, data: { apiKeys } })
})

app.delete('/admin/api-keys/:provider', async (c) => {
  const { provider } = c.req.param()
  await settingsService.removeApiKey(provider)
  invalidateModelCache(provider)
  const apiKeys = await settingsService.getMaskedKeys()
  return c.json({ success: true, data: { apiKeys } })
})

// ── Permissions (Global Auto-Approve Rules) ─────────────

app.get('/admin/permissions', async (c) => {
  const settings = await prisma.globalSettings.findUnique({ where: { id: 'singleton' } })
  return c.json({
    success: true,
    data: { autoApproveRules: (settings?.autoApproveRules as string[]) ?? [] },
  })
})

app.patch('/admin/permissions', async (c) => {
  const { autoApproveRules } = await c.req.json()
  if (!Array.isArray(autoApproveRules) || !autoApproveRules.every((r: unknown) => typeof r === 'string')) {
    return c.json({ success: false, error: 'autoApproveRules must be a string array' }, 400)
  }
  const settings = await prisma.globalSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', autoApproveRules },
    update: { autoApproveRules },
  })
  return c.json({
    success: true,
    data: { autoApproveRules: (settings.autoApproveRules as string[]) ?? [] },
  })
})

export default app

import { Hono } from 'hono'
import { settingsService } from '../services/settings.service.js'
import { buildModelCatalogs, invalidateModelCache } from '../services/model-discovery.service.js'
import { systemUpdateService } from '../services/system-update.service.js'
import { prisma } from '../lib/prisma.js'
import { parsePagination } from '../lib/pagination.js'
import { ok, fail } from '../lib/responses.js'

const app = new Hono()

// ── Stats ────────────────────────────────────────────────

app.get('/admin/stats', async (c) => {
  const [workspaces, documents, conversations] = await Promise.all([
    prisma.workspace.count(),
    prisma.document.count(),
    prisma.chatSession.count(),
  ])
  return ok(c, { workspaces, documents, conversations })
})

// ── Workspaces ───────────────────────────────────────────

app.get('/admin/workspaces', async (c) => {
  const { page, limit, skip } = parsePagination(c)
  const search = c.req.query('search') ?? ''

  const where = search ? { name: { contains: search, mode: 'insensitive' as const } } : {}

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
      skip,
      take: limit,
    }),
    prisma.workspace.count({ where }),
  ])

  return ok(c, { workspaces, total, page, limit })
})

// ── Documents ────────────────────────────────────────────

app.get('/admin/documents', async (c) => {
  const { page, limit, skip } = parsePagination(c)
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
      skip,
      take: limit,
    }),
    prisma.document.count({ where }),
  ])

  return ok(c, { documents, total, page, limit })
})

// ── Conversations ────────────────────────────────────────

app.get('/admin/conversations', async (c) => {
  const { page, limit, skip } = parsePagination(c)
  const search = c.req.query('search') ?? ''

  const where = search ? { title: { contains: search, mode: 'insensitive' as const } } : {}

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
      skip,
      take: limit,
    }),
    prisma.chatSession.count({ where }),
  ])

  return ok(c, { conversations, total, page, limit })
})

// ── Settings ─────────────────────────────────────────────

app.get('/admin/settings', async (c) => {
  const settings = await settingsService.get()
  const available = await settingsService.getAvailableProviders()
  const apiKeys = await settingsService.getMaskedKeys()

  const models = await buildModelCatalogs(available)

  return ok(c, {
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
  return ok(c, {
    active: {
      llm: settings.aiProvider,
      llmModel: settings.aiModel,
      embedding: settings.embeddingProvider,
      embeddingModel: settings.embeddingModel,
    },
  })
})

app.put('/admin/api-keys/:provider', async (c) => {
  const { provider } = c.req.param()
  const { key } = await c.req.json()
  if (!key || typeof key !== 'string') {
    return fail(c, 'key is required')
  }
  await settingsService.setApiKey(provider, key)
  invalidateModelCache(provider)
  const apiKeys = await settingsService.getMaskedKeys()
  return ok(c, { apiKeys })
})

app.delete('/admin/api-keys/:provider', async (c) => {
  const { provider } = c.req.param()
  await settingsService.removeApiKey(provider)
  invalidateModelCache(provider)
  const apiKeys = await settingsService.getMaskedKeys()
  return ok(c, { apiKeys })
})

// ── Permissions (Global Auto-Approve Rules) ─────────────

app.get('/admin/permissions', async (c) => {
  const settings = await prisma.globalSettings.findUnique({ where: { id: 'singleton' } })
  return ok(c, { autoApproveRules: (settings?.autoApproveRules as string[]) ?? [] })
})

app.patch('/admin/permissions', async (c) => {
  const { autoApproveRules } = await c.req.json()
  if (
    !Array.isArray(autoApproveRules) ||
    !autoApproveRules.every((r: unknown) => typeof r === 'string')
  ) {
    return fail(c, 'autoApproveRules must be a string array')
  }
  const settings = await prisma.globalSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', autoApproveRules },
    update: { autoApproveRules },
  })
  return ok(c, { autoApproveRules: (settings.autoApproveRules as string[]) ?? [] })
})

// ── System Update ───────────────────────────────────────

app.get('/admin/system/update', async (c) => {
  const status = await systemUpdateService.getStatus()
  return ok(c, status)
})

app.post('/admin/system/update', async (c) => {
  const status = await systemUpdateService.startUpdate()
  return c.json({ success: true, data: status }, 202)
})

export default app

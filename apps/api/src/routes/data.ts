import { Hono } from 'hono'
import { prisma } from '../lib/prisma.js'
import { parsePagination } from '../lib/pagination.js'

const app = new Hono()

app.get('/data/stats', async (c) => {
  const [workspaces, documents, conversations] = await Promise.all([
    prisma.workspace.count(),
    prisma.document.count(),
    prisma.chatSession.count(),
  ])

  return c.json({
    success: true,
    data: { workspaces, documents, conversations },
  })
})

app.get('/data/workspaces', async (c) => {
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

  return c.json({
    success: true,
    data: { workspaces, total, page, limit },
  })
})

app.get('/data/documents', async (c) => {
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

  return c.json({
    success: true,
    data: { documents, total, page, limit },
  })
})

app.get('/data/conversations', async (c) => {
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

  return c.json({
    success: true,
    data: { conversations, total, page, limit },
  })
})

export default app

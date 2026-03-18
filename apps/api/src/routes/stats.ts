import { Hono } from 'hono'
import { prisma } from '../lib/prisma.js'
import { ok } from '../lib/responses.js'

const app = new Hono()

app.get('/stats', async (c) => {
  const [workspaces, documents, chatSessions] = await Promise.all([
    prisma.workspace.count(),
    prisma.document.count(),
    prisma.chatSession.count(),
  ])

  return ok(c, { workspaces, documents, chatSessions })
})

export default app

import { Hono } from 'hono'
import { prisma } from '../lib/prisma.js'

const app = new Hono()

app.get('/stats', async (c) => {
  const [workspaces, documents, chatSessions] = await Promise.all([
    prisma.workspace.count(),
    prisma.document.count(),
    prisma.chatSession.count(),
  ])

  return c.json({ success: true, data: { workspaces, documents, chatSessions } })
})

export default app

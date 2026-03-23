import { Hono } from 'hono'
import { cronService } from '../services/cron.service.js'

const app = new Hono()

app.get('/cron', async (c) => {
  const workspaceId = c.req.query('workspaceId') || undefined
  const sessionId = c.req.query('sessionId') || undefined
  const includeGlobal = c.req.query('includeGlobal')
  const includeWorkspace = c.req.query('includeWorkspace')
  const includeConversation = c.req.query('includeConversation')

  const jobs = await cronService.list({
    workspaceId,
    sessionId,
    includeGlobal: includeGlobal === undefined ? undefined : includeGlobal === 'true',
    includeWorkspace: includeWorkspace === undefined ? undefined : includeWorkspace === 'true',
    includeConversation:
      includeConversation === undefined ? undefined : includeConversation === 'true',
  })
  return c.json({ success: true, data: jobs })
})

app.post('/cron', async (c) => {
  const body = await c.req.json()
  const job = await cronService.create(body)
  return c.json({ success: true, data: job }, 201)
})

app.patch('/cron/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const job = await cronService.update(id, body)
  return c.json({ success: true, data: job })
})

app.delete('/cron/:id', async (c) => {
  const id = c.req.param('id')
  try {
    await cronService.delete(id)
    return c.json({ success: true })
  } catch (err) {
    if (err instanceof Error && err.message.includes('built-in')) {
      return c.json({ success: false, message: err.message }, 403)
    }
    throw err
  }
})

app.patch('/cron/:id/toggle', async (c) => {
  const id = c.req.param('id')
  const { enabled } = await c.req.json()
  const job = await cronService.toggleEnabled(id, enabled)
  return c.json({ success: true, data: job })
})

app.post('/cron/:id/trigger', async (c) => {
  const id = c.req.param('id')
  await cronService.triggerNow(id)
  return c.json({ success: true })
})

export default app

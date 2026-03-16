import { Hono } from 'hono'
import { cronService } from '../services/cron.service.js'

const app = new Hono()

// GET /admin/cron — list all cron jobs
app.get('/admin/cron', async (c) => {
  const jobs = await cronService.list()
  return c.json({ success: true, data: jobs })
})

// POST /admin/cron — create a new cron job
app.post('/admin/cron', async (c) => {
  const body = await c.req.json()
  const job = await cronService.create(body)
  return c.json({ success: true, data: job }, 201)
})

// PATCH /admin/cron/:id — update a cron job
app.patch('/admin/cron/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const job = await cronService.update(id, body)
  return c.json({ success: true, data: job })
})

// DELETE /admin/cron/:id — delete a cron job (403 if builtin)
app.delete('/admin/cron/:id', async (c) => {
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

// PATCH /admin/cron/:id/toggle — toggle enabled/disabled
app.patch('/admin/cron/:id/toggle', async (c) => {
  const id = c.req.param('id')
  const { enabled } = await c.req.json()
  const job = await cronService.toggleEnabled(id, enabled)
  return c.json({ success: true, data: job })
})

// POST /admin/cron/:id/trigger — execute now (one-shot)
app.post('/admin/cron/:id/trigger', async (c) => {
  const id = c.req.param('id')
  await cronService.triggerNow(id)
  return c.json({ success: true })
})

export default app

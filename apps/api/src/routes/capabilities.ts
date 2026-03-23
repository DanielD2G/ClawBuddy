import { Hono } from 'hono'
import { capabilityService } from '../services/capability.service.js'

const app = new Hono()

// ── Public endpoints ────────────────────────

app.get('/capabilities', async (c) => {
  const capabilities = await capabilityService.listAll()
  return c.json({ success: true, data: capabilities })
})

app.get('/workspaces/:id/capabilities', async (c) => {
  const { id } = c.req.param()
  const capabilities = await capabilityService.getWorkspaceCapabilitySettings(id)
  return c.json({ success: true, data: capabilities })
})

app.post('/workspaces/:id/capabilities', async (c) => {
  const { id } = c.req.param()
  const { slug, config } = await c.req.json()
  if (!slug) {
    return c.json({ success: false, error: 'slug is required' }, 400)
  }
  const result = await capabilityService.enableCapability(id, slug, config)
  return c.json({ success: true, data: result }, 201)
})

app.delete('/workspaces/:id/capabilities/:capId', async (c) => {
  const { id, capId } = c.req.param()
  await capabilityService.disableCapability(id, capId)
  return c.json({ success: true, data: { disabled: true } })
})

app.patch('/workspaces/:id/capabilities/:capId', async (c) => {
  const { id, capId } = c.req.param()
  const { config } = await c.req.json()
  const result = await capabilityService.updateCapabilityConfig(id, capId, config)
  return c.json({ success: true, data: result })
})

export default app

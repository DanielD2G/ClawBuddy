import { Hono } from 'hono'
import { capabilityService } from '../services/capability.service.js'
import { prisma } from '../lib/prisma.js'

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

// ── Admin endpoints ─────────────────────────

app.post('/admin/capabilities', async (c) => {
  const body = await c.req.json()
  const {
    slug,
    name,
    description,
    icon,
    category,
    toolDefinitions,
    systemPrompt,
    dockerImage,
    packages,
    networkAccess,
    configSchema,
  } = body
  if (!slug || !name || !description || !toolDefinitions || !systemPrompt) {
    return c.json({ success: false, error: 'Missing required fields' }, 400)
  }
  const capability = await prisma.capability.create({
    data: {
      slug,
      name,
      description,
      icon,
      category: category ?? 'general',
      toolDefinitions,
      systemPrompt,
      dockerImage,
      packages: packages ?? [],
      networkAccess: networkAccess ?? false,
      configSchema: configSchema ?? undefined,
      builtin: false,
    },
  })
  return c.json({ success: true, data: capability }, 201)
})

app.get('/admin/sandboxes', async (c) => {
  const sandboxes = await prisma.sandboxSession.findMany({
    where: { status: { in: ['pending', 'running'] } },
    include: {
      workspace: { select: { id: true, name: true } },
      chatSession: { select: { id: true, title: true } },
      _count: { select: { executions: true } },
    },
    orderBy: { createdAt: 'desc' },
  })
  return c.json({ success: true, data: sandboxes })
})

app.delete('/admin/sandboxes/:id', async (c) => {
  const { id } = c.req.param()
  const { sandboxService } = await import('../services/sandbox.service.js')
  await sandboxService.destroySandbox(id)
  return c.json({ success: true, data: { destroyed: true } })
})

export default app

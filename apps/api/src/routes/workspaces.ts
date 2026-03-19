import { Hono } from 'hono'
import { createWorkspaceSchema, updateWorkspaceSchema } from '@agentbuddy/shared'
import { workspaceService } from '../services/workspace.service.js'
import { capabilityService } from '../services/capability.service.js'
import { sandboxService } from '../services/sandbox.service.js'
import { validateBody } from '../lib/validate.js'

const app = new Hono()

app.get('/', async (c) => {
  const workspaces = await workspaceService.list()
  return c.json({ success: true, data: workspaces })
})

app.post('/', async (c) => {
  const body = await c.req.json()
  const parsed = validateBody(createWorkspaceSchema, body)
  const workspace = await workspaceService.create(parsed)
  return c.json({ success: true, data: workspace }, 201)
})

app.get('/:id', async (c) => {
  const { id } = c.req.param()
  const workspace = await workspaceService.findById(id)
  if (!workspace) {
    return c.json({ success: false, error: 'Workspace not found' }, 404)
  }
  return c.json({ success: true, data: workspace })
})

app.patch('/:id', async (c) => {
  const { id } = c.req.param()
  const body = await c.req.json()
  const parsed = validateBody(updateWorkspaceSchema, body)
  const workspace = await workspaceService.update(id, parsed)
  return c.json({ success: true, data: workspace })
})

app.delete('/:id', async (c) => {
  const { id } = c.req.param()
  try {
    await sandboxService.stopWorkspaceContainer(id)
  } catch (err) {
    console.warn(`[Workspaces] Failed to stop container for workspace ${id}:`, err)
  }
  await workspaceService.delete(id)
  return c.json({ success: true, data: { id } })
})

// ── Workspace Capability Overrides ─────────────────────────

app.get('/:id/capabilities', async (c) => {
  const { id } = c.req.param()
  const capabilities = await capabilityService.getWorkspaceCapabilitySettings(id)
  return c.json({ success: true, data: capabilities })
})

app.put('/:id/capabilities/:capabilitySlug', async (c) => {
  const { id, capabilitySlug } = c.req.param()
  const body = await c.req.json()
  if (body.enabled) {
    await capabilityService.enableCapability(id, capabilitySlug, body.config)
  } else {
    await capabilityService.disableCapabilityBySlug(id, capabilitySlug)
  }
  return c.json({ success: true })
})

app.delete('/:id/capabilities/:capabilityId', async (c) => {
  const { id, capabilityId } = c.req.param()
  try {
    await capabilityService.removeCapabilityOverride(id, capabilityId)
    return c.json({ success: true })
  } catch {
    return c.json({ success: false, error: 'Override not found' }, 404)
  }
})

// ── Workspace Container Management ─────────────────────────

app.get('/:id/container/status', async (c) => {
  const { id } = c.req.param()
  const status = await sandboxService.getWorkspaceContainerStatus(id)
  return c.json({ success: true, data: status })
})

app.post('/:id/container/start', async (c) => {
  const { id } = c.req.param()
  const containerId = await sandboxService.startWorkspaceContainerWithCapabilities(id)
  return c.json({ success: true, data: { containerId, status: 'running' } })
})

app.post('/:id/container/stop', async (c) => {
  const { id } = c.req.param()
  await sandboxService.stopWorkspaceContainer(id)
  return c.json({ success: true, data: { status: 'stopped' } })
})

export default app

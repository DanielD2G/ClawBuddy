import { Hono } from 'hono'
import { prisma } from '../lib/prisma.js'
import { capabilityService } from '../services/capability.service.js'
import { sandboxService } from '../services/sandbox.service.js'

const app = new Hono()

app.get('/', async (c) => {
  const workspaces = await prisma.workspace.findMany({
    orderBy: { createdAt: 'desc' },
  })
  return c.json({ success: true, data: workspaces })
})

app.post('/', async (c) => {
  const body = await c.req.json()
  const workspace = await prisma.workspace.create({
    data: {
      name: body.name,
      description: body.description ?? null,
      color: body.color ?? null,
      settings: body.settings ?? null,
    },
  })
  return c.json({ success: true, data: workspace }, 201)
})

app.get('/:id', async (c) => {
  const { id } = c.req.param()
  const workspace = await prisma.workspace.findUnique({ where: { id } })
  if (!workspace) {
    return c.json({ success: false, error: 'Workspace not found' }, 404)
  }
  return c.json({ success: true, data: workspace })
})

app.patch('/:id', async (c) => {
  const { id } = c.req.param()
  const body = await c.req.json()
  const workspace = await prisma.workspace.update({
    where: { id },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.permissions !== undefined && { permissions: body.permissions }),
      ...(body.color !== undefined && { color: body.color }),
      ...(body.settings !== undefined && { settings: body.settings }),
      ...(body.autoExecute !== undefined && { autoExecute: body.autoExecute }),
    },
  })
  return c.json({ success: true, data: workspace })
})

app.delete('/:id', async (c) => {
  const { id } = c.req.param()
  // Stop workspace container before deleting
  try {
    await sandboxService.stopWorkspaceContainer(id)
  } catch { /* container may not exist */ }
  await prisma.workspace.delete({ where: { id } })
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
    const capability = await prisma.capability.findUnique({ where: { slug: capabilitySlug } })
    if (capability) {
      await capabilityService.disableCapability(id, capability.id)
    }
  }
  return c.json({ success: true })
})

app.delete('/:id/capabilities/:capabilityId', async (c) => {
  const { id, capabilityId } = c.req.param()
  try {
    await prisma.workspaceCapability.delete({
      where: { workspaceId_capabilityId: { workspaceId: id, capabilityId } },
    })
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
  const configEnvVars = await capabilityService.getDecryptedCapabilityConfigsForWorkspace(id)
  const mergedEnvVars: Record<string, string> = {}
  for (const envMap of configEnvVars.values()) {
    Object.assign(mergedEnvVars, envMap)
  }

  const containerId = await sandboxService.getOrCreateWorkspaceContainer(
    id,
    { networkAccess: true },
    Object.keys(mergedEnvVars).length ? mergedEnvVars : undefined,
  )
  return c.json({ success: true, data: { containerId, status: 'running' } })
})

app.post('/:id/container/stop', async (c) => {
  const { id } = c.req.param()
  await sandboxService.stopWorkspaceContainer(id)
  return c.json({ success: true, data: { status: 'stopped' } })
})

export default app

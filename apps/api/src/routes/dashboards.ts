import { Hono } from 'hono'
import { dashboardService } from '../services/dashboard.service.js'
import { prisma } from '../lib/prisma.js'
import { chatService } from '../services/chat.service.js'
import { createSSEStream } from '../lib/sse.js'
import { secretRedactionService } from '../services/secret-redaction.service.js'

const app = new Hono()

// ── List dashboards ─────────────────────────────────────────
app.get('/dashboards', async (c) => {
  const workspaceId = c.req.query('workspaceId')
  if (!workspaceId) {
    return c.json({ success: false, message: 'workspaceId is required' }, 400)
  }
  const dashboards = await dashboardService.list(workspaceId)
  return c.json({ success: true, data: dashboards })
})

// ── Get single dashboard ────────────────────────────────────
app.get('/dashboards/:id', async (c) => {
  const id = c.req.param('id')
  try {
    const dashboard = await dashboardService.getById(id)
    return c.json({ success: true, data: dashboard })
  } catch {
    return c.json({ success: false, message: 'Dashboard not found' }, 404)
  }
})

// ── Create dashboard ────────────────────────────────────────
app.post('/dashboards', async (c) => {
  const body = await c.req.json()
  const dashboard = await dashboardService.create(body)
  return c.json({ success: true, data: dashboard }, 201)
})

// ── Update dashboard ────────────────────────────────────────
app.patch('/dashboards/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const dashboard = await dashboardService.update(id, body)
  return c.json({ success: true, data: dashboard })
})

// ── Delete dashboard ────────────────────────────────────────
app.delete('/dashboards/:id', async (c) => {
  const id = c.req.param('id')
  try {
    await dashboardService.delete(id)
    return c.json({ success: true })
  } catch (err) {
    return c.json(
      { success: false, message: err instanceof Error ? err.message : 'Delete failed' },
      400,
    )
  }
})

// ── Add component ───────────────────────────────────────────
app.post('/dashboards/:id/components', async (c) => {
  const dashboardId = c.req.param('id')
  const body = await c.req.json()
  const component = await dashboardService.addComponent(dashboardId, body)
  return c.json({ success: true, data: component }, 201)
})

// ── Update component ────────────────────────────────────────
app.patch('/dashboards/components/:componentId', async (c) => {
  const componentId = c.req.param('componentId')
  const body = await c.req.json()
  const component = await dashboardService.updateComponent(componentId, body)
  return c.json({ success: true, data: component })
})

// ── Delete component ────────────────────────────────────────
app.delete('/dashboards/components/:componentId', async (c) => {
  const componentId = c.req.param('componentId')
  try {
    await dashboardService.deleteComponent(componentId)
    return c.json({ success: true })
  } catch {
    return c.json({ success: false, message: 'Component not found' }, 404)
  }
})

// ── Reorder components ───────────────────────────────────────
app.post('/dashboards/:id/reorder', async (c) => {
  const dashboardId = c.req.param('id')
  const { componentIds } = await c.req.json()
  const dashboard = await dashboardService.reorderComponents(dashboardId, componentIds)
  return c.json({ success: true, data: dashboard })
})

// ── Bulk update data ────────────────────────────────────────
app.post('/dashboards/:id/data', async (c) => {
  const dashboardId = c.req.param('id')
  const { updates } = await c.req.json()
  const dashboard = await dashboardService.updateDashboardData(dashboardId, updates)
  return c.json({ success: true, data: dashboard })
})

// ── Manual refresh trigger ──────────────────────────────────
app.post('/dashboards/:id/refresh', async (c) => {
  const id = c.req.param('id')
  const dashboard = await dashboardService.getById(id)

  const { cronService } = await import('../services/cron.service.js')

  let cronJobId = dashboard.cronJobId

  // If no cron job exists, create one on-the-fly for manual refresh
  if (!cronJobId) {
    const prompt = dashboardService.buildDynamicRefreshPrompt(dashboard)

    const cronJob = await cronService.create({
      name: `Dashboard refresh: ${dashboard.title}`,
      description: `Refresh dashboard "${dashboard.title}"`,
      schedule: '0 0 31 2 *', // Feb 31 = never auto-runs, manual-only
      type: 'agent',
      prompt,
      workspaceId: dashboard.workspaceId,
      sessionId: dashboard.sessionId ?? undefined,
    })

    cronJobId = cronJob.id

    await prisma.dashboard.update({
      where: { id },
      data: { cronJobId },
    })
  }

  // Set refreshing status
  await prisma.dashboard.update({
    where: { id },
    data: { refreshStatus: 'refreshing' },
  })

  await cronService.triggerNow(cronJobId)
  return c.json({ success: true })
})

// ── Dashboard chat (with dashboard context) ─────────────────
app.post('/dashboards/:id/chat', async (c) => {
  const id = c.req.param('id')
  const { content } = await c.req.json<{ content: string }>()

  if (!content?.trim()) {
    return c.json({ success: false, message: 'content is required' }, 400)
  }

  const dashboard = await dashboardService.getById(id)

  // Ensure a session exists for this dashboard
  let sessionId = dashboard.sessionId
  if (!sessionId) {
    const session = await prisma.chatSession.create({
      data: {
        workspaceId: dashboard.workspaceId,
        title: `Dashboard: ${dashboard.title}`,
        source: 'dashboard',
      },
    })
    sessionId = session.id
    await prisma.dashboard.update({
      where: { id },
      data: { sessionId },
    })
  }

  // Build dashboard context to prepend to the user message
  const dashboardContext = dashboardService.buildDynamicRefreshPrompt(dashboard)
  const contextualContent = `[Dashboard context for "${dashboard.title}" (id: ${dashboard.id})]\n\n${dashboardContext}\n\n---\nUser request: ${content}`

  const inventory = await secretRedactionService.buildSecretInventory(dashboard.workspaceId)

  return createSSEStream(async (emit) => {
    const redactedEmit = secretRedactionService.createRedactedEmit(emit, inventory)
    redactedEmit('session', { sessionId })
    await chatService.sendMessage(sessionId!, content, redactedEmit, {
      inventory,
      llmContent: contextualContent,
    })
  })
})

export default app

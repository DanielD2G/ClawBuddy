/**
 * Dashboard-specific cron lifecycle hooks.
 *
 * All dashboard ↔ cron coupling lives here — the cron worker
 * never imports dashboard code directly.
 */

import { prisma } from '../lib/prisma.js'
import { dashboardService } from '../services/dashboard.service.js'
import { registerCronLifecycleHook, type CronLifecycleHook, type CronLifecycleContext } from './cron-lifecycle.js'

/** Cache the dashboard id per cronJobId within a single execution */
const dashboardIdCache = new Map<string, string>()

async function findDashboardId(cronJobId: string): Promise<string | null> {
  if (dashboardIdCache.has(cronJobId)) {
    return dashboardIdCache.get(cronJobId)!
  }

  const dashboard = await prisma.dashboard.findFirst({
    where: { cronJobId },
    select: { id: true },
  })

  if (dashboard) {
    dashboardIdCache.set(cronJobId, dashboard.id)
  }

  return dashboard?.id ?? null
}

const dashboardCronHook: CronLifecycleHook = {
  async matches(cronJobId) {
    return (await findDashboardId(cronJobId)) !== null
  },

  async onBefore(ctx) {
    const dashboardId = await findDashboardId(ctx.cronJobId)
    if (!dashboardId) return

    await prisma.dashboard.update({
      where: { id: dashboardId },
      data: { refreshStatus: 'refreshing' },
    })
  },

  async buildPrompt(ctx) {
    const dashboardId = await findDashboardId(ctx.cronJobId)
    if (!dashboardId) return undefined

    try {
      const dashboard = await dashboardService.getById(dashboardId)
      return dashboardService.buildDynamicRefreshPrompt(dashboard)
    } catch {
      // Fall back to the stored static prompt
      return undefined
    }
  },

  async onSessionCreated(ctx) {
    const dashboardId = await findDashboardId(ctx.cronJobId)
    if (!dashboardId) return {}

    // Link session to dashboard and tag it
    await Promise.all([
      prisma.chatSession.update({
        where: { id: ctx.sessionId },
        data: { source: 'dashboard' },
      }).catch(() => {}),
      prisma.dashboard.update({
        where: { id: dashboardId },
        data: { sessionId: ctx.sessionId },
      }).catch(() => {}),
    ])

    return { source: 'dashboard' }
  },

  async onSuccess(ctx) {
    const dashboardId = await findDashboardId(ctx.cronJobId)
    if (!dashboardId) return

    await prisma.dashboard.update({
      where: { id: dashboardId },
      data: { refreshStatus: 'idle' },
    })

    dashboardIdCache.delete(ctx.cronJobId)
  },

  async onError(ctx) {
    const dashboardId = await findDashboardId(ctx.cronJobId)
    if (!dashboardId) return

    await prisma.dashboard.update({
      where: { id: dashboardId },
      data: { refreshStatus: 'error' },
    })

    dashboardIdCache.delete(ctx.cronJobId)
  },
}

// Self-registering — just import this module at startup
registerCronLifecycleHook(dashboardCronHook)

import { prisma } from '../lib/prisma.js'
import { cronQueue } from '../workers/cron.worker.js'

const BUILTIN_CRON_JOBS = [
  {
    name: 'Stop Idle Workspace Containers',
    description: 'Stops workspace Docker containers idle for more than 10 minutes',
    schedule: '*/5 * * * *',
    type: 'internal' as const,
    handler: 'cleanupIdleContainers',
    builtin: true,
  },
]

function repeatableJobKey(cronJobId: string) {
  return `cron:${cronJobId}`
}

export const cronService = {
  async list() {
    return prisma.cronJob.findMany({
      orderBy: { createdAt: 'asc' },
    })
  },

  async getById(id: string) {
    return prisma.cronJob.findUniqueOrThrow({ where: { id } })
  },

  async create(data: {
    name: string
    description?: string
    schedule: string
    type?: string
    handler?: string
    prompt?: string
    workspaceId?: string
    sessionId?: string
    enabled?: boolean
  }) {
    const cronJob = await prisma.cronJob.create({
      data: {
        name: data.name,
        description: data.description,
        schedule: data.schedule,
        type: data.type ?? 'agent',
        handler: data.handler,
        prompt: data.prompt,
        workspaceId: data.workspaceId,
        sessionId: data.sessionId,
        enabled: data.enabled ?? true,
      },
    })

    if (cronJob.enabled) {
      await this.addRepeatableJob(cronJob)
    }

    return cronJob
  },

  async update(
    id: string,
    data: {
      name?: string
      description?: string
      schedule?: string
      prompt?: string
      enabled?: boolean
    },
  ) {
    const existing = await prisma.cronJob.findUniqueOrThrow({ where: { id } })

    // Remove old repeatable before updating
    await this.removeRepeatableJob(existing)

    const updated = await prisma.cronJob.update({
      where: { id },
      data,
    })

    if (updated.enabled) {
      await this.addRepeatableJob(updated)
    }

    return updated
  },

  async delete(id: string) {
    const cronJob = await prisma.cronJob.findUniqueOrThrow({ where: { id } })

    if (cronJob.builtin) {
      throw new Error('Cannot delete built-in cron jobs')
    }

    await this.removeRepeatableJob(cronJob)
    await prisma.cronJob.delete({ where: { id } })
  },

  async toggleEnabled(id: string, enabled: boolean) {
    const cronJob = await prisma.cronJob.findUniqueOrThrow({ where: { id } })

    if (enabled) {
      await this.addRepeatableJob(cronJob)
    } else {
      await this.removeRepeatableJob(cronJob)
    }

    return prisma.cronJob.update({
      where: { id },
      data: { enabled },
    })
  },

  async registerBuiltinJobs() {
    // Remove old builtin cron jobs that have been replaced
    await prisma.cronJob.deleteMany({
      where: { handler: 'cleanupStaleSandboxes', builtin: true },
    })

    for (const builtin of BUILTIN_CRON_JOBS) {
      const existing = await prisma.cronJob.findFirst({
        where: { handler: builtin.handler, builtin: true },
      })

      if (!existing) {
        await prisma.cronJob.create({ data: builtin })
      }
    }

    await this.syncAllJobs()
    const count = BUILTIN_CRON_JOBS.length
    console.log(`[Cron] Registered ${count} builtin jobs`)
  },

  async syncAllJobs() {
    // Get all DB jobs
    const dbJobs = await prisma.cronJob.findMany()
    const dbJobIds = new Set(dbJobs.filter((j) => j.enabled).map((j) => j.id))

    // Get existing repeatables from BullMQ
    const existingRepeatables = await cronQueue.getRepeatableJobs()

    // Remove repeatables not in DB or disabled
    for (const rep of existingRepeatables) {
      const cronJobId = rep.key.replace(/^cron:/, '').split(':')[0]
      if (!dbJobIds.has(cronJobId)) {
        await cronQueue.removeRepeatableByKey(rep.key)
      }
    }

    // Add enabled jobs missing from BullMQ
    for (const job of dbJobs) {
      if (!job.enabled) continue
      // Check if already registered (key format varies, so just re-add — BullMQ deduplicates)
      await this.addRepeatableJob(job)
    }
  },

  async addRepeatableJob(cronJob: { id: string; schedule: string }) {
    await cronQueue.add(
      'cron-execute',
      { cronJobId: cronJob.id },
      {
        repeat: {
          pattern: cronJob.schedule,
        },
        jobId: repeatableJobKey(cronJob.id),
      },
    )
  },

  async removeRepeatableJob(cronJob: { id: string; schedule: string }) {
    try {
      await cronQueue.removeRepeatable('cron-execute', {
        pattern: cronJob.schedule,
        jobId: repeatableJobKey(cronJob.id),
      })
    } catch {
      // May not exist, that's fine
    }
  },

  async triggerNow(id: string) {
    const cronJob = await prisma.cronJob.findUniqueOrThrow({ where: { id } })

    await cronQueue.add(
      'cron-execute',
      { cronJobId: cronJob.id },
      { jobId: `trigger:${cronJob.id}:${Date.now()}` },
    )
  },
}

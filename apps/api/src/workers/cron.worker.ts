import { Worker, Queue, type Job } from 'bullmq'
import { redisConnection } from '../lib/redis.js'
import { prisma } from '../lib/prisma.js'
import { CRON_HANDLERS } from './cron-handlers.js'
import { agentService } from '../services/agent.service.js'
import { createTelegramEmit } from '../channels/telegram/telegram-emit.js'
import type { SSEEmit } from '../lib/sse.js'
import { logger } from '../lib/logger.js'

export const CRON_QUEUE_NAME = 'cron-jobs'

export const cronQueue = new Queue(CRON_QUEUE_NAME, {
  connection: redisConnection,
})

interface CronJobData {
  cronJobId: string
}

const worker = new Worker<CronJobData>(
  CRON_QUEUE_NAME,
  async (job: Job<CronJobData>) => {
    const { cronJobId } = job.data

    const cronJob = await prisma.cronJob.findUnique({
      where: { id: cronJobId },
    })

    if (!cronJob) {
      logger.warn(`[Cron] Job ${cronJobId} not found in DB, skipping`)
      return
    }

    if (!cronJob.enabled) {
      return
    }

    logger.info(`[Cron] Executing "${cronJob.name}" (${cronJob.type})`)

    try {
      if (cronJob.type === 'internal') {
        const handler = cronJob.handler ? CRON_HANDLERS[cronJob.handler] : null
        if (!handler) {
          throw new Error(`Unknown handler: ${cronJob.handler}`)
        }
        await handler()
      } else if (cronJob.type === 'agent') {
        if (!cronJob.prompt) {
          throw new Error('Agent cron job has no prompt')
        }

        let workspaceId = cronJob.workspaceId
        if (!workspaceId) {
          const fallback = await prisma.workspace.findFirst({ orderBy: { createdAt: 'asc' } })
          if (!fallback)
            throw new Error('Agent cron job has no workspaceId and no workspaces exist')
          workspaceId = fallback.id
        }

        // Use the session from the originating chat, or create one as fallback
        let sessionId = cronJob.sessionId
        if (!sessionId) {
          const session = await prisma.chatSession.create({
            data: {
              workspaceId,
              title: `[Cron] ${cronJob.name}`,
            },
          })
          sessionId = session.id
          await prisma.cronJob.update({
            where: { id: cronJobId },
            data: { sessionId },
          })
        }

        // Save the cron prompt as a user message so it appears in the conversation
        await prisma.chatMessage.create({
          data: {
            sessionId,
            role: 'user',
            content: `[Cron: ${cronJob.name}] ${cronJob.prompt}`,
          },
        })

        // If the session is linked to Telegram, forward responses there
        let cronEmit: SSEEmit | undefined
        const cronSession = await prisma.chatSession.findUnique({
          where: { id: sessionId },
          select: { source: true, externalChatId: true, workspaceId: true },
        })
        if (
          cronSession?.source === 'telegram' &&
          cronSession.externalChatId &&
          cronSession.workspaceId
        ) {
          cronEmit = createTelegramEmit(cronSession.workspaceId, cronSession.externalChatId)
        }

        // Run agent (headless unless Telegram-linked, auto-approve tools since no user to decide)
        // Agent loop saves ChatMessages per-iteration directly to DB
        try {
          await agentService.runAgentLoop(sessionId, cronJob.prompt, workspaceId, cronEmit, {
            autoApprove: true,
            historyIncludesCurrentUserMessage: true,
          })
        } catch (agentErr) {
          // Save error as assistant message so the chat shows what happened
          const errMsg = agentErr instanceof Error ? agentErr.message : String(agentErr)
          await prisma.chatMessage.create({
            data: {
              sessionId,
              role: 'assistant',
              content: `⚠️ Cron execution failed: ${errMsg}`,
            },
          })
          throw agentErr
        }
      }

      await prisma.cronJob.update({
        where: { id: cronJobId },
        data: {
          lastRunAt: new Date(),
          lastRunStatus: 'success',
          lastRunError: null,
        },
      })

      logger.info(`[Cron] "${cronJob.name}" completed successfully`)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      logger.error(`[Cron] "${cronJob.name}" failed`, errorMsg)

      await prisma.cronJob.update({
        where: { id: cronJobId },
        data: {
          lastRunAt: new Date(),
          lastRunStatus: 'error',
          lastRunError: errorMsg,
        },
      })
    }
  },
  {
    connection: redisConnection,
    concurrency: 2,
  },
)

worker.on('completed', (job) => {
  logger.info(`[Cron] Job ${job.id} completed`)
})

worker.on('failed', (job, err) => {
  logger.error(`[Cron] Job ${job?.id} failed`, err)
})

export { worker as cronWorker }

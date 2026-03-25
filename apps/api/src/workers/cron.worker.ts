import { Worker, Queue, type Job } from 'bullmq'
import { redisConnection } from '../lib/redis.js'
import { prisma } from '../lib/prisma.js'
import { CRON_HANDLERS } from './cron-handlers.js'
import { agentService } from '../services/agent.service.js'
import { createTelegramEmit } from '../channels/telegram/telegram-emit.js'
import { findCronHook } from './cron-lifecycle.js'
import type { SSEEmit } from '../lib/sse.js'

// Register lifecycle hooks — self-registering on import
import './dashboard-cron-hooks.js'

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
      console.warn(`[Cron] Job ${cronJobId} not found in DB, skipping`)
      return
    }

    if (!cronJob.enabled) {
      return
    }

    console.log(`[Cron] Executing "${cronJob.name}" (${cronJob.type})`)

    // Find a lifecycle hook that matches this cron job (if any)
    const hook = await findCronHook(cronJobId)

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
        let sessionSource: string | undefined
        if (!sessionId) {
          // Let the hook decide the session source tag
          const hookMeta = hook ? await hook.onSessionCreated?.({
            cronJobId, cronJobName: cronJob.name, workspaceId, sessionId: '',
          }) : undefined
          sessionSource = hookMeta?.source

          const session = await prisma.chatSession.create({
            data: {
              workspaceId,
              title: `[Cron] ${cronJob.name}`,
              source: sessionSource ?? 'cron',
            },
          })
          sessionId = session.id
          await prisma.cronJob.update({
            where: { id: cronJobId },
            data: { sessionId },
          })
        }

        const lifecycleCtx = { cronJobId, cronJobName: cronJob.name, workspaceId, sessionId }

        // Notify hook that execution is about to start
        await hook?.onBefore?.(lifecycleCtx)

        // Let hook tag/link an existing session (only if we didn't just create it)
        if (hook && !sessionSource) {
          await hook.onSessionCreated?.(lifecycleCtx)
        }

        // Let hook optionally override the prompt
        const agentPrompt = (await hook?.buildPrompt?.(lifecycleCtx)) ?? cronJob.prompt

        // Save the cron prompt as a user message so it appears in the conversation
        await prisma.chatMessage.create({
          data: {
            sessionId,
            role: 'user',
            content: `[Cron: ${cronJob.name}] ${agentPrompt}`,
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
          await agentService.runAgentLoop(sessionId, agentPrompt, workspaceId, cronEmit, {
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

      // Notify hook of success
      if (hook) {
        const ctx = { cronJobId, cronJobName: cronJob.name, workspaceId: cronJob.workspaceId ?? '', sessionId: cronJob.sessionId ?? '' }
        await hook.onSuccess?.(ctx)
      }

      await prisma.cronJob.update({
        where: { id: cronJobId },
        data: {
          lastRunAt: new Date(),
          lastRunStatus: 'success',
          lastRunError: null,
        },
      })

      console.log(`[Cron] "${cronJob.name}" completed successfully`)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.error(`[Cron] "${cronJob.name}" failed:`, errorMsg)

      // Notify hook of error
      if (hook) {
        const ctx = { cronJobId, cronJobName: cronJob.name, workspaceId: cronJob.workspaceId ?? '', sessionId: cronJob.sessionId ?? '' }
        await hook.onError?.(ctx, err)
      }

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
  console.log(`[Cron] Job ${job.id} completed`)
})

worker.on('failed', (job, err) => {
  console.error(`[Cron] Job ${job?.id} failed:`, err.message)
})

export { worker as cronWorker }

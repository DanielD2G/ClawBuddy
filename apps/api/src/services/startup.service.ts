import net from 'node:net'
import { prisma } from '../lib/prisma.js'
import { qdrant } from '../lib/qdrant.js'
import { redisConnection } from '../lib/redis.js'
import { capabilityService } from './capability.service.js'
import { skillService } from './skill.service.js'
import { toolDiscoveryService } from './tool-discovery.service.js'
import { cronService } from './cron.service.js'
import { settingsService } from './settings.service.js'
import { storageService } from './storage.service.js'
import { channelService } from './channel.service.js'
import { telegramBotManager } from '../channels/telegram/telegram-bot-manager.js'
import { decrypt } from './crypto.service.js'
import { updateLauncherService } from './update/update.launcher.js'
import { logger } from '../lib/logger.js'

const STARTUP_RETRY_DELAY_MS = 5_000
const REDIS_TIMEOUT_MS = 5_000

const CRITICAL_CHECKS = [
  'postgres',
  'redis',
  'qdrant',
  'minio',
  'settings',
  'capabilities',
  'skills',
  'toolDiscovery',
  'cron',
] as const

type StartupCheck = (typeof CRITICAL_CHECKS)[number]
type CheckStatus = 'pending' | 'ready' | 'error'
type StartupPhase = 'starting' | 'retrying' | 'ready'

interface StartupErrorState {
  check: StartupCheck
  message: string
  at: string
}

interface StartupState {
  ready: boolean
  phase: StartupPhase
  attempt: number
  startedAt: string
  lastReadyAt: string | null
  lastError: StartupErrorState | null
  checks: Record<StartupCheck, CheckStatus>
}

class StartupError extends Error {
  constructor(
    readonly check: StartupCheck,
    message: string,
  ) {
    super(message)
    this.name = 'StartupError'
  }
}

function createChecks(status: CheckStatus = 'pending'): Record<StartupCheck, CheckStatus> {
  return Object.fromEntries(CRITICAL_CHECKS.map((check) => [check, status])) as Record<
    StartupCheck,
    CheckStatus
  >
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function pingRedis() {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({
      host: redisConnection.host,
      port: redisConnection.port,
    })

    const cleanup = () => {
      socket.removeAllListeners()
      socket.destroy()
    }

    socket.setTimeout(REDIS_TIMEOUT_MS, () => {
      cleanup()
      reject(new Error('Redis ping timed out'))
    })

    socket.once('error', (error) => {
      cleanup()
      reject(error)
    })

    socket.once('connect', () => {
      socket.write('*1\r\n$4\r\nPING\r\n')
    })

    socket.once('data', (chunk: Buffer) => {
      const response = chunk.toString('utf-8')
      cleanup()
      if (response.startsWith('+PONG')) {
        resolve()
        return
      }
      reject(new Error(`Unexpected Redis response: ${response.trim()}`))
    })
  })
}

const state: StartupState = {
  ready: false,
  phase: 'starting',
  attempt: 0,
  startedAt: new Date().toISOString(),
  lastReadyAt: null,
  lastError: null,
  checks: createChecks(),
}

let bootstrapPromise: Promise<void> | null = null
let telegramBootInterval: ReturnType<typeof setInterval> | null = null

export const startupService = {
  getState(): StartupState {
    return {
      ...state,
      checks: { ...state.checks },
      lastError: state.lastError ? { ...state.lastError } : null,
    }
  },

  start() {
    if (bootstrapPromise) {
      return bootstrapPromise
    }

    bootstrapPromise = this.bootstrapLoop()
    return bootstrapPromise
  },

  async bootstrapLoop() {
    while (true) {
      state.attempt += 1
      state.phase = state.attempt === 1 ? 'starting' : 'retrying'
      state.ready = false
      state.checks = createChecks()

      try {
        await this.runCheck('postgres', async () => {
          await prisma.$queryRawUnsafe('SELECT 1')
        })

        await this.runCheck('redis', async () => {
          await pingRedis()
        })

        await this.runCheck('qdrant', async () => {
          await qdrant.getCollections()
        })

        await this.runCheck('minio', async () => {
          await storageService.ensureBucketExists()
        })

        await this.runCheck('settings', async () => {
          await prisma.globalSettings.upsert({
            where: { id: 'singleton' },
            create: { id: 'singleton' },
            update: {},
          })
          await settingsService.get()
        })

        await this.runCheck('capabilities', async () => {
          await capabilityService.syncBuiltinCapabilities()
        })

        await this.runCheck('skills', async () => {
          await skillService.syncSkillsFromStorage({ throwOnError: true })
        })

        await this.runCheck('toolDiscovery', async () => {
          const settings = await settingsService.get()
          if (!settings.onboardingComplete) {
            return
          }
          await toolDiscoveryService.indexCapabilities()
        })

        await this.runCheck('cron', async () => {
          await cronService.registerBuiltinJobs()
        })

        state.ready = true
        state.phase = 'ready'
        state.lastReadyAt = new Date().toISOString()
        state.lastError = null

        this.ensureTelegramBootLoop()
        void updateLauncherService.resumeIfNeeded().catch((error) => {
          logger.error('[Update] Failed to resume on-demand updater', error)
        })
        return
      } catch (error) {
        const startupError =
          error instanceof StartupError
            ? error
            : new StartupError('postgres', getErrorMessage(error))

        state.ready = false
        state.phase = 'retrying'
        state.lastError = {
          check: startupError.check,
          message: startupError.message,
          at: new Date().toISOString(),
        }

        logger.error(
          `[Startup] Attempt ${state.attempt} failed during ${startupError.check}: ${startupError.message}`,
          error,
        )
        await delay(STARTUP_RETRY_DELAY_MS)
      }
    }
  },

  async runCheck(check: StartupCheck, fn: () => Promise<void>) {
    try {
      await fn()
      state.checks = {
        ...state.checks,
        [check]: 'ready',
      }
    } catch (error) {
      state.checks = {
        ...state.checks,
        [check]: 'error',
      }
      throw new StartupError(check, getErrorMessage(error))
    }
  },

  ensureTelegramBootLoop() {
    if (telegramBootInterval) {
      return
    }

    void this.bootTelegramChannels()
    telegramBootInterval = setInterval(() => {
      void this.bootTelegramChannels()
    }, 15_000)
  },

  /**
   * Clear internal intervals for graceful shutdown.
   */
  shutdown() {
    if (telegramBootInterval) {
      clearInterval(telegramBootInterval)
      telegramBootInterval = null
    }
  },

  async bootTelegramChannels() {
    try {
      const channels = await channelService.getAllEnabled()
      for (const channel of channels) {
        if (channel.type !== 'telegram') {
          continue
        }

        try {
          const config = channel.config as Record<string, string>
          await telegramBotManager.startBot(
            channel.id,
            decrypt(config.botToken),
            channel.workspaceId,
          )
        } catch (error) {
          logger.error(`[Telegram] Failed to start bot for channel ${channel.id}`, error)
        }
      }
    } catch (error) {
      logger.error('[Telegram] Failed to boot channels', error)
    }
  },
}

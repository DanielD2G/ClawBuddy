import './workers/ingestion.worker.js'
import './workers/cron.worker.js'
import app from './app.js'
import { capabilityService } from './services/capability.service.js'
import { skillService } from './services/skill.service.js'
import { toolDiscoveryService } from './services/tool-discovery.service.js'
import { cronService } from './services/cron.service.js'
import { prisma } from './lib/prisma.js'
import { browserService } from './services/browser.service.js'
import { settingsService } from './services/settings.service.js'
import { channelService } from './services/channel.service.js'
import { telegramBotManager } from './channels/telegram/telegram-bot-manager.js'
import { decrypt } from './services/crypto.service.js'

// Sync built-in capabilities on startup, then sync skills from MinIO
capabilityService
  .syncBuiltinCapabilities()
  .then(() => skillService.syncSkillsFromStorage())
  .then(async () => {
    const settings = await settingsService.get()
    if (settings.onboardingComplete) {
      await toolDiscoveryService.indexCapabilities()
    }
  })
  .catch((err) => {
    console.error('[Capabilities] Failed to sync capabilities/skills:', err)
  })

// Register builtin cron jobs
cronService.registerBuiltinJobs().catch((err) => {
  console.error('[Cron] Failed to register builtin jobs:', err)
})

// Ensure GlobalSettings singleton exists
prisma.globalSettings
  .upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton' },
    update: {},
  })
  .catch((err) => {
    console.error('[Settings] Failed to ensure global settings:', err)
  })

// Boot all enabled Telegram channels
channelService
  .getAllEnabled()
  .then(async (channels) => {
    for (const ch of channels) {
      if (ch.type === 'telegram') {
        try {
          const config = ch.config as Record<string, string>
          await telegramBotManager.startBot(ch.id, decrypt(config.botToken), ch.workspaceId)
        } catch (err) {
          console.error(`[Telegram] Failed to start bot for channel ${ch.id}:`, err)
        }
      }
    }
  })
  .catch((err) => {
    console.error('[Telegram] Failed to boot channels:', err)
  })

// Periodic cleanup of idle browser sessions (every 60 seconds)
setInterval(() => {
  browserService.cleanupIdleSessions().catch((err) => {
    console.error('[Browser] Cleanup error:', err)
  })
}, 60_000)

// Graceful shutdown
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    console.log(`[Server] ${signal} received, shutting down...`)
    await Promise.allSettled([browserService.shutdown(), telegramBotManager.stopAll()])
    process.exit(0)
  })
}

export default {
  port: 4000,
  fetch: app.fetch,
  idleTimeout: 255, // seconds — prevents Bun from killing SSE streams during long LLM calls
}

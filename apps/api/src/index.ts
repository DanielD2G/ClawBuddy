import './workers/ingestion.worker.js'
import './workers/cron.worker.js'
import app from './app.js'
import { browserService } from './services/browser.service.js'
import { telegramBotManager } from './channels/telegram/telegram-bot-manager.js'
import { startupService } from './services/startup.service.js'

void startupService.start()

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

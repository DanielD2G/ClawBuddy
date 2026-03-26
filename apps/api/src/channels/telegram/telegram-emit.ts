import type { SSEEmit } from '../../lib/sse.js'
import { telegramBotManager } from './telegram-bot-manager.js'
import { logger } from '../../lib/logger.js'

/**
 * Create an SSEEmit that forwards 'content' events to a Telegram chat.
 * Sends are fire-and-forget so failures don't break the caller's flow.
 */
export function createTelegramEmit(workspaceId: string, chatId: string): SSEEmit {
  return (event, data) => {
    if (event === 'content' && typeof data.text === 'string' && data.text.trim()) {
      telegramBotManager.sendToChat(workspaceId, chatId, data.text).catch((err) => {
        logger.error('[Telegram] Failed to forward cron content to Telegram', err, { workspaceId })
      })
    }
  }
}

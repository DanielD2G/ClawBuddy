import { Bot } from 'grammy'
import { handleTelegramMessage, createNewSession } from './telegram-handler.js'
import { markdownToTelegramHtml, splitHtmlMessage } from './format-telegram.js'

interface BotEntry {
  bot: Bot
  workspaceId: string
}

class TelegramBotManager {
  private bots = new Map<string, BotEntry>()

  async startBot(channelId: string, botToken: string, workspaceId: string): Promise<string> {
    // Stop existing bot for this channel if running
    if (this.bots.has(channelId)) {
      await this.stopBot(channelId)
    }

    const bot = new Bot(botToken)

    // /new — create a new conversation
    bot.command('new', async (ctx) => {
      const telegramChatId = String(ctx.chat.id)
      await createNewSession(workspaceId, telegramChatId)
      await ctx.reply('New conversation started. How can I help you?')
    })

    // /help — show available commands
    bot.command('help', async (ctx) => {
      await ctx.reply(
        'Available commands:\n' +
        '/new — Start a new conversation\n' +
        '/help — Show this help message\n\n' +
        'Just send any message to chat with the assistant.'
      )
    })

    // /start — welcome message (Telegram sends this when user first opens bot)
    bot.command('start', async (ctx) => {
      await ctx.reply(
        'Welcome! I\'m your AI assistant.\n\n' +
        'Just send me a message and I\'ll help you.\n' +
        'Use /new to start a fresh conversation.\n' +
        'Use /help for more commands.'
      )
    })

    // Regular text messages
    bot.on('message:text', async (ctx) => {
      const telegramChatId = String(ctx.chat.id)
      const text = ctx.message.text

      // Show "typing..." indicator, refreshed every 4s (Telegram expires it after 5s)
      await ctx.replyWithChatAction('typing')
      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction('typing').catch(() => {})
      }, 4000)

      try {
        const sendFn = async (msg: string) => {
          const html = markdownToTelegramHtml(msg)

          try {
            if (html.length <= 4096) {
              await ctx.reply(html, { parse_mode: 'HTML' })
            } else {
              const parts = splitHtmlMessage(html, 4096)
              for (const part of parts) {
                await ctx.reply(part, { parse_mode: 'HTML' })
              }
            }
          } catch (err) {
            console.warn('[Telegram] HTML send failed, retrying as plain text:', err)
            // Fallback: strip HTML tags and send as plain text
            const plain = msg.replace(/#{1,6}\s+/gm, '').replace(/\*\*/g, '').replace(/(?<!\w)\*(?!\s)/g, '')
            if (plain.length <= 4096) {
              await ctx.reply(plain)
            } else {
              const parts = splitMessage(plain, 4096)
              for (const part of parts) {
                await ctx.reply(part)
              }
            }
          }
        }

        await handleTelegramMessage(workspaceId, telegramChatId, text, sendFn)

        clearInterval(typingInterval)
      } catch (err) {
        clearInterval(typingInterval)
        console.error('[Telegram] Error handling message:', err)
        await ctx.reply('Sorry, an error occurred while processing your message. Please try again.')
      }
    })

    // Error handler
    bot.catch((err) => {
      console.error(`[Telegram] Bot error (channel ${channelId}):`, err)
    })

    // Get bot info to store username
    const botInfo = await bot.api.getMe()
    const botUsername = botInfo.username

    // Start polling
    bot.start({
      onStart: () => {
        console.log(`[Telegram] Bot @${botUsername} started for channel ${channelId}`)
      },
    })

    this.bots.set(channelId, { bot, workspaceId })
    return botUsername
  }

  async stopBot(channelId: string): Promise<void> {
    const entry = this.bots.get(channelId)
    if (entry) {
      await entry.bot.stop()
      this.bots.delete(channelId)
      console.log(`[Telegram] Bot stopped for channel ${channelId}`)
    }
  }

  async stopAll(): Promise<void> {
    const channelIds = [...this.bots.keys()]
    await Promise.allSettled(channelIds.map((id) => this.stopBot(id)))
  }

  isRunning(channelId: string): boolean {
    return this.bots.has(channelId)
  }
}

function splitMessage(text: string, maxLength: number): string[] {
  const parts: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      parts.push(remaining)
      break
    }
    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf('\n', maxLength)
    if (splitIdx <= 0) splitIdx = maxLength
    parts.push(remaining.slice(0, splitIdx))
    remaining = remaining.slice(splitIdx).trimStart()
  }
  return parts
}

export const telegramBotManager = new TelegramBotManager()

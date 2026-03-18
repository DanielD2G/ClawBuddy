import { prisma } from '../../lib/prisma.js'
import { chatService } from '../../services/chat.service.js'
import type { SSEEmit } from '../../lib/sse.js'

/**
 * Find the most recent active Telegram session for this chat, or create a new one.
 */
async function findOrCreateSession(workspaceId: string, telegramChatId: string) {
  // Find the latest telegram session for this chat
  const existing = await prisma.chatSession.findFirst({
    where: {
      workspaceId,
      source: 'telegram',
      externalChatId: telegramChatId,
    },
    orderBy: { createdAt: 'desc' },
  })

  if (existing) return existing

  return prisma.chatSession.create({
    data: {
      workspaceId,
      source: 'telegram',
      externalChatId: telegramChatId,
    },
  })
}

/**
 * Create a brand-new session for the /new command.
 */
export async function createNewSession(workspaceId: string, telegramChatId: string) {
  return prisma.chatSession.create({
    data: {
      workspaceId,
      source: 'telegram',
      externalChatId: telegramChatId,
    },
  })
}

/**
 * Handle an incoming Telegram text message:
 * 1. Find or create a ChatSession
 * 2. Run the agent loop via chatService.sendMessage with a collector emit
 * 3. Return the collected response text
 */
export async function handleTelegramMessage(
  workspaceId: string,
  telegramChatId: string,
  text: string,
  sendFn: (msg: string) => Promise<void>,
): Promise<void> {
  const session = await findOrCreateSession(workspaceId, telegramChatId)

  const telegramEmit: SSEEmit = (event, data) => {
    if (event === 'content' && typeof data.text === 'string' && data.text.trim()) {
      sendFn(data.text).catch(() => {})
    }
  }

  await chatService.sendMessage(session.id, text, telegramEmit)
}

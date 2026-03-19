import { Hono } from 'hono'
import { Bot } from 'grammy'
import { channelService } from '../services/channel.service.js'
import { telegramBotManager } from '../channels/telegram/telegram-bot-manager.js'
import type { TelegramChannelConfig } from '../channels/types.js'
import { ok, fail } from '../lib/responses.js'

const app = new Hono()

// List channels (optionally filtered by workspaceId)
app.get('/', async (c) => {
  const workspaceId = c.req.query('workspaceId')
  const channels = await channelService.list(workspaceId)
  return ok(
    c,
    channels.map((ch) => ({
      ...ch,
      running: ch.type === 'telegram' ? telegramBotManager.isRunning(ch.id) : false,
    })),
  )
})

// Get single channel
app.get('/:id', async (c) => {
  const { id } = c.req.param()
  const channel =
    (await channelService.getByWorkspaceAndType(id, 'telegram')) ??
    (await channelService.list().then((chs) => chs.find((ch) => ch.id === id)))
  if (!channel) {
    return fail(c, 'Channel not found', 404)
  }
  return ok(c, {
    ...channel,
    running: channel.type === 'telegram' ? telegramBotManager.isRunning(channel.id) : false,
  })
})

// Create channel
app.post('/', async (c) => {
  const body = await c.req.json()
  const { workspaceId, type, name, config } = body as {
    workspaceId: string
    type: string
    name: string
    config: TelegramChannelConfig
  }

  if (!workspaceId || !type || !name || !config?.botToken) {
    return fail(c, 'workspaceId, type, name, and config.botToken are required')
  }

  const channel = await channelService.create({ workspaceId, type, name, config })
  return ok(c, channel, 201)
})

// Update channel
app.patch('/:id', async (c) => {
  const { id } = c.req.param()
  const body = await c.req.json()
  const channel = await channelService.update(id, body)
  return ok(c, channel)
})

// Delete channel
app.delete('/:id', async (c) => {
  const { id } = c.req.param()
  await telegramBotManager.stopBot(id)
  await channelService.delete(id)
  return c.json({ success: true })
})

// Enable channel + start bot
app.post('/:id/enable', async (c) => {
  const { id } = c.req.param()
  const channel = await channelService.get(id)

  if (channel.type === 'telegram') {
    const config = channel.config as TelegramChannelConfig
    const botUsername = await telegramBotManager.startBot(id, config.botToken, channel.workspaceId)
    // Store the bot username in config
    await channelService.update(id, { config: { botUsername } })
  }

  await channelService.enable(id)
  return c.json({ success: true })
})

// Disable channel + stop bot
app.post('/:id/disable', async (c) => {
  const { id } = c.req.param()
  await telegramBotManager.stopBot(id)
  await channelService.disable(id)
  return c.json({ success: true })
})

// Test bot token
app.post('/:id/test', async (c) => {
  const { id } = c.req.param()
  try {
    const channel = await channelService.get(id)
    const config = channel.config as TelegramChannelConfig
    const bot = new Bot(config.botToken)
    const me = await bot.api.getMe()
    return ok(c, {
      username: me.username,
      firstName: me.first_name,
      canJoinGroups: me.can_join_groups,
      canReadAllGroupMessages: me.can_read_all_group_messages,
    })
  } catch (err) {
    return fail(c, err instanceof Error ? err.message : 'Failed to connect to Telegram')
  }
})

// Test token without creating a channel first (for onboarding/setup)
app.post('/test-token', async (c) => {
  const body = await c.req.json()
  const { botToken } = body as { botToken: string }
  if (!botToken) {
    return fail(c, 'botToken is required')
  }
  try {
    const bot = new Bot(botToken)
    const me = await bot.api.getMe()
    return ok(c, {
      username: me.username,
      firstName: me.first_name,
    })
  } catch (err) {
    return fail(c, err instanceof Error ? err.message : 'Invalid bot token')
  }
})

export default app

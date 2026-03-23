import { prisma } from '../lib/prisma.js'
import { encrypt, decrypt } from './crypto.service.js'
import type { TelegramChannelConfig } from '../channels/types.js'

type ChannelRow = {
  id: string
  workspaceId: string
  type: string
  name: string
  enabled: boolean
  config: Record<string, string>
  createdAt: Date
  updatedAt: Date
}

function maskToken(token: string): string {
  if (token.length <= 8) return '••••••••'
  return token.slice(0, 4) + '••••' + token.slice(-4)
}

export const channelService = {
  async create(data: {
    workspaceId: string
    type: string
    name: string
    config: TelegramChannelConfig
  }) {
    const encryptedConfig = {
      ...data.config,
      botToken: encrypt(data.config.botToken),
    }
    return prisma.channel.create({
      data: {
        workspaceId: data.workspaceId,
        type: data.type,
        name: data.name,
        config: encryptedConfig,
      },
    })
  },

  async update(id: string, data: { name?: string; config?: Partial<TelegramChannelConfig> }) {
    const channel = (await prisma.channel.findUniqueOrThrow({ where: { id } })) as ChannelRow
    const currentConfig = channel.config as Record<string, string>

    let updatedConfig = { ...currentConfig }
    if (data.config) {
      if (data.config.botToken) {
        updatedConfig.botToken = encrypt(data.config.botToken)
      }
      if (data.config.botUsername !== undefined) {
        updatedConfig.botUsername = data.config.botUsername
      }
    }

    return prisma.channel.update({
      where: { id },
      data: {
        ...(data.name ? { name: data.name } : {}),
        config: updatedConfig,
      },
    })
  },

  async get(id: string) {
    const channel = (await prisma.channel.findUniqueOrThrow({ where: { id } })) as ChannelRow
    const config = channel.config as Record<string, string>
    return {
      ...channel,
      config: {
        ...config,
        botToken: decrypt(config.botToken),
      },
    }
  },

  async getByWorkspaceAndType(workspaceId: string, type: string) {
    return prisma.channel.findUnique({
      where: { workspaceId_type: { workspaceId, type } },
    }) as Promise<ChannelRow | null>
  },

  async list(workspaceId?: string): Promise<ChannelRow[]> {
    const channels = (await prisma.channel.findMany({
      where: workspaceId ? { workspaceId } : undefined,
      orderBy: { createdAt: 'desc' },
    })) as ChannelRow[]
    return channels.map((ch: ChannelRow) => {
      const config = ch.config as Record<string, string>
      return {
        ...ch,
        config: {
          ...config,
          botToken: maskToken(decrypt(config.botToken)),
        },
      }
    })
  },

  async delete(id: string) {
    return prisma.channel.delete({ where: { id } })
  },

  async enable(id: string) {
    return prisma.channel.update({
      where: { id },
      data: { enabled: true },
    })
  },

  async disable(id: string) {
    return prisma.channel.update({
      where: { id },
      data: { enabled: false },
    })
  },

  async getAllEnabled() {
    return prisma.channel.findMany({ where: { enabled: true } })
  },
}

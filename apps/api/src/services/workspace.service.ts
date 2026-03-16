import { prisma } from '../lib/prisma.js'
import type { Prisma } from '@prisma/client'

export const workspaceService = {
  async list() {
    return prisma.workspace.findMany({ orderBy: { createdAt: 'desc' } })
  },

  async create(data: { name: string; description?: string; color?: string; settings?: Prisma.InputJsonValue }) {
    return prisma.workspace.create({ data })
  },

  async findById(id: string) {
    return prisma.workspace.findUnique({ where: { id } })
  },

  async update(id: string, data: { name?: string; description?: string; color?: string; settings?: Prisma.InputJsonValue }) {
    return prisma.workspace.update({ where: { id }, data })
  },

  async delete(id: string) {
    return prisma.workspace.delete({ where: { id } })
  },

  async getSettings(id: string): Promise<Record<string, unknown> | null> {
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id } })
    return (workspace.settings as Record<string, unknown>) ?? null
  },

  async updateSettings(id: string, settings: Prisma.InputJsonValue) {
    return prisma.workspace.update({
      where: { id },
      data: { settings },
    })
  },
}

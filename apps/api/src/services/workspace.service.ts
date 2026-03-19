import { prisma } from '../lib/prisma.js'
import { Prisma } from '@prisma/client'
import { mergeWorkspaceSettings } from '@clawbuddy/shared'
import type { CreateWorkspaceInput, UpdateWorkspaceInput } from '@clawbuddy/shared'

export const workspaceService = {
  async list() {
    return prisma.workspace.findMany({ orderBy: { createdAt: 'desc' } })
  },

  async create(data: CreateWorkspaceInput) {
    return prisma.workspace.create({
      data: {
        name: data.name,
        description: data.description ?? null,
        color: data.color ?? null,
        settings: (data.settings ?? null) as Prisma.InputJsonValue,
      },
    })
  },

  async findById(id: string) {
    return prisma.workspace.findUnique({ where: { id } })
  },

  async update(id: string, data: UpdateWorkspaceInput) {
    let mergedSettings: Prisma.InputJsonValue | typeof Prisma.DbNull | undefined

    if (data.settings !== undefined) {
      if (data.settings === null) {
        mergedSettings = Prisma.DbNull
      } else {
        const existing = await prisma.workspace.findUnique({
          where: { id },
          select: { settings: true },
        })
        const nextSettings = mergeWorkspaceSettings(
          existing?.settings,
          data.settings as Record<string, unknown>,
        ) ?? {}
        mergedSettings = nextSettings as Prisma.InputJsonValue
      }
    }

    return prisma.workspace.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.permissions !== undefined && { permissions: data.permissions as Prisma.InputJsonValue }),
        ...(data.color !== undefined && { color: data.color }),
        ...(data.settings !== undefined && { settings: mergedSettings }),
        ...(data.autoExecute !== undefined && { autoExecute: data.autoExecute }),
      },
    })
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

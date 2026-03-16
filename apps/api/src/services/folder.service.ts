import { prisma } from '../lib/prisma.js'

export const folderService = {
  async listByParent(workspaceId: string, parentId?: string | null) {
    return prisma.folder.findMany({
      where: { workspaceId, parentId: parentId ?? null },
      orderBy: { name: 'asc' },
    })
  },

  async getWithAncestors(id: string) {
    const folder = await prisma.folder.findUnique({ where: { id } })
    if (!folder) return null

    const ancestors: typeof folder[] = []
    let current = folder
    while (current.parentId) {
      const parent = await prisma.folder.findUnique({ where: { id: current.parentId } })
      if (!parent) break
      ancestors.unshift(parent)
      current = parent
    }

    return { folder, ancestors }
  },

  async create(data: { name: string; workspaceId: string; parentId?: string }) {
    return prisma.folder.create({ data })
  },

  async delete(id: string) {
    return prisma.folder.delete({ where: { id } })
  },
}

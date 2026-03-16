import { prisma } from '../lib/prisma.js'

export const documentService = {
  async listByWorkspace(workspaceId: string, folderId?: string) {
    return prisma.document.findMany({
      where: {
        workspaceId,
        ...(folderId !== undefined && { folderId }),
      },
      orderBy: { createdAt: 'desc' },
    })
  },

  async create(data: {
    title: string
    workspaceId: string
    folderId?: string
    type: string
    fileUrl?: string
    content?: string
  }) {
    return prisma.document.create({ data })
  },

  async findById(id: string) {
    return prisma.document.findUnique({
      where: { id },
      include: { chunks: true },
    })
  },

  async updateStatus(id: string, status: string, chunkCount?: number) {
    return prisma.document.update({
      where: { id },
      data: { status, ...(chunkCount !== undefined && { chunkCount }) },
    })
  },
}

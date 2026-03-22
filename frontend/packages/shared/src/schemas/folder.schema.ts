import { z } from 'zod'

export const createFolderSchema = z.object({
  name: z.string().min(1, 'Folder name is required').max(100),
  parentId: z.string().uuid().optional(),
})

export type CreateFolderInput = z.infer<typeof createFolderSchema>

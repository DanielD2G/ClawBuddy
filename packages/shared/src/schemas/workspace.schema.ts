import { z } from 'zod'

export const createWorkspaceSchema = z.object({
  name: z.string().min(1, 'Workspace name is required').max(100),
  description: z.string().max(500).optional(),
})

export const updateWorkspaceSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
})

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>
